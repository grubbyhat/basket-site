import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { createPriceFeed } from './price.js';
import { openStore } from './store.js';
import { createCoinWatcher } from './watch.js';
import { account, offlineConnection, pumpCoin, pumpState } from './fixtures.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';

const mint = pumpCoin.mint.address;
const log = { info() {}, warn() {}, error() {} };

test('a tracked coin reports market cap, bonding progress and vault fees, then pushes updates', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint, status: 'confirmed', fees: { distributedLamports: '50000000', claims: [] } });
  const connection = offlineConnection({ vaultLamports: 890_880 + 30_000_000 });
  const price = createPriceFeed({ fetchImpl: async () => ({ json: async () => ({ result: { SOLUSD: { c: ['100.0'] } } }) }), log });
  await price.refresh();
  const global = PUMP_SDK.decodeGlobal(account(pumpState.global));
  const watcher = createCoinWatcher({ connection, store, pumpState: async () => ({ global }), price, log });
  const events = [];
  watcher.on(event => events.push(event));
  await watcher.track(mint);
  const state = watcher.get(mint);
  assert.equal(state.phase, 'bonding');
  assert.equal(state.bonded, false);
  assert.ok(state.mcapSol > 1 && state.mcapUsd > 100, `mcap ${state.mcapSol} SOL / $${state.mcapUsd}`);
  assert.equal(state.unclaimedSol, 0.03, 'rent is not counted as fees');
  assert.equal(state.collectedSol, 0.05);
  assert.equal(state.feesSol, 0.08);
  assert.equal(state.feesUsd, 8);
  assert.equal(connection.subscriptions.size, 2, 'curve + vault subscriptions');
  connection.push(pumpCoin.vault.address, { lamports: 890_880 + 120_000_000, data: Buffer.alloc(0), owner: new PublicKey('11111111111111111111111111111111') });
  assert.equal(events.at(-1).type, 'vault');
  assert.equal(events.at(-1).coin.unclaimedLamports, '120000000');
  assert.equal(watcher.all().length, 1);
  await watcher.untrack(mint);
  assert.equal(connection.subscriptions.size, 0);
  assert.equal(watcher.get(mint), null);
});

test('the price feed keeps the last good value when Kraken fails', async () => {
  let fail = false;
  const price = createPriceFeed({ fetchImpl: async () => { if (fail) throw new Error('down'); return { json: async () => ({ result: { SOLUSD: { c: ['101.23'] } } }) }; }, log });
  assert.equal(price.get().usd, null);
  await price.refresh();
  assert.equal(price.get().usd, 101.23);
  fail = true;
  await price.refresh();
  assert.equal(price.get().usd, 101.23);
});
