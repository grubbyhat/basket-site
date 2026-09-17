import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from './store.js';
import { createFeeLedger } from './fee-ledger.js';
import { moneyFixture } from './money-fixture.js';

test('fee-sharing receipts fund the creator wallet; only forwarded fees buy the exact main token', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true });
  assert.equal((await buyback.status()).availableLamports, '0', 'old developer SOL is not buyback money');
  await buyback.run();
  assert.equal((await buyback.status()).forwardedLamports, '300000000');
  assert.equal(f.sends[0].transaction.message.staticAccountKeys[0].toBase58(), String(f.treasury.publicKey));
  await buyback.run();
  assert.equal(f.sends[1].transaction.message.staticAccountKeys[0].toBase58(), String(f.signer.publicKey));
  const state = await buyback.status();
  assert.equal(state.purchases[0].tokens, '42', 'unrelated token balance is excluded');
  assert.ok(BigInt(state.spentLamports) <= 300_000_000n);
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n, 'existing developer money remains');
  for (let i = 0; i < 2; i++) assert.equal(f.confirmations[i].blockhash, f.sends[i].transaction.message.recentBlockhash);
});

test('a timeout after transfer acceptance survives restart and never forwards twice', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  const first = f.makeBuyback(); await first.configure({ enabled: true });
  f.failSend = true; f.visible = false;
  assert.equal((await first.run()).pending, true);
  assert.equal(f.sends.length, 1);
  assert.equal((await first.status()).forwardedLamports, '0');
  await assert.rejects(first.configure({ mainCoin: '' }), /still being settled/);
  const restored = await openStore(f.dir);
  const again = f.makeBuyback({ store: restored, feeLedger: createFeeLedger({ store: restored }) });
  assert.equal((await again.run()).pending, true); assert.equal(f.sends.length, 1);
  f.visible = true;
  assert.equal((await again.run()).settled, true);
  assert.equal((await again.status()).forwardedLamports, '300000000'); assert.equal(f.sends.length, 1);
});

test('a buy accepted before timeout is reconciled once, with no backup send', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true }); await buyback.run();
  f.failSend = true; f.visible = false;
  assert.equal((await buyback.run()).pending, true);
  await buyback.run(); assert.equal(f.sends.length, 2);
  f.visible = true; await buyback.run();
  assert.equal((await buyback.status()).purchases.length, 1); assert.equal(f.sends.length, 2);
});

test('an unfunded developer wallet cannot spend its own SOL when the treasury is empty', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  f.balances.set(String(f.treasury.publicKey), 0n);
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true });
  assert.equal((await buyback.run()).skipped, 'below minimum'); assert.equal(f.sends.length, 0);
});
