# Route

Launch a pump.fun token from a connected Solana wallet, or register one you already
launched, and route its creator fees to up to five X recipients. React + Vite
frontend, Express server with a chain watcher and a fee collector. The repository
keeps its original basket-site name.

**Live:** wallet connect (Wallet Standard), recipient verification on X with pictures,
self-hosted token metadata, launches signed in the user's wallet, registration of
existing coins, per-coin live market cap / bonding / fees over WebSockets, and fee
collection into the treasury. **Not yet:** conversion to dollars and X Money payouts.

## How the fees work

pump.fun pays a creator fee on every trade into a vault; nothing moves by itself.
Route uses pump.fun's fee-sharing program (`pfeeUxB6…`): the coin's creator creates
the coin's `FeeSharingConfig` and sets the configured GitHub/treasury split in one transaction
(`create_fee_sharing_config` + `update_fee_shares`; ~820 bytes, creator pays ~0.003 SOL
rent). The program migrates the coin's creator to the config and locks the shareholders
after that first update (`SharingConfigAdminRevoked` on any later change). Fees then
accrue in the config's own vault, `creator_vault(config)`, so every coin has its own
balance, and anyone can crank `distribute_creator_fees` to pay the shareholder. Route's
collector does that with the treasury key.

The selected workflow is **direct fee collection and buybacks through the main
token's creator wallet**. Set `ROUTE_FEE_MODE=wallet`, use the creator key for both
`ROUTE_TREASURY_SECRET` and `ROUTE_BUYBACK_SECRET`, and set `ROUTE_TREASURY` to that
public key. New Route launches share 100% on-chain to this wallet. Route collects
automatically; no GitHub sign-in, browser session or manual claim is needed.
The main token's net fee receipts fund buybacks. Other coins contribute the configured
buyback share; receiving their fees in one wallet does not assign the recipient pool
to buybacks. Existing coins with locked GitHub sharing are not redirected by changing
the server configuration.

Optional GitHub mode (`ROUTE_FEE_MODE=github`) uses **Route's GitHub identity on pump.fun**: pump's fee program derives a
"social fee PDA" from the GitHub user id (`social-fee-pda`, id, platform 2), pump.fun
shows that account's profile picture on the coin, and every distribution lands there.
Creating the PDA is permissionless; the treasury pays its rent once. This optional
workflow uses **manual GitHub claiming on Pump.fun, automatic receipt reconciliation
and creator-wallet buybacks**. Sign into Pump as the configured GitHub user and
claim to the configured Route treasury wallet shown in admin. Route does not need
that browser session or a Pump login token for this workflow.

Route checks the finalized GitHub lifetime claim counter on its collection sweep.
When it changes, Route verifies the program's claim event, source account, actual
SOL movement and recipient, then reconciles the corresponding tracked deposits.
Net received SOL (after transaction fees/rent) is allocated proportionally to those
deposits; unrelated deposits and untracked fee income do not authorize buybacks.
Claims to another wallet are recorded with zero credit and shown in admin.
Receipt identities prevent double counting; paginated history recovery survives
restarts. Same-block deposits use confirmed transaction order. Missing metadata or
gaps in the lifetime claim counter leave funds uncredited until resolved.

`ROUTE_GITHUB_CLAIM_MODE` defaults to `manual`, which never builds or submits a
GitHub withdrawal. Automatic coin-vault distribution remains enabled. The separate
`automatic` GitHub withdrawal integration is unfinished: Pump's public builder
returns unsigned transactions and its co-signing authorization is not connected.
It must not be advertised as hands-free GitHub claiming.
Set `ROUTE_GITHUB`; without it the treasury wallet is the shareholder.

- A **launch** is two transactions signed in one wallet prompt with one blockhash:
  `create_v2` plus the optional dev buy in the same transaction (wallet = creator and
  payer, mint co-signs; 1227 bytes at the longest name and ticker, no lookup table:
  the on-chain metadata URI is `/m/<12-char mint prefix>`), and the fee route. The
  server broadcasts the create, waits for confirmation, then broadcasts the route.
  If the route expires or fails the coin stays live with `route.status: failed`
  and the creator finishes it from the coin page (same flow as registration).
- **Registration** works for any pump.fun coin whose creator connects, unless a
  sharing config already exists elsewhere (locked). Graduated coins use
  `update_fee_shares_v2` with the canonical pool (not yet exercised live).
- Fees that accrued before registration stay in the creator's own pump.fun vault.

## Buybacks into the main coin

In wallet mode new Route launches send all fees to the configured wallet. Other
coins allocate up to 5% to main-token buybacks (`ROUTE_BUYBACK_SHARE_BPS`), capped
by actual net receipts; the recipient portion remains separately accounted for.
The main token's own net receipts are allocated entirely to buybacks. Optional
GitHub mode splits the other coins' on-chain shares 95%/5% and credits the main
token's GitHub share only after a verified withdrawal reaches the treasury.

Collection uses the Pump SDK for bonding-curve fees and transfers PumpSwap creator
fees back into the same per-coin vault before distributing them. Finalized program
events and actual recipient balances determine credits. Display estimates and the
last 200 displayed claims never authorize spending. Receipt identities and lifetime
credits are persisted in `DATA_DIR/meta/fee-receipts.json` without history trimming.

When the wallets differ, the treasury forwards only these confirmed credits to
`ROUTE_BUYBACK_SECRET`. When they are the same wallet, confirmed net receipts fund
buys directly, without a self-transfer. The buyer key must match BOTH the creator and
signing user in the main token's original Pump creation transaction. Mutable fee
admins and form fields are not creator proof. Missing or mismatched proof blocks
funding as well as buying. An absent developer key never falls back to the treasury.

The buyer spends at most confirmed funded fees, preserves its existing SOL
balance, and includes slippage, account rent and network fees inside the funded
budget. Failed buys also debit their network fee. Transactions persist their
signature and original blockhash before sending; unknown results retain the same
identity across restarts. No backup trade follows an ambiguous send. PumpPortal is
unavailable until its transaction and spending limits are verified.

For a shared wallet, the first finalized fee receipt records the balance that
existed before collection, after the external launch. Collection network fees are
excluded from credits. Missing legacy balance evidence blocks direct funding, and
collection and buying cannot broadcast concurrently through the shared wallet.

Buybacks can be armed before launch with **Start after launch** in `/admin`.
Arming pins the configured mint, creator wallet and treasury; it sends nothing.
The worker starts automatically only after that mint is registered with Route fee
sharing and its original creation wallet is verified. Stop cancels the armed state
as well as running buybacks. Immediate Start still requires creator verification.
The mint cannot change after existing fee allocations bind it.
The page displays creator verification, actual available funding, unresolved sends
and the configured fee-collection mode separately. No live main-token purchase has
been verified while the configured mint is still unlaunched.

The main token can be launched directly on Pump.fun with 100% of its creator fees
shared directly to the configured Route/creator wallet in wallet mode (or to
`UseRouteApp` in GitHub mode). The saved main mint is checked before each collection
sweep, including at boot. Once that mint exists and its fee-sharing configuration
points entirely at Route, it is registered and tracked without a separate launch
or registration transaction on Route. This also recovers a launch made during
server downtime. Admin shows whether Route is waiting for launch, fee sharing, or
registration recovery. Wallet mode needs no manual claim; optional GitHub mode
still requires the owner to claim GitHub fees in Pump.fun.
Automatic buyback activation requires the separate armed setting above.

Live fee-sharing notifications that cannot yet be read or adopted remain in a
persistent retry queue. Registered coins whose initial watcher read fails are
retried during collection sweeps. This queue recovers observed events; it is not a
historical scan of every unrelated mint launched while the server was offline.

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
- `POST /api/route/adopt` `{ mint, recipients? }` with header `x-route-admin` — record a coin whose
  fee sharing already points at Route (used by Route's own launcher). The server also watches
  the pump fee program and adds any coin that points its fee sharing at Route by itself, so a
  coin launched anywhere gets its Route page within seconds; the creator adds recipients later.
- `GET /api/coins`, `GET /api/coin/:mint` — records with live state; `GET /api/stats`.
- `WS /ws` — `snapshot` on connect, then `coin` and `sol` updates.
- `POST /api/admin/collect/:mint` with header `x-route-admin` — collect now.
- `POST /api/admin/setup` with header `x-route-admin` — create Route's GitHub fee account.
- `GET /api/admin/status`, `POST /api/admin/buyback` `{ enabled?, armed?, backup?, mainCoin? }`,
  `POST /api/admin/buyback/run`, `POST /api/admin/sweep` — admin controls.
- Media: `/i/<mint>.<ext>`, `/m/<mint>.json` (CORS `*`).

The watcher subscribes (WebSocket `accountSubscribe`) to each coin's bonding curve
and fee vault, and after graduation to the PumpSwap pool reserves and AMM vault.
Bonding progress is derived from the curve's own reserves (works for mayhem-mode
curves too). SOL/USD comes from Kraken's public ticker every 60 s. The collector
runs when `ROUTE_TREASURY_SECRET` is set: every `ROUTE_COLLECT_SWEEP_MS` (default
10 s, and once at boot) it re-reads every coin's vault in one batched call and, for each
coin holding at least `ROUTE_COLLECT_MIN_LAMPORTS` (default 0.01 SOL), cranks the
distribution immediately, three coins at a time, recording each claim on the coin
(`fees.claims`). Each distribution costs the treasury one network fee, so the treasury
must hold some SOL.

Records live in `DATA_DIR/launches/<mint>.json` (atomic writes). They hold no keys
and no signed packets; a launch's signed route is kept in memory only until the
create confirms.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ROUTE_TREASURY` | Public fee treasury: receives the direct protocol share and authorized GitHub withdrawals. |
| `ROUTE_FEE_MODE` | `wallet` sends fees directly to the configured treasury and ignores saved GitHub settings. `github` enables the optional social account. Defaults to GitHub only when `ROUTE_GITHUB` is set. |
| `ROUTE_GITHUB` | GitHub username whose social fee PDA receives every coin's fees (pump.fun shows its picture). The server creates the PDA at boot when the treasury key is set, or on `POST /api/admin/setup`. |
| `ROUTE_GITHUB_CLAIM_MODE` | `manual` (default): owner claims in Pump; Route reconciles confirmed receipts automatically. `automatic` remains unavailable until Pump co-signing is integrated. |
| `ROUTE_TREASURY_SECRET` | The treasury keypair (JSON array or base58): the wallet pump.fun claims to, the 5% shareholder and the collector's payer. Must match `ROUTE_TREASURY` if both are set. |
| `ROUTE_BUYBACK_SECRET` | Developer wallet key; must match the main token's original creation wallet. May equal the treasury key in direct-wallet mode. Only confirmed fee allocations fund buys. Unset: buybacks unavailable. |
| `ROUTE_ADMIN_TOKEN` | Header value for `/api/admin/*`. |
| `ROUTE_COLLECT_MIN_LAMPORTS` | Collection threshold per coin (default 10000000 = 0.01 SOL). |
| `ROUTE_COLLECT_SWEEP_MS` | Sweep interval for collection and buybacks (default 10000). |
| `ROUTE_MAIN_COIN` | Main coin mint (the admin page can set it too). |
| `ROUTE_BUYBACK_SHARE_BPS` | Treasury share of every other coin's fees for buybacks (default 500). |
| `ROUTE_BUYBACK_MIN_LAMPORTS` | Minimum available before a buy (default 100000000 = 0.1 SOL). |
| `ROUTE_BUYBACK_SLIPPAGE_PERCENT` | Buy slippage (default 10). |
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
