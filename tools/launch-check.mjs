// End-to-end flows in a headless browser with a mock Wallet Standard wallet that
// signs for real. Starts its own Route server on a temporary data directory.
//   1. A real prepare against mainnet state for an unfunded wallet must stop before
//      signing with "needs more SOL" (nothing is broadcast).
//   2. With prepare/send/status answered locally, the wallet signs both real launch
//      messages (create + fee route) in one prompt and the success screen appears;
//      both signatures and the mint's co-signature are verified.
//   3. Registering an existing coin: lookup, creator check, one signed route transaction.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { compileRoute } from '../server/fee-share.js';
import { createLaunchEngine } from '../server/launch.js';
import { BLOCKHASH, offlineConnection, pumpCoin } from '../server/fixtures.js';

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
const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
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
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => { window.__signPrompts = (window.__signPrompts || 0) + 1; return Promise.all(inputs.map(async input => ({ signedTransaction: fromBase64(await window.__routeMockSign(toBase64(input.transaction))) }))); } },
    },
  };
  window.addEventListener('wallet-standard:app-ready', event => event.detail.register(mock));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(mock) }));
}, { address: wallet.publicKey.toBase58(), publicKey: Array.from(wallet.publicKey.toBytes()) });
await page.route('**/api/x/*', route => {
  const handle = decodeURIComponent(route.request().url().split('/api/x/')[1]).toLowerCase();
  route.fulfill(json({ id: handle === 'jack' ? '12' : '44196397', handle, name: handle === 'jack' ? 'jack' : 'Elon Musk', avatarUrl: AVATAR }));
});
const verifySignedBy = (bytes, expectedMessage, signers) => {
  const signed = VersionedTransaction.deserialize(bytes);
  assert.deepEqual(Buffer.from(signed.message.serialize()), Buffer.from(expectedMessage), 'the wallet signed exactly the prepared message');
  signers.forEach((signer, index) => assert.ok(nacl.sign.detached.verify(expectedMessage, signed.signatures[index], signer.toBytes()), `signature ${index} verifies`));
};

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
  assert.deepEqual((await fetch(`${origin}/api/coins`).then(response => response.json())).coins, [], 'nothing is recorded as a coin');

  // 2. Locally answered prepare/send/status with real messages the wallet must sign.
  const offline = createLaunchEngine({ connection: offlineConnection(), treasury });
  const mint = offline.newMint();
  const create = await offline.compile({ mint, name: 'Route Check', symbol: 'RCHECK', uri: `${origin}/m/${mint.publicKey.toBase58()}.json`, user: wallet.publicKey, devBuyLamports: 0n, blockhash: BLOCKHASH });
  const route = await compileRoute({ mint: mint.publicKey, creator: wallet.publicKey, treasury, graduated: false, blockhash: BLOCKHASH });
  let signedLaunch = null;
  await page.route('**/api/launch/prepare', r => r.fulfill(json({ mint: mint.publicKey.toBase58(), transactions: [Buffer.from(create.bytes).toString('base64'), Buffer.from(route.bytes).toString('base64')], lastValidBlockHeight: 1 })));
  await page.route('**/api/launch/send', r => { signedLaunch = r.request().postDataJSON(); r.fulfill(json({ mint: signedLaunch.mint, signature: 'MockSignature111' })); });
  let polls = 0;
  const launched = { mint: mint.publicKey.toBase58(), status: 'confirmed', name: 'Route Check', symbol: 'RCHECK', signature: 'MockSignature111', pumpUrl: `https://pump.fun/coin/${mint.publicKey.toBase58()}`, recipients: [{ handle: 'jack', xId: '12', basisPoints: 5000 }, { handle: 'elonmusk', xId: '44196397', basisPoints: 5000 }], route: { status: 'pending' }, wallet: wallet.publicKey.toBase58(), createdAt: new Date().toISOString(), kind: 'launch', fees: { distributedLamports: '0', claims: [] } };
  await page.route(`**/api/launch/${mint.publicKey.toBase58()}`, r => { polls += 1; r.fulfill(json({ ...launched, status: polls < 2 ? 'sent' : 'confirmed', route: { status: polls < 3 ? 'pending' : 'active', signature: 'MockRoute111' } })); });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'Your coin is live.' }).waitFor({ timeout: 30_000 });
  await page.getByText(mint.publicKey.toBase58()).waitFor();
  await page.screenshot({ path: 'artifacts/launch-live.png' });
  assert.equal(await page.evaluate(() => window.__signPrompts), 1, 'both transactions were signed in one wallet prompt');
  assert.ok(signedLaunch && signedLaunch.signedTransactions.length === 2, 'send received both signatures');
  verifySignedBy(Buffer.from(signedLaunch.signedTransactions[0], 'base64'), create.transaction.message.serialize(), [wallet.publicKey, mint.publicKey]);
  verifySignedBy(Buffer.from(signedLaunch.signedTransactions[1], 'base64'), route.transaction.message.serialize(), [wallet.publicKey]);
  await page.getByRole('button', { name: 'Launch another' }).click();
  assert.equal(await page.locator('#name').inputValue(), '', 'a confirmed launch starts a fresh draft');

  // 3. Register an existing coin: the fixture coin, with the mock wallet posing as its creator.
  const existing = new PublicKey(pumpCoin.mint.address);
  const registerRoute = await compileRoute({ mint: existing, creator: wallet.publicKey, treasury, graduated: false, blockhash: BLOCKHASH });
  let signedRegister = null;
  await page.route(`**/api/coin/${existing.toBase58()}/inspect`, r => r.fulfill(json({ mint: existing.toBase58(), name: 'CATECOIN', symbol: '$CAT', uri: '', imageUrl: '', creator: wallet.publicKey.toBase58(), complete: false, graduated: false, sharing: null, onRoute: false, registrable: true, record: null })));
  await page.route('**/api/route/prepare', r => { const body = r.request().postDataJSON(); assert.equal(body.wallet, wallet.publicKey.toBase58()); assert.deepEqual(body.recipients, [{ handle: 'jack', basisPoints: 10000 }]); r.fulfill(json({ mint: existing.toBase58(), transactions: [Buffer.from(registerRoute.bytes).toString('base64')], lastValidBlockHeight: 1 })); });
  await page.route('**/api/route/send', r => { signedRegister = r.request().postDataJSON(); r.fulfill(json({ mint: existing.toBase58() })); });
  let coinPolls = 0;
  await page.route(`**/api/coin/${existing.toBase58()}`, r => { coinPolls += 1; r.fulfill(json({ sol: { usd: 100 }, coin: { mint: existing.toBase58(), kind: 'registered', status: 'confirmed', name: 'CATECOIN', symbol: '$CAT', wallet: wallet.publicKey.toBase58(), recipients: [{ handle: 'jack', xId: '12', basisPoints: 10000 }], route: { status: coinPolls < 2 ? 'sent' : 'active' }, fees: { distributedLamports: '0', claims: [] }, createdAt: new Date().toISOString(), pumpUrl: `https://pump.fun/coin/${existing.toBase58()}`, live: { phase: 'bonding', bonded: false, progress: 0.42, mcapSol: 32, mcapUsd: 3200, feesSol: 0.25, feesUsd: 25, collectedSol: 0.1, unclaimedSol: 0.15, unclaimedLamports: '150000000' } } })); });
  await page.goto(`${origin}/register`);
  await page.locator('#mint').fill(existing.toBase58());
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByText('CATECOIN').first().waitFor();
  await page.locator('#handle-0').fill('jack');
  await page.getByText('found on X').waitFor();
  await page.getByRole('button', { name: 'Put fees on Route' }).click();
  await page.getByText('Creator fees for $CAT now route to your people.').waitFor({ timeout: 30_000 });
  assert.ok(signedRegister, 'the route signature reached the server');
  verifySignedBy(Buffer.from(signedRegister.signedTransaction, 'base64'), registerRoute.transaction.message.serialize(), [wallet.publicKey]);
  await page.screenshot({ path: 'artifacts/register-done.png' });
  await page.getByRole('link', { name: /Open the coin page/ }).click();
  await page.getByRole('heading', { name: /CATECOIN/ }).waitFor();
  await page.getByText('Bonding 42%').waitFor();
  await page.getByText('$3.2K').waitFor();
  await page.screenshot({ path: 'artifacts/coin-page.png', fullPage: true });

  await page.locator('.wallet-menu > summary').click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Connect wallet' }).waitFor();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: wallet connect, X pictures, real prepare refusal, two-transaction launch signed in one prompt, coin registration, coin page and disconnect.');
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
