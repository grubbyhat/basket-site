import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { moneyFixture } from './money-fixture.js';
import { createSettlement } from './settlement.js';

test('metadata persistence failure cannot expose an uncommitted money journal in memory', async t => {
  const f = await moneyFixture(t);
  await f.store.setMeta('intent', { old: true });
  await rm(path.join(f.dir, 'meta'), { recursive: true });
  await assert.rejects(f.store.setMeta('intent', { broadcast: true }));
  assert.deepEqual(f.store.getMeta('intent'), { old: true });
  await mkdir(path.join(f.dir, 'meta'));
  await f.store.setMeta('intent', { retry: true });
  assert.deepEqual(f.store.getMeta('intent'), { retry: true });
});

test('a landed signature stays pending after blockhash expiry until metadata arrives', async t => {
  const f = await moneyFixture(t);
  await f.store.setMeta('pending', { signature: 'original', blockhash: 'original-hash' });
  const lane = createSettlement({ store: f.store, key: 'pending', connection: { async getTransaction() { return null; }, async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: null }] }; }, async isBlockhashValid() { throw new Error('must not expire a landed signature'); } } });
  assert.equal((await lane.execute({ settle() {} })).pending, true);
  assert.equal(lane.pending().signature, 'original');
});

test('finalized expiry releases an unseen signature without building another transaction in the same run', async t => {
  const f = await moneyFixture(t);
  await f.store.setMeta('pending', { signature: 'original', blockhash: 'original-hash' });
  const lane = createSettlement({ store: f.store, key: 'pending', connection: { async getTransaction() { return null; }, async getSignatureStatuses() { return { value: [null] }; }, async isBlockhashValid(hash, commitment) { assert.equal(hash, 'original-hash'); assert.equal(commitment, 'finalized'); return { value: false }; } } });
  const result = await lane.execute({ settle() {}, build() { throw new Error('must not build during recovery'); } });
  assert.equal(result.expired, true); assert.equal(lane.pending(), null);
});

test('a failed buy charges its network fee to the funded budget before another attempt', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true }); await buyback.run();
  const signature = 'failed-buy';
  const message = f.sends[0].transaction.message;
  const index = message.staticAccountKeys.findIndex(key => key.equals(f.signer.publicKey));
  const preBalances = message.staticAccountKeys.map(() => 1_000_000_000), postBalances = [...preBalances];
  postBalances[index] -= 5000;
  f.receipts.set(signature, { slot: 10, transaction: { message }, meta: { err: { InstructionError: [1, 'Custom'] }, fee: 5000, preBalances, postBalances } });
  await f.store.setMeta('buyback-pending', { signature, blockhash: message.recentBlockhash, context: { kind: 'buy', buyerAddress: String(f.signer.publicKey) } });
  assert.match((await buyback.run()).error, /failed on-chain/);
  assert.equal((await buyback.status()).spentLamports, '5000');
  assert.equal(f.store.getMeta('buyback-pending'), null);
});

test('the starting developer balance remains protected after outside spending', async t => {
  const f = await moneyFixture(t); await f.credit('fee');
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true }); await buyback.run();
  f.balances.set(String(f.signer.publicKey), 1_000_000_000n);
  assert.equal((await buyback.status()).protectedBuyerLamports, '1000000000');
  assert.equal((await buyback.run()).skipped, 'below minimum');
  assert.equal(f.sends.length, 1);
});
