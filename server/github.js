// Route's fee recipient on pump.fun is a GitHub identity: pump's fee program
// derives a "social fee PDA" from the GitHub user id (platform 2). Anyone may
// create the account (paying rent); only pump's own claim authority can move
// fees out of it, after the GitHub owner logs in on pump.fun.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PUMP_FEE_PROGRAM_ID, PUMP_SDK, socialFeePda } from '@pump-fun/pump-sdk';
import { RENT_EXEMPT_EMPTY } from './pump.js';

export const GITHUB_PLATFORM = 2;
export const X_PLATFORM = 1;
const TTL = 60 * 60_000;

export function createGithubResolver({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function lookup(username) {
    const key = String(username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(key)) return null;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(key)}`, { headers: { 'User-Agent': 'route-site', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (response.status === 404) { cache.set(key, { value: null, expires: now() + 60_000 }); return null; }
    if (!response.ok) throw new Error(`GitHub lookup failed (${response.status})`);
    const body = await response.json();
    if (!body?.id || !body?.login) throw new Error('GitHub lookup returned no user');
    const value = { id: String(body.id), login: String(body.login), avatarUrl: String(body.avatar_url || ''), name: String(body.name || '') };
    cache.set(key, { value, expires: now() + TTL });
    return value;
  }
  return { lookup };
}

export const githubFeePda = id => socialFeePda(String(id), GITHUB_PLATFORM);

export async function socialFeeState(connection, pda, commitment = 'confirmed') {
  const info = await connection.getAccountInfo(new PublicKey(pda), commitment);
  if (!info) return { exists: false, lamports: 0n, unclaimedLamports: 0n, totalClaimedLamports: 0n };
  let decoded = null;
  try { if (info.owner.equals(PUMP_FEE_PROGRAM_ID)) decoded = PUMP_SDK.decodeSocialFeePda(info); } catch { /* not a social fee account */ }
  const lamports = BigInt(info.lamports || 0);
  const rent = BigInt(Math.max(Number(RENT_EXEMPT_EMPTY), Math.round(info.data.length * 6960 + 890_880)));
  return { exists: Boolean(decoded), lamports, unclaimedLamports: lamports > rent ? lamports - rent : 0n, totalClaimedLamports: decoded ? BigInt(decoded.totalClaimed.toString()) : 0n, userId: decoded?.userId || null, platform: decoded?.platform ?? null };
}

// Creates the fee account for a GitHub id when it does not exist yet; the payer
// keypair (the treasury) covers rent and the network fee.
export async function ensureSocialFeePda({ connection, payer, userId, platform = GITHUB_PLATFORM, log = console }) {
  const pda = socialFeePda(String(userId), platform);
  const state = await socialFeeState(connection, pda);
  if (state.exists) return { pda, created: false };
  if (!payer) throw new Error(`Social fee account ${pda.toBase58()} is missing and no treasury key is configured to create it.`);
  const instruction = await PUMP_SDK.createSocialFeePda({ payer: payer.publicKey, userId: String(userId), platform });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), instruction] }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
  log.info(`[github] creating social fee account ${pda.toBase58()} for id ${userId}: ${signature}`);
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`social fee account creation failed: ${JSON.stringify(confirmation.value.err)}`);
  return { pda, created: true, signature };
}
