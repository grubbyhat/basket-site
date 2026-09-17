import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { compileRoute, inspectCoin, routeInstructions } from './fee-share.js';
import { MAX_TRANSACTION_BYTES } from './launch.js';
import { coinAccounts, curveStats, decodeCurve, readTokenMetadata } from './pump.js';
import { BLOCKHASH, account, offlineConnection, pumpCoin } from './fixtures.js';
import BN from 'bn.js';

const treasury = Keypair.generate().publicKey;
const mint = new PublicKey(pumpCoin.mint.address);

test('the fee-route transaction is one creator-signed transaction that fits without a lookup table', async () => {
  const creator = decodeCurve(account(pumpCoin.bondingCurve)).creator;
  const { transaction, bytes } = await compileRoute({ mint, creator, treasury, graduated: false, blockhash: BLOCKHASH });
  assert.ok(bytes.length <= MAX_TRANSACTION_BYTES, `${bytes.length} bytes`);
  assert.equal(transaction.message.header.numRequiredSignatures, 1, 'only the creator signs');
  assert.equal(transaction.message.staticAccountKeys[0].toBase58(), creator.toBase58());
  const instructions = await routeInstructions({ mint, creator, treasury, graduated: false });
  assert.equal(instructions.length, 2, 'create config + set shares');
  const graduated = await routeInstructions({ mint, creator, treasury, graduated: true });
  assert.equal(graduated.length, 2);
  assert.notEqual(Buffer.from(graduated[1].data).toString('hex').slice(0, 16), Buffer.from(instructions[1].data).toString('hex').slice(0, 16), 'graduated coins use update_fee_shares_v2');
});

test('coin accounts derive from the sharing config, so each coin has its own fee vault', () => {
  const accounts = coinAccounts(mint);
  assert.equal(accounts.config.toBase58(), pumpCoin.sharingConfig.address);
  assert.equal(accounts.vault.toBase58(), pumpCoin.vault.address);
  const other = coinAccounts(Keypair.generate().publicKey);
  assert.notEqual(other.vault.toBase58(), accounts.vault.toBase58());
});

test('bonding curve stats give a market cap and progress from the curve alone', () => {
  const curve = decodeCurve(account(pumpCoin.bondingCurve));
  const stats = curveStats(curve);
  // A freshly launched mayhem-mode curve: ~4 SOL market cap, nothing raised yet.
  assert.ok(stats.mcapLamports > 1_000_000_000n && stats.mcapLamports < 10_000_000_000_000n, `mcap ${stats.mcapLamports}`);
  assert.ok(stats.progress >= 0 && stats.progress < 0.01, `progress ${stats.progress}`);
  assert.ok(stats.neededLamports > 5_000_000_000n && stats.neededLamports < 100_000_000_000n, `needs ${stats.neededLamports} lamports to graduate`);
  assert.equal(stats.complete, false);
  assert.equal(stats.supply, 1_000_000_000_000_000n);
  // Buy half of the SOL the curve still needs (constant product): progress is a half.
  const half = new BN(stats.neededLamports.toString()).divn(2);
  const k = curve.virtualQuoteReserves.mul(curve.virtualTokenReserves);
  const virtualQuote = curve.virtualQuoteReserves.add(half);
  const virtualTokens = k.div(virtualQuote);
  const halfway = { ...curve, virtualQuoteReserves: virtualQuote, virtualTokenReserves: virtualTokens, realTokenReserves: curve.realTokenReserves.sub(curve.virtualTokenReserves.sub(virtualTokens)), realQuoteReserves: curve.realQuoteReserves.add(half) };
  assert.ok(Math.abs(curveStats(halfway).progress - 0.5) < 0.001, `halfway progress ${curveStats(halfway).progress}`);
  assert.equal(curveStats({ ...curve, complete: true }).progress, 1);
});

test('token metadata is read from the Token-2022 mint and inspect describes the coin', async () => {
  const connection = offlineConnection();
  const metadata = await readTokenMetadata(connection, mint);
  assert.equal(metadata.symbol, '$CAT');
  assert.equal(metadata.name, 'CATECOIN');
  assert.match(metadata.uri, /^https:\/\//);
  const coin = await inspectCoin({ connection, treasury, mint: mint.toBase58(), fetchImpl: async () => ({ ok: true, json: async () => ({ image: 'ipfs://QmImage' }) }) });
  assert.equal(coin.registrable, true);
  assert.equal(coin.sharing, null);
  assert.equal(coin.graduated, false);
  assert.equal(coin.imageUrl, 'https://ipfs.io/ipfs/QmImage');
  assert.equal(coin.creator, decodeCurve(account(pumpCoin.bondingCurve)).creator.toBase58());
  await assert.rejects(inspectCoin({ connection, treasury, mint: 'nope' }), error => error.status === 400);
  await assert.rejects(inspectCoin({ connection, treasury, mint: Keypair.generate().publicKey.toBase58() }), error => error.status === 404);
});
