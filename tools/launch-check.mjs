// End-to-end launch flow in a headless browser with a mock Wallet Standard wallet
// that signs for real. Starts its own Route server on a temporary data directory.
//   1. A real prepare against mainnet state for an unfunded wallet must stop before
//      signing with "needs more SOL" (nothing is broadcast).
//   2. With prepare/send/status answered locally, the wallet signs the real
//      transaction bytes and the success screen appears; the signature is verified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } from '@pump-fun/pump-sdk';
import nacl from 'tweetnacl';
import { createLaunchEngine } from '../server/launch.js';

const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = Number(process.env.ROUTE_CHECK_PORT || 5276);
const origin = `http://127.0.0.1:${port}`;
const treasury = Keypair.generate().publicKey;
const wallet = Keypair.generate();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'route-ui-'));
await mkdir('artifacts', { recursive: true });

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ROUTE_TREASURY: treasury.toBase58(), PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
for (let i = 0; i < 100; i += 1) {
  try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* not up yet */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAHklEQVR42u3NMQEAAAgDoK1/aM3g4QcFqDN1qFQjHA4PBjNZtPYOAAAAAElFTkSuQmCC', 'base64');
const AVATAR = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#b5dcc7"/></svg>').toString('base64');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.exposeFunction('__routeMockSign', async base64 => {
  const transaction = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  transaction.sign([wallet]);
  return Buffer.from(transaction.serialize()).toString('base64');
});
await page.addInitScript(({ address, publicKey }) => {
  const account = { address, publicKey: Uint8Array.from(publicKey), chains: ['solana:mainnet'], features: ['solana:signTransaction'], label: 'Mock', icon: undefined };
  const toBase64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
  const mock = {
    version: '1.0.0', name: 'Mock Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4IDgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiMzYjQ2NDciLz48L3N2Zz4=',
    chains: ['solana:mainnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { mock.accounts = [account]; return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { mock.accounts = []; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async input => ({ signedTransaction: fromBase64(await window.__routeMockSign(toBase64(input.transaction))) }))) },
    },
  };
  window.addEventListener('wallet-standard:app-ready', event => event.detail.register(mock));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(mock) }));
}, { address: wallet.publicKey.toBase58(), publicKey: Array.from(wallet.publicKey.toBytes()) });
await page.route('**/api/x/*', route => {
  const handle = decodeURIComponent(route.request().url().split('/api/x/')[1]).toLowerCase();
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: handle === 'jack' ? '12' : '44196397', handle, name: handle === 'jack' ? 'jack' : 'Elon Musk', avatarUrl: AVATAR }) });
});

try {
  await page.goto(`${origin}/launch`);
  await page.locator('#handle-0').fill('jack');
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.locator('#handle-1').fill('elonmusk');
  await page.getByRole('button', { name: 'Split evenly' }).click();
  await page.locator('#name').fill('Route Check');
  await page.locator('#ticker').fill('RCHECK');
  await page.locator('#token-image').setInputFiles({ name: 'art.png', mimeType: 'image/png', buffer: PNG });
  await page.getByAltText('Selected token artwork').waitFor();
  await page.getByText('Elon Musk').first().waitFor();
  assert.equal(await page.locator('.recipient-row .avatar img').count(), 2, 'both recipients show pictures');

  // Connect through the review step.
  await page.getByRole('button', { name: 'Review launch' }).click();
  await page.getByRole('button', { name: 'Connect wallet to launch' }).click();
  await page.getByRole('button', { name: /Mock Wallet/ }).click();
  await page.getByRole('button', { name: 'Launch on pump.fun' }).waitFor();
  const short = `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}`;
  await page.locator('.topbar').getByText(short).waitFor();
  await page.screenshot({ path: 'artifacts/launch-review-connected.png' });

  // 1. Real prepare: the server checks pump.fun state on mainnet and refuses an unfunded payer.
  await page.getByRole('button', { name: 'Launch on pump.fun' }).click();
  await page.getByText('Your wallet needs more SOL to cover this launch.').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.screenshot({ path: 'artifacts/launch-needs-sol.png' });
  const hosted = await fetch(`${origin}/api/launches`).then(response => response.json());
  assert.deepEqual(hosted.launches, [], 'nothing is recorded as launched');

  // 2. Locally answered prepare/send/status with a real message the wallet must sign.
  const fixture = JSON.parse(await readFile(new URL('../server/fixtures/pump-state.json', import.meta.url), 'utf8'));
  const account = entry => ({ owner: new PublicKey(entry.owner), data: Buffer.from(entry.data, 'base64'), executable: false, lamports: 1, rentEpoch: 0 });
  const offline = createLaunchEngine({ connection: { async getAccountInfo(key) { return key.equals(GLOBAL_PDA) ? account(fixture.global) : key.equals(PUMP_FEE_CONFIG_PDA) ? account(fixture.feeConfig) : null; } }, treasury });
  const mint = offline.newMint();
  const compiled = await offline.compile({ mint, name: 'Route Check', symbol: 'RCHECK', uri: `${origin}/m/${mint.publicKey.toBase58()}.json`, user: wallet.publicKey, devBuyLamports: 0n, blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi' });
  const expectedMessage = compiled.transaction.message.serialize();
  let signedBytes = null;
  await page.route('**/api/launch/prepare', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mint: mint.publicKey.toBase58(), transaction: Buffer.from(compiled.bytes).toString('base64'), lastValidBlockHeight: 1 }) }));
  await page.route('**/api/launch/send', route => {
    const body = route.request().postDataJSON();
    signedBytes = Buffer.from(body.signedTransaction, 'base64');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mint: body.mint, signature: 'MockSignature111' }) });
  });
  let polls = 0;
  await page.route(`**/api/launch/${mint.publicKey.toBase58()}`, route => { polls += 1; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mint: mint.publicKey.toBase58(), status: polls < 2 ? 'sent' : 'confirmed', name: 'Route Check', symbol: 'RCHECK', signature: 'MockSignature111', pumpUrl: `https://pump.fun/coin/${mint.publicKey.toBase58()}`, recipients: [{ handle: 'jack', xId: '12' }, { handle: 'elonmusk', xId: '44196397' }] }) }); });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'Your coin is live.' }).waitFor({ timeout: 20_000 });
  await page.getByText(mint.publicKey.toBase58()).waitFor();
  assert.equal(await page.getByRole('link', { name: /View on pump.fun/ }).getAttribute('href'), `https://pump.fun/coin/${mint.publicKey.toBase58()}`);
  await page.screenshot({ path: 'artifacts/launch-live.png' });
  assert.ok(signedBytes, 'the wallet signature reached send');
  const signed = VersionedTransaction.deserialize(signedBytes);
  assert.deepEqual(Buffer.from(signed.message.serialize()), Buffer.from(expectedMessage), 'the wallet signed exactly the prepared message');
  assert.ok(nacl.sign.detached.verify(expectedMessage, signed.signatures[0], wallet.publicKey.toBytes()), 'the wallet signature verifies');
  assert.ok(nacl.sign.detached.verify(expectedMessage, signed.signatures[1], mint.publicKey.toBytes()), 'the mint signature survived the wallet');
  await page.getByRole('button', { name: 'Launch another' }).click();
  assert.equal(await page.locator('#name').inputValue(), '', 'a confirmed launch starts a fresh draft');

  // Disconnect from the topbar menu.
  await page.locator('.wallet-menu > summary').click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Connect wallet' }).waitFor();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: wallet connect, X pictures, real prepare refusal for an unfunded wallet, signed launch flow and disconnect.');
} catch (error) {
  await page.screenshot({ path: 'artifacts/launch-check-failure.png' }).catch(() => {});
  console.error(error);
  console.error('--- server log ---\n' + serverLog.slice(-4000));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
