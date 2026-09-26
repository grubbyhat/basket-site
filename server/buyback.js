import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_PROGRAM_ID, PUMP_SDK, canonicalPumpPoolPda, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import { HttpError } from './errors.js';
import { createFeeLedger } from './fee-ledger.js';
import { coinAccounts } from './pump.js';
import { createSettlement, solBefore, solDelta, tokenDelta } from './settlement.js';

const RESERVE = 20_000_000n;
const BUY_OVERHEAD = 10_000_000n; // token/volume account rent and network fees, inside the funded budget
const max0 = value => value > 0n ? value : 0n;
const min = (a, b) => a < b ? a : b;

export function createBuyback({ connection, store, treasury = null, signer = null, watcher = null, mainCoin = null, minLamports = 100_000_000, slippagePercent = 10, sweepMs = 10_000, feeLedger = createFeeLedger({ store }), buildBuyImpl = null, buildClaimImpl = null, claimMinLamports = 10_000_000, maxLamports = null, canBuy = () => true, log = console }) {
  // An absent dev key must never silently switch buying to the fee treasury.
  const buyer = signer;
  const configured = Boolean(buyer && treasury);
  const separate = Boolean(buyer && treasury && !buyer.publicKey.equals(treasury.publicKey));
  const settings = () => ({ enabled: false, armed: false, armedFor: null, backup: 'none', mainCoin: null, ...(store.getMeta('settings', {})?.buyback || {}) });
  const ledger = () => structuredClone({ spentLamports: '0', forwardedLamports: '0', claimedLamports: '0', purchases: [], forwards: [], claims: [], settled: {}, purchaseCount: 0, tokenTotal: '0', ...(store.getMeta('buybacks', {}) || {}) });
  const coin = () => settings().mainCoin || mainCoin?.toBase58?.() || null;
  const lane = createSettlement({ connection, store, key: 'buyback-pending' });
  let running = false, configuring = false, timer = null;
  const entitledLamports = () => feeLedger.totals(coin(), treasury?.publicKey.toBase58()).buyback;
  // A main token created by the buyback wallet with no fee sharing: pump.fun pays
  // its creator fees to that wallet's own vaults (bonding curve, then PumpSwap after
  // migration), and this lane claims them so every wallet transaction stays serial.
  const directMain = () => {
    const record = store.get(coin());
    return Boolean(buyer && record?.status === 'confirmed' && record.route?.status === 'direct' && record.wallet === buyer.publicKey.toBase58());
  };
  // Claims received by a separate buyback wallet fund it like a forward.
  const claimedLamports = book => (separate ? BigInt(book.claimedLamports || 0) : 0n);
  const identities = (mint = coin()) => ({ mint, buyer: buyer?.publicKey.toBase58(), treasury: treasury?.publicKey.toBase58() });
  const activationBlock = () => {
    if (!settings().armed) return null;
    const expected = settings().armedFor, current = identities();
    if (!expected || Object.keys(current).some(key => current[key] !== expected[key])) return 'The main mint or wallets changed after buybacks were armed. Arm the intended identities again.';
    const record = store.get(coin());
    if (record?.status !== 'confirmed' || !['active', 'detected', 'direct'].includes(record.route?.status)) return 'Waiting for the main token to launch and be registered.';
    return null;
  };

  const ledgerBlock = book => {
    if (book.blockedReason) return book.blockedReason;
    if (!book.directFundingInitialized && BigInt(book.forwardedLamports) === 0n && BigInt(book.spentLamports) === 0n) return null;
    if (book.buyer !== buyer?.publicKey.toBase58() || book.treasury !== treasury?.publicKey.toBase58() || book.mint !== coin()) return 'Existing buyback funds belong to different or unverified wallet identities; receipt reconciliation is required.';
    return null;
  };

  // A shared creator/treasury wallet needs no transfer. Its first finalized fee
  // receipt establishes the existing SOL to preserve, after the external launch.
  // Missing legacy balance evidence cannot turn the wallet's balance into credit.
  const directFloor = book => {
    if (separate || book.directFundingInitialized) return BigInt(book.protectedBuyerLamports || RESERVE);
    const receipts = Object.values(feeLedger.read().distributions).filter(row => row.treasury === treasury?.publicKey.toBase58() && BigInt(row.buybackLamports) > 0n).sort((a, b) => a.slot - b.slot);
    if (!receipts.length) return null;
    if (receipts.some(row => row.treasuryBalanceBefore === undefined || row.netReceipt !== true)) return null;
    const before = BigInt(receipts[0].treasuryBalanceBefore);
    return before > RESERVE ? before : RESERVE;
  };

  const setupBlock = () => (!configured || !coin() ? 'Configure the buyback wallet, fee wallet and main token mint.' : null);

  async function status() {
    const book = ledger(), fromTreasury = entitledLamports(), claimed = claimedLamports(book), entitled = fromTreasury + claimed;
    const spent = BigInt(book.spentLamports), forwarded = BigInt(book.forwardedLamports);
    const [treasuryBalance, walletBalance] = await Promise.all([treasury, buyer].map(async key => key ? connection.getBalance(key.publicKey, 'confirmed').then(value => BigInt(value)).catch(() => null) : null));
    const owed = max0(entitled - spent), funded = separate ? max0(forwarded + claimed - spent) : owed;
    const toForward = !separate || treasuryBalance === null ? 0n : min(max0(fromTreasury - forwarded), max0(treasuryBalance - RESERVE));
    const floor = directFloor(book), protectedBalance = floor ?? RESERVE;
    const fundingBlock = !separate && entitled > 0n && floor === null ? 'Direct fee receipts are missing the original wallet balance; reconciliation is required.' : null;
    const available = walletBalance === null || fundingBlock ? 0n : min(funded, max0(walletBalance - protectedBalance));
    return {
      enabled: settings().enabled, armed: settings().armed, backup: 'none', mainCoin: coin(), configured: configured && Boolean(coin()),
      blockedReason: ledgerBlock(book) || fundingBlock || setupBlock() || activationBlock(),
      sweepMs, minLamports: String(minLamports), maxLamports: maxLamports ? String(maxLamports) : null, slippagePercent, separate,
      wallet: buyer?.publicKey.toBase58() || null, treasury: treasury?.publicKey.toBase58() || null,
      entitledLamports: String(entitled), spentLamports: String(spent), owedLamports: String(owed),
      forwardedLamports: String(forwarded), claimedLamports: String(BigInt(book.claimedLamports || 0)), toForwardLamports: String(toForward), directMain: directMain(),
      treasuryLamports: treasuryBalance === null ? null : String(treasuryBalance), walletLamports: walletBalance === null ? null : String(walletBalance),
      availableLamports: String(available), protectedBuyerLamports: String(protectedBalance), pending: lane.pending(),
      lastRun: book.lastRun || null, lastError: book.lastError || null,
      purchases: book.purchases.slice(-20).reverse(), forwards: book.forwards.slice(-10).reverse(), claims: book.claims.slice(-10).reverse(),
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
      // Receipts are credited per wallet (feeLedger.totals). A main coin's own fee
      // receipts in these wallets were booked 100% to buying that coin, so they pin
      // it; other coins' buyback shares buy whichever coin is main.
      const wallets = [treasury, buyer].filter(Boolean).map(key => key.publicKey.toBase58());
      const proposed = next.mainCoin || mainCoin?.toBase58() || null;
      const allocated = Object.values(feeLedger.read().distributions).some(row => wallets.includes(row.treasury) && row.mint === row.mainCoin && row.mint !== proposed);
      if (coin() && proposed !== coin() && allocated) throw new HttpError('The main coin cannot change after fee receipts have been allocated.', 409);
      next.enabled = false; next.armed = false; next.armedFor = null;
    }
    if (patch.enabled !== undefined) {
      next.enabled = Boolean(patch.enabled);
      next.armed = false; next.armedFor = null;
    }
    if (patch.armed !== undefined) {
      if (patch.enabled !== undefined) throw new HttpError('Choose either immediate start/stop or start after launch.', 400);
      next.armed = Boolean(patch.armed);
      next.enabled = false;
      const mint = next.mainCoin || mainCoin?.toBase58() || null;
      if (next.armed && (!configured || !mint)) throw new HttpError('Configure the main mint and buyback wallet before arming buybacks.', 409);
      next.armedFor = next.armed ? identities(mint) : null;
    }
    if (next.enabled && (!configured || !(next.mainCoin || mainCoin?.toBase58() || null))) throw new HttpError('Configure the main mint and buyback wallet before starting buybacks.', 409);
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

  // The creator claim for a direct main token: pump's curve vault always, plus the
  // PumpSwap creator vault (paid in wSOL, unwrapped and closed in the same
  // transaction) once that vault exists, so an unmigrated coin never pays its rent.
  async function buildClaim() {
    if (buildClaimImpl) return buildClaimImpl();
    const all = await new OnlinePumpSdk(connection).collectCoinCreatorFeeInstructions(buyer.publicKey, buyer.publicKey);
    const ammVault = await connection.getAccountInfo(coinAccounts(new PublicKey(coin()), buyer.publicKey).ammVaultAta);
    return ammVault ? all : all.filter(ix => ix.programId.equals(PUMP_PROGRAM_ID));
  }

  async function prepare(instructions, payer, context) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);
    return { transaction, lastValidBlockHeight, context };
  }

  // SOL arriving in a separate buyback wallet keeps whatever it already held (its
  // balance before, less money still funded) protected from spending.
  function raiseFloor(book, before) {
    const previousFunded = max0(BigInt(book.forwardedLamports) + BigInt(book.claimedLamports || 0) - BigInt(book.spentLamports));
    const existing = max0(before - previousFunded);
    const previousFloor = BigInt(book.protectedBuyerLamports || RESERVE);
    book.protectedBuyerLamports = String(existing > previousFloor ? existing : previousFloor);
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
      raiseFloor(book, solBefore(details, buyerAddress));
      book.forwardedLamports = String(BigInt(book.forwardedLamports) + received);
      book.forwards = [...book.forwards, { ...common, lamports: String(received) }].slice(-200);
    } else if (kind === 'claim') {
      // The wallet's change plus its wSOL account's change is the claim net of the
      // network fee; wSOL the wallet already held is unwrapped and cancels out.
      const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(buyerAddress), true, TOKEN_PROGRAM_ID);
      let wsolChange = 0n;
      try { wsolChange = solDelta(details, wsol); } catch { /* curve-only claim: no wSOL account */ }
      const before = solBefore(details, buyerAddress), received = max0(solDelta(details, buyerAddress) + wsolChange);
      if (separate) {
        raiseFloor(book, before);
        book.claimedLamports = String(BigInt(book.claimedLamports || 0) + received);
      }
      book.claims = [...book.claims, { ...common, mint, lamports: String(received) }].slice(-200);
      // The shared ledger books it for the coin page and, when the buyback wallet is
      // also the fee wallet, as that wallet's buyback entitlement.
      await feeLedger.distribution({ signature: attempt.signature, mint, mainCoin: mint, treasury: buyerAddress, treasuryBalanceBefore: String(before), netReceipt: true, lamports: String(received), treasuryLamports: String(received), socialLamports: '0', buybackLamports: String(received), at: attempt.at, slot: details.slot, reason: `${reason} (creator fees)` });
      const rows = Object.values(feeLedger.read().distributions).filter(row => row.mint === mint);
      if (store.get(mint)) await store.update(mint, { fees: { distributedLamports: rows.reduce((sum, row) => sum + BigInt(row.lamports), 0n).toString(), claims: rows.slice(-200) } });
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
    if (['buy', 'claim'].includes(attempt.context.kind)) {
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
      if (!configured || !coin()) return { skipped: 'not configured' };
      if (!canBuy()) return { skipped: 'fee collection is being settled' };
      if (!settings().enabled && !settings().armed && !force) return { skipped: 'disabled' };
      const snapshot = await status();
      if (snapshot.blockedReason) return { skipped: 'blocked', reason: snapshot.blockedReason };
      if (settings().armed) {
        await store.setMeta('settings', { ...store.getMeta('settings', {}), buyback: { ...settings(), enabled: true, armed: false, armedFor: null } });
      }
      const context = { mint: coin(), reason, buyerAddress: buyer.publicKey.toBase58(), treasuryAddress: treasury.publicKey.toBase58() };
      // One transaction per run, buying first. Claims and forwards only refill the funds,
      // so a coin whose fees never stop arriving can never starve its own buybacks.
      const available = BigInt(snapshot.availableLamports);
      const buyDue = available >= BigInt(minLamports) && available > BUY_OVERHEAD;
      if (!buyDue) {
        const amount = BigInt(snapshot.toForwardLamports);
        if (amount >= 5_000_000n) return await lane.execute({ settle, settleFailure, build: () => prepare([SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: buyer.publicKey, lamports: amount })], treasury, { ...context, kind: 'forward', budget: String(amount) }) });
        const claimable = BigInt(watcher?.get?.(coin())?.unclaimedLamports || 0);
        if (directMain() && claimable >= BigInt(claimMinLamports)) {
          return await lane.execute({ settle, settleFailure, build: async () => prepare([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...await buildClaim()], buyer, { ...context, kind: 'claim', budget: String(claimable) }) });
        }
        return { skipped: 'below minimum', availableLamports: String(available) };
      }
      // An optional cap spreads a large backlog over several buys instead of one.
      const budget = maxLamports && available > BigInt(maxLamports) ? BigInt(maxLamports) : available;
      if (!separate && !ledger().directFundingInitialized) {
        await store.setMeta('buybacks', { ...ledger(), buyer: context.buyerAddress, treasury: context.treasuryAddress, mint: context.mint, directFundingInitialized: true, protectedBuyerLamports: snapshot.protectedBuyerLamports });
      }
      return await lane.execute({ settle, settleFailure, build: async () => {
        const input = (budget - BUY_OVERHEAD) * 10_000n / BigInt(Math.ceil((100 + slippagePercent) * 100));
        const { venue, instructions } = await buildBuy(coin(), input);
        return prepare([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions], buyer, { ...context, kind: 'buy', budget: String(budget), venue });
      } });
    } catch (error) {
      await store.setMeta('buybacks', { ...ledger(), lastError: { at: new Date().toISOString(), message: error.message } }).catch(() => {});
      log.warn(`[buyback] ${error.message}`);
      return { error: error.message };
    } finally { running = false; }
  }

  function summary() {
    const book = ledger();
    return { mainCoin: coin(), enabled: settings().enabled, armed: settings().armed, wallet: buyer?.publicKey.toBase58() || null, claimedLamports: String(BigInt(book.claimedLamports || 0)), blockedReason: ledgerBlock(book) || setupBlock() || activationBlock(), pending: lane.pending()?.signature || null, spentLamports: book.spentLamports, purchases: book.purchaseCount, tokens: book.tokenTotal, lastAt: book.purchases.at(-1)?.at || null, recent: book.purchases.slice(-5).reverse() };
  }
  return {
    enabled: configured, separate, wallet: buyer?.publicKey.toBase58() || null,
    busy: () => running || configuring || Boolean(lane.pending()),
    status, configure, run, entitledLamports, buildBuy, buildClaim, summary, mainCoin: coin,
    start() { if (!buyer) return; run().catch(() => {}); timer = setInterval(() => run().catch(() => {}), sweepMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
