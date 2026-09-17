// Cranks pump.fun's `distribute_creator_fees` for Route coins so each coin's
// accrued creator fees land in Route's fee account. Permissionless on-chain; the
// treasury pays the network fee. A fixed sweep every ROUTE_COLLECT_SWEEP_MS
// (default 10 s) re-reads every coin's vault in one batched call and claims
// whatever is at or above the minimum, a few coins at a time.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { HttpError } from './errors.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { createSettlement, solDelta } from './settlement.js';
import { feeEvents } from './pump-events.js';
import { createFeeLedger } from './fee-ledger.js';

const SWEEP_MS = 10_000;
const PARALLEL = 3;

export function createCollector({ connection, store, treasury = null, watcher, socialPda = null, mainCoin = () => null, buybackShareBps = 500, feeLedger = createFeeLedger({ store }), canCollect = () => true, afterSweep = null, minLamports = 10_000_000, sweepMs = SWEEP_MS, collectImpl = null, pumpClient = new OnlinePumpSdk(connection), log = console }) {
  if (!treasury) {
    return { enabled: false, collect: async () => { throw new HttpError('Fee collection is not configured on this server.', 503); }, sweep: async () => 0, start() {}, stop() {} };
  }
  const online = pumpClient;
  const inflight = new Map();
  const lanes = new Map();
  const lane = mint => {
    if (!lanes.has(mint)) lanes.set(mint, createSettlement({ connection, store, key: `collect-${new PublicKey(mint).toBuffer().toString('hex')}` }));
    return lanes.get(mint);
  };

  async function settle(attempt, details) {
    const { mint, mainMint, reason } = attempt.context;
    const events = feeEvents(details).filter(event => event.name === 'distributeCreatorFeesEvent' && event.data.mint.toBase58() === mint);
    if (!events.length || events.some(event => ![PublicKey.default.toBase58(), NATIVE_MINT.toBase58()].includes(event.data.quoteMint.toBase58()))) throw new Error('Expected SOL distribution receipt is missing.');
    const distributed = events.reduce((sum, event) => sum + BigInt(event.data.distributed.toString()), 0n);
    const expected = address => events.reduce((sum, event) => sum + event.data.shareholders.filter(row => row.address.toBase58() === address).reduce((value, row) => value + BigInt(event.data.distributed.toString()) * BigInt(row.shareBps) / 10000n, 0n), 0n);
    const directDelta = solDelta(details, treasury.publicKey) + BigInt(details.meta.fee);
    const direct = directDelta > 0n ? directDelta : 0n;
    const social = socialPda && expected(String(socialPda)) > 0n ? solDelta(details, socialPda) : 0n;
    if (social < 0n || social > expected(String(socialPda)) || direct > expected(treasury.publicKey.toBase58())) throw new Error('Distribution receipt does not match the configured fee recipients.');
    const allowance = mint === mainMint ? direct : distributed * BigInt(buybackShareBps) / 10000n;
    const receipt = { signature: attempt.signature, mint, mainCoin: mainMint, treasury: treasury.publicKey.toBase58(), lamports: distributed.toString(), treasuryLamports: direct.toString(), socialLamports: social.toString(), buybackLamports: (direct < allowance ? direct : allowance).toString(), at: attempt.at, slot: details.slot, reason };
    await feeLedger.distribution(receipt);
    const rows = Object.values(feeLedger.read().distributions).filter(row => row.mint === mint);
    const fees = { distributedLamports: rows.reduce((sum, row) => sum + BigInt(row.lamports), 0n).toString(), claims: rows.slice(-200) };
    await store.update(mint, { fees });
    await watcher.refresh(mint).catch(() => {});
  }

  async function collect(mint, { reason = 'manual' } = {}) {
    if (inflight.has(mint)) return inflight.get(mint);
    if (!canCollect()) return { skipped: 'GitHub withdrawal is being settled' };
    const job = (collectImpl ? collectImpl(mint, { reason }) : lane(mint).execute({ settle, build: async () => {
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
      return { transaction, lastValidBlockHeight, context: { mint, mainMint: mainCoin(), reason } };
    } })).finally(() => inflight.delete(mint));
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
      const queue = watcher.all().filter(coin => due(coin) || (!collectImpl && lane(coin.mint).pending())).map(coin => coin.mint);
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
    } finally { sweeping = false; await afterSweep?.(); }
  }

  return {
    enabled: true,
    address: treasury.publicKey.toBase58(),
    sweepMs,
    collect, sweep,
    hasPending: () => inflight.size > 0 || (!collectImpl && watcher.all().some(coin => lane(coin.mint).pending())),
    start() {
      sweep('startup sweep').catch(() => {});
      sweeper = setInterval(() => sweep().catch(() => {}), sweepMs);
      sweeper.unref?.();
      log.info(`[collect] sweeping every ${sweepMs / 1000} s, minimum ${Number(minLamports) / 1e9} SOL per coin`);
    },
    stop() { if (sweeper) clearInterval(sweeper); sweeper = null; },
  };
}
