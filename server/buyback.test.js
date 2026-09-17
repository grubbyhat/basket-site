import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { moneyFixture } from './money-fixture.js';

test('unclaimed GitHub distributions and old display estimates cannot fund a buyback', async t => {
  const f = await moneyFixture(t);
  await f.store.create({ mint: String(f.mint), status: 'confirmed', fees: { claims: [{ lamports: '1000000000' }] } });
  await f.credit('social', { direct: 0n, social: 1_000_000_000n });
  const buyback = f.makeBuyback();
  await buyback.configure({ enabled: true });
  const state = await buyback.status();
  assert.equal(state.entitledLamports, '0');
  assert.equal(state.toForwardLamports, '0');
  assert.equal(state.availableLamports, '0');
  await buyback.run(); assert.equal(f.sends.length, 0);
});

test('unknown balances cannot authorize transfers or spending', async t => {
  const f = await moneyFixture(t); await f.credit('fee'); f.balanceDown = true;
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true });
  assert.equal((await buyback.status()).availableLamports, '0');
  await buyback.run(); assert.equal(f.sends.length, 0);
});

test('wrong creator and absent dev key block before funding even when wallets are shared', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  f.creator = Keypair.generate().publicKey.toBase58();
  const buyback = f.makeBuyback();
  await assert.rejects(buyback.configure({ enabled: true }), /creation wallet/);
  assert.equal((await buyback.run({ force: true })).skipped, 'blocked');
  assert.equal((await f.makeBuyback({ signer: null }).run({ force: true })).skipped, 'not configured');
  assert.equal((await f.makeBuyback({ signer: f.treasury }).run({ force: true })).skipped, 'blocked');
  assert.equal(f.sends.length, 0);
});

test('main mint allocation cannot change after fees are recorded', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  await assert.rejects(f.makeBuyback().configure({ mainCoin: String(Keypair.generate().publicKey) }), /cannot change/);
});

test('receipt budgets survive more than 200 claims and restarts without counting duplicates', async t => {
  const f = await moneyFixture(t);
  for (let i = 0; i < 205; i++) await f.credit(`fee${i}`, { direct: 1_000_000n });
  await f.credit('fee0', { direct: 1_000_000n });
  assert.equal(f.makeBuyback().entitledLamports(), 205_000_000n);
});
