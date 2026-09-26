import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('failed record writes do not publish a registration and can be retried', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-store-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: 'Existing', status: 'prepared' });
  // An existing directory at a record filename forces the final rename to fail.
  await mkdir(path.join(dir, 'launches', 'New.json'));
  await assert.rejects(store.create({ mint: 'New', status: 'confirmed' }));
  assert.equal(store.get('New'), null);
  await rm(path.join(dir, 'launches', 'New.json'), { recursive: true });
  await store.create({ mint: 'New', status: 'confirmed' });
  await rm(path.join(dir, 'launches', 'Existing.json'));
  await mkdir(path.join(dir, 'launches', 'Existing.json'));
  await assert.rejects(store.update('Existing', { status: 'confirmed' }));
  assert.equal(store.get('Existing').status, 'prepared');
});

test('a removed coin moves to removed/, stays out after a reopen and cannot be recreated', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-store-remove-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: 'Gone', status: 'confirmed', fees: { distributedLamports: '5' } });
  await store.create({ mint: 'Kept', status: 'confirmed' });
  await store.remove('Gone');
  assert.equal(store.get('Gone'), null);
  assert.equal(store.isRemoved('Gone'), true);
  assert.deepEqual(store.list().map(record => record.mint), ['Kept']);
  assert.equal(store.stats().collectedLamports, '0');
  await assert.rejects(store.create({ mint: 'Gone' }), /was removed/);
  await assert.rejects(store.update('Gone', { status: 'sent' }), /missing/);
  await assert.rejects(store.remove('Nope'), /missing/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'removed', 'Gone.json'), 'utf8')).fees.distributedLamports, '5');
  const reopened = await openStore(dir);
  assert.equal(reopened.get('Gone'), null);
  assert.equal(reopened.isRemoved('Gone'), true);
  assert.equal(reopened.get('Kept').status, 'confirmed');
});
