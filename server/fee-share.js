// pump.fun fee sharing for Route: a coin's creator creates the coin's
// FeeSharingConfig and sets one shareholder at 100%: Route's GitHub social fee
// account (pump.fun shows its picture), or the treasury wallet when no GitHub is set. The
// program migrates the coin's creator to the config, locks the shares after
// that first update, and from then on creator fees accrue in the config's own
// vault, from where anyone may crank `distribute_creator_fees` to the treasury.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { HttpError } from './errors.js';
import { coinAccounts, decodeConfig, decodeCurve, decodePool, fetchMetadataImage, readTokenMetadata } from './pump.js';

// A live registration simulated at ~182k CU; keep headroom.
export const ROUTE_UNITS = 260_000;
export const ROUTE_PRIORITY_MICRO_LAMPORTS = 100_000;

export function parseMint(value) {
  try { return new PublicKey(String(value || '').trim()); }
  catch { throw new HttpError('Enter a valid mint address.', 400, { field: 'mint' }); }
}

export function normalizeShareholders(input) {
  const list = Array.isArray(input) ? input : [{ address: input, shareBps: 10000 }];
  const merged = new Map();
  for (const entry of list) {
    const key = new PublicKey(entry.address).toBase58();
    if (!Number.isInteger(entry.shareBps) || entry.shareBps <= 0) throw new Error('Shareholder shares must be positive integers.');
    merged.set(key, (merged.get(key) || 0) + entry.shareBps);
  }
  const shareholders = [...merged].map(([address, shareBps]) => ({ address: new PublicKey(address), shareBps }));
  if (shareholders.reduce((sum, entry) => sum + entry.shareBps, 0) !== 10000) throw new Error('Shareholder shares must total 10000 bps.');
  return shareholders;
}

export async function routeInstructions({ mint, creator, shareholder, shareholders = null, graduated = false }) {
  const accounts = coinAccounts(mint);
  const shares = { authority: creator, mint, currentShareholders: [creator], newShareholders: normalizeShareholders(shareholders || shareholder) };
  return [
    await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: graduated ? accounts.pool : null }),
    graduated
      ? await PUMP_SDK.updateFeeSharesV2({ ...shares, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID })
      : await PUMP_SDK.updateFeeShares(shares),
  ];
}

export async function compileRoute({ mint, creator, shareholder, shareholders = null, graduated, blockhash }) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: ROUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ROUTE_PRIORITY_MICRO_LAMPORTS }),
    ...(await routeInstructions({ mint, creator, shareholder, shareholders, graduated })),
  ];
  const message = new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return { transaction, bytes: transaction.serialize() };
}

// What the register page needs to know about any pump.fun coin.
// A coin is on Route when every shareholder is one of Route's own addresses.
export async function inspectCoin({ connection, shareholder, allowed = null, mint: mintInput, fetchImpl = fetch }) {
  const mint = parseMint(mintInput);
  const accounts = coinAccounts(mint);
  const [curveInfo, configInfo, poolInfo, mintInfo] = await connection.getMultipleAccountsInfo([accounts.bondingCurve, accounts.config, accounts.pool, mint]);
  if (!curveInfo || !mintInfo) throw new HttpError('This is not a pump.fun coin.', 404, { field: 'mint' });
  const curve = decodeCurve(curveInfo);
  const config = decodeConfig(configInfo);
  const pool = decodePool(poolInfo);
  const metadata = await readTokenMetadata(connection, mint, mintInfo);
  const imageUrl = metadata?.uri ? await fetchMetadataImage(metadata.uri, { fetchImpl }) : '';
  const shareholders = config ? config.shareholders.map(holder => ({ address: holder.address.toBase58(), shareBps: holder.shareBps })) : [];
  const routeAddresses = new Set((allowed || [shareholder]).filter(Boolean).map(key => key.toBase58()));
  const onRoute = shareholders.length > 0 && routeAddresses.size > 0 && shareholders.every(entry => routeAddresses.has(entry.address));
  return {
    mint: mint.toBase58(),
    name: metadata?.name || '', symbol: metadata?.symbol || '', uri: metadata?.uri || '', imageUrl,
    tokenProgram: metadata?.tokenProgram || null,
    creator: config ? config.admin.toBase58() : curve.creator.toBase58(),
    complete: Boolean(curve.complete), graduated: Boolean(pool),
    sharing: config ? { admin: config.admin.toBase58(), revoked: Boolean(config.adminRevoked), shareholders } : null,
    onRoute,
    registrable: !config,
  };
}
