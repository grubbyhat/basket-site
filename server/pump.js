// pump.fun account addresses and decoders shared by the launch, register, watch
// and collect paths. All amounts are lamports as BigInt.
import { PublicKey } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getTokenMetadata } from '@solana/spl-token';
import { PUMP_SDK, ammCreatorVaultPda, bondingCurveMarketCap, bondingCurvePda, canonicalPumpPoolPda, creatorVaultPda, feeSharingConfigPda } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK, poolMarketCap } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';

export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
// Rent kept by an empty system account; the creator vault holds this much when drained.
export const RENT_EXEMPT_EMPTY = 890_880n;

export function coinAccounts(mint) {
  const config = feeSharingConfigPda(mint);
  return {
    bondingCurve: bondingCurvePda(mint),
    config,
    vault: creatorVaultPda(config),
    pool: canonicalPumpPoolPda(mint),
    ammVaultAta: getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(config), true, TOKEN_PROGRAM_ID),
  };
}

export const decodeCurve = info => (info ? PUMP_SDK.decodeBondingCurve(info) : null);
export const decodeConfig = info => (info ? PUMP_SDK.decodeSharingConfig(info) : null);
export const decodePool = info => (info ? PUMP_AMM_SDK.decodePool(info) : null);
export const tokenAmount = info => (info ? BigInt(AccountLayout.decode(info.data).amount.toString()) : 0n);
export const big = value => BigInt(value.toString());

// Progress uses only the curve's own state: the SOL it holds against the SOL the
// constant product still needs before its real token reserves run out. That holds
// for standard and mayhem curves alike, whose starting reserves differ.
export function curveStats(curve) {
  const mcap = bondingCurveMarketCap({ mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves });
  const virtualQuote = big(curve.virtualQuoteReserves), virtualTokens = big(curve.virtualTokenReserves), realTokens = big(curve.realTokenReserves), realQuote = big(curve.realQuoteReserves);
  const finalVirtualTokens = virtualTokens - realTokens;
  const needed = finalVirtualTokens > 0n ? (virtualQuote * virtualTokens) / finalVirtualTokens - virtualQuote : 0n;
  const progress = curve.complete ? 1 : realQuote + needed > 0n ? Number(realQuote) / Number(realQuote + needed) : 0;
  return { mcapLamports: big(mcap), progress: Math.min(1, Math.max(0, progress)), complete: Boolean(curve.complete), creator: curve.creator.toBase58(), supply: big(curve.tokenTotalSupply), neededLamports: needed };
}

export function poolStats({ supply, baseReserve, quoteReserve, isMayhemMode = false }) {
  if (baseReserve <= 0n) return { mcapLamports: 0n };
  return { mcapLamports: big(poolMarketCap({ baseMintSupply: new BN(supply.toString()), baseReserve: new BN(baseReserve.toString()), quoteReserve: new BN(quoteReserve.toString()), isMayhemMode })) };
}

function readBorshString(data, offset) {
  const length = data.readUInt32LE(offset);
  return { value: data.subarray(offset + 4, offset + 4 + length).toString('utf8').replace(/\0+$/, '').trim(), next: offset + 4 + length };
}

// Coins created through `create_v2` keep their metadata in the Token-2022 mint;
// older coins use a Metaplex metadata account.
export async function readTokenMetadata(connection, mint, mintInfo = null) {
  const info = mintInfo || await connection.getAccountInfo(mint);
  if (!info) return null;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const metadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return metadata ? { name: metadata.name.trim(), symbol: metadata.symbol.trim(), uri: metadata.uri.trim(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() } : null;
  }
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM);
  const account = await connection.getAccountInfo(pda);
  if (!account) return null;
  const name = readBorshString(account.data, 1 + 32 + 32);
  const symbol = readBorshString(account.data, name.next);
  const uri = readBorshString(account.data, symbol.next);
  return { name: name.value, symbol: symbol.value, uri: uri.value, tokenProgram: TOKEN_PROGRAM_ID.toBase58() };
}

export async function fetchMetadataImage(uri, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(uri, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!response.ok) return '';
    const body = await response.json();
    const image = typeof body?.image === 'string' ? body.image.trim() : '';
    return /^https?:\/\//.test(image) ? image : image.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${image.slice(7)}` : '';
  } catch { return ''; }
}
