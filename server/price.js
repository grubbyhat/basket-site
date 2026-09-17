// SOL/USD from Kraken's public ticker (no key), refreshed while anything is
// listening. Unknown stays null; the UI then shows SOL amounts only.
export function createPriceFeed({ fetchImpl = fetch, intervalMs = 60_000, log = console, pair = 'SOLUSD' } = {}) {
  const listeners = new Set();
  let current = { usd: null, at: null };
  let timer = null;
  async function refresh() {
    try {
      const response = await fetchImpl(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      const body = await response.json();
      const last = Number(body?.result?.[pair]?.c?.[0]);
      if (!Number.isFinite(last) || last <= 0) throw new Error(body?.error?.join?.(', ') || 'no price');
      current = { usd: last, at: new Date().toISOString() };
      listeners.forEach(listener => listener(current));
    } catch (error) {
      log.warn(`[price] SOL/USD refresh failed: ${error.message}`);
    }
    return current;
  }
  return {
    get: () => current,
    refresh,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() { if (!timer) { refresh(); timer = setInterval(refresh, intervalMs); timer.unref?.(); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
