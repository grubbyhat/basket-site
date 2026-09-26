// The main token launched by the dev (buyback) wallet with no fee sharing: pump.fun
// pays its creator fees to that wallet's own vaults, before and after migration.
// The buyback lane claims them, books the net receipt and buys only with it.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { moneyFixture } from './money-fixture.js';
import { createCollector } from './collector.js';
import { createFeeShareDetector } from './detect.js';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { account, offlineConnection, pumpCoin } from './fixtures.js';
import { decodeCurve } from './pump.js';

const silent = { info() {}, warn() {}, error() {} };

// A claim stand-in: SOL moves from a vault into the dev wallet, as pump's
// collect_creator_fee and collect_coin_creator_fee do.
function claimable(f, lamports) {
  const vault = Keypair.generate().publicKey, state = { unclaimed: lamports };
  f.balances.set(String(vault), 10_000_000_000n);
  const watcher = { get: () => ({ unclaimedLamports: String(state.unclaimed) }), async refresh() {} };
  const buildClaimImpl = async () => { const amount = state.unclaimed; state.unclaimed = 0n; return [SystemProgram.transfer({ fromPubkey: vault, toPubkey: f.signer.publicKey, lamports: amount })]; };
  return { state, watcher, buildClaimImpl };
}

const directRecord = f => f.store.create({ mint: String(f.mint), status: 'confirmed', wallet: String(f.signer.publicKey), route: { status: 'direct' }, fees: { distributedLamports: '0', claims: [] } });

test('a separate dev wallet claims the main token’s creator fees, keeps its own SOL and buys only with the claim', async t => {
  const f = await moneyFixture(t), claim = claimable(f, 300_000_000n);
  await directRecord(f);
  const buyback = f.makeBuyback({ watcher: claim.watcher, buildClaimImpl: claim.buildClaimImpl });
  assert.equal((await buyback.run()).skipped, 'disabled', 'nothing is claimed while buybacks are off');
  assert.equal(f.sends.length, 0);
  await buyback.configure({ armed: true });
  await buyback.run();
  assert.equal(f.sends.length, 2, 'one run: the claim, then the buy');
  for (const send of f.sends) assert.equal(send.transaction.message.staticAccountKeys[0].toBase58(), String(f.signer.publicKey), 'the dev wallet signs both');
  const status = await buyback.status();
  assert.equal(status.claimedLamports, '299995000', 'net of the network fee');
  assert.equal(status.protectedBuyerLamports, '1000000000', 'the wallet’s earlier SOL stays protected');
  assert.equal(status.toForwardLamports, '0', 'the treasury owes nothing for the main token');
  assert.equal(f.feeLedger.totals(String(f.mint), String(f.treasury.publicKey)).buyback, 0n, 'the claim is not the treasury’s receipt');
  assert.equal(f.store.get(String(f.mint)).fees.distributedLamports, '299995000', 'the coin page shows it as collected');
  assert.equal(status.purchases.length, 1);
  assert.ok(BigInt(status.spentLamports) <= 299_995_000n, 'the buy spends at most the claim');
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n);
});

test('below the minimum the dev wallet does not claim, and treasury shares still forward alongside claims', async t => {
  const f = await moneyFixture(t), claim = claimable(f, 1_000_000n);
  await directRecord(f);
  await f.feeLedger.distribution({ signature: 'other-coin', mint: String(Keypair.generate().publicKey), mainCoin: String(f.mint), treasury: String(f.treasury.publicKey), slot: 1, treasuryLamports: '400000000', buybackLamports: '20000000', socialLamports: '0', lamports: '400000000' });
  const buyback = f.makeBuyback({ watcher: claim.watcher, buildClaimImpl: claim.buildClaimImpl });
  await buyback.configure({ enabled: true });
  await buyback.run();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].transaction.message.staticAccountKeys[0].toBase58(), String(f.treasury.publicKey), 'a forward, not a claim');
  claim.state.unclaimed = 200_000_000n;
  await buyback.run();
  const status = await buyback.status();
  assert.equal(status.forwardedLamports, '20000000');
  assert.equal(status.claimedLamports, '199995000');
  assert.equal(status.entitledLamports, '219995000');
  assert.equal(status.purchases.length, 1, 'the claim and the forwarded share are bought in the same run');
  assert.ok(BigInt(status.spentLamports) <= 219_995_000n, 'forwarded plus claimed, never the wallet’s own SOL');
});

test('a dev wallet that is also the treasury books its claims as its fee receipts', async t => {
  const f = await moneyFixture(t, { sameWallet: true }), claim = claimable(f, 300_000_000n);
  await directRecord(f);
  const buyback = f.makeBuyback({ watcher: claim.watcher, buildClaimImpl: claim.buildClaimImpl });
  await buyback.configure({ enabled: true });
  await buyback.run();
  const status = await buyback.status();
  assert.equal(status.entitledLamports, '299995000', 'counted once, through the fee ledger');
  assert.equal(status.protectedBuyerLamports, '1000000000');
  assert.equal(status.purchases.length, 1, 'claimed and bought back in one run');
  assert.ok(BigInt(status.spentLamports) <= 299_995_000n);
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n);
});

test('other coins’ buyback shares do not pin the main mint; the main coin’s own receipts do', async t => {
  const f = await moneyFixture(t);
  await f.feeLedger.distribution({ signature: 'other-coin', mint: String(Keypair.generate().publicKey), mainCoin: String(f.mint), treasury: String(f.treasury.publicKey), slot: 1, treasuryLamports: '400000000', buybackLamports: '20000000', socialLamports: '0', lamports: '400000000' });
  const next = String(Keypair.generate().publicKey);
  const state = await f.makeBuyback().configure({ mainCoin: next });
  assert.equal(state.mainCoin, next);
  assert.equal(state.entitledLamports, '20000000', 'the old shares now buy the new main coin');
  await f.feeLedger.distribution({ signature: 'main-coin', mint: next, mainCoin: next, treasury: String(f.treasury.publicKey), slot: 2, treasuryLamports: '1000000', buybackLamports: '1000000', socialLamports: '0', lamports: '1000000' });
  await assert.rejects(f.makeBuyback().configure({ mainCoin: String(Keypair.generate().publicKey) }), /cannot change/);
});

test('the collector leaves the direct main token to the dev wallet and skips coins it only shows', async () => {
  const collected = [];
  const records = { A: { route: { status: 'active' } }, D: { route: { status: 'direct' } } };
  const watcher = { all: () => ['A', 'D', 'U'].map(mint => ({ mint, unclaimedLamports: '50000000' })), async refreshAll() {}, async refresh() {} };
  const collector = createCollector({ connection: {}, store: { get: mint => records[mint] || null }, treasury: Keypair.generate(), watcher, log: silent, collectImpl: async mint => { collected.push(mint); return { mint, signature: `Sig-${mint}` }; } });
  assert.equal(await collector.sweep(), 1);
  assert.deepEqual(collected, ['A']);
});

test('a main token without fee sharing is shown at once and registered as direct only for the dev wallet', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fork-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mint = pumpCoin.mint.address, creator = decodeCurve(account(pumpCoin.bondingCurve)).creator;
  const connection = offlineConnection(), treasury = Keypair.generate().publicKey;
  const tracked = [], untracked = [];
  const watcher = { track: async (m, options) => { tracked.push([m, options?.owner || null]); }, untrack: async m => { untracked.push(m); }, get: () => ({ mcapSol: 30 }), all: () => [], size: () => 0, on: () => () => {}, refresh: async () => null };
  const store = await openStore(dir);
  const make = claimWallet => createLaunchService({ store, engine: { shareholder: treasury, allowedShareholders: [treasury] }, xLookup: { lookup: async () => null }, dataDir: dir, origin: 'http://fork.test', treasury, watcher, connection, log: silent, mainCoin: () => mint, claimWallet });
  const detect = service => createFeeShareDetector({ connection, store, service, allowed: () => [treasury], mainCoin: () => mint, log: silent });

  // Another wallet created it: not claimable, but its page shows it with live data.
  const stranger = make(Keypair.generate().publicKey), strangerDetector = detect(stranger);
  await strangerDetector.reconcile();
  assert.equal(strangerDetector.summary().main.status, 'waiting-for-fee-sharing');
  assert.match(strangerDetector.summary().main.message, /not the buyback wallet/);
  assert.equal(store.get(mint), null, 'nothing is registered');
  assert.deepEqual(tracked, [[mint, creator.toBase58()]], 'watched on its creator’s own vaults');
  const shown = stranger.mainToken();
  assert.equal(shown.mint, mint);
  assert.equal(shown.creator, creator.toBase58());
  assert.equal(shown.pumpUrl, `https://pump.fun/coin/${mint}`);
  assert.deepEqual(shown.live, { mcapSol: 30 });
  await strangerDetector.reconcile();
  assert.equal(tracked.length, 1, 'shown once, not re-read each sweep');

  // Created by the dev wallet: registered as direct, re-watched on its vaults.
  const dev = make(creator), devDetector = detect(dev);
  await devDetector.reconcile();
  assert.equal(devDetector.summary().main.status, 'registered');
  const record = store.get(mint);
  assert.equal(record.route.status, 'direct');
  assert.equal(record.wallet, creator.toBase58());
  assert.deepEqual(record.shares, { treasuryBps: 10000, othersBps: 0 });
  assert.deepEqual(untracked, [mint]);
  assert.equal(dev.mainToken().route.status, 'direct');
  assert.equal(store.stats().routed, 1);
});

test('the direct main token’s creator vaults are its creator’s, before and after migration', async () => {
  const { coinAccounts } = await import('./pump.js');
  const { ammCreatorVaultPda, creatorVaultPda } = await import('@pump-fun/pump-sdk');
  const { coinCreatorVaultAuthorityPda } = await import('@pump-fun/pump-swap-sdk');
  const mint = new PublicKey(pumpCoin.mint.address), creator = Keypair.generate().publicKey;
  const accounts = coinAccounts(mint, creator);
  assert.ok(accounts.vault.equals(creatorVaultPda(creator)));
  assert.ok(ammCreatorVaultPda(creator).equals(coinCreatorVaultAuthorityPda(creator)), 'pump and PumpSwap derive the same coin-creator vault');
  assert.ok(!coinAccounts(mint).vault.equals(accounts.vault), 'a fee-sharing coin uses its config’s vaults instead');
});

test('a migrated main token is watched through its PumpSwap pool, even when tracked after migration', async t => {
  const { readFile } = await import('node:fs/promises');
  const { createCoinWatcher } = await import('./watch.js');
  const { AccountLayout } = await import('@solana/spl-token');
  const coin = JSON.parse(await readFile(new URL('./fixtures/migrated-coin.json', import.meta.url), 'utf8'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fork-migrated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await store.create({ mint: coin.mint.address, status: 'confirmed', wallet: coin.creator, route: { status: 'direct' } });
  const extra = Object.fromEntries(['mint', 'bondingCurve', 'pool', 'poolBase', 'poolQuote', 'vault', 'ammVaultAta'].filter(name => !coin[name].missing).map(name => [coin[name].address, account(coin[name])]));
  const connection = offlineConnection({ extra });
  const watcher = createCoinWatcher({ connection, store, price: { get: () => ({ usd: 100 }) }, log: silent });
  await watcher.track(coin.mint.address);
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = watcher.get(coin.mint.address);
  assert.equal(state.phase, 'graduated', 'the zeroed curve does not stop the watch');
  assert.ok(state.mcapSol > 0, `pool market cap ${state.mcapSol} SOL`);
  const ammFees = BigInt(AccountLayout.decode(Buffer.from(coin.ammVaultAta.data, 'base64')).amount.toString());
  assert.equal(BigInt(state.unclaimedLamports) >= ammFees, true, 'the creator’s PumpSwap vault counts as unclaimed');
  const watched = new Set([...connection.subscriptions.values()].map(entry => entry.key));
  for (const name of ['poolBase', 'poolQuote', 'ammVaultAta']) assert.ok(watched.has(coin[name].address), `${name} is subscribed`);
  await watcher.stop();
});

test('fees that never stop arriving cannot starve the buy', async t => {
  const f = await moneyFixture(t), claim = claimable(f, 300_000_000n);
  await directRecord(f);
  // Like a busy coin: there is always more than the claim minimum waiting.
  const refill = { get: () => ({ unclaimedLamports: '300000000' }), async refresh() {} };
  const buildClaimImpl = async () => { claim.state.unclaimed = 300_000_000n; return claim.buildClaimImpl(); };
  const buyback = f.makeBuyback({ watcher: refill, buildClaimImpl });
  await buyback.configure({ enabled: true });
  await buyback.run();
  let status = await buyback.status();
  assert.equal(status.claims.length, 1, 'a claim');
  assert.equal(status.purchases.length, 1, 'and its buy, although fees are still waiting');
  await buyback.run();
  status = await buyback.status();
  assert.equal(status.claims.length, 2);
  assert.equal(status.purchases.length, 2, 'every run claims and buys back');
});

test('an optional cap spreads a large backlog over several buys', async t => {
  const f = await moneyFixture(t), claim = claimable(f, 1_000_000_000n);
  await directRecord(f);
  const buyback = f.makeBuyback({ watcher: claim.watcher, buildClaimImpl: claim.buildClaimImpl, maxLamports: 300_000_000 });
  await buyback.configure({ enabled: true });
  await buyback.run();
  let status = await buyback.status();
  assert.equal(status.purchases.length, 1);
  assert.equal(status.purchases[0].budgetLamports, '300000000', 'one buy spends at most the cap');
  await buyback.run(); await buyback.run(); await buyback.run();
  status = await buyback.status();
  assert.equal(status.purchases.length, 4, 'the rest follows in capped buys');
  assert.ok(status.purchases.every(row => BigInt(row.budgetLamports) <= 300_000_000n));
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n, 'the wallet’s own SOL is untouched');
});

test('skipping the claimed backlog makes buys follow new claims only', async t => {
  const f = await moneyFixture(t, { sameWallet: true }), claim = claimable(f, 0n);
  await directRecord(f);
  // A backlog: 5 SOL already claimed into the wallet, never bought with.
  const address = String(f.signer.publicKey), before = f.balances.get(address);
  f.balances.set(address, before + 5_000_000_000n);
  await f.feeLedger.distribution({ signature: 'backlog', mint: String(f.mint), mainCoin: String(f.mint), treasury: address, slot: 1, treasuryLamports: '5000000000', buybackLamports: '5000000000', socialLamports: '0', lamports: '5000000000', netReceipt: true, treasuryBalanceBefore: String(before) });
  const buyback = f.makeBuyback({ watcher: claim.watcher, buildClaimImpl: claim.buildClaimImpl });
  assert.equal((await buyback.status()).owedLamports, '5000000000');
  await buyback.configure({ enabled: true });
  await assert.rejects(buyback.configure({ skipBacklog: true }), /Stop buybacks/);
  await buyback.configure({ enabled: false });
  let status = await buyback.configure({ skipBacklog: true });
  assert.equal(status.skippedLamports, '5000000000');
  assert.equal(status.owedLamports, '0');
  await buyback.configure({ enabled: true });
  assert.equal((await buyback.run()).skipped, 'below minimum', 'nothing to buy and nothing to claim');
  assert.equal(f.sends.length, 0);
  claim.state.unclaimed = 400_000_000n;
  await buyback.run(); // claim
  await buyback.run(); // buy
  status = await buyback.status();
  assert.equal(status.claims.length, 1);
  assert.equal(status.purchases.length, 1);
  assert.ok(BigInt(status.spentLamports) <= 399_995_000n, 'the buy spends at most the new claim');
  assert.ok(f.balances.get(address) >= before + 5_000_000_000n, 'the skipped backlog stays in the wallet');
});
