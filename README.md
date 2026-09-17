# Route

Launch a pump.fun token from a connected Solana wallet and route its creator fees to
up to five X recipients. React + Vite frontend, Express server. The repository keeps
its original basket-site name.

**What is live:** wallet connect (Wallet Standard: Phantom, Solflare, Backpack…),
recipient verification on X with pictures, self-hosted token metadata, one-transaction
pump.fun launches signed in the user's wallet, and a public list of launched coins.
**Not yet:** dev buys (need the lookup table below), fee collection, conversion to
dollars and X Money payouts.

## Run locally

Install Node.js 24 (Node 22 cannot load the pump.fun SDK's ESM build: its anchor
re-export of `BN` is not detected there), then:

```sh
npm ci
ROUTE_TREASURY=<treasury public key> npm run server   # API + hosted media on :5275
npm run dev                                           # Vite on :5274, proxies /api, /m, /i
```

Open [localhost:5274](http://127.0.0.1:5274). Without `ROUTE_TREASURY` the site runs
but every launch is refused with "Launches are not configured yet".

## How a launch works

1. The browser resolves each X handle through `GET /api/x/:handle` (fxtwitter, no
   credentials) and shows the account's name and picture.
2. `POST /api/launch/prepare` validates the draft, verifies every recipient again and
   keeps their numeric X IDs, stores the image and metadata JSON under `DATA_DIR/media`
   (served at `/i/<mint>.<ext>` and `/m/<mint>.json`), builds the pump.fun `create_v2`
   transaction with the **treasury as the coin creator** and the connected wallet as
   payer, signs it with the fresh mint keypair, simulates it against the live program
   and returns it. The mint secret is discarded; no keys are stored.
3. The wallet signs (`solana:signTransaction`). `POST /api/launch/send` accepts only the
   exact prepared message with valid wallet and mint signatures, broadcasts it, and
   records the outcome; the page polls `GET /api/launch/:mint` until `confirmed`,
   `failed` (`expired` when the blockhash ran out) or `unknown`.
4. Creator fees for every Route coin accrue to the treasury's pump.fun creator vault.
   Collection, conversion and payouts are the next backend step.

Records live in `DATA_DIR/launches/<mint>.json` (one JSON file per launch, atomic
writes). `GET /api/launches` lists confirmed launches; `GET /api/stats` counts them.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ROUTE_TREASURY` | Public key that becomes the pump.fun creator of every coin. Required for launches. |
| `ROUTE_LOOKUP_TABLE` | Address lookup table with pump.fun's static accounts; enables dev buys. Create it once with `npm run table:create` (pays from `ROUTE_TREASURY_KEYPAIR`, default `~/.route-keys/treasury.json`, needs ~0.005 SOL). |
| `SOLANA_RPC_URL` | RPC endpoint (default public mainnet-beta). |
| `DATA_DIR` | Records and hosted media (default `./data`; Railway volume `/data`). |
| `PUBLIC_ORIGIN` | Origin used in metadata URLs (defaults to the Railway public domain). |
| `PORT` | Listen port (default 5275). |

A create-only launch is a 942-byte legacy-sized v0 transaction. Create + dev buy is
1285 bytes without a lookup table, so dev buys stay refused ("Dev buys are not enabled
yet") until `ROUTE_LOOKUP_TABLE` is set.

## Checks

```sh
npm test              # validation, store, X lookup, transaction building, HTTP API
npm run test:chain    # builds a real launch and simulates it on mainnet (no signing)
npm run build
npm run test:browser  # BASKET_URL=http://127.0.0.1:5275 against a running server
npm run test:launch-ui  # mock Wallet Standard wallet signs a real message end to end
npm run test:motion
```

Browser checks use an installed Chrome (`CHROME_PATH` to override). Screenshots and
reports go to the ignored `artifacts/` directory. `test:chain` and `test:launch-ui`
need network access to Solana mainnet; nothing is broadcast.

## Deployment

Railway builds with Railpack (`npm run build`, then `node server/index.js` from
`railway.json`) and health-checks `/api/health`. The service needs `ROUTE_TREASURY`,
`DATA_DIR=/data` with a volume mounted at `/data`, and optionally `ROUTE_LOOKUP_TABLE`
and `SOLANA_RPC_URL`. Every push to `main` redeploys.

## Design and assets

The visual direction references [UsePaid](https://usepaid.app/), with guidance from
[Emil Kowalski's design engineering skill](https://github.com/emilkowalski/skills)
and [Taste Skill](https://github.com/leonxlnx/taste-skill).
Typography uses self-hosted IBM Plex Sans; icons use Phosphor.
