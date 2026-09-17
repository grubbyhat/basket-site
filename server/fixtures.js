// Offline stand-ins for the RPC, built from captured mainnet accounts.
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';

export const pumpState = JSON.parse(await readFile(new URL('./fixtures/pump-state.json', import.meta.url), 'utf8'));
export const pumpCoin = JSON.parse(await readFile(new URL('./fixtures/pump-coin.json', import.meta.url), 'utf8'));
export const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

export const account = entry => (entry && !entry.missing ? { owner: new PublicKey(entry.owner), data: Buffer.from(entry.data, 'base64'), executable: false, lamports: entry.lamports ?? 1, rentEpoch: 0 } : null);

// Answers account reads from the fixtures and records subscriptions instead of opening a socket.
export function offlineConnection({ extra = {}, vaultLamports = null } = {}) {
  const table = new Map();
  table.set(pumpState.global.address, account(pumpState.global));
  table.set(pumpState.feeConfig.address, account(pumpState.feeConfig));
  table.set(pumpCoin.mint.address, account(pumpCoin.mint));
  table.set(pumpCoin.bondingCurve.address, account(pumpCoin.bondingCurve));
  if (vaultLamports !== null) table.set(pumpCoin.vault.address, { owner: new PublicKey('11111111111111111111111111111111'), data: Buffer.alloc(0), executable: false, lamports: vaultLamports, rentEpoch: 0 });
  for (const [key, value] of Object.entries(extra)) table.set(key, value);
  const subscriptions = new Map();
  let nextId = 1;
  return {
    subscriptions,
    async getAccountInfo(key) { return table.get(key.toBase58()) || null; },
    async getMultipleAccountsInfo(keys) { return keys.map(key => table.get(key.toBase58()) || null); },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }; },
    async getAddressLookupTable() { return { value: null }; },
    async simulateTransaction() { return { value: { err: null, logs: [], unitsConsumed: 1 } }; },
    async sendRawTransaction() { throw new Error('offline'); },
    onAccountChange(key, handler) { const id = nextId++; subscriptions.set(id, { key: key.toBase58(), handler }); return id; },
    async removeAccountChangeListener(id) { subscriptions.delete(id); },
    push(address, info) { for (const entry of subscriptions.values()) if (entry.key === address) entry.handler(info, { slot: 1 }); },
  };
}
