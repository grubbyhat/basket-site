// Network check against mainnet: builds a real Route launch for a funded public
// key and simulates it on the live pump.fun program. Nothing is signed or sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createLaunchEngine } from './launch.js';

const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const treasury = process.env.ROUTE_TREASURY ? new PublicKey(process.env.ROUTE_TREASURY) : Keypair.generate().publicKey;
const lookupTable = process.env.ROUTE_LOOKUP_TABLE ? new PublicKey(process.env.ROUTE_LOOKUP_TABLE) : null;
// pump.fun's fee account: funded, public, only ever used as a simulated payer here.
const fundedUser = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';

test('create-only launch simulates successfully on the live program', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://basket-site.up.railway.app/m/${mint.publicKey.toBase58()}.json`, user: fundedUser, devBuyLamports: 0n });
  console.log(`create-only: ${built.size} bytes, ${built.unitsConsumed} CU`);
  assert.ok(built.size <= 1232);
  assert.ok(built.unitsConsumed > 50_000 && built.unitsConsumed < 140_000, `units ${built.unitsConsumed}`);
});

test('create + dev buy simulates through the lookup table', { skip: !lookupTable && 'set ROUTE_LOOKUP_TABLE after tools/create-lookup-table.mjs' }, async () => {
  const engine = createLaunchEngine({ connection, treasury, lookupTable });
  const mint = engine.newMint();
  const built = await engine.build({ mint, name: 'Route chain check coin name!!!!!', symbol: 'ROUTECHK12', uri: `https://basket-site.up.railway.app/m/${mint.publicKey.toBase58()}.json`, user: fundedUser, devBuyLamports: 10_000_000n });
  console.log(`create+buy: ${built.size} bytes, ${built.unitsConsumed} CU`);
  assert.ok(built.size <= 1232);
  assert.ok(built.unitsConsumed > 100_000 && built.unitsConsumed < 260_000, `units ${built.unitsConsumed}`);
});

test('an unfunded wallet is told it needs SOL before signing anything', async () => {
  const engine = createLaunchEngine({ connection, treasury });
  const mint = engine.newMint();
  await assert.rejects(engine.build({ mint, name: 'Route', symbol: 'ROUTE', uri: 'https://basket-site.up.railway.app/m/x.json', user: Keypair.generate().publicKey.toBase58(), devBuyLamports: 0n }), error => error.status === 400 && /more SOL/.test(error.message));
});
