// One-time setup: creates the Route address lookup table holding pump.fun's static
// launch accounts, so create + dev buy fits in a single transaction.
// Pays from the treasury keypair (ROUTE_TREASURY_KEYPAIR, default ~/.route-keys/treasury.json).
// Prints the table address to set as ROUTE_LOOKUP_TABLE.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AddressLookupTableProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { routeInstructions } from '../server/fee-share.js';
import BN from 'bn.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const keyPath = process.env.ROUTE_TREASURY_KEYPAIR || path.join(os.homedir(), '.route-keys', 'treasury.json');
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(keyPath, 'utf8'))));
const connection = new Connection(rpc, 'confirmed');
console.log(`treasury/authority ${authority.publicKey.toBase58()} via ${new URL(rpc).host}`);

const balance = await connection.getBalance(authority.publicKey);
console.log(`balance ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < 0.004 * LAMPORTS_PER_SOL) {
  console.error('Fund the treasury with at least 0.005 SOL before creating the table.');
  process.exit(1);
}

// The static set is what two different create + buy + fee-route launches share
// (the treasury itself is static, so it is included).
const online = new OnlinePumpSdk(connection);
const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
async function sampleKeys() {
  const mint = Keypair.generate(), user = Keypair.generate().publicKey;
  const lamports = new BN(10_000_000);
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports, quoteMint: PublicKey.default });
  const instructions = [
    ...(await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name: 'sample', symbol: 'SAMPLE', uri: 'https://example.invalid/m.json', creator: user, user, amount, solAmount: lamports, mayhemMode: false })),
    ...(await routeInstructions({ mint: mint.publicKey, creator: user, shareholder: authority.publicKey, graduated: false })),
  ];
  const keys = new Set();
  for (const ix of instructions) { keys.add(ix.programId.toBase58()); ix.keys.forEach(key => keys.add(key.pubkey.toBase58())); }
  return keys;
}
const [first, second] = await Promise.all([sampleKeys(), sampleKeys()]);
const addresses = [...first].filter(key => second.has(key)).map(key => new PublicKey(key));
console.log(`${addresses.length} static accounts:\n  ${addresses.map(key => key.toBase58()).join('\n  ')}`);

const slot = await connection.getSlot('finalized');
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: table, addresses });
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
const message = new TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: blockhash, instructions: [createIx, extendIx] }).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([authority]);
const signature = await connection.sendTransaction(transaction, { maxRetries: 3 });
console.log(`sent ${signature}; table ${table.toBase58()}`);
const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
if (confirmation.value.err) { console.error('failed', confirmation.value.err); process.exit(1); }

// Read back before trusting it: every static address must be in the table.
const { value } = await connection.getAddressLookupTable(table);
const stored = new Set((value?.state.addresses || []).map(key => key.toBase58()));
const missing = addresses.filter(key => !stored.has(key.toBase58()));
if (!value || missing.length) { console.error(`table incomplete; missing ${missing.map(key => key.toBase58()).join(', ') || 'everything'}`); process.exit(1); }
console.log(`\nROUTE_LOOKUP_TABLE=${table.toBase58()}  (${stored.size} addresses, usable from the next slot)`);
