import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemInstruction, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { openStore } from './store.js';
import { createFeeLedger } from './fee-ledger.js';
import { createBuyback } from './buyback.js';

export async function moneyFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-money-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir), treasury = Keypair.generate(), signer = Keypair.generate();
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey;
  const balances = new Map([[String(treasury.publicKey), 5_000_000_000n], [String(signer.publicKey), 1_000_000_000n], [String(pool), 0n]]);
  const receipts = new Map(), sends = [], confirmations = [];
  const fixture = { dir, store, treasury, signer, mint, pool, balances, receipts, sends, confirmations, visible: true, failSend: false, valid: true, balanceDown: false, creator: String(signer.publicKey) };
  let height = 1;
  const connection = {
    async getBalance(key) { if (fixture.balanceDown) throw new Error('RPC unavailable'); return Number(balances.get(String(key)) || 0n); },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + 100 }; },
    async sendRawTransaction(bytes) {
      const transaction = VersionedTransaction.deserialize(bytes), message = transaction.message, keys = message.staticAccountKeys;
      const signature = bs58.encode(transaction.signatures[0]);
      if (!store.getMeta('buyback-pending')?.signature) throw new Error('Missing durable intent before broadcast.');
      sends.push({ signature, transaction });
      const preBalances = keys.map(key => Number(balances.get(String(key)) || 0n));
      for (const ix of message.compiledInstructions) {
        if (!keys[ix.programIdIndex].equals(SystemProgram.programId)) continue;
        const transfer = SystemInstruction.decodeTransfer({ programId: SystemProgram.programId, data: Buffer.from(ix.data), keys: ix.accountKeyIndexes.map(index => ({ pubkey: keys[index] })) });
        const from = String(transfer.fromPubkey), to = String(transfer.toPubkey);
        balances.set(from, (balances.get(from) || 0n) - BigInt(transfer.lamports));
        balances.set(to, (balances.get(to) || 0n) + BigInt(transfer.lamports));
      }
      const payer = String(keys[0]); balances.set(payer, balances.get(payer) - 5000n);
      const postTokenBalances = payer === String(signer.publicKey) ? [
        { owner: payer, mint: String(mint), uiTokenAmount: { amount: '42' } },
        { owner: payer, mint: String(pool), uiTokenAmount: { amount: '999' } },
      ] : [];
      receipts.set(signature, { slot: height++, transaction: { message }, meta: { err: null, fee: 5000, preBalances, postBalances: keys.map(key => Number(balances.get(String(key)) || 0n)), preTokenBalances: [], postTokenBalances } });
      if (fixture.failSend) throw new Error('Timeout after acceptance');
      return signature;
    },
    async confirmTransaction(identity) { confirmations.push(identity); return { value: { err: null } }; },
    async getTransaction(signature) { return fixture.visible ? receipts.get(signature) || null : null; },
    async getSignatureStatuses(signatures) { return { value: signatures.map(signature => fixture.visible && receipts.has(signature) ? { confirmationStatus: 'finalized', err: null } : null) }; },
    async isBlockhashValid() { return { value: fixture.valid }; },
  };
  const feeLedger = createFeeLedger({ store });
  fixture.connection = connection; fixture.feeLedger = feeLedger;
  fixture.credit = (signature, { direct = 300_000_000n, social = 0n, main = true } = {}) => feeLedger.distribution({ signature, mint: String(mint), mainCoin: main ? String(mint) : null, treasury: String(treasury.publicKey), slot: 1, treasuryLamports: String(direct), buybackLamports: String(direct), socialLamports: String(social), lamports: String(direct + social) });
  fixture.makeBuyback = (overrides = {}) => createBuyback({ connection, store, treasury, signer, mainCoin: mint, feeLedger,
    verifyCreator: async value => ({ mint: value, creator: fixture.creator, signature: 'creation' }),
    buildBuyImpl: async (_, lamports) => ({ venue: 'fixture', instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: pool, lamports })] }),
    log: { info() {}, warn() {} }, ...overrides });
  return fixture;
}
