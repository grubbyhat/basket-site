import express from 'express';
import path from 'node:path';
import { HttpError } from './errors.js';
import { mediaDir } from './media.js';
import { publicLaunch } from './service.js';
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

export function createApp({ store, service, xLookup, engine, dataDir, distDir, origin, treasury, log = console }) {
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

  app.get('/api/health', (req, res) => res.json({ ok: true, origin, treasury: treasury?.toBase58() || null, devBuys: engine.devBuysEnabled, dataDir, ...store.stats() }));
  app.get('/api/stats', (req, res) => res.json(store.stats()));
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
  app.post('/api/launch/prepare', rateLimit(10), wrap(async (req, res) => res.json(await service.prepare(req.body))));
  app.post('/api/launch/send', rateLimit(10), wrap(async (req, res) => res.json(await service.send(req.body))));
  app.get('/api/launch/:mint', wrap(async (req, res) => {
    const record = store.get(String(req.params.mint || ''));
    if (!record) throw new HttpError('Launch not found.', 404);
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicLaunch(record));
  }));
  app.get('/api/launches', (req, res) => {
    const wallet = typeof req.query.wallet === 'string' && req.query.wallet ? req.query.wallet : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ launches: store.list({ wallet, status: wallet ? null : 'confirmed', limit }).map(publicLaunch) });
  });
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
