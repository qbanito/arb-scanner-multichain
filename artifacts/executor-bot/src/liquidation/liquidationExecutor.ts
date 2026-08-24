import { arbExecutorAbi } from "../abis";
import type { ChainClients, ChainEntry } from "../chains";
import type { Config } from "../config";
import { computeCompetitivePriorityFee } from "../dynamicPriorityFee";
import { checkGasVsProfit } from "../gasGuard";
import { TradeLimiter } from "../limiter";
import { logger } from "../logger";
import {
  getExecutionReadiness,
  hasSufficientGasBalance,
  minimumGasBalance,
} from "../readiness";
import { fetchBorrowerCandidates } from "./graphClient";
import { findAtRiskAccounts } from "./healthFactor";
import { isKnownAsset, knownAssetDecimals } from "./knownAssets";
import {
  buildLiquidationRoute,
  type LiquidationRoute,
} from "./liquidationRouteBuilder";
import { marketsForChain } from "./aaveRegistry";

// Verified from aave-v3-core's LiquidationLogic.sol.
const CLOSE_FACTOR_HF_THRESHOLD = 950_000_000_000_000_000n; // 0.95e18
const DEFAULT_CLOSE_FACTOR_BPS = 5_000n; // 50%
const MAX_CLOSE_FACTOR_BPS = 10_000n; // 100%

// Was a single `first: 500, skip: 0` page — silently capping this bot's own
// scan loop to whichever 500 borrowers the subgraph happened to return
// first, regardless of how many more exist. Paginated in parallel (cheap
// HTTP, same pattern as the API server's discovery) up to this many pages
// per chain per tick, matching the same candidate-pool depth the UI/
// watchlist already scans — the on-chain Health Factor check below
// (sequential, batched) is what actually bounds RPC load, not this.
const CANDIDATES_PAGE_SIZE = 500;
const CANDIDATES_MAX_PAGES = 3;

export async function runLiquidationLoop(
  config: Config,
  chainClients: ChainClients,
): Promise<never> {
  const limiter = new TradeLimiter(config.maxTradesPerHour);
  logger.info(
    { scanIntervalMs: config.liquidationScanIntervalMs },
    "liquidation scanner starting",
  );

  for (;;) {
    try {
      await scanTick(config, chainClients, limiter);
    } catch (err) {
      logger.error({ err }, "unhandled error in liquidation scan");
    }
    await sleep(config.liquidationScanIntervalMs);
  }
}

async function scanTick(
  config: Config,
  chainClients: ChainClients,
  limiter: TradeLimiter,
): Promise<void> {
  if (!config.graphApiKey) return;

  for (const [chainId, chain] of chainClients.clients) {
    // A chain can have several isolated Aave markets (see aaveRegistry.ts) —
    // each has its own borrowers and its own Pool contract, so each needs
    // its own subgraph fetch + HF check + liquidationCall target. Scanned
    // sequentially, same reasoning as the per-candidate throttle below: this
    // shares an RPC key with the per-block watchlist checker, and markets
    // firing concurrently is exactly the burst pattern that caused a real
    // 429 incident.
    for (const market of marketsForChain(chainId)) {
      const pages = await Promise.all(
        Array.from({ length: CANDIDATES_MAX_PAGES }, (_, page) =>
          fetchBorrowerCandidates(market.subgraphId, config.graphApiKey!, {
            first: CANDIDATES_PAGE_SIZE,
            skip: page * CANDIDATES_PAGE_SIZE,
          }),
        ),
      );
      const candidates = pages.flat();
      if (candidates.length === 0) continue;

      const atRisk = await findAtRiskAccounts(
        chain.publicClient,
        market.pool,
        candidates.map((c) => c.address),
      );

      logger.debug(
        {
          chainId,
          market: market.marketKey,
          candidates: candidates.length,
          atRisk: atRisk.length,
        },
        "liquidation scan cycle",
      );

      for (const account of atRisk) {
        const candidate = candidates.find(
          (c) => c.address.toLowerCase() === account.address.toLowerCase(),
        );
        if (!candidate) continue;

        const debtReserve = candidate.reserves
          .filter(
            (r) =>
              r.currentTotalDebt > 0n &&
              isKnownAsset(chainId, r.underlyingAsset),
          )
          .sort((a, b) =>
            a.currentTotalDebt > b.currentTotalDebt ? -1 : 1,
          )[0];
        const collateralReserve = candidate.reserves
          .filter(
            (r) =>
              r.currentATokenBalance > 0n &&
              r.usageAsCollateralEnabledOnUser &&
              isKnownAsset(chainId, r.underlyingAsset),
          )
          .sort((a, b) =>
            a.currentATokenBalance > b.currentATokenBalance ? -1 : 1,
          )[0];
        if (!debtReserve || !collateralReserve) continue;

        const closeFactorBps =
          account.healthFactor < CLOSE_FACTOR_HF_THRESHOLD
            ? MAX_CLOSE_FACTOR_BPS
            : DEFAULT_CLOSE_FACTOR_BPS;
        const debtToCover =
          (debtReserve.currentTotalDebt * closeFactorBps) / 10_000n;
        if (debtToCover === 0n) continue;

        // Gap between candidates. Each attemptLiquidation fires ~4 *parallel*
        // reads internally (buildLiquidationRoute's Promise.all) — 150ms here
        // still meant a sustained ~25+ req/sec against Alchemy and produced a
        // real 429 storm in practice, confirmed from a live run. This loop
        // only runs once per liquidationScanIntervalMs (60s default) and isn't
        // latency-sensitive — the real-time path is highValueWatcher.ts, not
        // this one — so there's no reason to rush it.
        await sleep(1_000);

        await attemptLiquidation(config, chain, chainClients, limiter, {
          chainId,
          pool: market.pool,
          oracle: market.oracle,
          dataProvider: market.dataProvider,
          user: candidate.address,
          debtAsset: debtReserve.underlyingAsset,
          collateralAsset: collateralReserve.underlyingAsset,
          debtToCover,
          healthFactor: account.healthFactor,
        });
      }
    }
  }
}

export type LiquidationAttempt = {
  chainId: number;
  /// Which Aave market's Pool this position belongs to — a chain can have
  /// several isolated markets (see aaveRegistry.ts), so chainId alone is not
  /// enough to know which contract to call liquidationCall on.
  pool: `0x${string}`;
  oracle: `0x${string}`;
  dataProvider: `0x${string}`;
  user: `0x${string}`;
  debtAsset: `0x${string}`;
  collateralAsset: `0x${string}`;
  /// Amount of `debtAsset` to repay, in its native units. Callers computing
  /// this from a possibly-stale source (e.g. a periodic discovery scan) can
  /// pass their best estimate — the on-chain `liquidationCall` and this
  /// bot's own simulate-before-send step are what actually keep this safe,
  /// not the precision of this number.
  debtToCover: bigint;
  healthFactor: bigint;
};

/// Builds, gas-checks, simulates, and (if ENABLE_LIVE_EXECUTION) sends a
/// single liquidation attempt. Shared by the periodic subgraph-driven
/// scanner (scanTick, above) and the tight block-driven watcher
/// (highValueWatcher.ts) for previously-discovered high-value positions —
/// same safety checks either way, only the trigger source differs.
export async function attemptLiquidation(
  config: Config,
  chain: ChainEntry,
  chainClients: ChainClients,
  limiter: TradeLimiter,
  attempt: LiquidationAttempt,
  /// Skips the route-building RPC round trips (pool fee reads, DEX quotes)
  /// when a fresh one is already on hand — see highValueWatcher.ts, which
  /// keeps routes pre-built for watchlist positions estimated to be close
  /// to crossing. Gas price and the simulate-before-send step are always
  /// re-checked live regardless; only the swap-leg calldata is reused.
  precomputedRoute?: LiquidationRoute,
): Promise<void> {
  const log = logger.child({
    user: attempt.user,
    chainId: attempt.chainId,
    healthFactor: attempt.healthFactor.toString(),
  });

  if (!chain.executorAddress) {
    log.info(
      "watch-only chain — position crossed the trigger, but no ArbExecutor is deployed here yet, so nothing to send",
    );
    return;
  }

  if (config.enableLiveExecution) {
    const readiness = (await getExecutionReadiness(chainClients)).get(
      attempt.chainId,
    );
    if (!readiness?.ready) {
      log.info(
        { blockers: readiness?.blockers ?? ["rpc-unavailable"] },
        "live liquidation standing by — executor is not ready; no transaction can be sent",
      );
      return;
    }
  }

  if (!limiter.canTrade()) {
    log.info("skip: hourly trade limit reached");
    return;
  }

  const debtDecimals = knownAssetDecimals(attempt.chainId, attempt.debtAsset);
  const collateralDecimals = knownAssetDecimals(
    attempt.chainId,
    attempt.collateralAsset,
  );
  if (debtDecimals === null || collateralDecimals === null) {
    log.debug("skip: debt/collateral asset not in known-asset set");
    return;
  }

  let route = precomputedRoute;
  if (route) {
    log.debug("using precomputed liquidation route");
  } else {
    const routeResult = await buildLiquidationRoute(chain.publicClient, {
      chainId: attempt.chainId,
      pool: attempt.pool,
      oracle: attempt.oracle,
      dataProvider: attempt.dataProvider,
      executorAddress: chain.executorAddress,
      user: attempt.user,
      debtAsset: attempt.debtAsset,
      debtDecimals,
      collateralAsset: attempt.collateralAsset,
      collateralDecimals,
      debtToCover: attempt.debtToCover,
      slippageBps: config.slippageBps,
    });
    if (!routeResult.ok) {
      log.debug(
        { reason: routeResult.reason },
        "skip: liquidation route not buildable",
      );
      return;
    }
    route = routeResult.route;
  }

  const {
    legs,
    asset,
    amountIn,
    estimatedGrossProfit,
    assetDecimals,
    estimatedGrossProfitUsd,
  } = route;
  // Liquidation profit already comes from a protocol-defined bonus, not a
  // market spread — a small on-chain floor here just guards against dust
  // and rounding, not the primary profitability check (that's the bonus
  // math itself plus the gas-vs-profit gate below).
  const minProfit = (amountIn * BigInt(config.minProfitBpsOnChain)) / 10_000n;

  const gasCheck = await checkGasVsProfit(chain.publicClient, {
    chainId: attempt.chainId,
    executorAddress: chain.executorAddress,
    account: chainClients.account,
    asset,
    amount: amountIn,
    legs,
    minProfit,
    assetDecimals,
    estimatedGrossProfitAsset: estimatedGrossProfit,
    minMultiplier: config.minProfitOverGasMultiplier,
    expectedProfitUsdOverride: estimatedGrossProfitUsd,
  });
  if (!gasCheck.ok) {
    log.debug({ reason: gasCheck.reason }, "skip: gas-vs-profit check failed");
    return;
  }

  // Bid more than the generic default for genuinely valuable opportunities —
  // scaled to how much profit is actually on the table, capped so it never
  // eats meaningfully into it. `null` (small trade, non-mainnet, or a
  // fee-market read failure) just means "send at the normal estimated fee",
  // never blocks the attempt.
  const dynamicFees = await computeCompetitivePriorityFee(
    chain.publicClient,
    attempt.chainId,
    gasCheck.gasEstimate,
    gasCheck.expectedProfitUsd,
    gasCheck.gasCostUsd,
  );
  if (dynamicFees) {
    log.info(
      {
        maxFeePerGas: dynamicFees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: dynamicFees.maxPriorityFeePerGas.toString(),
        extraTipUsd: dynamicFees.extraTipUsd,
      },
      "bidding above market-rate priority fee for competitive inclusion",
    );
  }

  const estimatedSendCostWei = dynamicFees
    ? gasCheck.gasEstimate * dynamicFees.maxFeePerGas
    : gasCheck.gasCostWei;
  const operatorGasBalance = await chain.publicClient.getBalance({
    address: chainClients.account.address,
  });
  if (
    !hasSufficientGasBalance(
      operatorGasBalance,
      minimumGasBalance(attempt.chainId),
      estimatedSendCostWei,
    )
  ) {
    log.warn(
      {
        gasBalance: operatorGasBalance.toString(),
        estimatedTransactionCostWei: estimatedSendCostWei.toString(),
      },
      "skip: operator balance cannot cover this liquidation's estimated gas with headroom",
    );
    return;
  }

  try {
    const { request } = await chain.publicClient.simulateContract({
      address: chain.executorAddress,
      abi: arbExecutorAbi,
      functionName: "initiateArbitrage",
      args: [asset, amountIn, legs, minProfit, asset],
      account: chainClients.account,
      ...(dynamicFees
        ? {
            maxFeePerGas: dynamicFees.maxFeePerGas,
            maxPriorityFeePerGas: dynamicFees.maxPriorityFeePerGas,
          }
        : {}),
    });

    log.info(
      {
        asset,
        amountIn: amountIn.toString(),
        gasCostUsd: gasCheck.gasCostUsd,
        expectedProfitUsd: gasCheck.expectedProfitUsd,
      },
      "liquidation simulation succeeded",
    );

    if (!config.enableLiveExecution) {
      log.info(
        "dry-run: would send liquidation now (ENABLE_LIVE_EXECUTION=false)",
      );
      return;
    }

    limiter.record();
    const hash = await chain.walletClient.writeContract(request);
    log.info({ hash }, "liquidation transaction sent");

    const receipt = await chain.publicClient.waitForTransactionReceipt({
      hash,
    });
    log.info(
      { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() },
      "liquidation transaction confirmed",
    );
  } catch (err) {
    log.warn(
      { err },
      "liquidation simulation reverted — position likely already liquidated by someone else, no funds at risk",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
