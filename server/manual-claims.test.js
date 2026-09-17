import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { readFile } from 'node:fs/promises';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import { moneyFixture } from './money-fixture.js';
import { githubFeePda } from './github.js';
import { createSocialClaimer } from './social-claim.js';
import { createManualClaimReconciler, socialClaimReceipt } from './manual-claims.js';
import { createFeeLedger } from './fee-ledger.js';
import { openStore } from './store.js';

const silent = { info() {}, warn() {} };

async function fixture(t) {
  const f = await moneyFixture(t), github = { id: '246145063', pda: githubFeePda('246145063') };
  const authority = Keypair.generate().publicKey;
  const histories = [], receipts = new Map();
  let total = 0n, blockSignatures = [];
  const calls = { transactions: 0, builds: 0, sends: 0 };
  const connection = {
    ...f.connection,
    async getAccountInfo(key, commitment) {
      assert.equal(commitment, 'finalized'); assert.ok(key.equals(github.pda));
      const data = await PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('socialFeePda', { bump: 1, version: 2, userId: github.id, platform: 2, totalClaimed: new BN(String(total)), lastClaimed: new BN(0), totalStableClaimed: new BN(0), reserved: Array(120).fill(0) });
      return { owner: PUMP_FEE_PROGRAM_ID, data, lamports: 500_000_000 };
    },
    async getSignaturesForAddress(key, options, commitment) {
      assert.ok(key.equals(github.pda)); assert.equal(commitment, 'finalized');
      const start = options.before ? histories.findIndex(row => row.signature === options.before) + 1 : 0;
      return histories.slice(start, start + options.limit);
    },
    async getTransaction(signature, options) { calls.transactions++; assert.equal(options.commitment, 'finalized'); return receipts.get(signature) || null; },
    async getBlockSignatures(slot, commitment) { assert.equal(commitment, 'finalized'); return { signatures: blockSignatures }; },
    async sendRawTransaction() { calls.sends++; throw new Error('Manual claiming must not broadcast transactions.'); },
  };
  async function credit(signature, { amount = 300_000_000n, slot = 1, main = true } = {}) {
    await f.feeLedger.distribution({ signature, mint: String(f.mint), mainCoin: main ? String(f.mint) : null, treasury: String(f.treasury.publicKey), slot, treasuryLamports: '0', buybackLamports: '0', socialLamports: String(amount), lamports: String(amount) });
  }
  async function claim(signature, { amount = 300_000_000n, after = amount, cost = 5000n, slot = 3, recipient = f.treasury.publicKey } = {}) {
    const instructions = [await PUMP_SDK.claimSocialFeePda({ recipient, socialClaimAuthority: authority, userId: github.id, platform: 2 })];
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: recipient, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions }).compileToV0Message());
    const keys = transaction.message.staticAccountKeys;
    const recipientIndex = keys.findIndex(key => key.equals(recipient)), pdaIndex = keys.findIndex(key => key.equals(github.pda));
    const preBalances = keys.map(() => 5_000_000_000), postBalances = [...preBalances];
    postBalances[pdaIndex] -= Number(amount); postBalances[recipientIndex] += Number(amount - cost);
    const program = PUMP_SDK.offlinePumpFeeProgram;
    const definition = program.idl.events.find(row => row.name === 'socialFeePdaClaimed');
    const data = program.coder.types.encode('socialFeePdaClaimed', {
      timestamp: new BN(1), userId: github.id, platform: 2, socialFeePda: github.pda, recipient, socialClaimAuthority: authority,
      amountClaimed: new BN(String(amount)), claimableBefore: new BN(String(amount)), lifetimeClaimed: new BN(String(after)),
      recipientBalanceBefore: new BN(String(5_000_000_000n - cost)), recipientBalanceAfter: new BN(String(5_000_000_000n - cost + amount)),
      quoteMint: PublicKey.default, lifetimeStableClaimed: new BN(0),
    });
    const event = Buffer.concat([Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]), Buffer.from(definition.discriminator), data]);
    const details = { slot, blockTime: 1, transaction: { message: transaction.message, signatures: [signature] }, meta: { err: null, fee: Number(cost), preBalances, postBalances, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: keys.findIndex(key => key.equals(PUMP_FEE_PROGRAM_ID)), accounts: [], data: bs58.encode(event) }] }] } };
    receipts.set(signature, details); histories.unshift({ signature, slot, err: null }); total = after;
    if (recipient.equals(f.treasury.publicKey)) f.balances.set(String(recipient), f.balances.get(String(recipient)) + amount - cost);
    return details;
  }
  return { ...f, github, connection, credit, claim, histories, receipts, calls, setBlockSignatures: value => { blockSignatures = value; },
    worker: (overrides = {}) => createSocialClaimer({ connection, store: f.store, treasury: f.treasury, github, feeLedger: f.feeLedger, buildClaim: async () => { calls.builds++; throw new Error('must not build in manual mode'); }, log: silent, ...overrides }),
    reconciler: (overrides = {}) => createManualClaimReconciler({ connection, store: f.store, feeLedger: f.feeLedger, github, recipient: f.treasury.publicKey, ...overrides }),
  };
}

test('manual mode watches claims without building, signing or submitting a withdrawal', async t => {
  const f = await fixture(t), worker = f.worker();
  assert.deepEqual(await worker.run(), { manual: true, imported: 0 });
  assert.equal(worker.summary().mode, 'manual'); assert.equal(worker.summary().ready, true);
  assert.equal(f.feeLedger.read().socialClaimed, '0');
  assert.equal(f.calls.builds, 0); assert.equal(f.calls.sends, 0);
});

test('a manual main-token claim funds creator-wallet buybacks once, using actual net receipts', async t => {
  const f = await fixture(t), worker = f.worker();
  await worker.run(); await f.credit('deposit'); await f.claim('manual-claim');
  assert.equal((await worker.run()).imported, 1);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 299_995_000n);
  await worker.run(); assert.equal(f.calls.transactions, 1, 'unchanged lifetime claims do not rescan history');
  const buyback = f.makeBuyback(); await buyback.configure({ enabled: true });
  await buyback.run(); await buyback.run();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].transaction.message.staticAccountKeys[0].toBase58(), String(f.signer.publicKey));
  assert.equal((await buyback.status()).forwardedLamports, '299995000');
  const store = await openStore(f.dir), ledger = createFeeLedger({ store });
  await f.worker({ store, feeLedger: ledger }).run();
  assert.equal(ledger.totals(String(f.mint)).buyback, 299_995_000n);
  assert.equal(Object.keys(ledger.read().withdrawals).length, 1);
});

test('claim reconciliation preserves other recipients shares and ignores untracked extra fees', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0');
  await f.credit('main', { amount: 200_000_000n });
  await f.credit('other', { amount: 100_000_000n, main: false });
  await f.claim('claim', { amount: 400_000_000n, cost: 40_000n });
  await f.worker().run();
  const totals = f.feeLedger.totals(String(f.mint));
  assert.equal(totals.buyback, 199_980_000n);
  assert.equal(totals.received, 299_970_000n);
  assert.equal(totals.socialPending, 0n);
});

test('multiple missed manual claims recover over paginated history and a server restart', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0');
  await f.credit('deposit-one', { amount: 100_000_000n, slot: 1 });
  await f.credit('deposit-two', { amount: 200_000_000n, slot: 4 });
  await f.claim('claim-one', { amount: 100_000_000n, after: 100_000_000n, slot: 3 });
  await f.claim('claim-two', { amount: 200_000_000n, after: 300_000_000n, slot: 7 });
  assert.equal((await f.reconciler({ pageSize: 1 })(300_000_000n)).pending, true);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 0n);
  const store = await openStore(f.dir), ledger = createFeeLedger({ store });
  const result = await f.reconciler({ store, feeLedger: ledger, pageSize: 1 })(300_000_000n);
  assert.equal(result.imported.length, 2);
  assert.equal(ledger.totals(String(f.mint)).buyback, 299_990_000n);
  assert.equal(store.getMeta('github-withdrawal-scan'), null);
});

test('temporarily missing claim metadata waits and retries without advancing or crediting funds', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0'); await f.credit('deposit');
  const details = await f.claim('claim'); f.receipts.delete('claim');
  const worker = f.worker(); assert.equal((await worker.run()).pending, true);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 0n);
  f.receipts.set('claim', details); assert.equal((await worker.run()).imported, 1);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 299_995_000n);
});

test('a lagging signature index is retried from the head after incomplete history', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0'); await f.credit('deposit');
  const details = await f.claim('claim');
  f.histories.splice(0, 1, { signature: 'older-unrelated', slot: 2, err: null });
  f.receipts.set('older-unrelated', { ...details, transaction: { ...details.transaction, signatures: ['older-unrelated'] }, meta: { ...details.meta, innerInstructions: [] } });
  const worker = f.worker(); assert.equal((await worker.run()).pending, true);
  assert.match((await worker.run()).error, /history is incomplete/);
  assert.equal(f.store.getMeta('github-withdrawal-scan'), null);
  f.histories.unshift({ signature: 'claim', slot: details.slot, err: null });
  assert.equal((await worker.run()).imported, 1);
});

test('a claim to another wallet is recorded but never credited to buybacks', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0'); await f.credit('deposit');
  await f.claim('claim', { recipient: Keypair.generate().publicKey });
  const worker = f.worker(); await worker.run();
  assert.equal(worker.summary().status, 'wrong-recipient');
  assert.equal(f.feeLedger.read().socialClaimed, '300000000');
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 0n);
  await worker.run(); assert.equal(f.calls.transactions, 1);
});

test('same-block deposits are assigned using actual transaction order', async t => {
  const f = await fixture(t); await f.feeLedger.baseline('0');
  await f.credit('before', { amount: 100_000_000n, slot: 5 });
  await f.credit('after', { amount: 200_000_000n, slot: 5 });
  await f.claim('claim', { amount: 100_000_000n, slot: 5 });
  f.setBlockSignatures(['before', 'claim', 'after']);
  await f.worker().run();
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 99_995_000n);
  assert.equal(f.feeLedger.totals(String(f.mint)).socialPending, 200_000_000n);
});

test('failed transactions, plain SOL deposits, and inconsistent claim balances cannot authorize spending', async t => {
  const f = await fixture(t), details = await f.claim('claim');
  const read = value => socialClaimReceipt({ signature: 'claim', details: value, github: f.github, recipient: f.treasury.publicKey });
  assert.equal(read({ ...details, meta: { ...details.meta, err: { InstructionError: [0, 'error'] } } }), null);
  assert.equal(read({ ...details, meta: { ...details.meta, innerInstructions: [] } }), null);
  assert.throws(() => read({ ...details, meta: { ...details.meta, postBalances: details.meta.preBalances } }), /actual SOL withdrawal/);
});

test('a captured finalized Pump V2 claim with both SOL and USDC yields only its actual SOL receipt', async () => {
  // Public mainnet transaction captured read-only on 2026-09-17. No live RPC or
  // signature generation is used by this regression test.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/github-claim.json', import.meta.url), 'utf8'));
  const meta = { ...fixture.meta, loadedAddresses: Object.fromEntries(Object.entries(fixture.meta.loadedAddresses || {}).map(([key, list]) => [key, list.map(value => new PublicKey(value))])) };
  const details = { slot: fixture.slot, blockTime: fixture.blockTime, meta, transaction: { signatures: fixture.signatures, message: VersionedMessage.deserialize(Buffer.from(fixture.message, 'base64')) } };
  const receipt = socialClaimReceipt({ signature: fixture.signatures[0], details, github: { id: '322216527', pda: githubFeePda('322216527') }, recipient: new PublicKey('PaidybYx1q4xTYXMgHq1PTAsFkPsdJf6XG7KC1NUSJ8') });
  assert.equal(receipt.lamports, '33577104');
  assert.equal(receipt.receivedLamports, '33567104');
  assert.equal(receipt.claimedBefore, '10778333868915');
  assert.equal(receipt.claimedAfter, '10778367446019');
});
