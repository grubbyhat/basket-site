import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// One JSON file per launch, keyed by mint. Writes are atomic (temp file + rename)
// and serialized per mint so a status update never races an earlier write.
export async function openStore(dir) {
  const launchesDir = path.join(dir, 'launches');
  const metaDir = path.join(dir, 'meta');
  await mkdir(launchesDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });
  const meta = new Map();
  for (const file of await readdir(metaDir)) {
    if (!file.endsWith('.json')) continue;
    try { meta.set(file.slice(0, -5), JSON.parse(await readFile(path.join(metaDir, file), 'utf8'))); }
    catch { throw new Error(`Cannot read persisted metadata ${file}; refusing to discard a possible money journal.`); }
  }
  const records = new Map();
  for (const file of await readdir(launchesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(path.join(launchesDir, file), 'utf8'));
      if (record?.mint) records.set(record.mint, record);
    } catch (error) {
      console.warn(`[store] skipped ${file}: ${error.message}`);
    }
  }
  const chains = new Map();
  function commit(mint, build) {
    const target = path.join(launchesDir, `${mint}.json`);
    const previous = chains.get(mint) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const record = build(records.get(mint));
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(record, null, 2));
      await rename(temp, target);
      records.set(mint, record);
      return record;
    });
    chains.set(mint, next);
    return next;
  }
  const metaChains = new Map();
  function persistMeta(key, value) {
    const target = path.join(metaDir, `${key}.json`);
    const previous = metaChains.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2));
      await rename(temp, target);
    });
    metaChains.set(key, next);
    return next;
  }
  return {
    getMeta: (key, fallback = null) => (meta.has(key) ? meta.get(key) : fallback),
    async setMeta(key, value) {
      if (!/^[a-z0-9-]+$/.test(key)) throw new Error('meta keys are lowercase names');
      // Money journals must not appear committed in memory after a disk failure.
      await persistMeta(key, value);
      meta.set(key, value);
      return value;
    },
    get: mint => records.get(mint) || null,
    async create(record) {
      if (!record?.mint) throw new Error('A launch record needs a mint.');
      return commit(record.mint, current => {
        if (current) throw new Error(`Launch ${record.mint} already exists.`);
        return { ...record, createdAt: record.createdAt || new Date().toISOString() };
      });
    },
    async update(mint, patch) {
      return commit(mint, current => {
        if (!current) throw new Error(`Launch ${mint} is missing.`);
        return { ...current, ...patch, updatedAt: new Date().toISOString() };
      });
    },
    list({ wallet = null, status = null, limit = 50 } = {}) {
      return [...records.values()]
        .filter(record => (!wallet || record.wallet === wallet) && (!status || record.status === status))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.max(0, limit));
    },
    stats() {
      const coins = [...records.values()].filter(record => record.status === 'confirmed');
      const recipients = new Set(coins.flatMap(record => (record.recipients || []).map(recipient => recipient.xId)));
      const collected = coins.reduce((sum, record) => sum + BigInt(record.fees?.distributedLamports || 0), 0n);
      return {
        coins: coins.length,
        launched: coins.filter(record => record.kind !== 'registered').length,
        registered: coins.filter(record => record.kind === 'registered').length,
        routed: coins.filter(record => ['active', 'detected'].includes(record.route?.status)).length,
        recipients: recipients.size,
        collectedLamports: collected.toString(),
        paidOutCents: 0, payments: 0,
      };
    },
  };
}
