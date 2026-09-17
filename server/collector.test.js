import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createCollector } from './collector.js';

const silent = { info() {}, warn() {}, error() {} };

test('every sweep re-reads all vaults and claims each coin above the minimum right away', async () => {
  let coins = [{ mint: 'A', unclaimedLamports: '20000000' }, { mint: 'B', unclaimedLamports: '100' }, { mint: 'C', unclaimedLamports: '10000000' }];
  let refreshed = 0;
  const collected = [];
  const watcher = { all: () => coins, async refreshAll() { refreshed += 1; return coins.length; }, async refresh() { return null; } };
  const collector = createCollector({ connection: {}, store: { get: () => null }, treasury: Keypair.generate(), watcher, minLamports: 10_000_000, sweepMs: 10_000, log: silent, collectImpl: async (mint, { reason }) => { collected.push(`${mint}:${reason}`); return { mint, signature: `Sig-${mint}` }; } });
  assert.equal(collector.enabled, true);
  assert.equal(collector.sweepMs, 10_000);
  assert.equal(await collector.sweep(), 2, 'two coins were at or above the minimum');
  assert.equal(refreshed, 1, 'the vaults were re-read first');
  assert.deepEqual(collected.sort(), ['A:sweep', 'C:sweep']);
  coins = [{ mint: 'B', unclaimedLamports: '30000000' }];
  collector.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  collector.stop();
  assert.ok(collected.includes('B:startup sweep'), 'starting sweeps immediately');
});

test('a coin is never claimed twice at once', async () => {
  let running = 0, peak = 0;
  const watcher = { all: () => [{ mint: 'A', unclaimedLamports: '20000000' }], async refreshAll() { return 1; }, async refresh() { return null; } };
  const collector = createCollector({ connection: {}, store: { get: () => null }, treasury: Keypair.generate(), watcher, log: silent, collectImpl: async mint => { running += 1; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 20)); running -= 1; return { mint, signature: 'Sig' }; } });
  const results = await Promise.all([collector.collect('A'), collector.collect('A'), collector.sweep()]);
  assert.equal(peak, 1);
  assert.equal(results[0].signature, 'Sig');
});

test('without a treasury key the collector is off and says so', async () => {
  const collector = createCollector({ connection: {}, store: {}, treasury: null, watcher: {}, log: silent });
  assert.equal(collector.enabled, false);
  await assert.rejects(collector.collect('x'), error => error.status === 503);
});
