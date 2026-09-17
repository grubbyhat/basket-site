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

// The treasury receives 100% of every Route coin's creator fees through pump.fun's
// fee-sharing config. Its secret is only needed to crank distributions (and pay
// their network fees); launches work with the public key alone.
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
// Address lookup table with pump.fun's static accounts. Needed for create + dev
// buy to fit in one transaction; created once with tools/create-lookup-table.mjs.
export const LOOKUP_TABLE = env.ROUTE_LOOKUP_TABLE ? new PublicKey(env.ROUTE_LOOKUP_TABLE) : null;
// GitHub account that receives every coin's fees on pump.fun (its social fee PDA is
// the shareholder, so pump.fun shows its profile picture). Without it the treasury
// wallet is the shareholder.
export const GITHUB_USER = (env.ROUTE_GITHUB || '').trim().replace(/^@/, '');
export const ADMIN_TOKEN = env.ROUTE_ADMIN_TOKEN || '';
// A coin's fees are collected once its vault holds at least this much.
export const COLLECT_MIN_LAMPORTS = Number(env.ROUTE_COLLECT_MIN_LAMPORTS || 10_000_000);
// The collector sweeps every coin's vault on this fixed interval.
export const COLLECT_SWEEP_MS = Math.max(2_000, Number(env.ROUTE_COLLECT_SWEEP_MS || 10_000));
