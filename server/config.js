import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const env = process.env;
const root = fileURLToPath(new URL('..', import.meta.url));

export const PORT = Number(env.PORT || 5275);
export const DATA_DIR = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data');
export const DIST_DIR = path.join(root, 'dist');
export const RPC_URL = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
export const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)).replace(/\/$/, '');
// The pump.fun creator of every Route coin. Creator fees accrue to this key's
// creator vault, where the payout service will collect them. Public key only.
export const TREASURY = env.ROUTE_TREASURY ? new PublicKey(env.ROUTE_TREASURY) : null;
// Address lookup table with pump.fun's static accounts. Needed for create + dev
// buy to fit in one transaction; created once with tools/create-lookup-table.mjs.
export const LOOKUP_TABLE = env.ROUTE_LOOKUP_TABLE ? new PublicKey(env.ROUTE_LOOKUP_TABLE) : null;
