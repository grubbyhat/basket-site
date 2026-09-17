// Network checks against mainnet: builds real Route transactions and simulates
// them on the live pump.fun programs. Nothing is signed or sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { compileRoute, inspectCoin } from './fee-share.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { githubFeePda } from './github.js';
import { createLaunchEngine } from './launch.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_URL || rpc.replace(/^http/, 'ws') });
const treasury = process.env.ROUTE_TREASURY ? new PublicKey(process.env.ROUTE_TREASURY) : Keypair.generate().publicKey;
// pump.fun's fee account: funded, public, only ever used as a simulated payer here.
const fundedUser = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';

test('create-only launch simulates successfully on the live program', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://useroute.io/m/${mint.publicKey.toBase58().slice(0, 12)}`, user: fundedUser, devBuyLamports: 0n });
  console.log(`create-only: ${built.create.size} bytes, ${built.unitsConsumed} CU; route ${built.route.size} bytes`);
  assert.ok(built.create.size <= 1232 && built.route.size <= 1232);
  assert.ok(built.unitsConsumed > 50_000 && built.unitsConsumed < 140_000, `units ${built.unitsConsumed}`);
});

test('create + dev buy simulates as one transaction on the live program', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://useroute.io/m/${mint.publicKey.toBase58().slice(0, 12)}`, user: fundedUser, devBuyLamports: 10_000_000n });
  console.log(`create+buy: ${built.create.size} bytes, ${built.unitsConsumed} CU`);
  assert.ok(built.create.size <= 1232, `${built.create.size} bytes`);
  assert.ok(built.unitsConsumed > 100_000 && built.unitsConsumed < 400_000, `units ${built.unitsConsumed}`);
});

test('an unfunded wallet is told it needs SOL before signing anything', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  await assert.rejects(engine.build({ mint, name: 'Route', symbol: 'ROUTE', uri: 'https://basket-site.up.railway.app/m/x.json', user: Keypair.generate().publicKey.toBase58(), devBuyLamports: 0n }), error => error.status === 400 && /more SOL/.test(error.message));
});

// Watches the pump program for a fresh create so the fee-route transaction can be
// simulated against a live, unregistered coin with its real creator as signer.
async function freshCoin() {
  const signature = await new Promise(resolve => {
    const timer = setTimeout(() => { connection.removeOnLogsListener(id).catch(() => {}); resolve(null); }, 45_000);
    const id = connection.onLogs(PUMP_PROGRAM_ID, ({ signature: sig, logs, err }) => {
      if (err || !logs.some(line => /Instruction: CreateV2$/.test(line))) return;
      clearTimeout(timer);
      connection.removeOnLogsListener(id).catch(() => {});
      resolve(sig);
    }, 'confirmed');
  });
  if (!signature) return null;
  const details = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
  const mint = details?.meta?.postTokenBalances?.[0]?.mint;
  return mint || null;
}

test('the fee-route transaction simulates on a live coin with its creator', async t => {
  const mint = await freshCoin();
  if (!mint) { t.skip('no new pump.fun coin appeared within 45 s'); return; }
  const coin = await inspectCoin({ connection, shareholder: treasury, mint });
  console.log(`fresh coin ${mint} ${coin.name} $${coin.symbol} by ${coin.creator} registrable=${coin.registrable} image=${coin.imageUrl ? 'yes' : 'no'}`);
  assert.equal(coin.registrable, true);
  assert.ok(coin.name && coin.symbol);
  const engine = createLaunchEngine({ connection, treasury });
  const balance = await connection.getBalance(new PublicKey(coin.creator));
  if (balance < 5_000_000) { t.skip(`creator ${coin.creator} holds ${balance} lamports; the config rent needs more`); return; }
  let route;
  try { route = await engine.buildRoute({ mint, creator: coin.creator, graduated: coin.graduated }); }
  catch (error) { if (/only be updated once/.test(error.message)) { t.skip('the creator locked this coin's fee sharing between inspection and simulation'); return; } throw error; }
  console.log(`route: ${route.size} bytes, ${route.unitsConsumed} CU`);
  assert.ok(route.size <= 1232);
  assert.ok(route.unitsConsumed > 50_000 && route.unitsConsumed < 200_000, `units ${route.unitsConsumed}`);
});

// pump-native GitHub recipient: the fee route names the GitHub social fee PDA, and
// the PDA itself is created by any payer. Both simulated with sigVerify off.
test('a fee route to a GitHub fee account and the account creation simulate', async t => {
  const githubPda = githubFeePda('109759539');
  const create = await PUMP_SDK.createSocialFeePda({ payer: new PublicKey(fundedUser), userId: '109759539', platform: 2 });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(fundedUser), recentBlockhash: blockhash, instructions: [create] }).compileToV0Message());
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const exists = Boolean(await connection.getAccountInfo(githubPda));
  console.log(`github pda ${githubPda.toBase58()} exists=${exists} create sim err=${JSON.stringify(sim.value.err)} units=${sim.value.unitsConsumed}`);
  assert.ok(exists || !sim.value.err, 'creating the GitHub fee account simulates when it does not exist yet');
  const mint = await freshCoin();
  if (!mint) { t.skip('no new pump.fun coin appeared within 45 s'); return; }
  const coin = await inspectCoin({ connection, shareholder: githubPda, mint });
  const { transaction } = await compileRoute({ mint: new PublicKey(mint), creator: new PublicKey(coin.creator), shareholder: githubPda, graduated: coin.graduated, blockhash });
  const routeSim = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  console.log(`route to github pda on ${mint}: err=${JSON.stringify(routeSim.value.err)} units=${routeSim.value.unitsConsumed}`);
  if (routeSim.value.err && /insufficient|"Custom":1}/.test(JSON.stringify(routeSim.value))) { t.skip('the fresh creator cannot pay the config rent'); return; }
  assert.equal(routeSim.value.err, null, (routeSim.value.logs || []).slice(-4).join(' | '));
});

// Finds a coin trading on PumpSwap by watching the AMM program for a moment and
// decoding the pool an instruction touched.
async function graduatedCoin() {
  const { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK } = await import('@pump-fun/pump-swap-sdk');
  const signature = await new Promise(resolve => {
    const timer = setTimeout(() => { connection.removeOnLogsListener(id).catch(() => {}); resolve(null); }, 30_000);
    const id = connection.onLogs(PUMP_AMM_PROGRAM_ID, ({ signature: sig, logs, err }) => {
      if (err || !logs.some(line => /Instruction: (Buy|Sell)$/.test(line))) return;
      clearTimeout(timer);
      connection.removeOnLogsListener(id).catch(() => {});
      resolve(sig);
    }, 'confirmed');
  });
  if (!signature) return null;
  const details = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
  if (!details) return null;
  const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
  const all = []; for (let i = 0; i < keys.length; i += 1) all.push(keys.get(i));
  const infos = await connection.getMultipleAccountsInfo(all);
  for (let i = 0; i < all.length; i += 1) {
    const info = infos[i];
    if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) continue;
    try { const pool = PUMP_AMM_SDK.decodePool(info); if (pool?.baseMint && pool.quoteMint.toBase58() === 'So11111111111111111111111111111111111111112' && pool.index === 0) return pool.baseMint.toBase58(); } catch { /* not a pool */ }
  }
  return null;
}

// Buyback builders: a bonding-curve buy on a live curve and a PumpSwap buy on a
// graduated coin, both simulated with a funded public key as the buyer.
test('buyback transactions build and simulate on both venues', async () => {
  const { createBuyback } = await import('./buyback.js');
  const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import('@solana/web3.js');
  const buyer = { publicKey: new PublicKey(fundedUser) };
  const engine = createBuyback({ connection, store: { list: () => [], getMeta: () => ({}), setMeta: async () => {} }, treasury: buyer, log: { info() {}, warn() {} } });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const graduated = await graduatedCoin();
  console.log(`pumpswap sample coin: ${graduated || 'none seen in 30 s'}`);
  for (const [label, mint] of [['bonding-curve', '3f37GChEcVS2SJ2D5RmJijfCJ89xmfibC9CZjr3Dpump'], ...(graduated ? [['pumpswap', graduated]] : [])]) {
    const built = await engine.buildBuy(mint, 10_000_000n);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...built.instructions] }).compileToV0Message());
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    console.log(`buy ${label} (${built.venue}): ${tx.serialize().length} bytes err=${JSON.stringify(sim.value.err)} units=${sim.value.unitsConsumed}`);
    assert.equal(built.venue, label);
    assert.equal(sim.value.err, null, (sim.value.logs || []).slice(-5).join(' | '));
  }
});
