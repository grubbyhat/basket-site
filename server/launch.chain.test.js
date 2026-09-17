// Network checks against mainnet: builds real Route transactions and simulates
// them on the live pump.fun programs. Nothing is signed or sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { inspectCoin } from './fee-share.js';
import { createLaunchEngine } from './launch.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_URL || rpc.replace(/^http/, 'ws') });
const treasury = process.env.ROUTE_TREASURY ? new PublicKey(process.env.ROUTE_TREASURY) : Keypair.generate().publicKey;
const lookupTable = process.env.ROUTE_LOOKUP_TABLE ? new PublicKey(process.env.ROUTE_LOOKUP_TABLE) : null;
// pump.fun's fee account: funded, public, only ever used as a simulated payer here.
const fundedUser = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';

test('create-only launch simulates successfully on the live program', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://basket-site.up.railway.app/m/${mint.publicKey.toBase58()}.json`, user: fundedUser, devBuyLamports: 0n });
  console.log(`create-only: ${built.create.size} bytes, ${built.unitsConsumed} CU; route ${built.route.size} bytes`);
  assert.ok(built.create.size <= 1232 && built.route.size <= 1232);
  assert.ok(built.unitsConsumed > 50_000 && built.unitsConsumed < 140_000, `units ${built.unitsConsumed}`);
});

test('create + dev buy simulates through the lookup table', { skip: !lookupTable && 'set ROUTE_LOOKUP_TABLE after tools/create-lookup-table.mjs' }, async () => {
  const engine = createLaunchEngine({ connection, treasury, lookupTable });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://basket-site.up.railway.app/m/${mint.publicKey.toBase58()}.json`, user: fundedUser, devBuyLamports: 10_000_000n });
  console.log(`create+buy: ${built.create.size} bytes, ${built.unitsConsumed} CU`);
  assert.ok(built.create.size <= 1232);
  assert.ok(built.unitsConsumed > 100_000 && built.unitsConsumed < 260_000, `units ${built.unitsConsumed}`);
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
  const details = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const mint = details?.meta?.postTokenBalances?.[0]?.mint;
  return mint || null;
}

test('the fee-route transaction simulates on a live coin with its creator', async t => {
  const mint = await freshCoin();
  if (!mint) { t.skip('no new pump.fun coin appeared within 45 s'); return; }
  const coin = await inspectCoin({ connection, treasury, mint });
  console.log(`fresh coin ${mint} ${coin.name} $${coin.symbol} by ${coin.creator} registrable=${coin.registrable} image=${coin.imageUrl ? 'yes' : 'no'}`);
  assert.equal(coin.registrable, true);
  assert.ok(coin.name && coin.symbol);
  const engine = createLaunchEngine({ connection, treasury });
  const balance = await connection.getBalance(new PublicKey(coin.creator));
  if (balance < 5_000_000) { t.skip(`creator ${coin.creator} holds ${balance} lamports; the config rent needs more`); return; }
  const route = await engine.buildRoute({ mint, creator: coin.creator, graduated: coin.graduated });
  console.log(`route: ${route.size} bytes, ${route.unitsConsumed} CU`);
  assert.ok(route.size <= 1232);
  assert.ok(route.unitsConsumed > 50_000 && route.unitsConsumed < 200_000, `units ${route.unitsConsumed}`);
});
