import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import { moneyFixture } from './money-fixture.js';
import { createCollector } from './collector.js';
import { createFeeLedger } from './fee-ledger.js';
import { openStore } from './store.js';
import { coinAccounts } from './pump.js';
import { createLaunchEngine } from './launch.js';
import { createFeeShareDetector } from './detect.js';

const silent = { info() {}, warn() {} };

async function credit(f, signature, { amount = 300_000_000n, allocation = amount, slot = 1, evidence = true } = {}) {
  const address = String(f.signer.publicKey), before = f.balances.get(address);
  f.balances.set(address, before + amount);
  await f.feeLedger.distribution({ signature, mint: String(f.mint), mainCoin: String(f.mint), treasury: address, slot,
    treasuryLamports: String(amount), buybackLamports: String(allocation), socialLamports: '0', lamports: String(amount),
    ...(evidence ? { netReceipt: true, treasuryBalanceBefore: String(before) } : {}) });
}

test('direct creator fees buy without a transfer, preserve existing SOL and recover an ambiguous buy after restart', async t => {
  const f = await moneyFixture(t, { sameWallet: true }), first = f.makeBuyback();
  await first.configure({ armed: true });
  assert.equal((await first.run()).skipped, 'blocked');
  await f.store.create({ mint: String(f.mint), status: 'confirmed', route: { status: 'detected' } });
  await credit(f, 'main-fee');
  assert.equal((await first.status()).availableLamports, '300000000');
  assert.equal((await first.status()).toForwardLamports, '0');
  f.failSend = true; f.visible = false;
  assert.equal((await first.run()).pending, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].transaction.message.staticAccountKeys[0].toBase58(), String(f.signer.publicKey));
  const store = await openStore(f.dir), feeLedger = createFeeLedger({ store });
  f.intentStore = store;
  const restored = f.makeBuyback({ store, feeLedger });
  await restored.run(); assert.equal(f.sends.length, 1);
  f.visible = true;
  await restored.run(); await restored.run();
  const status = await restored.status();
  assert.equal(status.purchases.length, 1); assert.equal(status.forwards.length, 0);
  assert.equal(status.forwardedLamports, '0'); assert.equal(status.separate, false);
  assert.equal(status.protectedBuyerLamports, '1000000000');
  assert.ok(BigInt(status.spentLamports) <= 300_000_000n);
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n);
  assert.equal(f.sends.length, 1);
});

test('direct collection does not turn old SOL or recipient allocations into buyback funds', async t => {
  const f = await moneyFixture(t, { sameWallet: true }), buyback = f.makeBuyback();
  await buyback.configure({ enabled: true });
  assert.equal((await buyback.status()).availableLamports, '0');
  await credit(f, 'other-coin', { amount: 2_000_000_000n, allocation: 100_000_000n });
  assert.equal((await buyback.status()).availableLamports, '100000000');
  await buyback.run();
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 2_900_000_000n);
  const entitled = buyback.entitledLamports();
  f.balances.set(String(f.signer.publicKey), 1_000_000_000n);
  assert.equal((await buyback.status()).availableLamports, '0');
  assert.equal(buyback.entitledLamports(), entitled);
});

test('missing original balance evidence and pending collection block direct spending', async t => {
  const f = await moneyFixture(t, { sameWallet: true });
  await credit(f, 'legacy', { evidence: false });
  const legacy = f.makeBuyback(); await legacy.configure({ enabled: true });
  assert.match((await legacy.run()).reason, /original wallet balance/);
  assert.equal(f.sends.length, 0);
  const busy = f.makeBuyback({ canBuy: () => false });
  assert.equal((await busy.run()).skipped, 'fee collection is being settled');
});

for (const graduated of [false, true]) test(`direct ${graduated ? 'PumpSwap' : 'Pump'} fee sharing registers, collects net SOL and funds its creator's buyback`, async t => {
  const f = await moneyFixture(t, { sameWallet: true }), accounts = coinAccounts(f.mint);
  const shareholders = [{ address: f.signer.publicKey, shareBps: 10000 }];
  const config = { bump: 1, version: 2, status: { active: {} }, mint: f.mint, admin: f.signer.publicKey, adminRevoked: true, shareholders };
  const configInfo = { owner: PUMP_FEE_PROGRAM_ID, data: await PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('sharingConfig', config) };
  let claimDetails, claims = 0;
  const connection = {
    ...f.connection,
    async getMultipleAccountsInfo(keys) { return keys.map(key => key.equals(accounts.config) ? configInfo : key.equals(f.mint) || (graduated && [accounts.pool, accounts.ammVaultAta].some(address => address.equals(key))) ? { data: Buffer.alloc(0) } : null); },
    async sendRawTransaction(bytes) {
      claims++;
      const transaction = VersionedTransaction.deserialize(bytes), keys = transaction.message.staticAccountKeys;
      const signature = bs58.encode(transaction.signatures[0]), treasuryIndex = keys.findIndex(key => key.equals(f.treasury.publicKey));
      const coder = PUMP_SDK.offlinePumpProgram.coder, definition = PUMP_SDK.offlinePumpProgram.idl.events.find(row => row.name === 'distributeCreatorFeesEvent');
      const data = coder.types.encode('distributeCreatorFeesEvent', { timestamp: new BN(1), mint: f.mint, bondingCurve: accounts.bondingCurve, sharingConfig: accounts.config, admin: f.signer.publicKey, shareholders, distributed: new BN(300_000_000), quoteMint: PublicKey.default });
      const event = Buffer.concat([Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]), Buffer.from(definition.discriminator), data]);
      const before = f.balances.get(String(f.signer.publicKey)), preBalances = keys.map(() => 2_000_000), postBalances = [...preBalances];
      preBalances[treasuryIndex] = Number(before); postBalances[treasuryIndex] = Number(before + 299_995_000n);
      f.balances.set(String(f.signer.publicKey), before + 299_995_000n);
      claimDetails = { slot: 4, transaction: { message: transaction.message }, meta: { err: null, fee: 5000, preBalances, postBalances, innerInstructions: [{ index: 2, instructions: [{ programIdIndex: keys.findIndex(key => key.equals(PUMP_PROGRAM_ID)), accounts: [], data: bs58.encode(event) }] }] } };
      return signature;
    },
    async getTransaction() { return claimDetails; },
  };
  const engine = createLaunchEngine({ connection, treasury: f.treasury.publicKey, buybackShareBps: 500 });
  assert.deepEqual(engine.shareholders, shareholders);
  const detector = createFeeShareDetector({ connection, store: f.store, allowed: () => engine.allowedShareholders, mainCoin: () => String(f.mint), service: { async adopt({ mint }) { await f.store.create({ mint, status: 'confirmed', route: { status: 'detected' } }); } }, log: silent });
  await detector.reconcile(); assert.equal(detector.summary().main.status, 'registered');
  const sdk = new OnlinePumpSdk(connection);
  const collector = createCollector({ connection, store: f.store, treasury: f.treasury, feeLedger: f.feeLedger, mainCoin: () => String(f.mint), watcher: { async refresh() {} }, pumpClient: {
    async getMinimumDistributableFee() { return { canDistribute: true, distributableFees: new BN(300_000_000), minimumRequired: new BN(1) }; },
    buildDistributeCreatorFeesInstructions: (...args) => sdk.buildDistributeCreatorFeesInstructions(...args),
  }, log: silent });
  await collector.collect(String(f.mint)); assert.equal(claims, 1);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 299_995_000n);
  const buyback = f.makeBuyback(); await buyback.configure({ armed: true }); await buyback.run();
  const result = await buyback.status();
  assert.equal(result.purchases.length, 1); assert.equal(result.forwards.length, 0);
  assert.equal(result.protectedBuyerLamports, '1000000000');
  assert.ok(f.balances.get(String(f.signer.publicKey)) >= 1_000_000_000n);
});
