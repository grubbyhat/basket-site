import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const env = process.env;
const root = fileURLToPath(new URL('..', import.meta.url));

export const PORT = Number(env.PORT || 5275);
export const DATA_DIR = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data');
export const DIST_DIR = path.join(root, 'dist');
export const RPC_URL = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
export const WS_URL = env.SOLANA_WS_URL || RPC_URL.replace(/^http/, 'ws');
export const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)).replace(/\/$/, '');

// The treasury receives the direct fee share and authorized GitHub withdrawals.
// Its key pays for distributions and forwards confirmed buyback allocations.
export function parseSecret(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const bytes = value.startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value);
  return Keypair.fromSecretKey(bytes);
}
export const TREASURY_KEYPAIR = parseSecret(env.ROUTE_TREASURY_SECRET);
export const TREASURY = env.ROUTE_TREASURY ? new PublicKey(env.ROUTE_TREASURY) : TREASURY_KEYPAIR?.publicKey || null;
if (TREASURY_KEYPAIR && TREASURY && !TREASURY_KEYPAIR.publicKey.equals(TREASURY)) {
  throw new Error('ROUTE_TREASURY does not match ROUTE_TREASURY_SECRET.');
}
// GitHub account that receives every coin's fees on pump.fun (its social fee PDA is
// the shareholder, so pump.fun shows its profile picture). Without it the treasury
// wallet is the shareholder.
export const GITHUB_USER = (env.ROUTE_GITHUB || '').trim().replace(/^@/, '');
export const ADMIN_TOKEN = env.ROUTE_ADMIN_TOKEN || '';
// The Route coin that fees are bought back into, and the share of every other
// coin's fees that goes to the treasury for those buybacks (500 = 5%).
export const MAIN_COIN = env.ROUTE_MAIN_COIN ? new PublicKey(env.ROUTE_MAIN_COIN) : null;
// The wallet that buys the main coin (the dev wallet that launched it). The treasury
// forwards confirmed buyback money to it. Unset: buybacks remain unavailable.
export const BUYBACK_KEYPAIR = parseSecret(env.ROUTE_BUYBACK_SECRET);
export const BUYBACK_SHARE_BPS = Math.min(10000, Math.max(0, Number(env.ROUTE_BUYBACK_SHARE_BPS || 500)));
export const BUYBACK_MIN_LAMPORTS = Number(env.ROUTE_BUYBACK_MIN_LAMPORTS || 100_000_000);
export const BUYBACK_SLIPPAGE_PERCENT = Number(env.ROUTE_BUYBACK_SLIPPAGE_PERCENT || 10);
// A coin's fees are collected once its vault holds at least this much.
export const COLLECT_MIN_LAMPORTS = Number(env.ROUTE_COLLECT_MIN_LAMPORTS || 10_000_000);
// The collector sweeps every coin's vault on this fixed interval.
export const COLLECT_SWEEP_MS = Math.max(2_000, Number(env.ROUTE_COLLECT_SWEEP_MS || 10_000));
