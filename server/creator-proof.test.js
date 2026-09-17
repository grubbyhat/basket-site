import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, TransactionMessage } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { creationFromTransaction } from './creator-proof.js';

test('creator identity comes from the original Pump create instruction and its signer', async () => {
  const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
  const build = async user => ({ slot: 12, meta: { err: null }, transaction: { message: new TransactionMessage({ payerKey: user, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [await PUMP_SDK.createV2Instruction({ mint, name: 'Route', symbol: 'ROUTE', uri: 'https://useroute.io/m/test', creator, user, mayhemMode: false })] }).compileToV0Message() } });
  assert.deepEqual(creationFromTransaction(await build(creator), String(mint)), { mint: String(mint), creator: String(creator), slot: 12 });
  assert.equal(creationFromTransaction(null, String(mint)), null);
});

test('a fee creator field assigned to someone else is not proof they created the token', async () => {
  const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  const instruction = await PUMP_SDK.createV2Instruction({ mint, name: 'Route', symbol: 'ROUTE', uri: 'https://useroute.io/m/test', creator, user, mayhemMode: false });
  const details = { slot: 12, meta: { err: null }, transaction: { message: new TransactionMessage({ payerKey: user, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [instruction] }).compileToV0Message() } };
  assert.throws(() => creationFromTransaction(details, String(mint)), /same developer wallet/);
});
