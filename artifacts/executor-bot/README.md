# executor-bot

Reads live opportunities from the scanner API, builds real swap calldata for
the ones it can safely execute, simulates them, and — only when
`ENABLE_LIVE_EXECUTION=true` — sends the transaction to
[`ArbExecutor`](../arb-executor).

**Status: operational with strict adapters.** It supports closed two-to-six
swap routes through verified Uniswap V2/V3, Sushi V2/V3, Camelot V2,
PancakeSwap V2/V3, Velodrome/Aerodrome V2 and Slipstream, LFJ Liquidity Book,
generic Curve pools, Balancer V2 Vault, SyncSwap V1, Lynex/Algebra V1.9, and
Agni V3 adapters available on each verified chain.
Everything else is
logged and skipped. See
[Current coverage](#current-coverage) for why, and
[Expanding coverage](#expanding-coverage) for how to add more safely.

## How it decides

Each poll cycle (`POLL_INTERVAL_MS`) or block-triggered evaluation
(`MIN_TICK_GAP_MS`):

1. Fetch opportunities per configured chain from `GET /api/scanner/opportunities`.
2. Pre-filter: `executable === true` and `profit.netProfitUsd >= MIN_PROFIT_USD`
   (an off-chain estimate — cheap to check, avoids wasting RPC calls on
   clearly-bad candidates).
3. Skip if the flash-borrowed asset cannot be safely sized in USD using the
   stable-token registry or the configured price oracle.
4. Skip if any route leg lacks a verified adapter in `dexRegistry.ts`.
5. Optimize the executable borrow amount continuously, build the route
   (`routeBuilder.ts`), quote every hop on-chain, and feed each next leg the
   prior leg's exact same-state output. Slippage is a final settlement/revert
   boundary, not a fictitious fee charged at every hop.
6. `simulateContract` the whole `initiateArbitrage` call — this is a real
   `eth_call`, it catches reverts (stale price, insufficient allow-listed
   targets, profit floor not met) without spending gas or touching funds.
7. If simulation succeeds and `ENABLE_LIVE_EXECUTION=true`: send it, wait for
   the receipt, log the result. Otherwise: log "would execute" and move on.

### Private order flow and Flashblocks

- **Ethereum MEV-Share**: `ENABLE_MEV_SHARE_HINTS=true` listens to the
  official hint stream. A hint is eligible only when a disclosed log/target
  address matches one of the opportunity's pools. The bot signs the
  arbitrage locally, jointly simulates `{ target hash -> backrun tx }` with
  `mev_simBundle`, and only then submits the same body with `mev_sendBundle`.
  A failed joint simulation never falls through to a public transaction.
- **BNB BackRunMe**: `ENABLE_BLOXROUTE_BACKRUNME=true` consumes bloXroute's
  BSC `arbOnlyMEV` feed and uses `simulate_arb_only_bundle` before
  `submit_arb_only_bundle`. This feed requires an approved Enterprise-Elite
  BackRunMe account and `BLOXROUTE_AUTH_HEADER`; without both, logs explicitly
  report standby and no private-order-flow claim is made.
- **Base Flashblocks**: Base exact quotes use the pre-confirmed `pending`
  state. The executor subscribes to the Flashblocks WSS feed, simulates on
  `pending`, and sends signed transactions through the preconf HTTP endpoint.
  `FLASHBLOCKS_MIN_TICK_GAP_MS` controls the sub-second wake-up floor. The
  public Base endpoints are rate-limited, so production should set dedicated
  provider URLs.

The on-chain `minProfit` floor is set in basis points of the borrowed amount
(`MIN_PROFIT_BPS_ON_CHAIN`), not an absolute USD figure — see the comment in
`config.ts` for why (converting a USD target into an arbitrary asset's units
needs a price oracle; basis-points-of-principal doesn't).

## Current coverage

Verified route-building coverage:

- **DEX**: Uniswap V2/V3, Sushi V2/V3, Camelot V2, PancakeSwap V2/V3,
  Velodrome/Aerodrome V2 and Slipstream, LFJ Liquidity Book, Curve pool-direct
  swaps, Balancer V2 Vault swaps, SyncSwap V1, Lynex/Algebra V1.9 on Linea,
  and Agni V3 on Mantle. Solidly-style pools
  use invariant-aware quotes; Slipstream selects the pool's exact factory and
  tick spacing; LFJ selects the pair's Liquidity Book version and dynamic fee;
  Curve discovers coin indices/ABI variants; Balancer uses the pool ID and
  `queryBatchSwap` before encoding the Vault swap.
- **Borrow assets**: registered canonical stablecoins on all 14 scanner
  networks. Wrapped native assets use the USD oracle configured by Aave on
  each network for gas checks.
- **Chains**: Ethereum and Arbitrum deployments, plus Optimism, Polygon, Base,
  Avalanche, BNB Chain, Celo, Linea, Mantle, Scroll, Sonic, zkSync Era, and
  Soneium in watch-only mode until their own `ArbExecutor` addresses are
  configured.

Deliberately unsupported (skipped, logged, never guessed at):

- **Uniswap V4** pools (`labels: ["v4"]`) — different swap mechanics
  (singleton `PoolManager` + `unlock` callback pattern), not compatible with
  this contract's router-call leg design without separate work.
- **PancakeSwap Infinity**, unregistered Algebra deployments, and SyncSwap
  V2/V3 pools — each needs its own verified planner/ABI and is never treated
  as if it were Uniswap V3 or SyncSwap V1.
- Every other `dexId` the scanner reports and every unsupported chain/adapter
  combination — their router mechanics have not been verified here.
- Cross-quote routes without an explicit registered closing path and any route
  whose last token differs from the flash-borrowed first token.
- Non-stablecoin quote tokens (e.g. TOKEN/WETH pools) — `MAX_BORROW_USD`
  sizing needs a USD price for the quote token itself, which isn't available
  without adding a price oracle.

Some scanner candidates will still be skipped — that is the bot declining an
unsupported or no-longer-profitable route. Watch the debug logs
(`LOG_LEVEL=debug`) to see exactly why each
opportunity was skipped.

**A word on very large spreads**: opportunities showing double-digit percent
spreads (e.g. 15-18%) are almost never real, executable arbitrage — they're
usually a near-empty pool with a stale/broken price. Check the pool's actual
on-chain liquidity and 24h volume (e.g. via DexScreener) before trusting a
number like that; a $25K-liquidity, near-zero-volume pool showing an 18%
"opportunity" against a blue-chip asset is a red flag, not a signal.

## Expanding coverage

To add a DEX: verify its router address against a primary source (the
project's own GitHub deploy list, not a block explorer label or memory —
see how `dexRegistry.ts`'s Uniswap V3 entry cites
`Uniswap/v3-periphery/deploys.md`), add it to `dexRegistry.ts`, and — if it's
not a Uniswap-V3-style `exactInputSingle` router — add its own hop-building
function alongside `buildHop` in `routeBuilder.ts`.

To add a quote token: verify the address (ideally against a source already
used elsewhere in this repo, like `scanner.ts`'s `TOKEN_DEFINITIONS`), add it
to `stableQuotes.ts`. Only add tokens that are genuinely ~$1 stable — this
list exists specifically so `MAX_BORROW_USD` sizing stays correct without a
price oracle.

Whatever you add, **also** call `setAllowedTarget` on every deployed
`ArbExecutor` for any new router/token address — the bot can build a route,
but the contract will reject it at execution time if the target isn't
allow-listed. See `artifacts/arb-executor/README.md`.

## Configuration

Copy `.env.example` to `.env` and fill it in in your editor — never paste
`PRIVATE_KEY` anywhere else. See `.env.example` for what each variable does;
defaults are safety-first (`ENABLE_LIVE_EXECUTION=false`, small
`MAX_BORROW_USD`, a `MAX_TRADES_PER_HOUR` cap).

### Profit settlement and BNB gas reserve

After every confirmed arbitrage, the bot requires the executor's borrowed
asset balance to have started at zero and withdraws the entire newly realized
profit to the operator wallet. This is mandatory: the deployed v1 contract
measures its whole balance, so leaving old profit inside could otherwise make
a later losing route appear profitable.

With `AUTO_GAS_RESERVE=true`, BNB Chain also maintains two thresholds:

- Below `BSC_GAS_RESERVE_TRIGGER_BNB`, it refills gas from only the profit of
  the trade that just confirmed.
- It converts no more than needed to approach
  `BSC_GAS_RESERVE_TARGET_BNB`; the remainder stays as profit in the operator
  wallet.
- WBNB is unwrapped 1:1. Other assets use a quoted PancakeSwap V2
  token/WBNB route with `GAS_RESERVE_SLIPPAGE_BPS`; if no direct route exists,
  conversion fails closed and the token is retained.
- Pre-existing wallet token balances are never eligible refill capital.

The pre-trade net-profit gate includes conservative gas for the mandatory
withdrawal and possible approve/swap refill. It also requires the wallet to
cover the chain minimum plus all estimated transaction costs before sending.
This substantially reduces the chance of exhausting gas, but no strategy can
guarantee an uninterrupted reserve when there are no profitable trades or gas
prices move beyond the configured budget.

## Before turning on ENABLE_LIVE_EXECUTION

1. Run in dry-run mode (the default) for a while first. Watch what it *would*
   send — `LOG_LEVEL=debug` shows every skip reason, `LOG_LEVEL=info` shows
   only simulation successes/failures.
2. Confirm the target `ArbExecutor`'s `allowedTargets` actually includes
   every router/token this bot's routes will touch (see
   `artifacts/arb-executor/README.md` for how to check/set this) — a missing
   entry just means a wasted simulation, but it's worth confirming ahead of
   time.
3. Start with a small `MAX_BORROW_USD` and a conservative
   `MIN_PROFIT_BPS_ON_CHAIN`, and watch the first several live transactions
   individually rather than leaving it fully unattended immediately.
4. Remember: `MIN_PROFIT_USD` (or the optional BNB-specific
   `MIN_PROFIT_USD_BSC`) is only an off-chain pre-filter using the
   scanner's estimate. The real backstop against loss is the on-chain
   `minProfit` check — if a route wouldn't actually be profitable by the
   time it lands, the whole transaction reverts and you lose only gas, never
   principal. That backstop only works because it's enforced in the
   contract, not in this bot — don't bypass it.
5. On Ethereum, configure `FLASHBOTS_PROTECT_RPC_URL` for ordinary private
   sends. `ENABLE_MEV_SHARE_HINTS=true` separately enables target-aware
   matched bundles; those are always jointly simulated before submission.
6. On BNB, do not enable BackRunMe until bloXroute has approved the account
   and issued the authorization header. On Base, replace the public
   Flashblocks endpoints with production-capacity provider URLs before
   sustained sub-second scanning.

## Run

```bash
pnpm --filter @workspace/executor-bot run dev
```

Or, once built:

```bash
pnpm --filter @workspace/executor-bot run build
pnpm --filter @workspace/executor-bot run start
```
