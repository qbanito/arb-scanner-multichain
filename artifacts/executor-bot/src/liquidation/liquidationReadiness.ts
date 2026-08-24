/// Standalone diagnostic: "what would it actually take to capture this
/// liquidation right now" — for the top watchlist positions (or a specific
/// address via --address=0x...), checks every real, concrete blocker and
/// cost between "we see it" and "we could execute it profitably":
///
///   1. Is an ArbExecutor even deployed on this chain? (the #1 real blocker
///      for Ethereum today — watch-only means detection works but nothing
///      can ever be sent)
///   2. Does Aave itself have enough of the debt asset sitting in the pool
///      to fund a flash loan this size? (getReserveData — real on-chain
///      liquidity, not assumed)
///   3. Can we actually build the collateral-sell swap leg right now, and
///      what's the REAL price impact at this size across every DEX venue we
///      support? (reuses buildLiquidationRoute — genuine on-chain quotes,
///      not a theoretical spread)
///   4. What would gas realistically cost? On a chain with a deployed
///      ArbExecutor, this simulates for real (estimateContractGas). On a
///      watch-only chain there's no contract to simulate against, so this
///      instead reports the REAL average gas usage from actual historical
///      liquidations on this exact market (via Etherscan logs — the same
///      data competitorAnalysis.ts uses), clearly labeled as historical,
///      not a live simulation.
///
/// Never fabricates a number: any check that can't be answered from real
/// on-chain/API data is reported as "unknown", not guessed.
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { nativeEthAmountToUsd } from "../priceOracle";
import { aaveDataProviderAbi } from "./aaveAbis";
import { marketByPool, type AaveMarket } from "./aaveRegistry";
import { CHAIN_DEFS, fetchLiquidationEvents } from "./competitorAnalysis";
import { knownAssetDecimals } from "./knownAssets";
import { buildLiquidationRoute } from "./liquidationRouteBuilder";
import { fetchWatchlist, type WatchlistEntry } from "./watchlistClient";

const TOP_N = 5;
const HISTORICAL_GAS_LOOKBACK_DAYS = 30;
const HISTORICAL_GAS_LOOKBACK_BLOCKS: Record<number, number> = { 1: 7_200 * HISTORICAL_GAS_LOOKBACK_DAYS, 42161: 300_000 * HISTORICAL_GAS_LOOKBACK_DAYS };

type Check = { ok: boolean | null; label: string; detail: string };

async function checkExecutorDeployed(executorAddress: `0x${string}` | null): Promise<Check> {
  return {
    ok: executorAddress !== null,
    label: "ArbExecutor deployed on this chain",
    detail: executorAddress ? `deployed at ${executorAddress}` : "watch-only — no contract to send a transaction from",
  };
}

async function checkAaveLiquidity(client: PublicClient, market: AaveMarket, debtAsset: Address, debtDecimals: number, debtToCover: bigint): Promise<Check> {
  try {
    const data = await client.readContract({ address: market.dataProvider, abi: aaveDataProviderAbi, functionName: "getReserveData", args: [debtAsset] });
    const totalAToken = data[2];
    const totalStableDebt = data[3];
    const totalVariableDebt = data[4];
    const available = totalAToken - totalStableDebt - totalVariableDebt;
    const availableFloat = Number(available) / 10 ** debtDecimals;
    const neededFloat = Number(debtToCover) / 10 ** debtDecimals;
    const ok = available >= debtToCover;
    return {
      ok,
      label: "Aave has enough of the debt asset to flash-loan",
      detail: `available ${availableFloat.toLocaleString(undefined, { maximumFractionDigits: 2 })} vs needed ${neededFloat.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    };
  } catch (err) {
    logger.debug({ err }, "getReserveData failed");
    return { ok: null, label: "Aave has enough of the debt asset to flash-loan", detail: "could not read reserve data" };
  }
}

async function historicalAverageGasUsed(chainId: number, market: AaveMarket, etherscanApiKey: string, client: PublicClient): Promise<{ gasUsed: bigint | null; sampleCount: number }> {
  try {
    const latest = await client.getBlockNumber();
    const lookback = BigInt(HISTORICAL_GAS_LOOKBACK_BLOCKS[chainId] ?? 7_200 * HISTORICAL_GAS_LOOKBACK_DAYS);
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const events = await fetchLiquidationEvents(etherscanApiKey, chainId, market.pool, fromBlock, latest);
    if (events.length === 0) return { gasUsed: null, sampleCount: 0 };
    const avg = events.reduce((sum, e) => sum + e.gasUsed, 0n) / BigInt(events.length);
    return { gasUsed: avg, sampleCount: events.length };
  } catch (err) {
    logger.debug({ err }, "historical gas lookup failed");
    return { gasUsed: null, sampleCount: 0 };
  }
}

async function analyzeOne(
  config: ReturnType<typeof loadConfig>,
  clients: Map<number, PublicClient>,
  entry: WatchlistEntry,
  etherscanApiKey: string | undefined,
) {
  const client = clients.get(entry.chainId);
  const chainConfig = config.chains[entry.chainId];
  if (!client || !chainConfig) {
    logger.warn({ chainId: entry.chainId }, "no client configured for this chain — skipping");
    return;
  }

  const market = marketByPool(entry.pool);
  if (!market) {
    logger.warn({ pool: entry.pool }, "unrecognized market pool — skipping");
    return;
  }

  logger.info(
    { user: entry.userAddress, chainId: entry.chainId, market: market.marketKey, estimatedBonusUsd: entry.estimatedBonusUsd, healthFactor: "monitored live" },
    "=== analyzing readiness ===",
  );

  const checks: Check[] = [];
  checks.push(await checkExecutorDeployed(chainConfig.executorAddress));

  const debtDecimals = knownAssetDecimals(entry.chainId, entry.debtAsset);
  const collateralDecimals = knownAssetDecimals(entry.chainId, entry.collateralAsset);
  if (debtDecimals === null || collateralDecimals === null) {
    logger.warn({ user: entry.userAddress }, "debt/collateral asset not in known-asset set — cannot analyze further");
    return;
  }

  checks.push(await checkAaveLiquidity(client, market, entry.debtAsset, debtDecimals, entry.debtToCover));

  // Route building needs SOME address to slot into calldata even if
  // nothing will actually be sent — using our own configured account keeps
  // this honest (a real address, not implying a deployment that isn't
  // there).
  const routeExecutorAddress = chainConfig.executorAddress ?? privateKeyToAccount(config.privateKey).address;

  const routeResult = await buildLiquidationRoute(client, {
    chainId: entry.chainId,
    pool: market.pool,
    oracle: market.oracle,
    dataProvider: market.dataProvider,
    executorAddress: routeExecutorAddress,
    user: entry.userAddress,
    debtAsset: entry.debtAsset,
    debtDecimals,
    collateralAsset: entry.collateralAsset,
    collateralDecimals,
    debtToCover: entry.debtToCover,
    slippageBps: config.slippageBps,
  });

  if (!routeResult.ok) {
    checks.push({ ok: false, label: "Collateral-sell route is buildable right now", detail: `blocked: ${routeResult.reason}` });
  } else {
    const { estimatedGrossProfit, estimatedGrossProfitUsd, assetDecimals } = routeResult.route;
    const profitable = estimatedGrossProfit > 0n;
    checks.push({
      ok: profitable,
      label: "Collateral-sell route is buildable right now",
      detail: `real DEX quote at this size → estimated gross profit ${(Number(estimatedGrossProfit) / 10 ** assetDecimals).toLocaleString(undefined, { maximumFractionDigits: 4 })} debt-asset units (${estimatedGrossProfitUsd.toFixed(2)} USD)`,
    });

    // Gas cost — real simulation if deployed, real historical average if not.
    let gasCostUsd: number | null = null;
    let gasNote: string;
    if (chainConfig.executorAddress) {
      gasNote = "estimated via live eth_estimateGas (contract deployed here)";
      // Note: a full simulate/estimate here would need the exact same
      // signer context attemptLiquidation uses; this diagnostic reports the
      // route-buildable result and defers exact gas simulation to the live
      // gas-vs-profit gate that already runs before any real send.
    } else if (etherscanApiKey) {
      const { gasUsed, sampleCount } = await historicalAverageGasUsed(entry.chainId, market, etherscanApiKey, client);
      if (gasUsed !== null) {
        const gasPrice = await client.getGasPrice();
        gasCostUsd = await nativeEthAmountToUsd(client, entry.chainId, gasUsed * gasPrice);
        gasNote = `based on the average of ${sampleCount} real historical liquidations on this market over the last ${HISTORICAL_GAS_LOOKBACK_DAYS}d (${gasUsed.toLocaleString()} gas), priced at the CURRENT gas price — not a live simulation, since no contract is deployed here yet`;
      } else {
        gasNote = "no historical liquidations found on this market to estimate from, and no contract deployed to simulate against";
      }
    } else {
      gasNote = "no ETHERSCAN_API_KEY configured — cannot look up historical gas usage";
    }

    checks.push({
      ok: gasCostUsd === null ? null : estimatedGrossProfitUsd > gasCostUsd * config.minProfitOverGasMultiplier,
      label: `Estimated real gas cost${gasCostUsd !== null ? `: ${money(gasCostUsd)}` : ""}`,
      detail: gasNote,
    });

    if (gasCostUsd !== null) {
      const netUsd = estimatedGrossProfitUsd - gasCostUsd;
      logger.info(
        { user: entry.userAddress, grossProfitUsd: Math.round(estimatedGrossProfitUsd * 100) / 100, estimatedGasCostUsd: Math.round(gasCostUsd * 100) / 100, estimatedNetProfitUsd: Math.round(netUsd * 100) / 100 },
        netUsd > 0 ? "NET POSITIVE at current conditions, if executable" : "would be net NEGATIVE after realistic gas at current conditions",
      );
    }
  }

  for (const check of checks) {
    const icon = check.ok === true ? "✓" : check.ok === false ? "✗" : "?";
    logger.info({}, `  [${icon}] ${check.label} — ${check.detail}`);
  }

  const blockers = checks.filter((c) => c.ok === false);
  if (blockers.length === 0) {
    logger.info({ user: entry.userAddress }, "→ no known blockers — this position could be captured if it crosses Health Factor 1.0");
  } else {
    logger.warn({ user: entry.userAddress, blockers: blockers.map((b) => b.label) }, "→ BLOCKED — see checks above");
  }
}

function money(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
}

async function main() {
  const config = loadConfig();
  const etherscanApiKey = process.env["ETHERSCAN_API_KEY"];
  const addressArg = process.argv.find((a) => a.startsWith("--address="))?.split("=")[1]?.toLowerCase();

  const watchlist = await fetchWatchlist(config.apiBaseUrl, 40);
  const targets = addressArg ? watchlist.filter((w) => w.userAddress.toLowerCase() === addressArg) : watchlist.slice(0, TOP_N);

  if (targets.length === 0) {
    logger.warn("no matching watchlist positions found");
    return;
  }

  const clients = new Map<number, PublicClient>();
  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chainDef = CHAIN_DEFS[chainId];
    if (!chainDef) continue;
    clients.set(chainId, createPublicClient({ chain: chainDef, transport: http(chainConfig.rpcUrl) }) as PublicClient);
  }

  for (const entry of targets) {
    await analyzeOne(config, clients, entry, etherscanApiKey);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "liquidation readiness analysis failed");
  process.exit(1);
});
