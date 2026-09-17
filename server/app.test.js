import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createApp } from './app.js';
import { saveTokenMedia } from './media.js';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { PNG_1X1, validBody } from './validate.test.js';

const profiles = { jack: { id: '12', handle: 'jack', name: 'jack', avatarUrl: 'https://pbs.twimg.com/p/a_400x400.jpg' }, elonmusk: { id: '44196397', handle: 'elonmusk', name: 'Elon Musk', avatarUrl: 'https://pbs.twimg.com/p/b_400x400.jpg' } };
const treasury = Keypair.generate().publicKey;

async function start(t, { engine } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-app-'));
  const distDir = path.join(dir, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Route</title>');
  const store = await openStore(dir);
  const xLookup = { lookup: async handle => (handle === 'down' ? Promise.reject(new Error('X lookup failed (503)')) : profiles[handle] || null) };
  const fakeEngine = engine || {
    devBuysEnabled: false,
    newMint: () => Keypair.generate(),
    async build({ mint }) { return { mint: mint.publicKey.toBase58(), transaction: 'dHg=', message: 'bXNn', blockhash: 'hash', lastValidBlockHeight: 10, size: 941, unitsConsumed: 100 }; },
    verifySigned({ signedTransaction, message }) { if (message !== 'bXNn' || signedTransaction !== 'c2lnbmVk') throw Object.assign(new Error('The signed transaction does not match the prepared launch.'), { status: 400 }); return { message: { staticAccountKeys: [{ toBase58: () => 'Signer' }] }, serialize: () => new Uint8Array() }; },
    async send() { return 'Sig111'; },
    async confirm() { return { status: 'confirmed', slot: 5 }; },
  };
  const service = createLaunchService({ store, engine: fakeEngine, xLookup, dataDir: dir, origin: 'http://route.test', treasury, log: { info() {}, warn() {}, error() {} } });
  const app = createApp({ store, service, xLookup, engine: fakeEngine, dataDir: dir, distDir, origin: 'http://route.test', treasury, log: { info() {}, warn() {}, error() {} } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: type.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  return { call, store, dir, origin };
}

test('health, stats, X lookups and the SPA fallback', async t => {
  const { call } = await start(t);
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.treasury, treasury.toBase58());
  assert.equal(health.body.devBuys, false);
  assert.equal(health.body.launched, 0);
  const jack = await call('/api/x/@Jack');
  assert.equal(jack.status, 200);
  assert.equal(jack.body.id, '12');
  assert.equal((await call('/api/x/nobody')).status, 404);
  assert.equal((await call('/api/x/not%20valid')).status, 400);
  assert.equal((await call('/api/x/down')).status, 502);
  assert.equal((await call('/api/missing')).status, 404);
  const page = await call('/launch');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Route<\/title>/);
});

test('prepare verifies recipients, hosts metadata, and send records the outcome', async t => {
  const { call, store } = await start(t);
  const body = validBody();
  const missing = await call('/api/launch/prepare', { method: 'POST', body: JSON.stringify({ ...body, recipients: [{ handle: 'jack', basisPoints: 5000 }, { handle: 'ghost', basisPoints: 5000 }] }) });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.field, 'handle-1');
  assert.match(missing.body.error, /@ghost/);
  const outage = await call('/api/launch/prepare', { method: 'POST', body: JSON.stringify({ ...body, recipients: [{ handle: 'down', basisPoints: 10000 }] }) });
  assert.equal(outage.status, 502);
  const invalid = await call('/api/launch/prepare', { method: 'POST', body: JSON.stringify({ ...body, symbol: 'bad ticker' }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.field, 'ticker');

  const prepared = await call('/api/launch/prepare', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.transaction, 'dHg=');
  const { mint } = prepared.body;
  const record = store.get(mint);
  assert.equal(record.status, 'prepared');
  assert.deepEqual(record.recipients.map(r => [r.handle, r.xId, r.basisPoints]), [['jack', '12', 6000], ['elonmusk', '44196397', 4000]]);
  assert.equal(record.creator, treasury.toBase58());
  assert.equal(record.metadataUri, `http://route.test/m/${mint}.json`);
  const metadata = await call(`/m/${mint}.json`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get('access-control-allow-origin'), '*');
  assert.equal(metadata.body.name, 'Route Coin');
  assert.equal(metadata.body.image, `http://route.test/i/${mint}.png`);
  assert.deepEqual(metadata.body.route.recipients[0], { x: 'jack', xId: '12', basisPoints: 6000 });
  const hosted = await call(`/i/${mint}.png`);
  assert.equal(hosted.status, 200);
  assert.equal(hosted.headers.get('content-type'), 'image/png');

  const publicView = await call(`/api/launch/${mint}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.message, undefined, 'internal fields stay private');
  assert.equal(publicView.body.pumpUrl, `https://pump.fun/coin/${mint}`);

  const mismatch = await call('/api/launch/send', { method: 'POST', body: JSON.stringify({ mint, signedTransaction: 'd3Jvbmc=' }) });
  assert.equal(mismatch.status, 400);
  assert.equal(store.get(mint).status, 'prepared');
  const sent = await call('/api/launch/send', { method: 'POST', body: JSON.stringify({ mint, signedTransaction: 'c2lnbmVk' }) });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.signature, 'Sig111');
  const again = await call('/api/launch/send', { method: 'POST', body: JSON.stringify({ mint, signedTransaction: 'c2lnbmVk' }) });
  assert.equal(again.status, 409);
  for (let i = 0; i < 50 && store.get(mint).status !== 'confirmed'; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.get(mint).status, 'confirmed');
  assert.equal(store.get(mint).slot, 5);
  const list = await call('/api/launches');
  assert.equal(list.body.launches.length, 1);
  assert.equal(list.body.launches[0].mint, mint);
  assert.equal((await call('/api/stats')).body.launched, 1);
  assert.equal((await call('/api/stats')).body.recipients, 2);
});

test('a rejected broadcast fails the record and explains itself', async t => {
  const engine = {
    devBuysEnabled: false, newMint: () => Keypair.generate(),
    async build({ mint }) { return { mint: mint.publicKey.toBase58(), transaction: 'dHg=', message: 'bXNn', blockhash: 'hash', lastValidBlockHeight: 10, size: 941, unitsConsumed: 100 }; },
    verifySigned() { return { message: { staticAccountKeys: [{ toBase58: () => 'Signer' }] }, serialize: () => new Uint8Array() }; },
    async send() { const error = new Error('Simulation failed.'); error.transactionMessage = 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'; error.transactionLogs = []; throw error; },
    async confirm() { return { status: 'unknown' }; },
  };
  const { call, store } = await start(t, { engine });
  const prepared = await call('/api/launch/prepare', { method: 'POST', body: JSON.stringify(validBody({ image: PNG_1X1 })) });
  const sent = await call('/api/launch/send', { method: 'POST', body: JSON.stringify({ mint: prepared.body.mint, signedTransaction: 'c2lnbmVk' }) });
  assert.equal(sent.status, 502);
  assert.match(sent.body.error, /more SOL/);
  assert.equal(store.get(prepared.body.mint).status, 'failed');
  assert.deepEqual((await call('/api/launches')).body.launches, []);
});
