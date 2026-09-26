// Network checks against mainnet: builds real Fork transactions and simulates
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
  const built = await engine.build({ mint, name: 'Fork chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://useroute.io/m/${mint.publicKey.toBase58().slice(0, 12)}`, user: fundedUser, devBuyLamports: 0n });
  console.log(`create-only: ${built.create.size} bytes, ${built.unitsConsumed} CU; route ${built.route.size} bytes`);
  assert.ok(built.create.size <= 1232 && built.route.size <= 1232);
  assert.ok(built.unitsConsumed > 50_000 && built.unitsConsumed < 140_000, `units ${built.unitsConsumed}`);
});

test('create + dev buy simulates as one transaction on the live program', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Fork chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://useroute.io/m/${mint.publicKey.toBase58().slice(0, 12)}`, user: fundedUser, devBuyLamports: 10_000_000n });
  console.log(`create+buy: ${built.create.size} bytes, ${built.unitsConsumed} CU`);
  assert.ok(built.create.size <= 1232, `${built.create.size} bytes`);
  assert.ok(built.unitsConsumed > 100_000 && built.unitsConsumed < 400_000, `units ${built.unitsConsumed}`);
});

test('an unfunded wallet is told it needs SOL before signing anything', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  await assert.rejects(engine.build({ mint, name: 'Fork', symbol: 'ROUTE', uri: 'https://basket-site.up.railway.app/m/x.json', user: Keypair.generate().publicKey.toBase58(), devBuyLamports: 0n }), error => error.status === 400 && /more SOL/.test(error.message));
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
  catch (error) { if (/only be updated once/.test(error.message)) { t.skip('the creator locked this coin’s fee sharing between inspection and simulation'); return; } throw error; }
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
  const engine = createBuyback({ connection, store: { list: () => [], getMeta: () => ({}), setMeta: async () => {} }, treasury: buyer, signer: buyer, log: { info() {}, warn() {} } });
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

// The Fork main token has no fee sharing: its creator (the dev wallet) claims its own
// vaults. After migration pump sets the PumpSwap pool's coin_creator to the curve
// creator, so one claim takes the curve vault and the PumpSwap wSOL vault together.
// Simulated as the creator of a live graduated coin without fee sharing.
test('the direct creator claim takes both vaults of a migrated coin without fee sharing', async t => {
  const { createBuyback } = await import('./buyback.js');
  const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import('@solana/web3.js');
  const { NATIVE_MINT, TOKEN_PROGRAM_ID, AccountLayout, getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const { bondingCurvePda, canonicalPumpPoolPda, creatorVaultPda, feeSharingConfigPda } = await import('@pump-fun/pump-sdk');
  const { PUMP_AMM_SDK } = await import('@pump-fun/pump-swap-sdk');
  const { coinAccounts } = await import('./pump.js');
  const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const seen = new Set();
  let sample = null;
  for (const { signature } of await connection.getSignaturesForAddress(AMM, { limit: 40 })) {
    if (sample) break;
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
    if (!tx) continue;
    const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])].filter(key => !seen.has(key.toBase58()) && seen.add(key.toBase58()));
    for (const [index, info] of (await connection.getMultipleAccountsInfo(keys.slice(0, 100))).entries()) {
      if (!info?.owner.equals(AMM) || info.data.length < 200) continue;
      let pool; try { pool = PUMP_AMM_SDK.decodePool(info); } catch { continue; }
      if (!pool.quoteMint.equals(NATIVE_MINT) || !canonicalPumpPoolPda(pool.baseMint).equals(keys[index])) continue;
      const [curveInfo, configInfo] = await connection.getMultipleAccountsInfo([bondingCurvePda(pool.baseMint), feeSharingConfigPda(pool.baseMint)]);
      if (!curveInfo || configInfo) continue;
      const creator = PUMP_SDK.decodeBondingCurve(curveInfo).creator;
      assert.ok(pool.coinCreator.equals(creator), 'a migrated pool pays the curve creator');
      const ammVault = await connection.getAccountInfo(coinAccounts(pool.baseMint, creator).ammVaultAta);
      if (ammVault && BigInt(AccountLayout.decode(ammVault.data).amount.toString()) > 0n) { sample = { mint: pool.baseMint, creator }; break; }
    }
  }
  if (!sample) { t.skip('no graduated coin without fee sharing and with PumpSwap creator fees seen in the latest trades'); return; }
  const { mint, creator } = sample;
  const store = { list: () => [], get: () => null, getMeta: () => ({}), setMeta: async () => {} };
  const engine = createBuyback({ connection, store, treasury: { publicKey: creator }, signer: { publicKey: creator }, mainCoin: mint, log: { info() {}, warn() {} } });
  const instructions = await engine.buildClaim();
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...instructions] }).compileToV0Message());
  const accounts = coinAccounts(mint, creator), wsol = getAssociatedTokenAddressSync(NATIVE_MINT, creator, true, TOKEN_PROGRAM_ID);
  const watched = [creator, creatorVaultPda(creator), accounts.ammVaultAta, wsol];
  const before = await connection.getMultipleAccountsInfo(watched);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched.map(String) } });
  const vaultAfter = BigInt(AccountLayout.decode(Buffer.from(sim.value.accounts[2].data[0], 'base64')).amount.toString());
  const gained = BigInt(sim.value.accounts[0].lamports) - BigInt(before[0].lamports);
  const ammFees = BigInt(AccountLayout.decode(before[2].data).amount.toString());
  console.log(`direct claim ${mint.toBase58()} by ${creator.toBase58()}: ${tx.serialize().length} bytes, ${sim.value.unitsConsumed} CU, err=${JSON.stringify(sim.value.err)}, creator +${gained} lamports (PumpSwap vault ${ammFees}, curve vault ${before[1]?.lamports ?? 0})`);
  assert.equal(sim.value.err, null, (sim.value.logs || []).slice(-5).join(' | '));
  assert.equal(vaultAfter, 0n, 'the PumpSwap creator vault is emptied');
  assert.ok(gained >= ammFees - 10_000n, 'its SOL reaches the creator wallet, unwrapped');
  assert.ok(!sim.value.accounts[3] || sim.value.accounts[3].lamports === 0, 'no wSOL account is left behind');
});
