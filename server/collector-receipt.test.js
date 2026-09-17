import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk';
import bs58 from 'bs58';
import BN from 'bn.js';
import { coinAccounts } from './pump.js';
import { githubFeePda } from './github.js';
import { moneyFixture } from './money-fixture.js';
import { createCollector } from './collector.js';

for (const graduated of [false, true]) test(`${graduated ? 'PumpSwap' : 'bonding curve'} fee-sharing collection books actual finalized receipts, not estimates`, async t => {
  const f = await moneyFixture(t), social = githubFeePda('246145063'), accounts = coinAccounts(f.mint);
  const shareholders = [{ address: social, shareBps: 9500 }, { address: f.treasury.publicKey, shareBps: 500 }];
  const config = { bump: 1, version: 2, status: { active: {} }, mint: f.mint, admin: f.signer.publicKey, adminRevoked: true, shareholders };
  const info = { owner: PUMP_FEE_PROGRAM_ID, data: await PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('sharingConfig', config) };
  let details = null, visible = false, sends = 0, transaction;
  const connection = {
    ...f.connection,
    async getMultipleAccountsInfo(keys) { return keys.map(key => key.equals(accounts.config) ? info : graduated && [accounts.pool, accounts.ammVaultAta].some(address => address.equals(key)) ? { data: Buffer.alloc(0) } : null); },
    async sendRawTransaction(bytes) {
      sends++; transaction = VersionedTransaction.deserialize(bytes);
      const signature = bs58.encode(transaction.signatures[0]);
      assert.equal(f.store.getMeta(`collect-${f.mint.toBuffer().toString('hex')}`).signature, signature);
      const keys = transaction.message.staticAccountKeys, treasuryIndex = keys.findIndex(key => key.equals(f.treasury.publicKey)), socialIndex = keys.findIndex(key => key.equals(social));
      const eventDefinition = PUMP_SDK.offlinePumpProgram.idl.events.find(row => row.name === 'distributeCreatorFeesEvent');
      const data = PUMP_SDK.offlinePumpProgram.coder.types.encode('distributeCreatorFeesEvent', { timestamp: new BN(1), mint: f.mint, bondingCurve: accounts.bondingCurve, sharingConfig: accounts.config, admin: f.signer.publicKey, shareholders, distributed: new BN(2_000_000_000), quoteMint: PublicKey.default });
      const event = Buffer.concat([Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]), Buffer.from(eventDefinition.discriminator), data]);
      const preBalances = keys.map(() => 2_000_000), postBalances = [...preBalances];
      preBalances[treasuryIndex] = 5_000_000_000; postBalances[treasuryIndex] = 5_099_995_000;
      postBalances[socialIndex] += 1_900_000_000;
      details = { slot: 4, transaction: { message: transaction.message }, meta: { err: null, fee: 5000, preBalances, postBalances, innerInstructions: [{ index: 2, instructions: [{ programIdIndex: keys.findIndex(key => key.equals(PUMP_PROGRAM_ID)), accounts: [], data: bs58.encode(event) }] }] } };
      return signature;
    },
    async getTransaction() { return visible ? details : null; },
    async getSignatureStatuses() { return { value: [null] }; },
  };
  const sdk = new OnlinePumpSdk(connection);
  const pumpClient = {
    async getMinimumDistributableFee() { return { canDistribute: true, distributableFees: new BN(10_000_000_000), minimumRequired: new BN(1) }; },
    buildDistributeCreatorFeesInstructions: (...args) => sdk.buildDistributeCreatorFeesInstructions(...args),
  };
  await f.store.create({ mint: String(f.mint), status: 'confirmed', fees: { claims: [], distributedLamports: '0' } });
  const watcher = { all: () => [{ mint: String(f.mint), unclaimedLamports: '0' }], async refresh() {}, async refreshAll() {} };
  const collector = createCollector({ connection, store: f.store, treasury: f.treasury, socialPda: social, feeLedger: f.feeLedger, watcher, pumpClient, log: { info() {}, warn() {} } });
  assert.equal((await collector.collect(String(f.mint))).pending, true);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 0n);
  visible = true;
  await collector.sweep(); // Reconcile even though the coin's vault is now empty.
  assert.equal(sends, 1);
  assert.equal(f.store.get(String(f.mint)).fees.distributedLamports, '2000000000');
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 100_000_000n);
  assert.equal(f.feeLedger.totals(String(f.mint)).socialPending, 1_900_000_000n);
  assert.equal(transaction.message.staticAccountKeys.some(key => key.equals(PUMP_AMM_PROGRAM_ID)), graduated);
});
