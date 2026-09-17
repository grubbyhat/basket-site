import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createCollector } from './collector.js';

const silent = { info() {}, warn() {}, error() {} };

test('the collector schedules due coins from vault events and from the periodic sweep', async () => {
  const listeners = new Set();
  let coins = [{ mint: 'A', unclaimedLamports: '20000000' }, { mint: 'B', unclaimedLamports: '100' }];
  let refreshed = 0;
  const watcher = { on(fn) { listeners.add(fn); return () => listeners.delete(fn); }, all: () => coins, async refreshAll() { refreshed += 1; return coins.length; }, async refresh() { return null; } };
  const collector = createCollector({ connection: {}, store: { get: () => null }, treasury: Keypair.generate(), watcher, minLamports: 10_000_000, sweepMs: 60_000, log: silent });
  assert.equal(collector.enabled, true);
  collector.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(refreshed, 1, 'startup sweep re-reads every vault');
  const scheduled = await collector.sweep();
  assert.equal(scheduled, 1, 'only the coin above the threshold is scheduled');
  coins = [{ mint: 'A', unclaimedLamports: '20000000' }, { mint: 'B', unclaimedLamports: '30000000' }];
  listeners.forEach(fn => fn({ type: 'vault', mint: 'B', coin: coins[1] }));
  assert.equal(await collector.sweep(), 2);
  collector.stop();
});

test('without a treasury key the collector is off and says so', async () => {
  const collector = createCollector({ connection: {}, store: {}, treasury: null, watcher: {}, log: silent });
  assert.equal(collector.enabled, false);
  await assert.rejects(collector.collect('x'), error => error.status === 503);
});
