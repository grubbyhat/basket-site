import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK, feeSharingConfigPda } from '@pump-fun/pump-sdk';
import { createFeeShareDetector, shareholdersOnRoute } from './detect.js';
import { openStore } from './store.js';

const silent = { info() {}, warn() {} };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir), mint = Keypair.generate().publicKey, github = Keypair.generate().publicKey;
  const config = feeSharingConfigPda(mint);
  const info = { owner: PUMP_FEE_PROGRAM_ID, data: await PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('sharingConfig', {
    bump: 1, version: 2, status: { active: {} }, mint, admin: Keypair.generate().publicKey,
    adminRevoked: true, shareholders: [{ address: github, shareBps: 10000 }],
  }) };
  let time = 0;
  const f = { dir, store, mint, github, config, info, launched: true, shared: true, visible: true, failAdopt: false, adoptions: [] };
  const connection = {
    async getTransaction() { return f.visible ? { meta: { err: null }, transaction: { message: { getAccountKeys: () => ({ length: 1, get: () => config }) } } } : null; },
    async getMultipleAccountsInfo(keys) { return keys.map(key => key.equals(mint) ? (f.launched ? { data: Buffer.alloc(0) } : null) : key.equals(config) && f.shared ? f.info : null); },
  };
  const service = { async adopt(input) {
    if (f.failAdopt) throw new Error('metadata RPC temporarily unavailable');
    f.adoptions.push(input);
    await store.create({ mint: input.mint, status: 'confirmed', route: { status: 'detected' } });
  } };
  f.advance = () => { time += 60_000; };
  f.make = (overrides = {}) => createFeeShareDetector({ connection, store, service, allowed: () => [github], now: () => time, log: silent, ...overrides });
  return f;
}

test('a config counts as Route only when every shareholder is one of Route’s addresses', () => {
  const github = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  const config = list => ({ shareholders: list.map(([address, shareBps]) => ({ address, shareBps })) });
  assert.equal(shareholdersOnRoute(config([[github, 9500], [treasury, 500]]), [treasury, github]), true);
  assert.equal(shareholdersOnRoute(config([[treasury, 10000]]), [treasury, github]), true);
  assert.equal(shareholdersOnRoute(config([[github, 9500], [other, 500]]), [treasury, github]), false);
  assert.equal(shareholdersOnRoute(config([]), [treasury, github]), false);
  assert.equal(shareholdersOnRoute(config([[github, 10000]]), []), false);
  assert.equal(shareholdersOnRoute(null, [treasury]), false);
  assert.ok(new PublicKey(github.toBase58()).equals(github));
});

test('the saved main coin is adopted with 100% GitHub sharing even when no launch event was observed', async t => {
  const f = await fixture(t), detector = f.make({ mainCoin: () => String(f.mint) });
  f.launched = false; f.shared = false;
  await detector.reconcile(); assert.equal(detector.summary().main.status, 'waiting-for-launch');
  f.launched = true;
  await detector.reconcile(); assert.equal(detector.summary().main.status, 'waiting-for-fee-sharing');
  f.shared = true;
  await detector.reconcile(); assert.equal(detector.summary().main.status, 'registered');
  await detector.reconcile(); assert.equal(f.adoptions.length, 1);
  assert.equal(f.adoptions[0].source, 'main-token');
});

test('delayed transaction metadata stays queued across restart and duplicate notifications adopt only once', async t => {
  const f = await fixture(t), first = f.make();
  f.visible = false;
  await Promise.all([first.inspectSignature('signature'), first.inspectSignature('signature')]);
  assert.equal(first.summary().pending, 1); assert.equal(f.adoptions.length, 0);
  const restored = await openStore(f.dir), second = f.make({ store: restored });
  f.visible = true; f.advance();
  await second.reconcile();
  assert.equal(second.summary().pending, 0); assert.equal(f.adoptions.length, 1);
  await second.inspectSignature('signature'); assert.equal(f.adoptions.length, 1);
});

test('an adoption error is retried instead of marking the sharing signature permanently seen', async t => {
  const f = await fixture(t), detector = f.make();
  f.failAdopt = true; await detector.inspectSignature('signature');
  assert.equal(detector.summary().pending, 1);
  f.failAdopt = false; f.advance(); await detector.reconcile();
  assert.equal(detector.summary().pending, 0); assert.equal(f.adoptions.length, 1);
});

test('main discovery rejects a fee-sharing config owned by another program', async t => {
  const f = await fixture(t), detector = f.make({ mainCoin: () => String(f.mint) });
  f.info = { ...f.info, owner: Keypair.generate().publicKey };
  await detector.reconcile();
  assert.equal(detector.summary().main.status, 'error'); assert.equal(f.adoptions.length, 0);
});

test('a config missing from an otherwise successful RPC read remains queued', async t => {
  const f = await fixture(t), detector = f.make();
  f.shared = false; await detector.inspectSignature('signature');
  assert.equal(detector.summary().pending, 1);
  f.shared = true; f.advance(); await detector.reconcile();
  assert.equal(f.adoptions.length, 1); assert.equal(detector.summary().pending, 0);
});
