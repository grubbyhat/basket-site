import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPda, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import { HttpError } from './errors.js';
import { createFeeLedger } from './fee-ledger.js';
import { createCreatorVerifier } from './creator-proof.js';
import { createSettlement, solBefore, solDelta, tokenDelta } from './settlement.js';

const RESERVE = 20_000_000n;
const BUY_OVERHEAD = 10_000_000n; // token/volume account rent and network fees, inside the funded budget
const max0 = value => value > 0n ? value : 0n;
const min = (a, b) => a < b ? a : b;

export function createBuyback({ connection, store, treasury = null, signer = null, watcher = null, mainCoin = null, minLamports = 100_000_000, slippagePercent = 10, sweepMs = 10_000, feeLedger = createFeeLedger({ store }), verifyCreator = createCreatorVerifier({ connection, store }), buildBuyImpl = null, log = console }) {
  // An absent dev key must never silently switch buying to the fee treasury.
  const buyer = signer;
  const separate = Boolean(buyer && treasury && !buyer.publicKey.equals(treasury.publicKey));
  const settings = () => ({ enabled: false, backup: 'none', mainCoin: null, ...(store.getMeta('settings', {})?.buyback || {}) });
  const ledger = () => structuredClone({ spentLamports: '0', forwardedLamports: '0', purchases: [], forwards: [], settled: {}, purchaseCount: 0, tokenTotal: '0', ...(store.getMeta('buybacks', {}) || {}) });
  const coin = () => settings().mainCoin || mainCoin?.toBase58?.() || null;
  const lane = createSettlement({ connection, store, key: 'buyback-pending' });
  let running = false, configuring = false, timer = null, creatorState = { verified: false, message: 'Creator verification has not run yet.' };
  const entitledLamports = () => feeLedger.totals(coin(), treasury?.publicKey.toBase58()).buyback;

  const ledgerBlock = book => {
    if (book.blockedReason) return book.blockedReason;
    if (BigInt(book.forwardedLamports) === 0n && BigInt(book.spentLamports) === 0n) return null;
    if (book.buyer !== buyer?.publicKey.toBase58() || book.treasury !== treasury?.publicKey.toBase58() || book.mint !== coin()) return 'Existing buyback funds belong to different or unverified wallet identities; receipt reconciliation is required.';
    return null;
  };

  async function verify(mint = coin()) {
    try {
      if (!separate || !mint) throw new Error('Configure a separate developer wallet and the main token mint.');
      const proof = await verifyCreator(mint, buyer.publicKey.toBase58());
      if (proof.mint !== mint || proof.creator !== buyer.publicKey.toBase58()) throw new Error('Developer wallet does not match the token creation wallet.');
      creatorState = { verified: true, ...proof, message: null };
    } catch (error) { creatorState = { verified: false, message: error.message }; }
    return creatorState;
  }

  async function status({ checkCreator = true } = {}) {
    if (checkCreator) await verify();
    const book = ledger(), entitled = entitledLamports();
    const spent = BigInt(book.spentLamports), forwarded = BigInt(book.forwardedLamports);
    const [treasuryBalance, walletBalance] = await Promise.all([treasury, buyer].map(async key => key ? connection.getBalance(key.publicKey, 'confirmed').then(value => BigInt(value)).catch(() => null) : null));
    const owed = max0(entitled - spent), funded = max0(forwarded - spent);
    const toForward = treasuryBalance === null ? 0n : min(max0(entitled - forwarded), max0(treasuryBalance - RESERVE));
    const protectedBalance = BigInt(book.protectedBuyerLamports || RESERVE);
    const available = walletBalance === null ? 0n : min(funded, max0(walletBalance - protectedBalance));
    return {
      enabled: settings().enabled, backup: 'none', mainCoin: coin(), configured: separate && Boolean(coin()),
      creator: creatorState, blockedReason: ledgerBlock(book) || (!creatorState.verified ? creatorState.message : null),
      sweepMs, minLamports: String(minLamports), slippagePercent, separate,
      wallet: buyer?.publicKey.toBase58() || null, treasury: treasury?.publicKey.toBase58() || null,
      entitledLamports: String(entitled), spentLamports: String(spent), owedLamports: String(owed),
      forwardedLamports: String(forwarded), toForwardLamports: String(toForward),
      treasuryLamports: treasuryBalance === null ? null : String(treasuryBalance), walletLamports: walletBalance === null ? null : String(walletBalance),
      availableLamports: String(available), protectedBuyerLamports: String(protectedBalance), pending: lane.pending(),
      lastRun: book.lastRun || null, lastError: book.lastError || null,
      purchases: book.purchases.slice(-20).reverse(), forwards: book.forwards.slice(-10).reverse(),
    };
  }

  async function configure(patch) {
    if (running || configuring || lane.pending()) throw new HttpError('A buyback transaction or configuration is still being settled.', 409);
    configuring = true;
    try {
    const next = { ...settings(), backup: 'none' };
    if (patch.backup && patch.backup !== 'none') throw new HttpError('PumpPortal is unavailable until its transaction and spending limits are verified.', 400);
    if (patch.mainCoin !== undefined) {
      try { next.mainCoin = patch.mainCoin ? new PublicKey(String(patch.mainCoin)).toBase58() : null; }
      catch { throw new HttpError('Enter the main coin mint address.', 400); }
      if (coin() && (next.mainCoin || mainCoin?.toBase58() || null) !== coin() && Object.keys(feeLedger.read().distributions).length) throw new HttpError('The main coin cannot change after fee receipts have been allocated.', 409);
      next.enabled = false;
    }
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (next.enabled) {
      const proof = await verify(next.mainCoin || mainCoin?.toBase58() || null);
      if (!proof.verified) throw new HttpError(proof.message, 409);
    }
    await store.setMeta('settings', { ...store.getMeta('settings', {}), buyback: next });
    return await status();
    } finally { configuring = false; }
  }

  async function buildBuy(mintAddress, lamports) {
    if (buildBuyImpl) return buildBuyImpl(mintAddress, lamports);
    const mint = new PublicKey(mintAddress), user = buyer.publicKey;
    const [mintInfo, poolInfo] = await connection.getMultipleAccountsInfo([mint, canonicalPumpPoolPda(mint)]);
    if (!mintInfo) throw new Error('Main coin mint not found.');
    if (![TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID].some(program => mintInfo.owner.equals(program))) throw new Error('Unsupported main token program.');
    const tokenProgram = mintInfo.owner;
    if (poolInfo) {
      const state = await new OnlinePumpAmmSdk(connection).swapSolanaState(canonicalPumpPoolPda(mint), user);
      if (!state.pool.baseMint.equals(mint) || !state.pool.quoteMint.equals(NATIVE_MINT)) throw new Error('Main token pool is not the expected SOL pair.');
      return { venue: 'pumpswap', instructions: await PUMP_AMM_SDK.buyQuoteInput(state, new BN(String(lamports)), slippagePercent) };
    }
    const online = new OnlinePumpSdk(connection);
    const [global, feeConfig, state] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig(), online.fetchBuyState(mint, user, tokenProgram)]);
    if (state.bondingCurve.complete) throw new Error('Main token is migrating; its pool is not visible yet.');
    const quote = state.bondingCurve.quoteMint;
    if (quote && !quote.equals(PublicKey.default) && !quote.equals(NATIVE_MINT)) throw new Error('Main token is not paired with SOL.');
    const supply = new BN(MintLayout.decode(mintInfo.data).supply.toString());
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: supply, bondingCurve: state.bondingCurve, amount: new BN(String(lamports)), quoteMint: PublicKey.default });
    if (amount.lten(0)) throw new Error('Buy amount is too small.');
    return { venue: 'bonding-curve', instructions: await PUMP_SDK.buyInstructions({ global, ...state, mint, user, amount, solAmount: new BN(String(lamports)), slippage: slippagePercent, tokenProgram }) };
  }

  async function prepare(instructions, payer, context) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);
    return { transaction, lastValidBlockHeight, context };
  }

  async function settle(attempt, details) {
    const book = ledger();
    if (book.settled[attempt.signature]) return;
    const { kind, mint, budget, reason, venue, buyerAddress, treasuryAddress } = attempt.context;
    if (buyerAddress !== buyer?.publicKey.toBase58() || treasuryAddress !== treasury?.publicKey.toBase58()) throw new Error('Pending transaction belongs to different wallets. Restore its configuration before settlement.');
    const common = { at: attempt.at, signature: attempt.signature, slot: details.slot, reason };
    book.buyer = buyerAddress; book.treasury = treasuryAddress; book.mint = mint;
    if (kind === 'forward') {
      const received = solDelta(details, buyerAddress);
      if (received !== BigInt(budget) || solDelta(details, treasuryAddress) + BigInt(details.meta.fee) !== -received) throw new Error('Forward receipt does not match its exact funding amount.');
      const previousFunded = max0(BigInt(book.forwardedLamports) - BigInt(book.spentLamports));
      const existing = max0(solBefore(details, buyerAddress) - previousFunded);
      const previousFloor = BigInt(book.protectedBuyerLamports || RESERVE);
      book.protectedBuyerLamports = String(existing > previousFloor ? existing : previousFloor);
      book.forwardedLamports = String(BigInt(book.forwardedLamports) + received);
      book.forwards = [...book.forwards, { ...common, lamports: String(received) }].slice(-200);
    } else {
      const spent = -solDelta(details, buyerAddress), tokens = tokenDelta(details, buyerAddress, mint);
      if (spent < 0n) throw new Error('Unexpected positive SOL buyback balance change.');
      book.spentLamports = String(BigInt(book.spentLamports) + spent);
      book.purchases = [...book.purchases, { ...common, mint, lamports: String(spent), budgetLamports: budget, tokens: String(tokens), venue }].slice(-500);
      book.purchaseCount += 1;
      book.tokenTotal = String(BigInt(book.tokenTotal) + tokens);
      if (spent > BigInt(budget) || tokens <= 0n) book.blockedReason = 'Buyback receipt exceeded its funded budget or did not receive the main token; reconciliation required.';
    }
    book.settled[attempt.signature] = true;
    book.lastRun = common.at;
    book.lastError = null;
    await store.setMeta('buybacks', book);
    watcher?.refresh?.(mint)?.catch(() => {});
  }

  async function settleFailure(attempt, details) {
    const book = ledger();
    if (book.settled[attempt.signature]) return;
    if (attempt.context.kind === 'buy') {
      const spent = -solDelta(details, attempt.context.buyerAddress);
      if (spent < 0n) throw new Error('Unexpected failed buyback receipt.');
      book.spentLamports = String(BigInt(book.spentLamports) + spent);
      book.failedFeeLamports = String(BigInt(book.failedFeeLamports || 0) + spent);
    }
    book.settled[attempt.signature] = true;
    await store.setMeta('buybacks', book);
  }

  async function run({ force = false, reason = 'sweep' } = {}) {
    if (running || configuring) return { skipped: 'busy' };
    running = true;
    try {
      if (lane.pending()) return await lane.execute({ settle, settleFailure });
      if (!separate || !coin()) return { skipped: 'not configured' };
      if (!settings().enabled && !force) return { skipped: 'disabled' };
      const snapshot = await status();
      if (snapshot.blockedReason) return { skipped: 'blocked', reason: snapshot.blockedReason };
      const context = { mint: coin(), reason, buyerAddress: buyer.publicKey.toBase58(), treasuryAddress: treasury.publicKey.toBase58() };
      const amount = BigInt(snapshot.toForwardLamports);
      if (amount >= 5_000_000n) return await lane.execute({ settle, settleFailure, build: () => prepare([SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: buyer.publicKey, lamports: amount })], treasury, { ...context, kind: 'forward', budget: String(amount) }) });
      const available = BigInt(snapshot.availableLamports);
      if (available < BigInt(minLamports) || available <= BUY_OVERHEAD) return { skipped: 'below minimum', availableLamports: String(available) };
      return await lane.execute({ settle, settleFailure, build: async () => {
        const input = (available - BUY_OVERHEAD) * 10_000n / BigInt(Math.ceil((100 + slippagePercent) * 100));
        const { venue, instructions } = await buildBuy(coin(), input);
        return prepare([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions], buyer, { ...context, kind: 'buy', budget: String(available), venue });
      } });
    } catch (error) {
      await store.setMeta('buybacks', { ...ledger(), lastError: { at: new Date().toISOString(), message: error.message } }).catch(() => {});
      log.warn(`[buyback] ${error.message}`);
      return { error: error.message };
    } finally { running = false; }
  }

  function summary() {
    const book = ledger();
    return { mainCoin: coin(), enabled: settings().enabled, wallet: buyer?.publicKey.toBase58() || null, creator: creatorState, blockedReason: ledgerBlock(book) || (!creatorState.verified ? creatorState.message : null), pending: lane.pending()?.signature || null, spentLamports: book.spentLamports, purchases: book.purchaseCount, tokens: book.tokenTotal, lastAt: book.purchases.at(-1)?.at || null, recent: book.purchases.slice(-5).reverse() };
  }
  return {
    enabled: separate, separate, wallet: buyer?.publicKey.toBase58() || null,
    status, configure, run, entitledLamports, buildBuy, summary, mainCoin: coin,
    start() { if (!buyer) return; run().catch(() => {}); timer = setInterval(() => run().catch(() => {}), sweepMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
