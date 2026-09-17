import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK } from '@pump-fun/pump-sdk';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { githubFeePda, socialFeeState } from './github.js';
import { createSettlement, solDelta } from './settlement.js';
import { feeEvents } from './pump-events.js';

export const PUMP_SOCIAL_BUILDER = 'https://blockchain-swap.pump.fun/transactions/creator-fees/social';

export async function fetchSocialClaim({ wallet, userId, fetchImpl = fetch }) {
  const response = await fetchImpl(PUMP_SOCIAL_BUILDER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, user_id: userId, platform: 2 }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Pump social claim builder returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.wallet !== wallet || result.user_id !== userId || result.platform !== 2 || result.social_fee_pda !== githubFeePda(userId).toBase58()) throw new Error('Pump returned a different GitHub identity or recipient.');
  if (result.claims_disabled || result.rate_limited_until_unix > Date.now() / 1000) throw new Error('Pump has temporarily disabled or rate-limited GitHub claims.');
  if (!result.is_claimable || !result.claim_transaction) return null;
  return VersionedTransaction.deserialize(bs58.decode(result.claim_transaction));
}

export async function validateSocialClaim({ transaction, recipient, userId, authority }) {
  const message = transaction.message;
  if (message.addressTableLookups?.length) throw new Error('Unexpected address lookup tables in GitHub claim.');
  const keys = message.staticAccountKeys;
  if (keys[0]?.toBase58() !== recipient.toBase58() || message.header.numRequiredSignatures !== 2 || !keys[1]?.equals(authority)) throw new Error('GitHub claim requires the expected treasury and Pump signers.');
  const pda = githubFeePda(userId);
  const expectedV1 = await PUMP_SDK.claimSocialFeePda({ recipient, socialClaimAuthority: authority, userId, platform: 2 });
  const expectedV2 = await PUMP_SDK.offlinePumpFeeProgram.methods.claimSocialFeePdaV2(userId, 2).accountsPartial({ recipient, socialFeePda: pda, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, socialClaimAuthority: authority }).instruction();
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, recipient);
  const expectedAta = createAssociatedTokenAccountIdempotentInstruction(recipient, ata, recipient, NATIVE_MINT);
  const same = (ix, expected) => Buffer.from(ix.data).equals(expected.data) && ix.accountKeyIndexes.length === expected.keys.length && ix.accountKeyIndexes.every((index, position) => keys[index].equals(expected.keys[position].pubkey));
  let claims = 0, atas = 0;
  const compute = new Set();
  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex], data = Buffer.from(ix.data);
    if (program.equals(PUMP_FEE_PROGRAM_ID)) {
      if (++claims !== 1 || (!same(ix, expectedV1) && !same(ix, expectedV2))) throw new Error('Unexpected GitHub claim instruction or quote token.');
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (++atas !== 1 || !same(ix, expectedAta)) throw new Error('Unexpected token account in GitHub claim.');
    } else if (program.equals(ComputeBudgetProgram.programId)) {
      if (compute.has(data[0])) throw new Error('Duplicate compute budget instruction.');
      compute.add(data[0]);
      if (!(data[0] === 2 && data.length === 5 && data.readUInt32LE(1) <= 300_000) && !(data[0] === 3 && data.length === 9 && data.readBigUInt64LE(1) <= 200_000n)) throw new Error('GitHub claim network fee exceeds its limit.');
    } else throw new Error('Unexpected program in GitHub withdrawal.');
  }
  if (claims !== 1) throw new Error('Missing GitHub withdrawal instruction.');
  if (!nacl.sign.detached.verify(message.serialize(), transaction.signatures[1], authority.toBytes())) {
    const error = new Error('Pump authorization is required: the claim builder returned no valid Pump co-signature.');
    error.code = 'PUMP_AUTHORIZATION_REQUIRED';
    throw error;
  }
}

export function createSocialClaimer({ connection, store, treasury, github, feeLedger, canClaim = () => true, buildClaim = fetchSocialClaim, minLamports = 10_000_000, log = console }) {
  const lane = createSettlement({ connection, store, key: 'social-claim-pending' });
  let running = false;
  let state = { enabled: Boolean(treasury && github), ready: false, status: 'authorization-unverified', message: 'Pump withdrawal authorization has not been verified.', lastRun: null, lastSignature: null };
  const summary = () => ({ ...state, pending: lane.pending()?.signature || null });
  async function settle(attempt, details) {
    const event = feeEvents(details).find(row => row.name === 'socialFeePdaClaimed' && row.data.userId === github.id && row.data.platform === 2 && [PublicKey.default.toBase58(), NATIVE_MINT.toBase58()].includes(row.data.quoteMint.toBase58()));
    if (!event || event.data.recipient.toBase58() !== treasury.publicKey.toBase58() || event.data.socialFeePda.toBase58() !== github.pda.toBase58()) throw new Error('GitHub withdrawal receipt is missing or has a different recipient.');
    const amount = BigInt(event.data.amountClaimed.toString());
    if (-solDelta(details, github.pda) !== amount) throw new Error('GitHub withdrawal does not match its on-chain balance change.');
    await feeLedger.withdrawal({ signature: attempt.signature, slot: details.slot, lamports: String(amount), claimedBefore: attempt.context.claimedBefore, claimedAfter: event.data.lifetimeClaimed.toString(), depositSignatures: attempt.context.depositSignatures, at: attempt.at });
    state = { ...state, ready: true, status: 'ready', message: null, lastSignature: attempt.signature };
  }
  async function run() {
    if (running || !state.enabled || !canClaim()) return { skipped: 'busy or unconfigured' };
    running = true;
    try {
      if (lane.pending()) return await lane.execute({ settle });
      const social = await socialFeeState(connection, github.pda);
      await feeLedger.baseline(social.totalClaimedLamports);
      if (social.unclaimedLamports < BigInt(minLamports)) return { skipped: 'below minimum' };
      return await lane.execute({ settle, build: async () => {
        const transaction = await buildClaim({ wallet: treasury.publicKey.toBase58(), userId: github.id });
        if (!transaction) return { skipped: 'Pump reports no claimable fees' };
        const [global] = PublicKey.findProgramAddressSync([Buffer.from('fee-program-global')], PUMP_FEE_PROGRAM_ID);
        const info = await connection.getAccountInfo(global, 'finalized');
        if (!info?.owner.equals(PUMP_FEE_PROGRAM_ID)) throw new Error('Pump fee authority could not be verified.');
        const authority = PUMP_SDK.offlinePumpFeeProgram.coder.accounts.decode('feeProgramGlobal', info.data).socialClaimAuthority;
        await validateSocialClaim({ transaction, recipient: treasury.publicKey, userId: github.id, authority });
        state = { ...state, ready: true, status: 'ready', message: null };
        transaction.sign([treasury]);
        return { transaction, context: { claimedBefore: String(social.totalClaimedLamports), depositSignatures: Object.values(feeLedger.read().distributions).filter(row => !row.socialWithdrawn).map(row => row.signature) } };
      } });
    } catch (error) {
      state = { ...state, ready: false, status: error.code === 'PUMP_AUTHORIZATION_REQUIRED' ? 'authorization-required' : 'error', message: error.message };
      log.warn(`[github claim] ${error.message}`);
      return { error: error.message };
    } finally { state.lastRun = new Date().toISOString(); running = false; }
  }
  return { run, summary, busy: () => running || Boolean(lane.pending()) };
}
