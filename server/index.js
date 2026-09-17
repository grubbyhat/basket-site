import http from 'node:http';
import { Connection } from '@solana/web3.js';
import { createApp } from './app.js';
import { createCollector } from './collector.js';
import { ADMIN_TOKEN, COLLECT_MIN_LAMPORTS, DATA_DIR, DIST_DIR, LOOKUP_TABLE, PORT, PUBLIC_ORIGIN, RPC_URL, TREASURY, TREASURY_KEYPAIR, WS_URL } from './config.js';
import { createLaunchEngine } from './launch.js';
import { attachLive } from './live.js';
import { createPriceFeed } from './price.js';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { createCoinWatcher } from './watch.js';
import { createXLookup } from './x-lookup.js';

const connection = new Connection(RPC_URL, { commitment: 'confirmed', wsEndpoint: WS_URL });
const store = await openStore(DATA_DIR);
const xLookup = createXLookup();
const engine = createLaunchEngine({ connection, treasury: TREASURY, lookupTable: LOOKUP_TABLE });
const price = createPriceFeed();
const watcher = createCoinWatcher({ connection, store, pumpState: engine.pumpState, price });
const collector = createCollector({ connection, store, treasury: TREASURY_KEYPAIR, watcher, minLamports: COLLECT_MIN_LAMPORTS });
const service = createLaunchService({ store, engine, xLookup, dataDir: DATA_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY, watcher, connection });
const app = createApp({ store, service, xLookup, engine, dataDir: DATA_DIR, distDir: DIST_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY, price, watcher, collector, adminToken: ADMIN_TOKEN });
const server = http.createServer(app);
attachLive({ server, watcher, price, coinsView: mint => (mint ? service.coin(mint) : service.coins()) });

server.listen(PORT, async () => {
  console.log(`[route] listening on ${PORT} as ${PUBLIC_ORIGIN}; data ${DATA_DIR}; rpc ${new URL(RPC_URL).host}; ws ${new URL(WS_URL).host}; treasury ${TREASURY?.toBase58() || 'UNSET'}; collector ${collector.enabled ? 'on' : 'off'}; dev buys ${engine.devBuysEnabled ? 'on' : 'off'}`);
  price.start();
  service.recover();
  await watcher.start();
  collector.start();
});
