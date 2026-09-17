// Watches pump's fee program for fee-sharing changes that point at Route's own
// addresses (the GitHub fee account or the treasury) and adds such coins to Route
// on the spot, so a coin launched from any launcher gets its Route page within
// seconds of its fee sharing landing. Recipients come later from the creator.
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK } from '@pump-fun/pump-sdk';

export function shareholdersOnRoute(config, allowed) {
  const routeAddresses = new Set(allowed.map(key => key.toBase58()));
  const shareholders = config?.shareholders || [];
  return shareholders.length > 0 && routeAddresses.size > 0 && shareholders.every(entry => routeAddresses.has(entry.address.toBase58()));
}

export function createFeeShareDetector({ connection, store, service, allowed, log = console }) {
  let subscription = null;
  const seen = new Set();

  async function inspectSignature(signature) {
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    const details = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    if (!details?.meta || details.meta.err) return;
    const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
    const all = [];
    for (let index = 0; index < keys.length; index += 1) all.push(keys.get(index));
    const infos = await connection.getMultipleAccountsInfo(all).catch(() => []);
    for (let index = 0; index < all.length; index += 1) {
      const info = infos[index];
      if (!info || !info.owner.equals(PUMP_FEE_PROGRAM_ID)) continue;
      let config = null;
      try { config = PUMP_SDK.decodeSharingConfig(info); } catch { continue; }
      if (!config?.mint || !shareholdersOnRoute(config, allowed())) continue;
      const mint = config.mint.toBase58();
      if (['active', 'detected'].includes(store.get(mint)?.route?.status)) continue;
      try {
        await service.adopt({ mint, recipients: [], source: 'detected', signature });
        log.info(`[detect] ${mint} shares its fees with Route; added (${signature})`);
      } catch (error) {
        log.warn(`[detect] ${mint}: ${error.message}`);
      }
    }
  }

  return {
    inspectSignature,
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
