// Cranks pump.fun's `distribute_creator_fees` for Route coins so each coin's
// accrued creator fees land in the treasury wallet. Permissionless on-chain; the
// treasury pays the network fee and receives 100% of every distribution.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { HttpError } from './errors.js';

const DEBOUNCE_MS = 30_000;

export function createCollector({ connection, store, treasury = null, watcher, minLamports = 10_000_000, log = console }) {
  if (!treasury) {
    return { enabled: false, collect: async () => { throw new HttpError('Fee collection is not configured on this server.', 503); }, start() {}, stop() {} };
  }
  const online = new OnlinePumpSdk(connection);
  const inflight = new Map();
  const timers = new Map();

  async function collect(mint, { reason = 'manual' } = {}) {
    if (inflight.has(mint)) return inflight.get(mint);
    const job = (async () => {
      const record = store.get(mint);
      if (!record) throw new HttpError('Unknown coin.', 404);
      const key = new PublicKey(mint);
      const info = await online.getMinimumDistributableFee(key, treasury.publicKey, { payer: treasury.publicKey });
      const distributable = BigInt(info.distributableFees.toString());
      if (!info.canDistribute) return { mint, skipped: 'below minimum', distributableLamports: distributable.toString(), minimumLamports: info.minimumRequired.toString() };
      const { instructions } = await online.buildDistributeCreatorFeesInstructions(key, { payer: treasury.publicKey });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({ payerKey: treasury.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...instructions] }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([treasury]);
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
      log.info(`[collect] ${mint} distributing ~${Number(distributable) / 1e9} SOL (${reason}) ${signature}`);
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(`distribution failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      // The treasury is the only shareholder: what it gained plus the fee it paid is the distribution.
      const details = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      let lamports = distributable;
      if (details?.meta) {
        const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
        const index = keys.staticAccountKeys.findIndex(k => k.equals(treasury.publicKey));
        if (index >= 0) lamports = BigInt(details.meta.postBalances[index] - details.meta.preBalances[index] + details.meta.fee);
      }
      const fees = store.get(mint)?.fees || { distributedLamports: '0', claims: [] };
      await store.update(mint, { fees: { distributedLamports: (BigInt(fees.distributedLamports || 0) + lamports).toString(), claims: [...(fees.claims || []), { signature, lamports: lamports.toString(), at: new Date().toISOString(), slot: details?.slot ?? null, reason }].slice(-200) } });
      await watcher.refresh(mint).catch(() => {});
      return { mint, signature, lamports: lamports.toString() };
    })().finally(() => inflight.delete(mint));
    inflight.set(mint, job);
    return job;
  }

  function schedule(mint, reason) {
    if (timers.has(mint)) return;
    timers.set(mint, setTimeout(() => { timers.delete(mint); collect(mint, { reason }).catch(error => log.warn(`[collect] ${mint}: ${error.message}`)); }, DEBOUNCE_MS));
    timers.get(mint).unref?.();
  }

  let off = null;
  return {
    enabled: true,
    address: treasury.publicKey.toBase58(),
    collect,
    start() {
      off = watcher.on(event => { if (event.type === 'vault' && BigInt(event.coin.unclaimedLamports) >= BigInt(minLamports)) schedule(event.mint, 'fees accrued'); });
      for (const coin of watcher.all()) if (BigInt(coin.unclaimedLamports) >= BigInt(minLamports)) schedule(coin.mint, 'startup sweep');
    },
    stop() { off?.(); timers.forEach(clearTimeout); timers.clear(); },
  };
}
