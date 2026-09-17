// Watches pump's fee program for fee-sharing changes that point at Route's own
// addresses (the GitHub fee account or the treasury) and adds such coins to Route
// on the spot, so a coin launched from any launcher gets its Route page within
// seconds of its fee sharing landing. Recipients come later from the creator.
import { PublicKey } from '@solana/web3.js';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK, feeSharingConfigPda } from '@pump-fun/pump-sdk';

export function shareholdersOnRoute(config, allowed) {
  const routeAddresses = new Set(allowed.map(key => key.toBase58()));
  const shareholders = config?.shareholders || [];
  return shareholders.length > 0 && routeAddresses.size > 0 && shareholders.every(entry => routeAddresses.has(entry.address.toBase58()));
}

export function createFeeShareDetector({ connection, store, service, allowed, mainCoin = () => null, now = Date.now, log = console }) {
  let subscription = null;
  const seen = new Set();
  const inflight = new Map();
  let changes = Promise.resolve(), reconciling = null;
  let pending = structuredClone(store.getMeta('fee-share-discovery', {}));
  let main = { mint: null, status: 'unconfigured', message: 'Main token mint is not configured.' };

  function updatePending(change) {
    const job = changes.catch(() => {}).then(async () => {
      const next = structuredClone(pending);
      change(next);
      await store.setMeta('fee-share-discovery', next);
      pending = next;
    });
    changes = job;
    return job;
  }

  async function inspect(signature) {
    const details = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!details?.meta) throw new Error('Fee-sharing transaction metadata is not available yet.');
    if (details.meta.err) return;
    const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
    const all = [];
    for (let index = 0; index < keys.length; index += 1) all.push(keys.get(index));
    const infos = await connection.getMultipleAccountsInfo(all);
    if (infos.length !== all.length) throw new Error('Fee-sharing account read is incomplete.');
    let foundConfig = false;
    for (let index = 0; index < all.length; index += 1) {
      const info = infos[index];
      if (!info || !info.owner.equals(PUMP_FEE_PROGRAM_ID)) continue;
      let config = null;
      try { config = PUMP_SDK.decodeSharingConfig(info); } catch { continue; }
      if (!config?.mint || !all[index].equals(feeSharingConfigPda(config.mint))) continue;
      foundConfig = true;
      if (!shareholdersOnRoute(config, allowed())) continue;
      const mint = config.mint.toBase58();
      if (['active', 'detected'].includes(store.get(mint)?.route?.status)) continue;
      await service.adopt({ mint, recipients: [], source: 'detected', signature });
      log.info(`[detect] ${mint} shares its fees with Route; added (${signature})`);
    }
    if (!foundConfig) throw new Error('Fee-sharing configuration is not readable yet.');
  }

  function inspectSignature(signature) {
    if (seen.has(signature)) return Promise.resolve();
    if (inflight.has(signature)) return inflight.get(signature);
    const job = (async () => {
      if (!pending[signature]) await updatePending(next => { next[signature] = { attempts: 0, retryAt: 0 }; });
      if (pending[signature].retryAt > now()) return;
      try {
        await inspect(signature);
        await updatePending(next => { delete next[signature]; });
        seen.add(signature);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
      } catch (error) {
        await updatePending(next => {
          const attempts = (next[signature]?.attempts || 0) + 1;
          next[signature] = { attempts, retryAt: now() + Math.min(60_000, attempts * 10_000) };
        });
        if (pending[signature].attempts === 1) log.warn(`[detect] queued ${signature} for retry: ${error.message}`);
      }
    })().finally(() => inflight.delete(signature));
    inflight.set(signature, job);
    return job;
  }

  // The saved main mint is checked directly, so launching while Route is down or
  // losing a websocket notification cannot leave its fees permanently untracked.
  async function checkMain() {
    const mint = mainCoin();
    if (!mint) return (main = { mint: null, status: 'unconfigured', message: 'Main token mint is not configured.' });
    if (store.get(mint)?.status === 'confirmed' && ['active', 'detected'].includes(store.get(mint)?.route?.status)) {
      return (main = { mint, status: 'registered', message: null });
    }
    try {
      const key = new PublicKey(mint);
      const [mintInfo, info] = await connection.getMultipleAccountsInfo([key, feeSharingConfigPda(key)]);
      if (!mintInfo) return (main = { mint, status: 'waiting-for-launch', message: 'Waiting for the configured main token to be launched.' });
      if (!info) return (main = { mint, status: 'waiting-for-fee-sharing', message: 'Main token exists; waiting for fee sharing to Route.' });
      if (!info.owner.equals(PUMP_FEE_PROGRAM_ID)) throw new Error('Main token fee-sharing account has the wrong owner.');
      const config = PUMP_SDK.decodeSharingConfig(info);
      if (!config.mint.equals(key)) throw new Error('Main token fee-sharing account has a different mint.');
      if (!shareholdersOnRoute(config, allowed())) return (main = { mint, status: 'wrong-fee-sharing', message: 'Main token fees are not entirely shared with Route.' });
      await service.adopt({ mint, recipients: [], source: 'main-token' });
      return (main = { mint, status: 'registered', message: null });
    } catch (error) {
      if (main.message !== error.message) log.warn(`[detect main] ${error.message}`);
      return (main = { mint, status: 'error', message: error.message });
    }
  }

  function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      await checkMain();
      const due = Object.entries(pending).filter(([, value]) => value.retryAt <= now()).slice(0, 20);
      for (const [signature] of due) await inspectSignature(signature);
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  return {
    inspectSignature, reconcile,
    summary: () => ({ main: { ...main }, pending: Object.keys(pending).length }),
    start() {
      try {
        subscription = connection.onLogs(PUMP_FEE_PROGRAM_ID, ({ signature, logs, err }) => {
          if (err || !logs.some(line => /Instruction: UpdateFeeShares/.test(line))) return;
          inspectSignature(signature).catch(error => log.warn(`[detect] ${signature}: ${error.message}`));
        }, 'confirmed');
        log.info('[detect] watching pump fee sharing for coins pointed at Route');
      } catch (error) {
        log.warn(`[detect] cannot subscribe: ${error.message}`);
      }
    },
    async stop() { if (subscription != null) await connection.removeOnLogsListener(subscription).catch(() => {}); subscription = null; },
  };
}
