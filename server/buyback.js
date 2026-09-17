// Buys the Route coin with the fees the treasury is entitled to: all of the main
// coin's own fees plus the buyback share of every other coin's fees, as recorded
// by the collector's distributions. Runs on the same fixed sweep as collection.
// Primary path: pump SDKs (bonding curve, then PumpSwap after graduation).
// Backup: PumpPortal, when enabled from the admin page.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPda, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import { HttpError } from './errors.js';
import { buildPumpPortalBuy } from './pumpportal.js';

const SETTINGS_KEY = 'settings';
const LEDGER_KEY = 'buybacks';
const RESERVE_LAMPORTS = 20_000_000; // fee money the treasury always keeps

export function createBuyback({ connection, store, treasury = null, watcher = null, mainCoin = null, minLamports = 100_000_000, slippagePercent = 10, sweepMs = 10_000, buyImpl = null, log = console }) {
  const settings = () => ({ enabled: false, backup: 'none', mainCoin: null, ...(store.getMeta?.(SETTINGS_KEY, {})?.buyback || {}) });
  const ledger = () => ({ spentLamports: '0', purchases: [], lastError: null, lastRun: null, ...(store.getMeta?.(LEDGER_KEY, {}) || {}) });
  const coin = () => settings().mainCoin || mainCoin?.toBase58?.() || null;

  // What the treasury has earned for buybacks, from recorded distributions.
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

  async function treasuryLamports() {
    if (!treasury) return 0n;
    return BigInt(await connection.getBalance(treasury.publicKey, 'confirmed'));
  }

  async function status() {
    const current = settings();
    const book = ledger();
    const entitled = entitledLamports();
    const spent = BigInt(book.spentLamports || 0);
    const balance = await treasuryLamports().catch(() => null);
    const owed = entitled > spent ? entitled - spent : 0n;
    const spendable = balance === null ? null : balance > BigInt(RESERVE_LAMPORTS) ? balance - BigInt(RESERVE_LAMPORTS) : 0n;
    const available = spendable === null ? owed : owed < spendable ? owed : spendable;
    return {
      enabled: current.enabled, backup: current.backup, mainCoin: coin(), configured: Boolean(treasury && coin()),
      sweepMs, minLamports: String(minLamports), slippagePercent,
      entitledLamports: entitled.toString(), spentLamports: spent.toString(), owedLamports: owed.toString(),
      treasuryLamports: balance === null ? null : balance.toString(), availableLamports: available.toString(),
      lastRun: book.lastRun, lastError: book.lastError, purchases: (book.purchases || []).slice(-20).reverse(),
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
    const user = treasury.publicKey;
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

  async function sendAndConfirm(transaction) {
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) throw new Error(`buy failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    const details = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    let tokens = null, lamportsSpent = null;
    if (details?.meta) {
      const owner = treasury.publicKey.toBase58();
      const balance = list => (list || []).filter(entry => entry.owner === owner).reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);
      tokens = (balance(details.meta.postTokenBalances) - balance(details.meta.preTokenBalances)).toString();
      const keys = details.transaction.message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
      const index = keys.staticAccountKeys.findIndex(k => k.equals(treasury.publicKey));
      if (index >= 0) lamportsSpent = String(details.meta.preBalances[index] - details.meta.postBalances[index]);
    }
    return { signature, tokens, lamportsSpent, slot: details?.slot ?? null };
  }

  async function buyPrimary(mintAddress, lamports) {
    const { venue, instructions } = await buildBuy(mintAddress, lamports);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: treasury.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions] }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([treasury]);
    return { venue, ...(await sendAndConfirm(transaction)) };
  }

  async function buyBackup(mintAddress, lamports) {
    const transaction = await buildPumpPortalBuy({ publicKey: treasury.publicKey.toBase58(), mint: mintAddress, sol: Number(lamports) / 1e9, slippagePercent });
    transaction.sign([treasury]);
    return { venue: 'pumpportal', ...(await sendAndConfirm(transaction)) };
  }

  let running = false;
  async function run({ force = false, reason = 'sweep' } = {}) {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      const current = settings();
      const mintAddress = coin();
      if (!treasury || !mintAddress) return { skipped: 'not configured' };
      if (!current.enabled && !force) return { skipped: 'disabled' };
      const snapshot = await status();
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

  let timer = null;
  return {
    enabled: Boolean(treasury),
    status, configure, run, entitledLamports, buildBuy,
    start() {
      if (!treasury) return;
      timer = setInterval(() => run().catch(() => {}), sweepMs);
      timer.unref?.();
      const current = settings();
      log.info(`[buyback] ${current.enabled ? 'ON' : 'off'}; main coin ${coin() || 'unset'}; every ${sweepMs / 1000} s, minimum ${Number(minLamports) / 1e9} SOL`);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
