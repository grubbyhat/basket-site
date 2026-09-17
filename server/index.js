import http from 'node:http';
import { Connection } from '@solana/web3.js';
import { createApp } from './app.js';
import { createBuyback } from './buyback.js';
import { createCollector } from './collector.js';
import { createFeeShareDetector } from './detect.js';
import { ADMIN_TOKEN, BUYBACK_KEYPAIR, BUYBACK_MIN_LAMPORTS, BUYBACK_SHARE_BPS, BUYBACK_SLIPPAGE_PERCENT, COLLECT_MIN_LAMPORTS, COLLECT_SWEEP_MS, DATA_DIR, MAIN_COIN, DIST_DIR, GITHUB_USER, PORT, PUBLIC_ORIGIN, RPC_URL, TREASURY, TREASURY_KEYPAIR, WS_URL } from './config.js';
import { createGithubResolver, ensureSocialFeePda, githubFeePda, socialFeeState } from './github.js';
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

// Route's fee recipient: the GitHub account's social fee PDA when configured.
let github = null;
if (GITHUB_USER) {
  const profile = await createGithubResolver().lookup(GITHUB_USER);
  if (!profile) throw new Error(`ROUTE_GITHUB user "${GITHUB_USER}" was not found on GitHub.`);
  const pda = githubFeePda(profile.id);
  let state = await socialFeeState(connection, pda);
  if (!state.exists) {
    try { await ensureSocialFeePda({ connection, payer: TREASURY_KEYPAIR, userId: profile.id }); state = await socialFeeState(connection, pda); }
    catch (error) { console.warn(`[github] fee account for ${profile.login} is not created yet: ${error.message}`); }
  }
  github = { ...profile, pda, ready: state.exists };
}
const shareholder = github?.ready ? github.pda : null;
if (github && !github.ready) console.warn(`[github] ${github.login}'s fee account ${github.pda.toBase58()} does not exist; launches use the treasury wallet until it is created (fund the treasury and restart, or POST /api/admin/setup).`);

const engine = createLaunchEngine({ connection, treasury: TREASURY, shareholder, buybackShareBps: BUYBACK_SHARE_BPS });
const price = createPriceFeed();
const watcher = createCoinWatcher({ connection, store, pumpState: engine.pumpState, price, route: github ? { pda: github.pda, github: { login: github.login, id: github.id, avatarUrl: github.avatarUrl, ready: github.ready } } : null });
const collector = createCollector({ connection, store, treasury: TREASURY_KEYPAIR, watcher, minLamports: COLLECT_MIN_LAMPORTS, sweepMs: COLLECT_SWEEP_MS });
const buyback = createBuyback({ connection, store, treasury: TREASURY_KEYPAIR, signer: BUYBACK_KEYPAIR, watcher, mainCoin: MAIN_COIN, minLamports: BUYBACK_MIN_LAMPORTS, slippagePercent: BUYBACK_SLIPPAGE_PERCENT, sweepMs: COLLECT_SWEEP_MS });
const service = createLaunchService({ store, engine, xLookup, dataDir: DATA_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY, watcher, connection });
const setup = github ? async () => {
  const result = await ensureSocialFeePda({ connection, payer: TREASURY_KEYPAIR, userId: github.id });
  github.ready = true;
  engine.setShareholder(github.pda);
  return { github: github.login, pda: github.pda.toBase58(), created: result.created, signature: result.signature || null };
} : null;
const app = createApp({ store, service, xLookup, engine, dataDir: DATA_DIR, distDir: DIST_DIR, origin: PUBLIC_ORIGIN, treasury: TREASURY, price, watcher, collector, buyback, adminToken: ADMIN_TOKEN, github, setup });
const detector = createFeeShareDetector({ connection, store, service, allowed: () => engine.allowedShareholders });
const server = http.createServer(app);
attachLive({ server, watcher, price, coinsView: mint => (mint ? service.coin(mint) : service.coins()), routeView: () => ({ ...watcher.route(), shareholder: engine.shareholder?.toBase58() || null, github: github ? { login: github.login, id: github.id, avatarUrl: github.avatarUrl, ready: github.ready } : null, buyback: buyback.summary() }) });

server.listen(PORT, async () => {
  console.log(`[route] listening on ${PORT} as ${PUBLIC_ORIGIN}; data ${DATA_DIR}; rpc ${new URL(RPC_URL).host}; ws ${new URL(WS_URL).host}; treasury ${TREASURY?.toBase58() || 'UNSET'}; shareholder ${engine.shareholder?.toBase58() || 'UNSET'}${github ? ` (github ${github.login}${github.ready ? '' : ', account missing'})` : ''}; collector ${collector.enabled ? 'on' : 'off'}`);
  price.start();
  service.recover();
  await watcher.start();
  collector.start();
  buyback.start();
  detector.start();
});
