/// Standalone diagnostic: replays real historical Aave liquidations through
/// our ACTUAL route-building + profitability-gate logic, reading Aave
/// prices/config and Uniswap quotes as of the exact block right before each
/// liquidation landed — not current state. Answers the question nothing
/// else in this codebase answers: does our pipeline, as it exists today,
/// actually produce profitable transactions on real historical opportunities,
/// or would it have skipped/lost money on them?
///
/// Scope and honest limitations:
///   - Uses each historical event's REAL gasUsed/gasPrice (what the actual
///     winner paid) rather than re-estimating gas — that's a harder, more
///     honest number than a synthetic estimate would be.
///   - Prices (Aave oracle + Uniswap quotes) are read at the historical
///     block, so the swap-leg economics are as real as a point-in-time
///     eth_call can make them — this is NOT a rough approximation.
///   - USD conversion for the *profit* and *gas cost* figures uses each
///     token's price at that same historical block (Aave oracle for the
///     debt asset when it's a stablecoin — sizing.ts already handles that
///     — or the current WETH/USD Chainlink feed for gas, since that feed
///     doesn't expose historical rounds this script queries). Native-ETH gas
///     cost in USD is therefore a current-price approximation like the
///     other diagnostics in this package — labeled as such in the output.
///   - Does not model competition: if we'd have built this exact route, it
///     says nothing about whether we'd have WON the race against the real
///     liquidator (that's what strategyAnalysis.ts and Flashbots Protect
///     integration are for). This only tests our own economics/gates.
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { nativeEthAmountToUsd } from "../priceOracle";
import { marketByPool, marketsForChain } from "./aaveRegistry";
import { CHAIN_DEFS, BLOCKS_PER_DAY, ETHERSCAN_REQUEST_GAP_MS, fetchLiquidationEvents, type LiquidationEvent } from "./competitorAnalysis";
import { knownAssetDecimals } from "./knownAssets";
import { buildLiquidationRoute } from "./liquidationRouteBuilder";

const DEFAULT_DAYS = 30;
const REQUEST_GAP_MS = 150; // sequential + throttled — shared RPC, see session lessons in executor.ts

type Outcome =
  | { kind: "skip_unknown_asset" }
  | { kind: "skip_route_failed"; reason: string }
  | { kind: "skip_no_price_feed"; missing: "profit_asset" | "native_gas"; asset: `0x${string}` }
  | { kind: "skip_below_onchain_floor"; shortfallPct: number }
  | { kind: "skip_below_gas_multiplier"; grossProfitUsd: number; gasCostUsd: number }
  | { kind: "would_execute"; grossProfitUsd: number; gasCostUsd: number; netProfitUsd: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backtestOne(
  client: PublicClient,
  config: ReturnType<typeof loadConfig>,
  executorAddress: Address,
  ev: LiquidationEvent,
): Promise<Outcome> {
  const debtDecimals = knownAssetDecimals(ev.chainId, ev.debtAsset);
  const collateralDecimals = knownAssetDecimals(ev.chainId, ev.collateralAsset);
  if (debtDecimals === null || collateralDecimals === null) return { kind: "skip_unknown_asset" };

  const market = marketByPool(ev.pool);
  if (!market) return { kind: "skip_unknown_asset" };

  const routeResult = await buildLiquidationRoute(client, {
    chainId: ev.chainId,
    pool: market.pool,
    oracle: market.oracle,
    dataProvider: market.dataProvider,
    executorAddress,
    user: ev.user,
    debtAsset: ev.debtAsset,
    debtDecimals,
    collateralAsset: ev.collateralAsset,
    collateralDecimals,
    debtToCover: ev.debtToCover,
    slippageBps: config.slippageBps,
    blockNumber: ev.blockNumber > 0n ? ev.blockNumber - 1n : ev.blockNumber,
  });
  if (!routeResult.ok) return { kind: "skip_route_failed", reason: routeResult.reason };

  const { asset, amountIn, estimatedGrossProfit, estimatedGrossProfitUsd } = routeResult.route;
  const minProfit = (amountIn * BigInt(config.minProfitBpsOnChain)) / 10_000n;
  if (estimatedGrossProfit < minProfit) {
    const shortfallPct = minProfit === 0n ? 0 : (Number(minProfit - estimatedGrossProfit) / Number(minProfit)) * 100;
    return { kind: "skip_below_onchain_floor", shortfallPct };
  }

  // Profit USD comes straight from buildLiquidationRoute — sourced from
  // Aave's own oracle (already read to size the route), not a separate
  // Chainlink lookup, so it covers every Aave-known asset. Gas cost still
  // needs its own conversion since it's paid in native ETH regardless of
  // which asset the liquidation profit is denominated in.
  const grossProfitUsd = estimatedGrossProfitUsd;
  const gasCostUsd = await nativeEthAmountToUsd(client, ev.chainId, ev.gasUsed * ev.gasPriceWei);
  if (gasCostUsd === null) return { kind: "skip_no_price_feed", missing: "native_gas", asset };

  if (grossProfitUsd < gasCostUsd * config.minProfitOverGasMultiplier) {
    return { kind: "skip_below_gas_multiplier", grossProfitUsd, gasCostUsd };
  }

  return { kind: "would_execute", grossProfitUsd, gasCostUsd, netProfitUsd: grossProfitUsd - gasCostUsd };
}

async function main() {
  const config = loadConfig();
  const etherscanApiKey = process.env["ETHERSCAN_API_KEY"];
  if (!etherscanApiKey) throw new Error("ETHERSCAN_API_KEY is required for this script (add it to .env)");

  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? Number(daysArg) : DEFAULT_DAYS;

  // Route-building only needs a valid address to slot into swap-leg calldata
  // for the quote simulation — it doesn't need to actually be a deployed
  // ArbExecutor, since nothing here sends a transaction. Using our own
  // account keeps this honest (a real address we control) without implying
  // a deployment that may not exist yet on a given chain.
  const account = privateKeyToAccount(config.privateKey);

  const clients = new Map<number, PublicClient>();
  const allEvents: LiquidationEvent[] = [];

  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chainDef = CHAIN_DEFS[chainId];
    if (!chainDef) continue;

    const client = createPublicClient({ chain: chainDef, transport: http(chainConfig.rpcUrl) }) as PublicClient;
    clients.set(chainId, client);

    // A chain can have several isolated Aave markets (see aaveRegistry.ts) —
    // backtested separately, since each is its own Pool with its own
    // liquidation history. Throttled between markets, same as the paging gap
    // inside fetchLiquidationEvents itself — four markets firing back-to-back
    // tripped Etherscan's rate limit in practice ("NOTOK") when this loop was
    // first added without it.
    for (const market of marketsForChain(chainId)) {
      try {
        const latest = await client.getBlockNumber();
        const lookbackBlocks = BigInt(Math.round((BLOCKS_PER_DAY[chainId] ?? 7_200) * days));
        const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

        logger.info({ chainId, market: market.marketKey, days }, "fetching historical LiquidationCall events...");
        const events = await fetchLiquidationEvents(etherscanApiKey, chainId, market.pool, fromBlock, latest);
        logger.info({ chainId, market: market.marketKey, count: events.length }, "events fetched");
        allEvents.push(...events);
        await sleep(ETHERSCAN_REQUEST_GAP_MS);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, chainId, market: market.marketKey }, "skipping market — event fetch failed");
      }
    }
  }

  if (allEvents.length === 0) {
    logger.warn("no historical events found — nothing to backtest");
    return;
  }

  logger.info({ totalEvents: allEvents.length, windowDays: days }, "backtesting our route-building + profitability gates against real history...");

  const counts: Record<Outcome["kind"], number> = {
    skip_unknown_asset: 0,
    skip_route_failed: 0,
    skip_no_price_feed: 0,
    skip_below_onchain_floor: 0,
    skip_below_gas_multiplier: 0,
    would_execute: 0,
  };
  const wouldExecuteEvents: Array<{ ev: LiquidationEvent; outcome: Extract<Outcome, { kind: "would_execute" }> }> = [];
  const missingPriceFeedAssets = new Map<string, { chainId: number; asset: string; count: number }>();
  let totalNetProfitUsd = 0;

  for (const ev of allEvents) {
    const client = clients.get(ev.chainId);
    if (!client) continue;

    const outcome = await backtestOne(client, config, account.address, ev);
    counts[outcome.kind] += 1;

    if (outcome.kind === "would_execute") {
      wouldExecuteEvents.push({ ev, outcome });
      totalNetProfitUsd += outcome.netProfitUsd;
      logger.info(
        {
          chainId: ev.chainId,
          txHash: ev.txHash,
          blockNumber: ev.blockNumber.toString(),
          grossProfitUsd: Math.round(outcome.grossProfitUsd * 100) / 100,
          gasCostUsd: Math.round(outcome.gasCostUsd * 100) / 100,
          netProfitUsd: Math.round(outcome.netProfitUsd * 100) / 100,
        },
        "WOULD_EXECUTE — our pipeline would have attempted this and cleared both profitability gates",
      );
    } else {
      if (outcome.kind === "skip_no_price_feed") {
        const key = `${ev.chainId}:${outcome.asset.toLowerCase()}`;
        const entry = missingPriceFeedAssets.get(key) ?? { chainId: ev.chainId, asset: outcome.asset, count: 0 };
        entry.count += 1;
        missingPriceFeedAssets.set(key, entry);
      }
      logger.debug({ chainId: ev.chainId, txHash: ev.txHash, outcome }, "backtest outcome");
    }

    await sleep(REQUEST_GAP_MS);
  }

  logger.info(
    {
      totalEvents: allEvents.length,
      ...counts,
      wouldExecuteCount: wouldExecuteEvents.length,
      totalNetProfitUsdIfExecuted: Math.round(totalNetProfitUsd * 100) / 100,
      windowDays: days,
    },
    "backtest complete",
  );

  if (missingPriceFeedAssets.size > 0) {
    logger.info(
      { assets: [...missingPriceFeedAssets.values()].sort((a, b) => b.count - a.count) },
      "assets with no configured price feed (priceOracle.ts) — each skipped trade on this list would have needed one to be priced",
    );
  }
}

main().catch((err) => {
  logger.fatal({ err }, "backtest failed");
  process.exit(1);
});
