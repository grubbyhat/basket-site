import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { validateSocialClaim } from './social-claim.js';
import { moneyFixture } from './money-fixture.js';

async function claimFixture({ signed = true, extra = false } = {}) {
  const recipient = Keypair.generate(), authority = Keypair.generate(), userId = '246145063';
  const instructions = [await PUMP_SDK.claimSocialFeePda({ recipient: recipient.publicKey, socialClaimAuthority: authority.publicKey, userId, platform: 2 })];
  if (extra) instructions.push(SystemProgram.transfer({ fromPubkey: recipient.publicKey, toPubkey: authority.publicKey, lamports: 1_000_000 }));
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: recipient.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions }).compileToV0Message());
  if (signed) transaction.sign([authority]);
  return { transaction, recipient: recipient.publicKey, authority: authority.publicKey, userId };
}

test('only exact GitHub withdrawals with a valid Pump co-signature may be signed by the treasury', async () => {
  await validateSocialClaim(await claimFixture());
  await assert.rejects(validateSocialClaim(await claimFixture({ signed: false })), error => error.code === 'PUMP_AUTHORIZATION_REQUIRED');
  await assert.rejects(validateSocialClaim(await claimFixture({ extra: true })), /Unexpected program/);
  const wrongIdentity = await claimFixture(); wrongIdentity.userId = '322216527';
  await assert.rejects(validateSocialClaim(wrongIdentity), /Unexpected GitHub claim/);
});

test('a finalized GitHub withdrawal releases main-coin fees while preserving other recipients shares', async t => {
  const f = await moneyFixture(t);
  await f.feeLedger.baseline('0');
  await f.credit('main-deposit', { direct: 5n, social: 95n });
  await f.credit('other-deposit', { direct: 5n, social: 95n, main: false });
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 10n);
  const receipt = { signature: 'withdrawal', slot: 3, lamports: '190', claimedBefore: '0', claimedAfter: '190', depositSignatures: ['main-deposit', 'other-deposit'] };
  await f.feeLedger.withdrawal(receipt); await f.feeLedger.withdrawal(receipt);
  assert.equal(f.feeLedger.totals(String(f.mint)).buyback, 105n);
  assert.equal(f.feeLedger.totals(String(f.mint)).received, 200n);
  await assert.rejects(f.feeLedger.baseline('200'), /external GitHub withdrawal/);
});
