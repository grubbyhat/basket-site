import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createApp } from './app.js';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { PNG_1X1, validBody } from './validate.test.js';
import { account, offlineConnection, pumpCoin } from './fixtures.js';
import { decodeCurve } from './pump.js';

const profiles = { jack: { id: '12', handle: 'jack', name: 'jack', avatarUrl: 'https://pbs.twimg.com/p/a_400x400.jpg' }, elonmusk: { id: '44196397', handle: 'elonmusk', name: 'Elon Musk', avatarUrl: 'https://pbs.twimg.com/p/b_400x400.jpg' } };
const treasury = Keypair.generate().publicKey;
const silent = { info() {}, warn() {}, error() {} };
const packed = (transaction, message, size) => ({ transaction, message, size });

function fakeEngine(overrides = {}) {
  const sent = [];
  return {
    sent,
    devBuysEnabled: true,
    newMint: () => Keypair.generate(),
    async build({ mint }) { return { mint: mint.publicKey.toBase58(), create: packed('dHg=', 'bXNn', 941), route: packed('cnQ=', 'cm91dGU=', 812), blockhash: 'hash', lastValidBlockHeight: 10, unitsConsumed: 100 }; },
    async buildRoute() { return { ...packed('cnQ=', 'cm91dGU=', 812), blockhash: 'hash', lastValidBlockHeight: 10, unitsConsumed: 150 }; },
    verifySigned({ signedTransaction, message }) {
      const expected = { bXNn: 'c2lnbmVk', 'cm91dGU=': 'c2lnbmVkMg==' }[message];
      if (!expected || signedTransaction !== expected) throw Object.assign(new Error('The signed transaction does not match the prepared one.'), { status: 400 });
      return { message: { staticAccountKeys: [{ toBase58: () => 'Signer' }] }, serialize: () => Buffer.from(signedTransaction) };
    },
    async send(signed) { sent.push(signed.serialize().toString()); return `Sig${sent.length}`; },
    async confirm() { return { status: 'confirmed', slot: 5 }; },
    ...overrides,
  };
}

async function start(t, { engine = fakeEngine(), connection = offlineConnection() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-app-'));
  const distDir = path.join(dir, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Route</title>');
  const store = await openStore(dir);
  const xLookup = { lookup: async handle => (handle === 'down' ? Promise.reject(new Error('X lookup failed (503)')) : profiles[handle] || null) };
  const tracked = [];
  const watcher = { track: async mint => { tracked.push(mint); }, get: () => null, all: () => [], size: () => 0, on: () => () => {}, refresh: async () => null };
  const service = createLaunchService({ store, engine, xLookup, dataDir: dir, origin: 'http://route.test', treasury, watcher, connection, log: silent });
  const app = createApp({ store, service, xLookup, engine, dataDir: dir, distDir, origin: 'http://route.test', treasury, watcher, adminToken: 'secret', log: silent });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: type.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  const post = (route, body, headers) => call(route, { method: 'POST', body: JSON.stringify(body), headers });
  const until = async (predicate, tries = 100) => { for (let i = 0; i < tries && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 20)); };
  return { call, post, until, store, tracked, engine };
}

test('health, stats, X lookups and the SPA fallback', async t => {
  const { call } = await start(t);
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.treasury, treasury.toBase58());
  assert.equal(health.body.devBuys, true);
  assert.equal(health.body.coins, 0);
  const jack = await call('/api/x/@Jack');
  assert.equal(jack.status, 200);
  assert.equal(jack.body.id, '12');
  assert.equal((await call('/api/x/nobody')).status, 404);
  assert.equal((await call('/api/x/not%20valid')).status, 400);
  assert.equal((await call('/api/x/down')).status, 502);
  assert.equal((await call('/api/missing')).status, 404);
  assert.equal((await call('/api/coins')).body.coins.length, 0);
  const page = await call('/launch');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Route<\/title>/);
});

test('launch metadata fixes the Route token-page website and preserves any chosen X profile or post', async t => {
  const { call, post } = await start(t);
  const twitter = 'https://x.com/a_different_project/status/123456789';
  const prepared = await post('/api/launch/prepare', { ...validBody(), twitter, website: 'https://different.example/' });
  assert.equal(prepared.status, 200);
  const metadata = await call(`/m/${prepared.body.mint}.json`);
  assert.equal(metadata.body.website, `http://route.test/coin/${prepared.body.mint}`);
  assert.equal(metadata.body.twitter, twitter);
});

test('a launch is two signed transactions: the coin, then its fee route', async t => {
  const { call, post, until, store, tracked, engine } = await start(t);
  const body = validBody();
  const missing = await post('/api/launch/prepare', { ...body, recipients: [{ handle: 'jack', basisPoints: 5000 }, { handle: 'ghost', basisPoints: 5000 }] });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.field, 'handle-1');
  assert.equal((await post('/api/launch/prepare', { ...body, recipients: [{ handle: 'down', basisPoints: 10000 }] })).status, 502);
  assert.equal((await post('/api/launch/prepare', { ...body, symbol: 'bad ticker' })).body.field, 'ticker');

  const prepared = await post('/api/launch/prepare', body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.deepEqual(prepared.body.transactions, ['dHg=', 'cnQ=']);
  const { mint } = prepared.body;
  const record = store.get(mint);
  assert.equal(record.status, 'prepared');
  assert.equal(record.kind, 'launch');
  assert.equal(record.route.status, 'pending');
  assert.deepEqual(record.recipients.map(r => [r.handle, r.xId, r.basisPoints]), [['jack', '12', 6000], ['elonmusk', '44196397', 4000]]);
  assert.equal(record.metadataUri, `http://route.test/m/${mint.slice(0, 12)}`, 'the on-chain URI is the short form');
  assert.equal(record.website, `http://route.test/coin/${mint}`);
  const short = await call(`/m/${mint.slice(0, 12)}`);
  assert.equal(short.status, 200);
  assert.equal(short.body.website, `http://route.test/coin/${mint}`, 'metadata links back to the coin page');
  assert.equal(short.body.twitter, 'https://x.com/jack', 'the X link defaults to the first recipient');
  const metadata = await call(`/m/${mint}.json`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get('access-control-allow-origin'), '*');
  assert.equal(metadata.body.image, `http://route.test/i/${mint}.png`);
  assert.deepEqual(metadata.body.route.recipients[0], { x: 'jack', xId: '12', basisPoints: 6000 });
  assert.equal((await call(`/i/${mint}.png`)).headers.get('content-type'), 'image/png');
  const publicView = await call(`/api/launch/${mint}`);
  assert.equal(publicView.body.messages, undefined, 'internal fields stay private');
  assert.equal(publicView.body.pumpUrl, `https://pump.fun/coin/${mint}`);

  assert.equal((await post('/api/launch/send', { mint, signedTransactions: ['c2lnbmVk'] })).status, 400, 'both signatures are required');
  assert.equal((await post('/api/launch/send', { mint, signedTransactions: ['c2lnbmVk', 'd3Jvbmc='] })).status, 400, 'the route must match too');
  assert.equal(store.get(mint).status, 'prepared');
  const sent = await post('/api/launch/send', { mint, signedTransactions: ['c2lnbmVk', 'c2lnbmVkMg=='] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.signature, 'Sig1');
  assert.equal((await post('/api/launch/send', { mint, signedTransactions: ['c2lnbmVk', 'c2lnbmVkMg=='] })).status, 409);
  await until(() => store.get(mint).route?.status === 'active');
  assert.equal(store.get(mint).status, 'confirmed');
  assert.equal(store.get(mint).route.signature, 'Sig2');
  assert.deepEqual(engine.sent, ['c2lnbmVk', 'c2lnbmVkMg=='], 'create was broadcast before the route');
  assert.deepEqual([...new Set(tracked)], [mint], 'the watcher follows the coin');
  const coins = await call('/api/coins');
  assert.equal(coins.body.coins[0].mint, mint);
  assert.equal(coins.body.coins[0].route.status, 'active');
  assert.equal((await call('/api/stats')).body.coins, 1);
  assert.equal((await call('/api/stats')).body.routed, 1);
});

test('a failed route leaves the coin live and lets the creator finish it later', async t => {
  let calls = 0;
  const engine = fakeEngine({ async send(signed) { calls += 1; if (calls === 2) { const error = new Error('Simulation failed.'); error.transactionMessage = 'Transaction simulation failed: Blockhash not found'; throw error; } return `Sig${calls}`; } });
  const { post, until, store, call } = await start(t, { engine });
  const body = validBody();
  const { body: { mint } } = await post('/api/launch/prepare', body);
  await post('/api/launch/send', { mint, signedTransactions: ['c2lnbmVk', 'c2lnbmVkMg=='] });
  await until(() => store.get(mint).route?.status === 'failed');
  assert.equal(store.get(mint).status, 'confirmed');
  assert.match(store.get(mint).route.friendly, /expired/);
  assert.equal((await call(`/api/coin/${mint}`)).body.coin.route.status, 'failed');
  // The creator finishes the route through the registration endpoints; the coin is not a real
  // pump coin in this offline test, so inspection stops at the chain read.
  const denied = await post('/api/route/prepare', { mint, wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(denied.status, 403);
  const retry = await post('/api/route/prepare', { mint, wallet: body.wallet });
  assert.equal(retry.status, 404, 'a coin missing on-chain cannot be re-routed');
});

test('registering an existing pump.fun coin needs its creator and one signature', async t => {
  const creator = decodeCurve(account(pumpCoin.bondingCurve)).creator.toBase58();
  const { post, until, store, call, tracked } = await start(t);
  const mint = pumpCoin.mint.address;
  const inspect = await call(`/api/coin/${mint}/inspect`);
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body.symbol, '$CAT');
  assert.equal(inspect.body.creator, creator);
  assert.equal(inspect.body.registrable, true);
  assert.equal(inspect.body.record, null);
  assert.equal((await call('/api/coin/notamint/inspect')).status, 400);
  const stranger = await post('/api/route/prepare', { mint, wallet: Keypair.generate().publicKey.toBase58(), recipients: [{ handle: 'jack', basisPoints: 10000 }] });
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error, /wallet that created/);
  const prepared = await post('/api/route/prepare', { mint, wallet: creator, recipients: [{ handle: 'jack', basisPoints: 10000 }] });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.deepEqual(prepared.body.transactions, ['cnQ=']);
  const record = store.get(mint);
  assert.equal(record.kind, 'registered');
  assert.equal(record.status, 'prepared');
  assert.equal(record.name, 'CATECOIN');
  assert.equal((await post('/api/route/send', { mint, signedTransaction: 'd3Jvbmc=' })).status, 400);
  const sent = await post('/api/route/send', { mint, signedTransaction: 'c2lnbmVkMg==' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await until(() => store.get(mint).route?.status === 'active');
  assert.equal(store.get(mint).status, 'confirmed');
  assert.equal(store.get(mint).signature, 'Sig1');
  assert.deepEqual(tracked, [mint]);
  assert.equal((await call('/api/coins')).body.coins[0].kind, 'registered');
  assert.equal((await call(`/api/coin/${mint}/inspect`)).body.record.route.status, 'active');
  assert.equal((await post('/api/route/prepare', { mint, wallet: creator })).status, 409, 'already on Route');
  assert.equal((await call('/api/stats')).body.registered, 1);
});

test('admin fee collection is token-gated and reports when it is not configured', async t => {
  const { post, call } = await start(t);
  assert.equal((await post('/api/admin/collect/abc', {})).status, 403);
  assert.equal((await post('/api/admin/collect/abc', {}, { 'x-route-admin': 'secret' })).status, 503);
  assert.equal((await call('/api/admin/status')).status, 403);
  const status = await call('/api/admin/status', { headers: { 'x-route-admin': 'secret' } });
  assert.equal(status.status, 200);
  assert.equal(status.body.treasury, treasury.toBase58());
  assert.equal(status.body.buyback, null);
  assert.equal((await post('/api/admin/buyback', { enabled: true }, { 'x-route-admin': 'secret' })).status, 503);
});

test('a rejected broadcast fails the record and explains itself', async t => {
  const engine = fakeEngine({ async send() { const error = new Error('Simulation failed.'); error.transactionMessage = 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'; error.transactionLogs = []; throw error; } });
  const { post, store, call } = await start(t, { engine });
  const prepared = await post('/api/launch/prepare', validBody({ image: PNG_1X1 }));
  const sent = await post('/api/launch/send', { mint: prepared.body.mint, signedTransactions: ['c2lnbmVk', 'c2lnbmVkMg=='] });
  assert.equal(sent.status, 502);
  assert.match(sent.body.error, /more SOL/);
  assert.equal(store.get(prepared.body.mint).status, 'failed');
  assert.deepEqual((await call('/api/coins')).body.coins, []);
});
