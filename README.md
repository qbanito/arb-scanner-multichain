# Arbitrage Scanner

Live market-intelligence and guarded execution software for discovering,
ranking, simulating, and executing same-chain arbitrage cycles across
14 EVM networks: Ethereum, Arbitrum, Optimism, Polygon, Base, Avalanche,
BNB Chain, Celo, Linea, Mantle, Scroll, Sonic, zkSync Era, and Soneium.

> **Find the gap before it closes.**

The repository contains the React/Vite scanner cockpit, a shared Express API server, and the contract-generated TypeScript clients used by the frontend and backend.

## What it does

- Scans 14 EVM networks using live RPC, pool-state, and market-data sources.
- Discovers closed two-pool, cross-stable, triangular, and three-to-six-swap
  multi-protocol cycles using a bounded log-space graph search.
- Combines verified Uniswap, Sushi, Camelot, PancakeSwap, Velodrome,
  Aerodrome/Slipstream, LFJ Liquidity Book, Curve, Balancer V2, SyncSwap V1,
  Lynex/Algebra, and Agni V3 adapters where their chain-specific contracts are
  registered.
- Converts mismatched stable quote assets through an explicit best closing
  path, so an open buy/sell price difference never enters the actionable feed
  as if it were a closed flash-loan cycle.
- Expands the token graph from liquid assets discovered at runtime, preserves
  every edge in multi-asset pools, and fairly rotates exact-quote capacity so
  routes below the first top-N page are not permanently starved.
- Optimizes borrow size continuously with exact on-chain calls and ranks
  candidates by conservative expected value and executable net profit after
  flash-loan premium, route slippage, and gas.
- Shows buy and sell venues, spread, liquidity, fees, slippage, gas, flash-loan costs, and confidence.
- Provides live network telemetry including block height, gas price, block time, and scanned pool count.
- Displays tracked token coverage, liquidity, prices, pool counts, supported chains, and 24-hour change.
- Supports chain and spread filters, refresh, route detail inspection, venue links, and mobile navigation.
- Exposes explicit loading, empty, retry, and upstream-unavailable states instead of silently fabricating market data.

## Repository layout

```text
.
├── artifacts/
│   ├── api-server/              Express API service
│   │   └── src/routes/scanner.ts
│   ├── arb-scanner/             React/Vite web application
│   │   └── src/App.tsx
│   ├── arb-executor/            Aave V3 flash-loan execution contract
│   ├── executor-bot/            Route builder, simulation and guarded sender
│   └── mockup-sandbox/          Component preview artifact
├── lib/
│   ├── api-spec/openapi.yaml    Source-of-truth API contract
│   ├── api-client-react/        Generated React Query client and schemas
│   ├── api-zod/                 Generated server validation schemas
│   └── db/                      Shared database package scaffold
├── scripts/                     Workspace utility scripts
├── package.json                 Root workspace scripts
├── pnpm-workspace.yaml          Workspace and dependency policy
└── pnpm-lock.yaml               Locked dependency graph
```

## Requirements

- Node.js 24
- pnpm
- Network access to the configured chain RPC endpoints
- Network access to DexScreener market-data endpoints

The API server requires a runtime-provided `PORT`. The web artifact requires `PORT` and `BASE_PATH`; the managed Replit workflows provide these automatically.

## Install

```bash
pnpm install
```

## Run locally

Start the shared API server:

```bash
pnpm --filter @workspace/api-server run dev
```

Start the scanner frontend in a second terminal:

```bash
PORT=26056 BASE_PATH=/ pnpm --filter @workspace/arb-scanner run dev
```

The frontend calls the shared API at `/api`. When running outside the managed artifact workflow, make sure the API server is reachable through the same local development setup.

## Verification commands

Run the workspace checks:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

Local frontend builds default to port `5173` and base path `/`; hosted
workflows can override them with `PORT` and `BASE_PATH`.

Check each package directly:

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/arb-scanner run typecheck
PORT=26056 BASE_PATH=/ pnpm --filter @workspace/arb-scanner run build
```

## API contract and code generation

The API contract is maintained in `lib/api-spec/openapi.yaml`. After changing an endpoint or schema, regenerate the React Query client and Zod schemas:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Generated files are committed because the frontend and API server consume them directly:

- `lib/api-client-react/src/generated/api.ts`
- `lib/api-client-react/src/generated/api.schemas.ts`
- `lib/api-zod/src/generated/api.ts`
- `lib/api-zod/src/generated/types/*`

## API endpoints

All endpoints are mounted below `/api`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/healthz` | API health check |
| `GET /api/scanner/summary` | Active opportunity, pool, token, profit, and latency summary |
| `GET /api/scanner/networks` | Supported-network telemetry and pool coverage |
| `GET /api/scanner/tokens` | Live tracked token universe |
| `GET /api/scanner/opportunities` | Ranked opportunities with optional filters |
| `GET /api/scanner/opportunities/:id` | Live detail for one opportunity |

Opportunity query parameters:

- `chain`: `all` or one of the 14 chain slugs shown in the dashboard filter
- `token`: token symbol filter
- `minProfitBps`: minimum spread in basis points
- `limit`: number of results, from 1 to 300

## Live data behavior

The scanner caches the pool catalog for five minutes, persists the last real
catalog per chain across API restarts, refreshes only pools
whose contracts emitted logs since the prior block (with a safe full-refresh
fallback), and keeps a short-lived opportunity snapshot. Expired real
snapshots are returned immediately while the next scan refreshes in the
background. Upstream failures retain only the last real snapshot; the API
does not invent opportunities. An RPC circuit breaker temporarily selects the
configured fallback after a primary provider failure or rate limit.

Pool discovery uses a process-wide request gate. If DexScreener is unavailable,
the scanner opens a circuit breaker and falls back to a rate-limited
GeckoTerminal network snapshot instead of clearing the dashboard. The fallback
is intentionally a smaller emergency catalog; exact execution prices always
come from the chain, never either indexer.

Results from `chain=all` are ranked globally before applying `limit`, so a
busy first network cannot hide profitable routes detected on later networks.
Each chain also has a bounded first-response budget: a throttled network keeps
refreshing in the background instead of leaving the whole dashboard empty.
Networks without a configured `ArbExecutor` remain watch-only: their routes
can be fully quoted and ranked, but cannot be queued for execution.

### Across cross-chain mission

The API exposes a quote-only Across layer:

- `GET /api/scanner/across/status` reports whether the integration is configured.
- `GET /api/scanner/across/quote` requests an Across Swap API quote and returns the approval/calldata payload without signing or submitting it.
- `GET /api/scanner/across/profit` calculates gross spread, bridge fee, origin/destination gas, slippage and inventory carry.
- `GET /api/scanner/across/opportunities` compares the best observed token prices across configured chains, refreshes Across quotes for the top dislocations and ranks net profit.

Configure `ACROSS_ENABLED=true`, `ACROSS_API_KEY` and `ACROSS_INTEGRATOR_ID` in the API server. Production Across requests require both credentials. The returned route remains `executable: false` with `cross-chain-inventory-required`: an Across fill is fast, but it is not an atomic continuation of an origin-chain flash loan. Live execution requires destination inventory, fill reconciliation and a separately audited settlement policy.

The deployed allow-list covers the ten-network overlap currently modeled by the scanner and Across (Ethereum, Optimism, BNB Chain, Polygon, zkSync, Soneium, Linea, Base, Arbitrum and Avalanche). The opportunity snapshot is refreshed every 15 seconds while the API process is alive. A paid Render worker is required for an always-on background process; the free web tier can suspend when idle.

Upstream data sources currently include:

- JSON-RPC endpoints for block telemetry, pool state, router quotes, Aave premium, and gas.
- DexScreener token-pair data for live liquidity, prices, venues, volume, and price change.
- GeckoTerminal top-pool snapshots as the pool-discovery fallback.

Useful scanner tuning variables (all have bounded defaults):

- `SCANNER_MAX_HOPS` (3–6), `SCANNER_MAX_GRAPH_CANDIDATES`,
  `SCANNER_MAX_EXPLORED_PATHS`, and `SCANNER_MAX_POOLS_PER_PAIR`.
- `SCANNER_MAX_EXACT_QUOTES_PER_CHAIN`, `SCANNER_QUOTE_CONCURRENCY`, and
  `SCANNER_SIZE_REFINEMENT_ITERATIONS`.
- `SCANNER_DISCOVERY_TOKENS_PER_CHAIN` and
  `SCANNER_MAX_DISCOVERED_GRAPH_TOKENS`.
- `SCANNER_SCAN_CACHE_MS`, `SCANNER_NETWORK_CACHE_MS`,
  `SCANNER_DEX_REQUEST_GAP_MS`, `SCANNER_GECKO_REQUEST_GAP_MS`, and
  `SCANNER_GECKO_RETRY_COOLDOWN_MS`, and `SCANNER_GECKO_PAGES_PER_CHAIN`.
- `SCANNER_GLOBAL_CHAIN_WAIT_MS` and `SCANNER_CACHE_DIR` for the bounded
  global first response and persistent real catalog location.

If no real snapshot exists and an upstream source is unavailable, the API
returns a service-unavailable response and the frontend renders an explicit
unavailable state.

## Frontend structure

The main dashboard lives in `artifacts/arb-scanner/src/App.tsx`, with the visual system in `artifacts/arb-scanner/src/index.css`.

The cockpit includes:

- Live system health and refresh controls.
- Summary metrics for opportunity count, estimated net profit, pools, complete
  route coverage, exact-quote coverage, and scan latency.
- Network pulse cards.
- Filterable executable opportunity table.
- Opportunity detail drawer with route economics.
- Token universe coverage cards.
- Responsive mobile navigation and layouts.

## Deployment

The web artifact is registered at the root preview path and is configured in:

```text
artifacts/arb-scanner/.replit-artifact/artifact.toml
```

The API server is registered separately in:

```text
artifacts/api-server/.replit-artifact/artifact.toml
```

For Replit, use the managed workflows so `PORT`, `BASE_PATH`, and artifact routing are injected correctly.

## Security notes

- Do not commit API keys, GitHub tokens, RPC credentials, or `.env` files.
- Use the workspace secret manager for sensitive values.
- Keep the GitHub repository private unless the project owner explicitly wants a public repository.
