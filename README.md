# Route

Launch a pump.fun token from a connected Solana wallet, or register one you already
launched, and route its creator fees to up to five X recipients. React + Vite
frontend, Express server with a chain watcher and a fee collector. The repository
keeps its original basket-site name.

**Live:** wallet connect (Wallet Standard), recipient verification on X with pictures,
self-hosted token metadata, launches signed in the user's wallet, registration of
existing coins, per-coin live market cap / bonding / fees over WebSockets, and fee
collection into the treasury. **Not yet:** dev buys (need the lookup table below),
conversion to dollars and X Money payouts.

## How the fees work

pump.fun pays a creator fee on every trade into a vault; nothing moves by itself.
Route uses pump.fun's fee-sharing program (`pfeeUxB6…`): the coin's creator creates
the coin's `FeeSharingConfig` and sets a single shareholder at 100% in one transaction
(`create_fee_sharing_config` + `update_fee_shares`; ~820 bytes, creator pays ~0.003 SOL
rent). The program migrates the coin's creator to the config and locks the shareholders
after that first update (`SharingConfigAdminRevoked` on any later change). Fees then
accrue in the config's own vault, `creator_vault(config)`, so every coin has its own
balance, and anyone can crank `distribute_creator_fees` to pay the shareholder. Route's
collector does that with the treasury key.

The shareholder is **Route's GitHub identity on pump.fun**: pump's fee program derives a
"social fee PDA" from the GitHub user id (`social-fee-pda`, id, platform 2), pump.fun
shows that account's profile picture on the coin, and every distribution lands there.
Creating the PDA is permissionless (`create_social_fee_pda`, the treasury pays the rent
once). Claiming out of it is `claim_social_fee_pda`, which only pump's own
`social_claim_authority` signs after the GitHub owner logs in on pump.fun: collection
into the account is automatic, the final claim to a wallet is a pump.fun login with that
GitHub. Set `ROUTE_GITHUB`; without it the treasury wallet is the shareholder.

- A **launch** is two transactions signed in one wallet prompt with one blockhash:
  `create_v2` (wallet = creator and payer, mint co-signs) and the fee route. The
  server broadcasts the create, waits for confirmation, then broadcasts the route.
  If the route expires or fails the coin stays live with `route.status: failed`
  and the creator finishes it from the coin page (same flow as registration).
- **Registration** works for any pump.fun coin whose creator connects, unless a
  sharing config already exists elsewhere (locked). Graduated coins use
  `update_fee_shares_v2` with the canonical pool (not yet exercised live).
- Fees that accrued before registration stay in the creator's own pump.fun vault.

## Run locally

Install Node.js 24 (Node 22 cannot load the pump.fun SDK's ESM build: its anchor
re-export of `BN` is not detected there), then:

```sh
npm ci
ROUTE_TREASURY=<treasury public key> npm run server   # API, media, WebSocket on :5275
npm run dev                                           # Vite on :5274, proxies /api, /m, /i, /ws
```

Without `ROUTE_TREASURY` the site runs but launches and registrations are refused.

## Server

- `GET /api/x/:handle` — X profile (numeric id, name, picture) via fxtwitter.
- `POST /api/launch/prepare` → `{ mint, transactions: [create, route] }`;
  `POST /api/launch/send` `{ mint, signedTransactions }`; `GET /api/launch/:mint`.
- `GET /api/coin/:mint/inspect` — any pump coin: metadata, creator, phase, sharing state.
- `POST /api/route/prepare` `{ mint, wallet, recipients? }` → `{ transactions: [route] }`
  (or `already: true` when the chain already routes to the treasury);
  `POST /api/route/send` `{ mint, signedTransaction }`.
- `GET /api/coins`, `GET /api/coin/:mint` — records with live state; `GET /api/stats`.
- `WS /ws` — `snapshot` on connect, then `coin` and `sol` updates.
- `POST /api/admin/collect/:mint` with header `x-route-admin` — collect now.
- `POST /api/admin/setup` with header `x-route-admin` — create Route's GitHub fee account.
- Media: `/i/<mint>.<ext>`, `/m/<mint>.json` (CORS `*`).

The watcher subscribes (WebSocket `accountSubscribe`) to each coin's bonding curve
and fee vault, and after graduation to the PumpSwap pool reserves and AMM vault.
Bonding progress is derived from the curve's own reserves (works for mayhem-mode
curves too). SOL/USD comes from Kraken's public ticker every 60 s. The collector
runs when `ROUTE_TREASURY_SECRET` is set: when a vault holds at least
`ROUTE_COLLECT_MIN_LAMPORTS` (default 0.01 SOL) it distributes after a 30 s
debounce and records each claim on the coin (`fees.claims`). Vault events come from
the subscriptions; a one-minute sweep re-reads every vault in one batched call as the
safety net, and a sweep also runs at boot. Each distribution costs the treasury one
network fee, so the treasury must hold some SOL.

Records live in `DATA_DIR/launches/<mint>.json` (atomic writes). They hold no keys
and no signed packets; a launch's signed route is kept in memory only until the
create confirms.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ROUTE_TREASURY` | Public key that receives 100% of every coin's creator fees. |
| `ROUTE_GITHUB` | GitHub username whose social fee PDA receives every coin's fees (pump.fun shows its picture). The server creates the PDA at boot when the treasury key is set, or on `POST /api/admin/setup`. |
| `ROUTE_TREASURY_SECRET` | The treasury keypair (JSON array or base58); enables the collector, which pays distribution fees from it, and pays the one-time GitHub fee account rent. Must match `ROUTE_TREASURY` if both are set. |
| `ROUTE_ADMIN_TOKEN` | Header value for `/api/admin/*`. |
| `ROUTE_COLLECT_MIN_LAMPORTS` | Collection threshold (default 10000000). |
| `ROUTE_LOOKUP_TABLE` | Address lookup table for create + dev buy; `npm run table:create` (needs ~0.005 SOL in the treasury). |
| `SOLANA_RPC_URL`, `SOLANA_WS_URL` | RPC endpoints (default public mainnet-beta). |
| `DATA_DIR` | Records and hosted media (Railway volume `/data`). |
| `PUBLIC_ORIGIN` | Origin used in metadata URLs. |

## Checks

```sh
npm test              # validation, store, X lookup, fee sharing, watcher, transaction building, HTTP API
npm run test:chain    # mainnet: simulates a create, and the fee route on a freshly created live coin
npm run build
npm run test:browser  # BASKET_URL=http://127.0.0.1:5275 against a running server
npm run test:launch-ui  # mock Wallet Standard wallet: two-transaction launch, registration, coin page
```

`test:chain` and `test:launch-ui` need network access to Solana mainnet; nothing is
broadcast. Browser checks use an installed Chrome (`CHROME_PATH` to override).

## Deployment

Railway builds with Railpack (`npm run build`, then `node server/index.js`) and
health-checks `/api/health`. Every push to `main` redeploys. The service needs the
variables above plus a volume at `/data`.

## Design and assets

The visual direction references [UsePaid](https://usepaid.app/), with guidance from
[Emil Kowalski's design engineering skill](https://github.com/emilkowalski/skills)
and [Taste Skill](https://github.com/leonxlnx/taste-skill).
Typography uses self-hosted IBM Plex Sans; icons use Phosphor.
