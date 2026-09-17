// Live state for every coin on Route through WebSocket account subscriptions:
// the bonding curve (price, market cap, bonding progress, graduation), the
// coin's fee vault (unclaimed fees) and, once graduated, the PumpSwap pool's
// reserves and AMM fee vault. One initial read per account, then pushes only.
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { RENT_EXEMPT_EMPTY, coinAccounts, curveStats, decodeCurve, decodePool, poolStats, tokenAmount } from './pump.js';

const decodeSocialFee = info => PUMP_SDK.decodeSocialFeePda(info);

const POOL_RETRY_MS = [2000, 5000, 10000, 20000, 40000];

export function createCoinWatcher({ connection, store, pumpState, price, route = null, log = console }) {
  const coins = new Map();
  const listeners = new Set();
  const lamportsToSol = value => Number(value) / 1e9;
  // Route's own fee account (the GitHub social fee PDA): what the cranks have
  // sent there and is waiting for a pump.fun claim, and what has been claimed.
  const routeState = { address: route?.pda?.toBase58() || null, github: route?.github || null, exists: false, unclaimedLamports: 0n, totalClaimedLamports: 0n, subscription: null, updatedAt: null };
  function routeView() {
    const usd = price.get().usd;
    const unclaimedSol = lamportsToSol(routeState.unclaimedLamports), claimedSol = lamportsToSol(routeState.totalClaimedLamports);
    return { address: routeState.address, github: routeState.github, exists: routeState.exists, unclaimedSol, unclaimedUsd: usd ? unclaimedSol * usd : null, claimedSol, claimedUsd: usd ? claimedSol * usd : null, updatedAt: routeState.updatedAt };
  }
  function applyRoute(info) {
    routeState.exists = Boolean(info);
    routeState.unclaimedLamports = 0n;
    routeState.totalClaimedLamports = 0n;
    if (info) {
      const lamports = BigInt(info.lamports || 0);
      const rent = BigInt(Math.round(info.data.length * 6960) + 890_880);
      routeState.unclaimedLamports = lamports > rent ? lamports - rent : 0n;
      try { routeState.totalClaimedLamports = BigInt(decodeSocialFee(info).totalClaimed.toString()); } catch { /* a plain wallet has no claim ledger */ }
    }
    routeState.updatedAt = new Date().toISOString();
    listeners.forEach(listener => { try { listener({ type: 'route', route: routeView() }); } catch (error) { log.warn(`[watch] listener failed: ${error.message}`); } });
  }

  function publicState(entry) {
    const usd = price.get().usd;
    const distributed = BigInt(store.get(entry.mint)?.fees?.distributedLamports || 0);
    const unclaimed = entry.vaultLamports > RENT_EXEMPT_EMPTY ? entry.vaultLamports - RENT_EXEMPT_EMPTY : 0n;
    const feesLamports = unclaimed + entry.ammVaultLamports + distributed;
    const mcapSol = lamportsToSol(entry.mcapLamports);
    return {
      mint: entry.mint,
      phase: entry.graduated ? 'graduated' : entry.complete ? 'migrating' : 'bonding',
      bonded: entry.complete || entry.graduated,
      progress: entry.graduated || entry.complete ? 1 : entry.progress,
      mcapSol, mcapUsd: usd ? mcapSol * usd : null,
      unclaimedSol: lamportsToSol(unclaimed + entry.ammVaultLamports),
      collectedSol: lamportsToSol(distributed),
      feesSol: lamportsToSol(feesLamports),
      feesUsd: usd ? lamportsToSol(feesLamports) * usd : null,
      unclaimedLamports: (unclaimed + entry.ammVaultLamports).toString(),
      updatedAt: entry.updatedAt,
    };
  }

  function emit(entry, type = 'coin') {
    entry.updatedAt = new Date().toISOString();
    const coin = publicState(entry);
    listeners.forEach(listener => { try { listener({ type, mint: entry.mint, coin }); } catch (error) { log.warn(`[watch] listener failed: ${error.message}`); } });
  }

  function subscribe(entry, key, handler) {
    try {
      const id = connection.onAccountChange(key, (info, context) => { try { handler(info, context); } catch (error) { log.warn(`[watch] ${entry.mint} update failed: ${error.message}`); } }, 'confirmed');
      entry.subscriptions.push(id);
    } catch (error) {
      log.warn(`[watch] subscribe failed for ${entry.mint}: ${error.message}`);
    }
  }

  async function watchPool(entry, attempt = 0) {
    if (entry.graduated || !coins.has(entry.mint)) return;
    const [poolInfo] = await connection.getMultipleAccountsInfo([entry.accounts.pool]).catch(() => [null]);
    const pool = decodePool(poolInfo);
    if (!pool) {
      if (attempt < POOL_RETRY_MS.length) setTimeout(() => watchPool(entry, attempt + 1), POOL_RETRY_MS[attempt]).unref?.();
      return;
    }
    entry.graduated = true;
    entry.pool = { base: pool.poolBaseTokenAccount, quote: pool.poolQuoteTokenAccount, isMayhemMode: Boolean(pool.isMayhemMode) };
    const [baseInfo, quoteInfo, ammVaultInfo] = await connection.getMultipleAccountsInfo([entry.pool.base, entry.pool.quote, entry.accounts.ammVaultAta]).catch(() => [null, null, null]);
    entry.baseReserve = tokenAmount(baseInfo);
    entry.quoteReserve = tokenAmount(quoteInfo);
    entry.ammVaultLamports = tokenAmount(ammVaultInfo);
    const refreshPrice = () => { entry.mcapLamports = poolStats({ supply: entry.supply, baseReserve: entry.baseReserve, quoteReserve: entry.quoteReserve, isMayhemMode: entry.pool.isMayhemMode }).mcapLamports; emit(entry); };
    refreshPrice();
    subscribe(entry, entry.pool.base, info => { entry.baseReserve = tokenAmount(info); refreshPrice(); });
    subscribe(entry, entry.pool.quote, info => { entry.quoteReserve = tokenAmount(info); refreshPrice(); });
    subscribe(entry, entry.accounts.ammVaultAta, info => { entry.ammVaultLamports = tokenAmount(info); emit(entry, 'vault'); });
    log.info(`[watch] ${entry.mint} graduated; watching pool ${entry.accounts.pool.toBase58()}`);
  }

  async function track(mint) {
    if (coins.has(mint)) return coins.get(mint);
    const key = new PublicKey(mint);
    const entry = { mint, accounts: coinAccounts(key), subscriptions: [], complete: false, graduated: false, progress: 0, mcapLamports: 0n, supply: 0n, vaultLamports: 0n, ammVaultLamports: 0n, baseReserve: 0n, quoteReserve: 0n, pool: null, updatedAt: null };
    coins.set(mint, entry);
    const applyCurve = info => {
      const curve = decodeCurve(info);
      if (!curve) return;
      const stats = curveStats(curve);
      entry.supply = stats.supply;
      entry.progress = stats.progress;
      entry.complete = stats.complete;
      if (!entry.graduated) entry.mcapLamports = stats.mcapLamports;
      if (entry.complete && !entry.graduated) watchPool(entry);
    };
    const [curveInfo, vaultInfo] = await connection.getMultipleAccountsInfo([entry.accounts.bondingCurve, entry.accounts.vault]);
    if (!curveInfo) { coins.delete(mint); throw new Error(`no bonding curve for ${mint}`); }
    applyCurve(curveInfo);
    entry.vaultLamports = BigInt(vaultInfo?.lamports || 0);
    subscribe(entry, entry.accounts.bondingCurve, info => { applyCurve(info); emit(entry); });
    subscribe(entry, entry.accounts.vault, info => { entry.vaultLamports = BigInt(info.lamports || 0); emit(entry, 'vault'); });
    emit(entry);
    return entry;
  }

  async function untrack(mint) {
    const entry = coins.get(mint);
    if (!entry) return;
    coins.delete(mint);
    await Promise.all(entry.subscriptions.map(id => connection.removeAccountChangeListener(id).catch(() => {})));
  }

  async function refresh(mint) {
    const entry = coins.get(mint);
    if (!entry) return null;
    const [vaultInfo, ammVaultInfo] = await connection.getMultipleAccountsInfo([entry.accounts.vault, entry.accounts.ammVaultAta]);
    entry.vaultLamports = BigInt(vaultInfo?.lamports || 0);
    entry.ammVaultLamports = tokenAmount(ammVaultInfo);
    emit(entry, 'vault');
    return publicState(entry);
  }

  // One batched read of every coin's fee vaults: the safety net behind the
  // subscriptions, so a dropped socket never leaves fees uncollected.
  async function refreshAll() {
    const entries = [...coins.values()];
    for (let start = 0; start < entries.length; start += 50) {
      const batch = entries.slice(start, start + 50);
      const infos = await connection.getMultipleAccountsInfo(batch.flatMap(entry => [entry.accounts.vault, entry.accounts.ammVaultAta]));
      batch.forEach((entry, index) => {
        const vaultLamports = BigInt(infos[index * 2]?.lamports || 0);
        const ammVaultLamports = tokenAmount(infos[index * 2 + 1]);
        if (vaultLamports === entry.vaultLamports && ammVaultLamports === entry.ammVaultLamports) return;
        entry.vaultLamports = vaultLamports;
        entry.ammVaultLamports = ammVaultLamports;
        emit(entry, 'vault');
      });
    }
    if (route?.pda) applyRoute(await connection.getAccountInfo(route.pda).catch(() => null));
    return entries.length;
  }

  return {
    track, untrack, refresh, refreshAll,
    get: mint => (coins.has(mint) ? publicState(coins.get(mint)) : null),
    all: () => [...coins.values()].map(publicState),
    route: routeView,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    size: () => coins.size,
    async start() {
      if (route?.pda) {
        try {
          applyRoute(await connection.getAccountInfo(route.pda));
          routeState.subscription = connection.onAccountChange(route.pda, info => applyRoute(info), 'confirmed');
        } catch (error) { log.warn(`[watch] route account: ${error.message}`); }
      }
      const tracked = store.list({ limit: 1000 }).filter(record => record.status === 'confirmed');
      for (const record of tracked) {
        try { await track(record.mint); } catch (error) { log.warn(`[watch] cannot track ${record.mint}: ${error.message}`); }
      }
      log.info(`[watch] tracking ${coins.size} coin(s)`);
    },
    async stop() { for (const mint of [...coins.keys()]) await untrack(mint); if (routeState.subscription != null) await connection.removeAccountChangeListener(routeState.subscription).catch(() => {}); },
  };
}
