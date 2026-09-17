import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } from '@pump-fun/pump-sdk';
import nacl from 'tweetnacl';
import { MAX_TRANSACTION_BYTES, createLaunchEngine, describeSimulationError } from './launch.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/pump-state.json', import.meta.url), 'utf8'));
const account = entry => ({ owner: new PublicKey(entry.owner), data: Buffer.from(entry.data, 'base64'), executable: false, lamports: 1, rentEpoch: 0 });
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

// A connection that answers from the captured fixture and never sends anything.
function offlineConnection() {
  return {
    async getAccountInfo(key) {
      if (key.equals(GLOBAL_PDA)) return account(fixture.global);
      if (key.equals(PUMP_FEE_CONFIG_PDA)) return account(fixture.feeConfig);
      return null;
    },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }; },
    async getAddressLookupTable() { return { value: null }; },
    async simulateTransaction() { return { value: { err: null, logs: [], unitsConsumed: 1 } }; },
    async sendRawTransaction() { throw new Error('offline'); },
  };
}
const treasury = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const uri = mint => `https://useroute.io/m/${mint.publicKey.toBase58().slice(0, 12)}`;
const longest = { name: 'Thirty-two character coin name!!', symbol: 'TENCHARSXX' };

test('a create-only launch fits a single transaction', async () => {
  const engine = createLaunchEngine({ connection: offlineConnection(), treasury });
  const mint = engine.newMint();
  const { bytes, transaction } = await engine.compile({ mint, ...longest, uri: uri(mint), user, devBuyLamports: 0n, blockhash: BLOCKHASH });
  assert.ok(bytes.length <= MAX_TRANSACTION_BYTES, `${bytes.length} bytes`);
  assert.equal(transaction.message.staticAccountKeys[0].toBase58(), user.toBase58(), 'the wallet pays');
  assert.equal(transaction.message.header.numRequiredSignatures, 2, 'wallet + mint sign');
  const built = await engine.build({ mint, ...longest, uri: uri(mint), user: user.toBase58(), devBuyLamports: 0n });
  assert.equal(built.mint, mint.publicKey.toBase58());
  assert.equal(built.create.size, bytes.length);
  assert.ok(built.route.size > 0 && built.route.size <= MAX_TRANSACTION_BYTES, `route ${built.route.size} bytes`);
  assert.equal(built.lastValidBlockHeight, 1000);
  const route = await engine.buildRoute({ mint: mint.publicKey.toBase58(), creator: user.toBase58(), graduated: false });
  assert.ok(route.size <= MAX_TRANSACTION_BYTES);
  assert.equal(route.blockhash, BLOCKHASH);
});

test('create + dev buy is one transaction that fits at the longest name and ticker', async () => {
  const engine = createLaunchEngine({ connection: offlineConnection(), treasury });
  const mint = engine.newMint();
  const { bytes, transaction } = await engine.compile({ mint, ...longest, uri: uri(mint), user, devBuyLamports: 100_000_000n, blockhash: BLOCKHASH });
  assert.ok(bytes.length <= MAX_TRANSACTION_BYTES, `create+buy is ${bytes.length} bytes`);
  assert.equal(transaction.message.addressTableLookups.length, 0, 'no lookup table');
  assert.equal(transaction.message.compiledInstructions.length, 4, 'priority fee + create + ATA + buy');
  assert.equal(transaction.message.header.numRequiredSignatures, 2, 'wallet + mint sign');
  const built = await engine.build({ mint, ...longest, uri: uri(mint), user: user.toBase58(), devBuyLamports: 100_000_000n });
  assert.equal(built.create.size, bytes.length);
  assert.equal(engine.devBuysEnabled, true);
});

test('a missing treasury refuses every launch', async () => {
  const engine = createLaunchEngine({ connection: offlineConnection(), treasury: null });
  const mint = engine.newMint();
  await assert.rejects(engine.build({ mint, ...longest, uri: uri(mint), user: user.toBase58(), devBuyLamports: 0n }), error => error.status === 503);
});

test('only the exact prepared message with valid signatures is accepted', async () => {
  const engine = createLaunchEngine({ connection: offlineConnection(), treasury });
  const payer = Keypair.generate();
  const other = Keypair.generate();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1 })] }).compileToV0Message();
  const expected = Buffer.from(message.serialize()).toString('base64');
  const unsigned = new VersionedTransaction(message);
  assert.throws(() => engine.verifySigned({ signedTransaction: Buffer.from(unsigned.serialize()).toString('base64'), message: expected }), /did not sign/);
  const forged = new VersionedTransaction(message);
  forged.addSignature(payer.publicKey, nacl.sign.detached(message.serialize(), other.secretKey));
  assert.throws(() => engine.verifySigned({ signedTransaction: Buffer.from(forged.serialize()).toString('base64'), message: expected }), /did not sign/);
  const signed = new VersionedTransaction(message);
  signed.sign([payer]);
  const ok = engine.verifySigned({ signedTransaction: Buffer.from(signed.serialize()).toString('base64'), message: expected });
  assert.equal(ok.message.staticAccountKeys[0].toBase58(), payer.publicKey.toBase58());
  assert.throws(() => engine.verifySigned({ signedTransaction: Buffer.from(signed.serialize()).toString('base64'), message: 'AAAA' }), /does not match/);
  assert.throws(() => engine.verifySigned({ signedTransaction: 'not base64 tx', message: expected }), /could not be read/);
});

test('simulation failures are explained in plain words', () => {
  assert.match(describeSimulationError({ err: 'AccountNotFound', logs: [] }), /more SOL/);
  assert.match(describeSimulationError({ err: { InstructionError: [2, { Custom: 6000 }] }, logs: ['Program log: insufficient lamports 1, need 2'] }), /more SOL/);
  assert.match(describeSimulationError({ err: { InstructionError: [2, { Custom: 6082 }] }, logs: [] }), /6082/);
});
