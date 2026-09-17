// Resolves an X handle to its numeric account ID, display name and picture through
// the public fxtwitter API (no credentials). The numeric ID is what a launch record
// keeps, so a later handle change never redirects a payout.
export const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const POSITIVE_TTL = 10 * 60_000;
const NEGATIVE_TTL = 60_000;
const MAX_ENTRIES = 2000;

export function createXLookup({ fetchImpl = fetch, now = Date.now, endpoint = 'https://api.fxtwitter.com' } = {}) {
  const cache = new Map();
  const inflight = new Map();
  function remember(key, value) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: now() + (value ? POSITIVE_TTL : NEGATIVE_TTL) });
    return value;
  }
  async function fetchProfile(key) {
    const response = await fetchImpl(`${endpoint}/${encodeURIComponent(key)}`, {
      headers: { 'User-Agent': 'route-site', Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    if (response.status === 404) return remember(key, null);
    if (!response.ok) throw new Error(`X lookup failed (${response.status})`);
    // Unknown users come back as an HTML page with status 200.
    if (!(response.headers.get('content-type') || '').includes('json')) return remember(key, null);
    const body = await response.json();
    const user = body?.user;
    if (body?.code !== 200 || !user?.id || !user?.screen_name) return remember(key, null);
    return remember(key, {
      id: String(user.id),
      handle: String(user.screen_name).toLowerCase(),
      name: String(user.name || ''),
      avatarUrl: String(user.avatar_url || '').replace(/_normal\.(\w+)$/, '_400x400.$1'),
      followers: Number.isFinite(user.followers) ? user.followers : null,
      lookedUpAt: new Date(now()).toISOString(),
    });
  }
  async function lookup(handle) {
    const key = String(handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!HANDLE_PATTERN.test(key)) return null;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (!inflight.has(key)) inflight.set(key, fetchProfile(key).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }
  return { lookup, cache };
}
