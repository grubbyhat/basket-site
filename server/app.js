import express from 'express';
import path from 'node:path';
import { HttpError } from './errors.js';
import { mediaDir } from './media.js';
import { HANDLE_PATTERN } from './x-lookup.js';

function rateLimit(max, windowMs = 60_000) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter(time => now - time < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    recent.push(now);
    hits.set(req.ip, recent);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    next();
  };
}

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createApp({ store, service, xLookup, engine, dataDir, distDir, origin, treasury, price = null, watcher = null, collector = null, buyback = null, adminToken = '', github = null, setup = null, log = console }) {
  const admin = (req, res, next) => { if (!adminToken || req.get('x-route-admin') !== adminToken) return res.status(403).json({ error: 'Not allowed.' }); next(); };
  const routeInfo = () => ({ shareholder: engine.shareholder?.toBase58() || null, github: github ? { login: github.login, id: github.id, avatarUrl: github.avatarUrl, ready: github.ready } : null, buyback: buyback?.summary ? buyback.summary() : null, ...(watcher?.route ? watcher.route() : {}) });
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  // Hosted token media: pump.fun and wallets fetch these from other origins.
  const media = mediaDir(dataDir);
  const open = (req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); };
  app.use('/i', open, express.static(media, { index: false, immutable: true, maxAge: '365d', extensions: false }));
  app.get('/m/:file', open, (req, res, next) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(req.params.file)) return next();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(media, req.params.file), { headers: { 'Content-Type': 'application/json' } }, error => error && next());
  });

  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  app.get('/api/health', (req, res) => res.json({ ok: true, origin, treasury: treasury?.toBase58() || null, devBuys: engine.devBuysEnabled, collector: collector?.enabled ? collector.address : null, sweepMs: collector?.enabled ? collector.sweepMs : null, watching: watcher?.size() ?? 0, sol: price?.get() || null, route: routeInfo(), dataDir, ...store.stats() }));
  app.get('/api/stats', noStore, (req, res) => res.json({ ...store.stats(), sol: price?.get() || null, route: routeInfo() }));
  app.get('/api/x/:handle', rateLimit(60), wrap(async (req, res) => {
    const handle = String(req.params.handle || '').replace(/^@/, '').toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) throw new HttpError('Enter an X handle.', 400);
    let profile;
    try { profile = await xLookup.lookup(handle); }
    catch (error) { throw new HttpError(`X lookup is unavailable right now (${error.message}).`, 502); }
    if (!profile) throw new HttpError(`We couldn't find @${handle} on X.`, 404);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(profile);
  }));

  // Launch a new coin: two transactions signed together.
  app.post('/api/launch/prepare', rateLimit(10), wrap(async (req, res) => res.json(await service.prepare(req.body))));
  app.post('/api/launch/send', rateLimit(10), wrap(async (req, res) => res.json(await service.send(req.body))));
  app.get('/api/launch/:mint', noStore, wrap(async (req, res) => {
    const coin = service.coin(String(req.params.mint || ''));
    if (!coin) throw new HttpError('Launch not found.', 404);
    res.json(coin);
  }));

  // Put an existing coin's fees on Route.
  app.get('/api/coin/:mint/inspect', rateLimit(30), noStore, wrap(async (req, res) => res.json(await service.inspect(req.params.mint))));
  app.post('/api/route/prepare', rateLimit(10), wrap(async (req, res) => res.json(await service.prepareRoute(req.body))));
  app.post('/api/route/send', rateLimit(10), wrap(async (req, res) => res.json(await service.sendRoute(req.body))));

  // Coins on Route with their live state.
  app.get('/api/coins', noStore, (req, res) => res.json({ sol: price?.get() || null, route: routeInfo(), coins: service.coins() }));
  app.get('/api/coin/:mint', noStore, wrap(async (req, res) => {
    const coin = service.coin(String(req.params.mint || ''));
    if (!coin) throw new HttpError('This coin is not on Route.', 404);
    res.json({ sol: price?.get() || null, coin });
  }));
  app.get('/api/launches', noStore, (req, res) => {
    const wallet = typeof req.query.wallet === 'string' && req.query.wallet ? req.query.wallet : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.json({ launches: wallet ? store.list({ wallet, limit }).map(record => service.coin(record.mint)) : service.coins().slice(0, limit) });
  });

  app.post('/api/admin/collect/:mint', admin, wrap(async (req, res) => {
    if (!collector?.enabled) throw new HttpError('Fee collection is not configured on this server.', 503);
    res.json(await collector.collect(String(req.params.mint || ''), { reason: 'admin' }));
  }));
  app.get('/api/admin/status', admin, noStore, wrap(async (req, res) => res.json({
    treasury: treasury?.toBase58() || null,
    treasuryLamports: treasury ? String(await (async () => { try { return await engine.balance?.(); } catch { return null; } })() ?? '') : null,
    route: routeInfo(),
    collector: collector?.enabled ? { address: collector.address, sweepMs: collector.sweepMs } : null,
    buyback: buyback ? await buyback.status() : null,
    coins: store.stats(),
  })));
  app.post('/api/admin/buyback', admin, wrap(async (req, res) => {
    if (!buyback) throw new HttpError('Buybacks are not configured on this server.', 503);
    res.json(await buyback.configure(req.body || {}));
  }));
  app.post('/api/admin/buyback/run', admin, wrap(async (req, res) => {
    if (!buyback) throw new HttpError('Buybacks are not configured on this server.', 503);
    res.json(await buyback.run({ force: true, reason: 'admin' }));
  }));
  app.post('/api/admin/sweep', admin, wrap(async (req, res) => {
    if (!collector?.enabled) throw new HttpError('Fee collection is not configured on this server.', 503);
    res.json({ claimed: await collector.sweep('admin') });
  }));
  // One-time setup that needs the treasury key: create Route's GitHub fee account.
  app.post('/api/admin/setup', admin, wrap(async (req, res) => {
    if (!setup) throw new HttpError('Nothing to set up on this server.', 503);
    res.json(await setup());
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(distDir, 'index.html'), error => error && next());
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = error.status || error.statusCode || 500;
    if (status >= 500) log.error(`[http] ${req.method} ${req.path}: ${error.stack || error.message}`);
    const message = error.type === 'entity.too.large' ? 'This image is too large to upload.' : status >= 500 && !(error instanceof HttpError) ? 'Something went wrong on our side.' : error.message;
    res.status(status).json({ error: message, ...(error.field ? { field: error.field } : {}) });
  });
  return app;
}
