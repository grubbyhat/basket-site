import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createBuyback } from './buyback.js';
import { openStore } from './store.js';

const silent = { info() {}, warn() {}, error() {} };
const MAIN = Keypair.generate().publicKey.toBase58();

async function setup(t, { balance = 5_000_000_000n } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-buyback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  // The main coin: all of its fees; another coin: 5% of its fees; a legacy coin: nothing.
  await store.create({ mint: MAIN, status: 'confirmed', fees: { distributedLamports: '300000000', claims: [{ lamports: '100000000' }, { lamports: '200000000' }] } });
  await store.create({ mint: 'Other', status: 'confirmed', shares: { treasuryBps: 500, othersBps: 9500 }, fees: { distributedLamports: '2000000000', claims: [{ lamports: '2000000000' }] } });
  await store.create({ mint: 'Legacy', status: 'confirmed', fees: { distributedLamports: '900000000', claims: [{ lamports: '900000000' }] } });
  await store.create({ mint: 'Pending', status: 'prepared', shares: { treasuryBps: 10000 }, fees: { claims: [{ lamports: '900000000' }] } });
  const connection = { async getBalance() { return Number(balance); } };
  return { store, connection, dir };
}

test('the buyback budget is the main coin fees plus the 5% shares, capped by the treasury balance', async t => {
  const { store, connection } = await setup(t);
  const buys = [];
  const buyback = createBuyback({ connection, store, treasury: Keypair.generate(), mainCoin: null, minLamports: 100_000_000, log: silent, buyImpl: async (mint, lamports) => { buys.push([mint, lamports.toString()]); return { signature: 'BuySig', venue: 'test', tokens: '123', lamportsSpent: lamports.toString() }; } });
  let status = await buyback.status();
  assert.equal(status.configured, false, 'no main coin yet');
  assert.equal(status.entitledLamports, '100000000', 'without a main coin only the 5% shares count');
  assert.deepEqual(await buyback.run({ force: true }), { skipped: 'not configured' });

  await buyback.configure({ mainCoin: MAIN });
  status = await buyback.status();
  assert.equal(status.entitledLamports, '400000000', '0.3 SOL from the main coin + 5% of 2 SOL');
  assert.equal(status.availableLamports, '400000000');
  assert.equal(status.enabled, false);
  assert.deepEqual(await buyback.run(), { skipped: 'disabled' }, 'nothing runs until it is started');

  await buyback.configure({ enabled: true });
  const purchase = await buyback.run();
  assert.equal(purchase.signature, 'BuySig');
  assert.equal(purchase.lamports, '400000000');
  assert.deepEqual(buys, [[MAIN, '400000000']]);
  status = await buyback.status();
  assert.equal(status.spentLamports, '400000000');
  assert.equal(status.availableLamports, '0');
  assert.deepEqual(await buyback.run(), { skipped: 'below minimum', availableLamports: '0' });
  assert.equal(status.purchases[0].tokens, '123');

  // New fees arrive on the other coin: 5% of 10 SOL = 0.5 SOL.
  await store.update('Other', { fees: { distributedLamports: '12000000000', claims: [{ lamports: '2000000000' }, { lamports: '10000000000' }] } });
  assert.equal((await buyback.status()).availableLamports, '500000000');
});

test('the treasury balance and the reserve cap what can be spent, and errors are recorded', async t => {
  const { store, connection } = await setup(t, { balance: 150_000_000n });
  const buyback = createBuyback({ connection, store, treasury: Keypair.generate(), mainCoin: null, minLamports: 100_000_000, log: silent, buyImpl: async () => { throw new Error('rpc down'); } });
  await buyback.configure({ mainCoin: MAIN, enabled: true });
  const status = await buyback.status();
  assert.equal(status.owedLamports, '400000000');
  assert.equal(status.availableLamports, '130000000', 'balance minus the 0.02 SOL reserve');
  const result = await buyback.run();
  assert.equal(result.error, 'rpc down');
  assert.equal((await buyback.status()).lastError.message, 'rpc down');
  assert.equal((await buyback.status()).spentLamports, '0');
  await assert.rejects(buyback.configure({ backup: 'other' }), error => error.status === 400);
  await assert.rejects(buyback.configure({ mainCoin: 'not-a-mint' }), error => error.status === 400);
  await buyback.configure({ backup: 'pumpportal' });
  assert.equal((await buyback.status()).backup, 'pumpportal');
});

test('settings and the ledger survive a restart', async t => {
  const { store, connection, dir } = await setup(t);
  const treasury = Keypair.generate();
  const first = createBuyback({ connection, store, treasury, log: silent, buyImpl: async (mint, lamports) => ({ signature: 'Sig', venue: 'test', tokens: '1', lamportsSpent: lamports.toString() }) });
  await first.configure({ mainCoin: MAIN, enabled: true, backup: 'pumpportal' });
  await first.run();
  const again = createBuyback({ connection, store: await openStore(dir), treasury, log: silent });
  const status = await again.status();
  assert.equal(status.enabled, true);
  assert.equal(status.mainCoin, MAIN);
  assert.equal(status.backup, 'pumpportal');
  assert.equal(status.spentLamports, '400000000');
  assert.equal(status.purchases.length, 1);
});
