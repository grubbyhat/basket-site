// A separate buyback signer: the treasury forwards only the ledger's buyback money,
// the signer buys, and the recipients' claimed fees sitting in the treasury stay put.
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

test('the treasury forwards entitled − forwarded to the signer, and the signer buys up to what is owed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-signer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: MAIN, status: 'confirmed', fees: { distributedLamports: '300000000', claims: [{ lamports: '300000000' }] } });
  await store.create({ mint: 'Other', status: 'confirmed', shares: { treasuryBps: 500, othersBps: 9500 }, fees: { claims: [{ lamports: '2000000000' }] } });
  const treasury = Keypair.generate(), signer = Keypair.generate();
  // The treasury holds 5 SOL: 0.4 SOL of buyback money and 4.6 SOL of recipients' claimed fees.
  const balances = { [treasury.publicKey.toBase58()]: 5_000_000_000n, [signer.publicKey.toBase58()]: 1_000_000_000n };
  const forwards = [], buys = [];
  const buyback = createBuyback({
    connection: {}, store, treasury, signer, mainCoin: null, minLamports: 100_000_000, log: silent,
    balanceImpl: async key => balances[key.toBase58()],
    forwardImpl: async lamports => { forwards.push(lamports); balances[treasury.publicKey.toBase58()] -= lamports; balances[signer.publicKey.toBase58()] += lamports; return { signature: `Fwd${forwards.length}` }; },
    buyImpl: async (mint, lamports) => { buys.push([mint, lamports]); balances[signer.publicKey.toBase58()] -= lamports; return { signature: `Buy${buys.length}`, venue: 'test', tokens: '42', lamportsSpent: lamports.toString() }; },
  });
  assert.equal(buyback.separate, true);
  assert.equal(buyback.wallet, signer.publicKey.toBase58());
  await buyback.configure({ mainCoin: MAIN, enabled: true });
  let status = await buyback.status();
  assert.equal(status.entitledLamports, '400000000');
  assert.equal(status.toForwardLamports, '400000000', 'only the buyback money is due to move');
  assert.equal(status.treasuryLamports, '5000000000');

  const purchase = await buyback.run();
  assert.deepEqual(forwards, [400_000_000n], 'the treasury forwarded exactly the buyback money');
  assert.equal(purchase.signature, 'Buy1');
  assert.deepEqual(buys, [[MAIN, 400_000_000n]], 'the signer bought what was owed, not its own SOL');
  assert.equal(balances[treasury.publicKey.toBase58()], 4_600_000_000n, 'recipients’ money stays in the treasury');
  assert.equal(balances[signer.publicKey.toBase58()], 1_000_000_000n, 'the signer’s own SOL is untouched');
  status = await buyback.status();
  assert.equal(status.forwardedLamports, '400000000');
  assert.equal(status.spentLamports, '400000000');
  assert.equal(status.toForwardLamports, '0');
  assert.deepEqual(await buyback.run(), { skipped: 'below minimum', availableLamports: '0' });

  // New 5% money arrives: 0.5 SOL more is forwarded and bought.
  await store.update('Other', { fees: { claims: [{ lamports: '2000000000' }, { lamports: '10000000000' }] } });
  balances[treasury.publicKey.toBase58()] += 500_000_000n;
  await buyback.run();
  assert.deepEqual(forwards, [400_000_000n, 500_000_000n]);
  assert.equal((await buyback.status()).spentLamports, '900000000');
  assert.equal((await buyback.status()).forwards.length, 2);
});

test('a treasury below its reserve forwards nothing and nothing is bought', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-signer2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: MAIN, status: 'confirmed', fees: { claims: [{ lamports: '300000000' }] } });
  const treasury = Keypair.generate(), signer = Keypair.generate();
  const buyback = createBuyback({ connection: {}, store, treasury, signer, log: silent, balanceImpl: async () => 15_000_000n, forwardImpl: async () => { throw new Error('must not forward'); }, buyImpl: async () => { throw new Error('must not buy'); } });
  await buyback.configure({ mainCoin: MAIN, enabled: true });
  const status = await buyback.status();
  assert.equal(status.toForwardLamports, '0');
  assert.equal((await buyback.run()).skipped, 'below minimum');
});
