import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openStore } from './store.js';

test('launch records persist atomically and survive a reopen', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: 'Mint1', status: 'prepared', wallet: 'W1', recipients: [{ xId: '1' }], createdAt: '2026-09-17T10:00:00.000Z' });
  await store.create({ mint: 'Mint2', status: 'prepared', wallet: 'W2', recipients: [{ xId: '1' }, { xId: '2' }], createdAt: '2026-09-17T11:00:00.000Z' });
  await assert.rejects(store.create({ mint: 'Mint1' }), /already exists/);
  await Promise.all([store.update('Mint1', { status: 'sent' }), store.update('Mint1', { status: 'confirmed', signature: 'sig' })]);
  assert.equal(store.get('Mint1').status, 'confirmed');
  assert.deepEqual(store.list().map(record => record.mint), ['Mint2', 'Mint1']);
  assert.deepEqual(store.list({ wallet: 'W2' }).map(record => record.mint), ['Mint2']);
  assert.deepEqual(store.list({ status: 'confirmed' }).map(record => record.mint), ['Mint1']);
  assert.deepEqual(store.stats(), { coins: 1, launched: 1, registered: 0, routed: 0, recipients: 1, collectedLamports: '0', paidOutCents: 0, payments: 0 });
  const onDisk = JSON.parse(await readFile(path.join(dir, 'launches', 'Mint1.json'), 'utf8'));
  assert.equal(onDisk.signature, 'sig');
  const reopened = await openStore(dir);
  assert.equal(reopened.get('Mint2').wallet, 'W2');
  assert.equal(reopened.get('Mint1').status, 'confirmed');
});
