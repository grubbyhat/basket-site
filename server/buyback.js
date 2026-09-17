// Buys the Route coin with the fees that belong to buybacks: all of the main
// coin's own fees plus the buyback share of every other coin's fees, as recorded
// by the collector's distributions. Runs on the same fixed sweep as collection.
//
// Wallets: the treasury (the wallet pump.fun claims to, the 5% shareholder and
// the collector's payer) holds the money; a separate buyback signer, the dev
// wallet that launched the main coin, does the buying. Each sweep the treasury
// forwards to the signer exactly what the ledger says is buyback money, never
// the recipients' share that sits in the same wallet after a GitHub claim.
// Primary buy path: pump SDKs (bonding curve, then PumpSwap after graduation).
// Backup: PumpPortal, when enabled from the admin page.
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPda, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import { HttpError } from './errors.js';
import { buildPumpPortalBuy } from './pumpportal.js';

const SETTINGS_KEY = 'settings';
const LEDGER_KEY = 'buybacks';
const RESERVE_LAMPORTS = 20_000_000n; // network-fee money a wallet always keeps
const FORWARD_MIN_LAMPORTS = 5_000_000n;

export function createBuyback({ connection, store, treasury = null, signer = null, watcher = null, mainCoin = null, minLamports = 100_000_000, slippagePercent = 10, sweepMs = 10_000, buyImpl = null, forwardImpl = null, balanceImpl = null, log = console }) {
  const buyer = signer || treasury;
  const separate = Boolean(signer && treasury && !signer.publicKey.equals(treasury.publicKey));
  const settings = () => ({ enabled: false, backup: 'none', mainCoin: null, ...(store.getMeta?.(SETTINGS_KEY, {})?.buyback || {}) });
  const ledger = () => ({ spentLamports: '0', forwardedLamports: '0', purchases: [], forwards: [], lastError: null, lastRun: null, ...(store.getMeta?.(LEDGER_KEY, {}) || {}) });
  const coin = () => settings().mainCoin || mainCoin?.toBase58?.() || null;
  const balanceOf = async key => BigInt(balanceImpl ? await balanceImpl(key) : await connection.getBalance(key, 'confirmed'));
  const max0 = value => (value > 0n ? value : 0n);
  const min = (a, b) => (a < b ? a : b);

  // What buybacks have earned, from recorded distributions.
  function entitledLamports() {
    const main = coin();
    let total = 0n;
    for (const record of store.list({ status: 'confirmed', limit: 5000 })) {
      const claims = record.fees?.claims || [];
      const bps = record.mint === main ? 10000 : Number(record.shares?.treasuryBps || 0);
      if (!bps) continue;
      for (const claim of claims) total += (BigInt(claim.lamports || 0) * BigInt(bps)) / 10000n;
    }
    return total;
  }

  async function status() {
    const current = settings();
    const book = ledger();
    const entitled = entitledLamports();
    const spent = BigInt(book.spentLamports || 0);
    const forwarded = BigInt(book.forwardedLamports || 0);
    const owed = max0(entitled - spent);
    const treasuryBalance = treasury ? await balanceOf(treasury.publicKey).catch(() => null) : null;
    const walletBalance = buyer ? (separate ? await balanceOf(buyer.publicKey).catch(() => null) : treasuryBalance) : null;
    // With a separate signer the treasury still has to hand over entitled − forwarded.
    const toForward = separate ? min(max0(entitled - forwarded), treasuryBalance === null ? 0n : max0(treasuryBalance - RESERVE_LAMPORTS)) : 0n;
    const spendable = walletBalance === null ? null : max0(walletBalance - RESERVE_LAMPORTS);
    const available = spendable === null ? owed : min(owed, spendable);
    return {
      enabled: current.enabled, backup: current.backup, mainCoin: coin(), configured: Boolean(buyer && coin()),
      sweepMs, minLamports: String(minLamports), slippagePercent,
      wallet: buyer ? buyer.publicKey.toBase58() : null, treasury: treasury ? treasury.publicKey.toBase58() : null, separate,
      entitledLamports: entitled.toString(), spentLamports: spent.toString(), owedLamports: owed.toString(),
      forwardedLamports: forwarded.toString(), toForwardLamports: toForward.toString(),
      treasuryLamports: treasuryBalance === null ? null : treasuryBalance.toString(),
      walletLamports: walletBalance === null ? null : walletBalance.toString(),
      availableLamports: available.toString(),
      lastRun: book.lastRun, lastError: book.lastError,
      purchases: (book.purchases || []).slice(-20).reverse(), forwards: (book.forwards || []).slice(-10).reverse(),
    };
  }

  async function configure(patch) {
    const current = settings();
    const next = { ...current };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.backup !== undefined) { if (!['none', 'pumpportal'].includes(patch.backup)) throw new HttpError('Unknown backup.', 400); next.backup = patch.backup; }
    if (patch.mainCoin !== undefined) {
      if (patch.mainCoin === null || patch.mainCoin === '') next.mainCoin = null;
      else { try { next.mainCoin = new PublicKey(String(patch.mainCoin)).toBase58(); } catch { throw new HttpError('Enter the main coin mint address.', 400); } }
    }
    const all = store.getMeta?.(SETTINGS_KEY, {}) || {};
    await store.setMeta(SETTINGS_KEY, { ...all, buyback: next });
    log.info(`[buyback] ${next.enabled ? 'ON' : 'off'}; main coin ${next.mainCoin || mainCoin?.toBase58?.() || 'unset'}; backup ${next.backup}`);
    return status();
  }

  // Builds the buy through the pump SDKs for whichever venue the coin is on.
  async function buildBuy(mintAddress, lamports) {
    const mint = new PublicKey(mintAddress);
    const user = buyer.publicKey;
    const [mintInfo, poolInfo] = await connection.getMultipleAccountsInfo([mint, canonicalPumpPoolPda(mint)]);
    if (!mintInfo) throw new Error('main coin mint not found');
    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    if (poolInfo) {
      const amm = new OnlinePumpAmmSdk(connection);
      const state = await amm.swapSolanaState(canonicalPumpPoolPda(mint), user);
      return { venue: 'pumpswap', instructions: await PUMP_AMM_SDK.buyQuoteInput(state, new BN(lamports.toString()), slippagePercent) };
    }
    const online = new OnlinePumpSdk(connection);
    const [global, feeConfig, buyState] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig(), online.fetchBuyState(mint, user, tokenProgram)]);
    if (buyState.bondingCurve.complete) throw new Error('main coin has left the bonding curve but its pool is not visible yet');
    const supply = new BN(MintLayout.decode(mintInfo.data).supply.toString());
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: supply, bondingCurve: buyState.bondingCurve, amount: new BN(lamports.toString()), quoteMint: PublicKey.default });
    if (amount.lten(0)) throw new Error('the buy is too small for any tokens');
    const instructions = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: buyState.bondingCurveAccountInfo, bondingCurve: buyState.bondingCurve, associatedUserAccountInfo: buyState.associatedUserAccountInfo, mint, user, amount, solAmount: new BN(lamports.toString()), slippage: slippagePercent, tokenProgram });
    return { venue: 'bonding-curve', instructions };
  }

  async function sendAndConfirm(transaction, owner) {
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) throw new Error(`failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    const details = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).catch(() => null);
    let tokens = null, lamportsSpent = null;
    if (details?.meta) {
      const address = owner.toBase58();
      const balance = list => (list || []).filter(entry => entry.owner === address).reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);
      tokens = (balance(details.meta.postTokenBalances) - balance(details.meta.preTokenBalances)).toString();
      const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
      const index = keys.staticAccountKeys.findIndex(k => k.equals(owner));
      if (index >= 0) lamportsSpent = String(details.meta.preBalances[index] - details.meta.postBalances[index]);
    }
    return { signature, tokens, lamportsSpent, slot: details?.slot ?? null };
  }

  async function buyPrimary(mintAddress, lamports) {
    const { venue, instructions } = await buildBuy(mintAddress, lamports);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions] }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([buyer]);
    return { venue, ...(await sendAndConfirm(transaction, buyer.publicKey)) };
  }

  async function buyBackup(mintAddress, lamports) {
    const transaction = await buildPumpPortalBuy({ publicKey: buyer.publicKey.toBase58(), mint: mintAddress, sol: Number(lamports) / 1e9, slippagePercent });
    transaction.sign([buyer]);
    return { venue: 'pumpportal', ...(await sendAndConfirm(transaction, buyer.publicKey)) };
  }

  // Treasury → buyback signer, only ever the ledger's buyback money.
  async function forward(lamports) {
    if (forwardImpl) return forwardImpl(lamports);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: treasury.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: buyer.publicKey, lamports: Number(lamports) })] }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([treasury]);
    const { signature } = await sendAndConfirm(transaction, treasury.publicKey);
    return { signature };
  }

  let running = false;
  async function run({ force = false, reason = 'sweep' } = {}) {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      const current = settings();
      const mintAddress = coin();
      if (!buyer || !mintAddress) return { skipped: 'not configured' };
      if (!current.enabled && !force) return { skipped: 'disabled' };
      let snapshot = await status();
      const toForward = BigInt(snapshot.toForwardLamports);
      if (separate && toForward >= FORWARD_MIN_LAMPORTS) {
        const result = await forward(toForward);
        const book = ledger();
        await store.setMeta(LEDGER_KEY, { ...book, forwardedLamports: (BigInt(book.forwardedLamports || 0) + toForward).toString(), forwards: [...(book.forwards || []), { at: new Date().toISOString(), lamports: toForward.toString(), signature: result.signature, reason }].slice(-200) });
        log.info(`[buyback] forwarded ${Number(toForward) / 1e9} SOL from the treasury to ${buyer.publicKey.toBase58()}: ${result.signature}`);
        snapshot = await status();
      }
      const available = BigInt(snapshot.availableLamports);
      if (available < BigInt(minLamports)) return { skipped: 'below minimum', availableLamports: available.toString() };
      const book = ledger();
      let result;
      try {
        result = buyImpl ? await buyImpl(mintAddress, available) : await buyPrimary(mintAddress, available);
      } catch (primaryError) {
        if (current.backup !== 'pumpportal' || buyImpl) throw primaryError;
        log.warn(`[buyback] primary buy failed (${primaryError.message}); trying PumpPortal`);
        result = await buyBackup(mintAddress, available);
      }
      const spent = BigInt(result.lamportsSpent ?? available);
      const purchase = { at: new Date().toISOString(), reason, mint: mintAddress, lamports: spent.toString(), budgetLamports: available.toString(), tokens: result.tokens, signature: result.signature, venue: result.venue, slot: result.slot ?? null };
      await store.setMeta(LEDGER_KEY, { ...book, spentLamports: (BigInt(book.spentLamports || 0) + spent).toString(), purchases: [...(book.purchases || []), purchase].slice(-500), lastRun: purchase.at, lastError: null });
      log.info(`[buyback] bought ${mintAddress} with ${Number(spent) / 1e9} SOL via ${result.venue}: ${result.signature}`);
      watcher?.refresh?.(mintAddress).catch(() => {});
      return purchase;
    } catch (error) {
      const book = ledger();
      await store.setMeta(LEDGER_KEY, { ...book, lastRun: new Date().toISOString(), lastError: { at: new Date().toISOString(), message: error.message } }).catch(() => {});
      log.warn(`[buyback] ${error.message}`);
      return { error: error.message };
    } finally { running = false; }
  }

  function summary() {
    const book = ledger();
    const purchases = book.purchases || [];
    return { mainCoin: coin(), enabled: settings().enabled, wallet: buyer ? buyer.publicKey.toBase58() : null, spentLamports: String(book.spentLamports || 0), purchases: purchases.length, tokens: purchases.reduce((sum, purchase) => sum + BigInt(purchase.tokens || 0), 0n).toString(), lastAt: purchases.length ? purchases[purchases.length - 1].at : null, recent: purchases.slice(-5).reverse().map(purchase => ({ at: purchase.at, lamports: purchase.lamports, tokens: purchase.tokens, signature: purchase.signature, venue: purchase.venue })) };
  }

  let timer = null;
  return {
    enabled: Boolean(buyer),
    separate,
    wallet: buyer ? buyer.publicKey.toBase58() : null,
    status, configure, run, entitledLamports, buildBuy, summary,
    start() {
      if (!buyer) return;
      timer = setInterval(() => run().catch(() => {}), sweepMs);
      timer.unref?.();
      const current = settings();
      log.info(`[buyback] ${current.enabled ? 'ON' : 'off'}; main coin ${coin() || 'unset'}; buyer ${buyer.publicKey.toBase58()}${separate ? ` (fed by the treasury ${treasury.publicKey.toBase58()})` : ' (the treasury)'}; every ${sweepMs / 1000} s, minimum ${Number(minLamports) / 1e9} SOL`);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
