import type { PublicClient } from "viem";
import { chainlinkAggregatorAbi } from "../abis";
import { aavePoolReadAbi } from "./aaveAbis";
import { marketByPool } from "./aaveRegistry";
import type { ChainClients } from "../chains";
import type { Config } from "../config";
import { TradeLimiter } from "../limiter";
import { logger } from "../logger";
import { knownAssetDecimals } from "./knownAssets";
import { attemptLiquidation } from "./liquidationExecutor";
import { buildLiquidationRoute, type LiquidationRoute } from "./liquidationRouteBuilder";
import { priceFeedFor } from "../priceOracle";
import { fetchWatchlist, type WatchlistEntry } from "./watchlistClient";

const HF_ONE = 10n ** 18n;
// A single multicall batch either way — widening this trades a few more ms
// of RPC time per block for real-time HF coverage on more positions, not a
// meaningfully different cost. Was 10, tightly scoped to "only the very
// biggest" positions; widened so more of the pipeline's own discovery
// (subgraph pagination, more known assets, more DEX venues) actually gets
// real-time monitoring instead of only periodic (scanTick) checks.
const WATCHLIST_SIZE = 40;
const REFRESH_INTERVAL_MS = 2 * 60_000;
// Once an address triggers an attempt, don't re-trigger it again for a
// while — either it succeeded (limiter/on-chain state will reflect that)
// or it reverted because someone else got there first, and hammering the
// same address every block afterward is pure waste.
const TRIGGER_COOLDOWN_MS = 5 * 60_000;
// Widening WATCHLIST_SIZE (10 -> 40) started pulling in near-worthless dust
// positions to fill the list whenever fewer than 40 real at-risk accounts
// exist — each one still costs a full attemptLiquidation RPC burst (gas
// estimate, oracle reads, simulate) for a bonus worth less than the gas to
// claim it. This is the actual reason a wider watchlist started tripping
// Alchemy's rate limit: not more real coverage, just more wasted attempts.
const MIN_TRIGGER_BONUS_USD = 5;

// How many recent Health Factor samples to keep per watched address, used to
// estimate how fast (and whether) it is trending toward liquidation. This is
// plain linear extrapolation from real on-chain reads — not a prediction
// model, just enough to tell "falling fast, about to cross" from "drifting,
// no rush".
const HF_HISTORY_SIZE = 6;
const HF_HISTORY_MAX_AGE_MS = 5 * 60_000;
// If the linear trend projects HF=1.0 within this window, start (and keep)
// a pre-built liquidation route on hand so the actual crossing can fire
// `attemptLiquidation` without first paying for pool-fee reads and DEX
// quotes on the critical path.
const APPROACHING_WINDOW_MS = 3 * 60_000;
// Route contents (swap legs, expected amounts) depend on live DEX prices —
// treat a cached one as stale quickly rather than trust an old quote.
const ROUTE_CACHE_TTL_MS = 15_000;

type HfSample = { t: number; hf: number };
type CachedRoute = { route: LiquidationRoute; builtAt: number };

/// Tight, on-chain-only monitor for the small set of highest-value at-risk
/// positions already found by the slower subgraph-driven discovery (see
/// watchlistClient.ts). Re-checks their real Health Factor every new block
/// via a cheap multicall — bypassing subgraph indexing lag and this bot's
/// own 30s API cache entirely for the "is it liquidatable *right now*"
/// question, which is the part that actually has to be fast to compete for
/// a position like this.
/// Fits a straight line through recent (time, healthFactor) samples and
/// returns milliseconds until it projects HF=1.0, or null if there aren't
/// enough samples yet or the trend isn't declining. Plain linear
/// extrapolation from real reads — deliberately not a "prediction model".
function projectedMsToCross(history: HfSample[]): number | null {
  if (history.length < 2) return null;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const dt = last.t - first.t;
  if (dt <= 0) return null;
  const slopePerMs = (last.hf - first.hf) / dt;
  if (slopePerMs >= 0) return null; // flat or rising — not approaching
  const msToOne = (1 - last.hf) / slopePerMs;
  return msToOne > 0 ? msToOne : null;
}

export async function runHighValueWatcher(config: Config, chainClients: ChainClients): Promise<never> {
  const limiter = new TradeLimiter(config.maxTradesPerHour);
  let watchlist: WatchlistEntry[] = [];
  const lastTriggeredAt = new Map<string, number>();
  const hfHistory = new Map<string, HfSample[]>();
  const routeCache = new Map<string, CachedRoute>();

  const refresh = async () => {
    try {
      watchlist = await fetchWatchlist(config.apiBaseUrl, WATCHLIST_SIZE);
      logger.info(
        { count: watchlist.length, top: watchlist[0] ? { user: watchlist[0].userAddress, bonusUsd: watchlist[0].estimatedBonusUsd } : null },
        "high-value liquidation watchlist refreshed",
      );
      await resyncMempoolWatch();
    } catch (err) {
      logger.error({ err }, "failed to refresh liquidation watchlist");
    }
  };

  // --- Mempool early warning (Ethereum mainnet only) ---------------------
  // The per-block re-check above (checkNow) can only react once a Chainlink
  // price update has already been mined. Alchemy can also push us *pending*
  // transactions to specific addresses before they're mined — seeing one
  // land on the aggregator behind a watchlist position's collateral feed is
  // a strong signal that position's Health Factor is about to move, one
  // block before checkNow would otherwise notice. Deliberately NOT decoding
  // the pending tx's calldata to predict the exact new price: Chainlink
  // OCR2's `transmit()` report is a non-trivial packed encoding, and a wrong
  // decode here would be worse than not trying — it could either misfire on
  // a price that never lands, or (worse) silently fail to recognize a real
  // one. Instead, this only widens *when* an already-safe operation (
  // precomputeRoute, same function checkNow's trend-based trigger already
  // uses) gets a head start — it never changes what gets sent, only how
  // early the route is warmed before the real, on-chain-confirmed HF check
  // decides to fire.
  const aggregatorCache = new Map<string, `0x${string}`>(); // feed proxy (lowercase) -> OCR aggregator/transmitter (lowercase)
  let mempoolUnsubscribe: (() => void) | null = null;
  let watchedAggregators = new Set<string>();

  async function resolveAggregator(client: PublicClient, proxy: `0x${string}`): Promise<`0x${string}` | null> {
    const key = proxy.toLowerCase();
    const cached = aggregatorCache.get(key);
    if (cached) return cached;
    try {
      const aggregator = await client.readContract({ address: proxy, abi: chainlinkAggregatorAbi, functionName: "aggregator" });
      const lower = aggregator.toLowerCase() as `0x${string}`;
      aggregatorCache.set(key, lower);
      return lower;
    } catch (err) {
      logger.debug({ err, proxy }, "failed to resolve Chainlink OCR aggregator behind price feed proxy");
      return null;
    }
  }

  async function resyncMempoolWatch(): Promise<void> {
    const chain = chainClients.clients.get(1); // alchemy_pendingTransactions: Ethereum mainnet only, no Arbitrum equivalent
    if (!chain?.wsClient) return;

    const aggregatorToAssets = new Map<string, Set<string>>();
    const collateralAssets = new Set(watchlist.filter((w) => w.chainId === 1).map((w) => w.collateralAsset.toLowerCase()));
    for (const asset of collateralAssets) {
      const proxy = priceFeedFor(1, asset);
      if (!proxy) continue;
      const aggregator = await resolveAggregator(chain.publicClient, proxy);
      if (!aggregator) continue;
      const set = aggregatorToAssets.get(aggregator) ?? new Set<string>();
      set.add(asset);
      aggregatorToAssets.set(aggregator, set);
    }

    const newAggregators = new Set(aggregatorToAssets.keys());
    // Only "unchanged" (skip resubscribing) when there's a *confirmed active*
    // subscription for this exact target set — not merely "we already tried
    // this set once". Comparing against watchedAggregators alone would mean
    // a failed subscribe attempt (e.g. a 429 during the WS handshake, seen
    // in practice at cold start when several subscriptions race to connect
    // at once) permanently marks that set as "watched" even though nothing
    // is actually listening, silently disabling retries until the watchlist
    // composition happens to change to something different.
    const unchanged = mempoolUnsubscribe !== null && newAggregators.size === watchedAggregators.size && [...newAggregators].every((a) => watchedAggregators.has(a));
    if (unchanged) return;

    mempoolUnsubscribe?.();
    mempoolUnsubscribe = null;
    if (newAggregators.size === 0) {
      watchedAggregators = newAggregators;
      return;
    }

    try {
      // viem's typed `subscribe` only lists a fixed set of standard
      // subscription names (newHeads/newPendingTransactions/logs/syncing);
      // Alchemy's `alchemy_pendingTransactions` with server-side address
      // filtering isn't one of them, even though the underlying transport
      // sends whatever `params` it's given as a plain `eth_subscribe` call
      // (verified by reading viem's WebSocket transport source directly —
      // this is a TS authoring gap, not a runtime restriction).
      const params = ["alchemy_pendingTransactions", { toAddress: [...newAggregators], hashesOnly: false }] as unknown as ["newPendingTransactions"];
      const { unsubscribe } = await chain.wsClient.transport.subscribe({
        params,
        onData: (data: unknown) => {
          const result = (data as { result?: { to?: string } } | undefined)?.result;
          const to = typeof result?.to === "string" ? result.to.toLowerCase() : null;
          if (!to) return;
          const assets = aggregatorToAssets.get(to);
          if (!assets) return;

          const now = Date.now();
          for (const entry of watchlist) {
            if (entry.chainId !== 1 || !assets.has(entry.collateralAsset.toLowerCase())) continue;
            const key = `1:${entry.pool.toLowerCase()}:${entry.userAddress.toLowerCase()}`;
            const cached = routeCache.get(key);
            if (cached && now - cached.builtAt < ROUTE_CACHE_TTL_MS) continue; // already warm
            logger.info(
              { user: entry.userAddress, collateralAsset: entry.collateralAsset },
              "pending Chainlink price update seen in mempool — pre-warming liquidation route ahead of confirmation",
            );
            void precomputeRoute(config, chain, entry, key, routeCache);
          }
        },
        onError: (err: unknown) => logger.warn({ err }, "mempool oracle watch subscription error"),
      });
      mempoolUnsubscribe = () => void unsubscribe();
      watchedAggregators = newAggregators; // only recorded as "watched" once actually confirmed live
      logger.info({ aggregators: [...newAggregators] }, "watching mempool for pending Chainlink updates on watchlist collateral feeds");
    } catch (err) {
      // watchedAggregators deliberately left as-is (not updated to
      // newAggregators) so the next refresh cycle's `unchanged` check — now
      // gated on mempoolUnsubscribe !== null too — retries instead of
      // treating this failed attempt as done.
      logger.warn({ err }, "failed to subscribe to alchemy_pendingTransactions — will retry next watchlist refresh, block-driven checks still run meanwhile");
    }
  }
  // -------------------------------------------------------------------

  await refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);

  let checking = false;
  const checkNow = async (chainId: number) => {
    if (checking) return;
    const entries = watchlist.filter((w) => w.chainId === chainId);
    if (entries.length === 0) return;

    const chain = chainClients.clients.get(chainId);
    if (!chain) return;

    checking = true;
    try {
      // Each entry carries its own Pool address — a chain can have several
      // isolated Aave markets (see aaveRegistry.ts), so this is not
      // necessarily the same contract for every entry. viem's multicall
      // supports a different target per call, so this still costs one
      // multicall round trip either way.
      const results = await chain.publicClient.multicall({
        contracts: entries.map((entry) => ({
          address: entry.pool,
          abi: aavePoolReadAbi,
          functionName: "getUserAccountData",
          args: [entry.userAddress],
        })),
        allowFailure: true,
      });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const result = results[i];
        if (result?.status !== "success") continue;
        const healthFactor = result.result[5];
        const key = `${chainId}:${entry.pool.toLowerCase()}:${entry.userAddress.toLowerCase()}`;

        const now = Date.now();
        const history = hfHistory.get(key) ?? [];
        history.push({ t: now, hf: Number(healthFactor) / 1e18 });
        while (history.length > HF_HISTORY_SIZE || (history.length > 1 && now - history[0]!.t > HF_HISTORY_MAX_AGE_MS)) {
          history.shift();
        }
        hfHistory.set(key, history);

        if (entry.estimatedBonusUsd < MIN_TRIGGER_BONUS_USD) continue;

        if (healthFactor > HF_ONE) {
          const msToCross = projectedMsToCross(history);
          if (msToCross !== null && msToCross <= APPROACHING_WINDOW_MS) {
            const cached = routeCache.get(key);
            const isFresh = cached && now - cached.builtAt < ROUTE_CACHE_TTL_MS;
            if (!isFresh) {
              logger.info(
                { user: entry.userAddress, chainId, healthFactor: healthFactor.toString(), etaMs: Math.round(msToCross) },
                "watchlist position trending toward Health Factor 1.0 — pre-building liquidation route",
              );
              void precomputeRoute(config, chain, entry, key, routeCache);
            }
          }
          continue;
        }

        const market = marketByPool(entry.pool);
        if (!market) {
          logger.warn({ user: entry.userAddress, chainId, pool: entry.pool }, "skip: watchlist entry's pool isn't a known market");
          continue;
        }

        const last = lastTriggeredAt.get(key) ?? 0;
        if (now - last < TRIGGER_COOLDOWN_MS) continue;
        lastTriggeredAt.set(key, now);

        const cached = routeCache.get(key);
        const precomputedRoute = cached && now - cached.builtAt < ROUTE_CACHE_TTL_MS ? cached.route : undefined;
        routeCache.delete(key);
        hfHistory.delete(key);

        logger.info(
          {
            user: entry.userAddress,
            chainId,
            market: entry.market,
            healthFactor: healthFactor.toString(),
            estimatedBonusUsd: entry.estimatedBonusUsd,
            usedPrecomputedRoute: precomputedRoute !== undefined,
          },
          "watchlist position crossed Health Factor 1.0 — attempting liquidation",
        );

        await attemptLiquidation(
          config,
          chain,
          chainClients,
          limiter,
          {
            chainId,
            pool: market.pool,
            oracle: market.oracle,
            dataProvider: market.dataProvider,
            user: entry.userAddress,
            debtAsset: entry.debtAsset,
            collateralAsset: entry.collateralAsset,
            debtToCover: entry.debtToCover,
            healthFactor,
          },
          precomputedRoute,
        );
      }
    } catch (err) {
      logger.warn({ err, chainId }, "high-value watcher check failed");
    } finally {
      checking = false;
    }
  };

  const timerOnlyChains: number[] = [];
  for (const [chainId, entry] of chainClients.clients) {
    if (!entry.wsClient) {
      timerOnlyChains.push(chainId);
      continue;
    }
    entry.wsClient.watchBlocks({
      onBlock: () => void checkNow(chainId),
      onError: (err) => logger.warn({ err, chainId }, "high-value watcher block subscription error"),
    });
  }

  // Fallback heartbeat only for chains without a WebSocket subscription —
  // block-driven chains are already checked on every block above.
  for (;;) {
    for (const chainId of timerOnlyChains) {
      await checkNow(chainId);
    }
    await sleep(5_000);
  }
}

/// Builds a liquidation route ahead of the actual HF=1.0 crossing and caches
/// it, so the trigger path in checkNow above can skip straight to the gas
/// check / simulate / send steps. Runs off the hot path (fire-and-forget
/// from checkNow) since route building does its own RPC round trips and
/// must never block the per-block HF re-check loop.
async function precomputeRoute(
  config: Config,
  chain: NonNullable<ReturnType<ChainClients["clients"]["get"]>>,
  entry: WatchlistEntry,
  key: string,
  routeCache: Map<string, CachedRoute>,
): Promise<void> {
  if (!chain.executorAddress) return;
  const market = marketByPool(entry.pool);
  if (!market) return;
  const debtDecimals = knownAssetDecimals(entry.chainId, entry.debtAsset);
  const collateralDecimals = knownAssetDecimals(entry.chainId, entry.collateralAsset);
  if (debtDecimals === null || collateralDecimals === null) return;

  try {
    const routeResult = await buildLiquidationRoute(chain.publicClient, {
      chainId: entry.chainId,
      pool: market.pool,
      oracle: market.oracle,
      dataProvider: market.dataProvider,
      executorAddress: chain.executorAddress,
      user: entry.userAddress,
      debtAsset: entry.debtAsset,
      debtDecimals,
      collateralAsset: entry.collateralAsset,
      collateralDecimals,
      debtToCover: entry.debtToCover,
      slippageBps: config.slippageBps,
    });
    if (!routeResult.ok) return;
    routeCache.set(key, { route: routeResult.route, builtAt: Date.now() });
  } catch (err) {
    logger.debug({ err, user: entry.userAddress, chainId: entry.chainId }, "route pre-build failed, will build fresh at trigger time");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
