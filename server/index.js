import { Connection } from '@solana/web3.js';
import { createApp } from './app.js';
import { DATA_DIR, DIST_DIR, LOOKUP_TABLE, PORT, PUBLIC_ORIGIN, RPC_URL, TREASURY } from './config.js';
import { createLaunchEngine } from './launch.js';
import { createLaunchService } from './service.js';
import { openStore } from './store.js';
import { createXLookup } from './x-lookup.js';

const connection = new Connection(RPC_URL, { commitment: 'confirmed' });
const store = await openStore(DATA_DIR);
const xLookup = createXLookup();
const engine = createLaunchEngine({ connection, treasury: TREASURY, lookupTable: LOOKUP_TABLE });
const service = createLaunchService({ store, engine, xLookup, dataDir: DATA_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY });
const app = createApp({ store, service, xLookup, engine, dataDir: DATA_DIR, distDir: DIST_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY });

app.listen(PORT, () => {
  console.log(`[route] listening on ${PORT} as ${PUBLIC_ORIGIN}; data ${DATA_DIR}; rpc ${new URL(RPC_URL).host}; treasury ${TREASURY?.toBase58() || 'UNSET'}; dev buys ${engine.devBuysEnabled ? 'on' : 'off'}`);
  service.recover();
});
