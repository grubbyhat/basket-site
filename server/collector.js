// Cranks pump.fun's `distribute_creator_fees` for Route coins so each coin's
// accrued creator fees land in Route's fee account. Permissionless on-chain; the
// treasury pays the network fee. A fixed sweep every ROUTE_COLLECT_SWEEP_MS
// (default 10 s) re-reads every coin's vault in one batched call and claims
// whatever is at or above the minimum, a few coins at a time.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { HttpError } from './errors.js';

const SWEEP_MS = 10_000;
const PARALLEL = 3;

export function createCollector({ connection, store, treasury = null, watcher, minLamports = 10_000_000, sweepMs = SWEEP_MS, collectImpl = null, log = console }) {
  if (!treasury) {
    return { enabled: false, collect: async () => { throw new HttpError('Fee collection is not configured on this server.', 503); }, sweep: async () => 0, start() {}, stop() {} };
  }
  const online = new OnlinePumpSdk(connection);
  const inflight = new Map();

  async function collect(mint, { reason = 'manual' } = {}) {
    if (inflight.has(mint)) return inflight.get(mint);
    const job = (collectImpl ? collectImpl(mint, { reason }) : (async () => {
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
      // Route's fee account is the only shareholder; the treasury only paid the fee, so
      // the distributed amount is what the program reported as distributable.
      const details = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const fees = store.get(mint)?.fees || { distributedLamports: '0', claims: [] };
      await store.update(mint, { fees: { distributedLamports: (BigInt(fees.distributedLamports || 0) + distributable).toString(), claims: [...(fees.claims || []), { signature, lamports: distributable.toString(), at: new Date().toISOString(), slot: details?.slot ?? null, reason }].slice(-200) } });
      await watcher.refresh(mint).catch(() => {});
      return { mint, signature, lamports: distributable.toString() };
    })()).finally(() => inflight.delete(mint));
    inflight.set(mint, job);
    return job;
  }

  const due = coin => BigInt(coin.unclaimedLamports) >= BigInt(minLamports);
  let sweeping = false;
  let sweeper = null;
  // Re-read every vault, then claim each due coin right away, a few in parallel.
  async function sweep(reason = 'sweep') {
    if (sweeping) return 0;
    sweeping = true;
    try {
      try { await watcher.refreshAll(); } catch (error) { log.warn(`[collect] sweep read failed: ${error.message}`); }
      const queue = watcher.all().filter(due).map(coin => coin.mint);
      let claimed = 0;
      const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        while (queue.length) {
          const mint = queue.shift();
          try { const result = await collect(mint, { reason }); if (result?.signature) claimed += 1; }
          catch (error) { log.warn(`[collect] ${mint}: ${error.message}`); }
        }
      });
      await Promise.all(workers);
      return claimed;
    } finally { sweeping = false; }
  }

  return {
    enabled: true,
    address: treasury.publicKey.toBase58(),
    sweepMs,
    collect, sweep,
    start() {
      sweep('startup sweep').catch(() => {});
      sweeper = setInterval(() => sweep().catch(() => {}), sweepMs);
      sweeper.unref?.();
      log.info(`[collect] sweeping every ${sweepMs / 1000} s, minimum ${Number(minLamports) / 1e9} SOL per coin`);
    },
    stop() { if (sweeper) clearInterval(sweeper); sweeper = null; },
  };
}
