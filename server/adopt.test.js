// The launcher contract: a coin whose fee sharing already points at Route is
// registered by POST /api/route/prepare answering `already: true`, whether Route's
// detector saw the coin first or not, and re-registration sets the recipients.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK, feeSharingConfigPda } from '@pump-fun/pump-sdk';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { account, offlineConnection, pumpCoin } from './fixtures.js';
import { decodeCurve } from './pump.js';

const silent = { info() {}, warn() {}, error() {} };
const profiles = { jack: { id: '12', handle: 'jack', name: 'jack', avatarUrl: '' }, elonmusk: { id: '44196397', handle: 'elonmusk', name: 'Elon Musk', avatarUrl: '' } };

// A sharing config account for the fixture coin, encoded with the fee program's own coder.
async function sharingConfigAccount({ mint, admin, shareholders }) {
  const data = await PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('sharingConfig', {
    bump: 255, version: 2, status: { active: {} }, mint, admin, adminRevoked: true,
    shareholders: shareholders.map(([address, shareBps]) => ({ address, shareBps })),
  });
  return { owner: PUMP_FEE_PROGRAM_ID, data: Buffer.from(data), executable: false, lamports: 1, rentEpoch: 0 };
}

test('a coin already routed on-chain registers with already:true, and a detected coin keeps working for the launcher', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-adopt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const treasury = Keypair.generate().publicKey;
  const github = Keypair.generate().publicKey;
  const mint = new PublicKey(pumpCoin.mint.address);
  const creator = decodeCurve(account(pumpCoin.bondingCurve)).creator;
  let configAccount;
  try { configAccount = await sharingConfigAccount({ mint, admin: creator, shareholders: [[github, 9500], [treasury, 500]] }); }
  catch (error) { t.skip(`sharing config encoding unavailable: ${error.message}`); return; }
  const connection = offlineConnection({ extra: { [feeSharingConfigPda(mint).toBase58()]: configAccount } });
  const store = await openStore(dir);
  const engine = { shareholder: github, shareholders: [{ address: github, shareBps: 9500 }, { address: treasury, shareBps: 500 }], allowedShareholders: [treasury, github], newMint: () => Keypair.generate(), async buildRoute() { throw new Error('must not build'); } };
  const tracked = [];
  const service = createLaunchService({ store, engine, xLookup: { lookup: async handle => profiles[handle] || null }, dataDir: dir, origin: 'http://route.test', treasury, watcher: { track: async m => { tracked.push(m); }, get: () => null, all: () => [], size: () => 0, on: () => () => {}, refresh: async () => null }, connection, log: silent });

  // Detector first: no recipients yet.
  const detected = await service.adopt({ mint: mint.toBase58(), recipients: [], source: 'detected', signature: 'DetectSig' });
  assert.equal(detected.route.status, 'detected');
  assert.deepEqual(detected.recipients, []);
  assert.equal(detected.wallet, creator.toBase58());
  assert.deepEqual(detected.shares, { treasuryBps: 500, othersBps: 9500 });

  // The launcher registers with the recipients: instant, no transaction, already:true.
  const strangers = await service.prepareRoute({ mint: mint.toBase58(), wallet: Keypair.generate().publicKey.toBase58(), recipients: [{ handle: 'jack', basisPoints: 10000 }] }).catch(error => error);
  assert.equal(strangers.status, 403);
  const registered = await service.prepareRoute({ mint: mint.toBase58(), wallet: creator.toBase58(), recipients: [{ handle: 'jack', basisPoints: 6000 }, { handle: 'elonmusk', basisPoints: 4000 }] });
  assert.equal(registered.already, true);
  assert.deepEqual(registered.transactions, []);
  assert.equal(registered.record.route.status, 'active');
  assert.deepEqual(registered.record.recipients.map(r => [r.handle, r.basisPoints, r.xId]), [['jack', 6000, '12'], ['elonmusk', 4000, '44196397']]);
  assert.equal(registered.record.route.signature, 'DetectSig');

  // Registering again with new recipients updates them; the public view matches the launcher's check.
  const again = await service.prepareRoute({ mint: mint.toBase58(), wallet: creator.toBase58(), recipients: [{ handle: 'jack', basisPoints: 10000 }] });
  assert.equal(again.already, true);
  assert.deepEqual(service.coin(mint.toBase58()).recipients.map(r => r.handle), ['jack']);
  assert.equal(service.coin(mint.toBase58()).wallet, creator.toBase58());
  assert.equal(store.stats().routed, 1);
  assert.ok(tracked.length >= 1);

  // A fresh coin (no record) with a route on-chain registers the same way.
  const fresh = await openStore(await mkdtemp(path.join(os.tmpdir(), 'route-adopt2-')));
  const service2 = createLaunchService({ store: fresh, engine, xLookup: { lookup: async handle => profiles[handle] || null }, dataDir: dir, origin: 'http://route.test', treasury, watcher: null, connection, log: silent });
  const first = await service2.prepareRoute({ mint: mint.toBase58(), wallet: creator.toBase58(), recipients: [{ handle: 'jack', basisPoints: 10000 }] });
  assert.equal(first.already, true);
  assert.equal(first.record.route.status, 'active');
  assert.equal(first.record.kind, 'registered');
});

test('wallet-only routing keeps the recipient pool visible and allocates the main coin entirely to buybacks', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-wallet-adopt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const treasury = Keypair.generate().publicKey, mint = new PublicKey(pumpCoin.mint.address);
  const creator = decodeCurve(account(pumpCoin.bondingCurve)).creator;
  const configAccount = await sharingConfigAccount({ mint, admin: creator, shareholders: [[treasury, 10000]] });
  const connection = offlineConnection({ extra: { [feeSharingConfigPda(mint).toBase58()]: configAccount } });
  const store = await openStore(dir);
  let mainMint = null;
  const service = createLaunchService({ store, engine: { shareholder: treasury, allowedShareholders: [treasury] }, xLookup: { lookup: async handle => profiles[handle] }, dataDir: dir, origin: 'http://route.test', treasury, connection, log: silent, mainCoin: () => mainMint, buybackShareBps: 500 });
  const other = await service.adopt({ mint: String(mint), recipients: [{ handle: 'jack', basisPoints: 10000 }] });
  assert.deepEqual(other.shares, { treasuryBps: 500, othersBps: 9500 });
  mainMint = String(mint);
  const main = await service.adopt({ mint: String(mint) });
  assert.deepEqual(main.shares, { treasuryBps: 10000, othersBps: 0 });
});
