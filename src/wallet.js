import { getWallets } from '@wallet-standard/app';

// Wallet Standard only: Phantom, Solflare, Backpack and the rest register
// themselves on the page. No adapter UI library, so the buttons stay Route's.
export const CHAIN = 'solana:mainnet';
const SIGN = 'solana:signTransaction';
const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const REMEMBER_KEY = 'route-wallet-name';

const registry = getWallets();

export function listWallets() {
  return registry.get().filter(wallet => wallet.chains.includes(CHAIN) && wallet.features[SIGN] && wallet.features[CONNECT]);
}

export function onWalletsChange(callback) {
  const offRegister = registry.on('register', callback);
  const offUnregister = registry.on('unregister', callback);
  return () => { offRegister(); offUnregister(); };
}

export async function connectWallet(wallet, { silent = false } = {}) {
  const { accounts } = await wallet.features[CONNECT].connect(silent ? { silent: true } : undefined);
  const account = accounts.find(entry => entry.chains.includes(CHAIN)) || accounts[0];
  if (!account) throw new Error('No Solana account was shared by the wallet.');
  try { localStorage.setItem(REMEMBER_KEY, wallet.name); } catch { /* optional */ }
  return account;
}

export async function disconnectWallet(wallet) {
  try { localStorage.removeItem(REMEMBER_KEY); } catch { /* optional */ }
  await wallet?.features[DISCONNECT]?.disconnect().catch(() => {});
}

export function rememberedWalletName() {
  try { return localStorage.getItem(REMEMBER_KEY); } catch { return null; }
}

export async function signTransaction(wallet, account, bytes) {
  const [{ signedTransaction }] = await wallet.features[SIGN].signTransaction({ transaction: bytes, account, chain: CHAIN });
  return signedTransaction;
}

export function shortAddress(address = '') { return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address; }

export function isRejection(error) { return /reject|cancel|denied|closed|user/i.test(String(error?.message || error)); }
