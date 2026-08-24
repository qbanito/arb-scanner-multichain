import type { ArbitrageOpportunity } from "@workspace/api-zod";
import { formatUnits } from "viem";
import { aavePoolPremiumAbi, arbExecutorAbi } from "./abis";
import type { ChainClients } from "./chains";
import type { Config } from "./config";
import { checkGasVsProfit } from "./gasGuard";
import { TradeLimiter } from "./limiter";
import { logger } from "./logger";
import { watchMevShareHints } from "./mevShareHints";
import { nativeEthAmountToUsd } from "./priceOracle";
import {
  estimateSettlementGasBudgetWei,
  readExecutorTokenBalance,
  settleConfirmedProfit,
  sweepExecutorToken,
  type GasReserveSettings,
} from "./profitSettlement";
import { buildRoute } from "./routeBuilder";
import {
  completeExecutionRequest,
  fetchExecutionRequests,
  fetchOpportunities,
} from "./scannerClient";
import {
  getExecutionReadiness,
  hasSufficientGasBalance,
  minimumGasBalance,
  routeTargetsAllowed,
} from "./readiness";
import { optimizeUsdSize } from "./sizing";

export async function runLoop(
  config: Config,
  chainClients: ChainClients,
): Promise<never> {
  const limiter = new TradeLimiter(config.maxTradesPerHour);
  const runtime = { readinessSignature: "" };

  const wsChains = [...chainClients.clients.entries()]
    .filter(([, c]) => c.wsClient !== null)
    .map(([id]) => id);
  logger.info(
    {
      liveExecution: config.enableLiveExecution,
      requireManualExecution: config.requireManualExecution,
      chains: Object.keys(config.chains).map(Number),
      blockDrivenChains: wsChains,
      maxBorrowUsd: config.maxBorrowUsd,
      minProfitUsd: config.minProfitUsd,
      minProfitUsdByChain: config.minProfitUsdByChain,
      minProfitBpsOnChain: config.minProfitBpsOnChain,
      maxTradesPerHour: config.maxTradesPerHour,
      scannerRequestTimeoutMs: config.scannerRequestTimeoutMs,
      minTickGapMs: config.minTickGapMs,
      mevShareHints: config.enableMevShareHints,
      autoGasReserve: config.autoGasReserve,
      bscGasReserveTriggerWei: config.bscGasReserveTriggerWei.toString(),
      bscGasReserveTargetWei: config.bscGasReserveTargetWei.toString(),
    },
    config.enableLiveExecution
      ? "executor-bot starting in LIVE EXECUTION mode — real transactions will be sent"
      : "executor-bot starting in dry-run mode — no transactions will be sent",
  );

  // Guards against overlapping runs — a burst of blocks (or a block landing
  // mid-tick) triggers a re-evaluation, not a second concurrent one. Also
  // enforces a minimum gap between ticks: Arbitrum produces a block roughly
  // every ~250ms, far faster than a single tick's RPC calls should be fired,
  // and reacting to literally every block exhausted a free-tier RPC rate
  // limit in practice (shared across this bot, the liquidation scanner, and
  // the API server). This still reacts far faster than the old fixed 15s
  // poll, just not faster than the RPC provider can actually sustain.
  let ticking = false;
  let lastTickAt = 0;
  const runTickSafely = (trigger: string) => {
    if (ticking) return;
    if (Date.now() - lastTickAt < config.minTickGapMs) return;
    ticking = true;
    lastTickAt = Date.now();
    tick(config, chainClients, limiter, runtime)
      .catch((err) =>
        logger.error({ err, trigger }, "unhandled error in poll cycle"),
      )
      .finally(() => {
        ticking = false;
      });
  };

  // Block-driven: react the instant a new block lands on any WebSocket-
  // connected chain, instead of waiting for the next timer tick. Falls back
  // silently to timer-only polling for chains without a derivable wss:// URL
  // (see chains.ts).
  for (const [chainId, entry] of chainClients.clients) {
    if (!entry.wsClient) continue;
    entry.wsClient.watchBlocks({
      onBlock: () => runTickSafely(`block:${chainId}`),
      onError: (err) =>
        logger.warn({ err, chainId }, "block subscription error"),
    });
  }

  if (config.enableMevShareHints) {
    void watchMevShareHints(config.mevShareStreamUrl, (hint) => {
      logger.debug({ hash: hint.hash }, "MEV-Share hint received");
      runTickSafely(`mev-share:${hint.hash}`);
    }).catch((err) =>
      logger.error({ err }, "MEV-Share watcher stopped unexpectedly"),
    );
  }

  // Fixed-interval fallback/heartbeat — keeps working even if every chain's
  // WebSocket subscription is down, and bounds the worst-case reaction time
  // to `pollIntervalMs` regardless.
  for (;;) {
    runTickSafely("timer");
    await sleep(config.pollIntervalMs);
  }
}

const CHAIN_QUERY_NAMES: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  146: "sonic",
  324: "zksync",
  1868: "soneium",
  5000: "mantle",
  8453: "base",
  42161: "arbitrum",
  42220: "celo",
  43114: "avalanche",
  59144: "linea",
  534352: "scroll",
};

type RuntimeState = { readinessSignature: string };

async function tick(
  config: Config,
  chainClients: ChainClients,
  limiter: TradeLimiter,
  runtime: RuntimeState,
): Promise<void> {
  let liveReadyChains: Set<number> | null = null;
  if (config.enableLiveExecution) {
    const readiness = await getExecutionReadiness(chainClients);
    const statuses = [...readiness]
      .map(([chainId, state]) => ({
        chainId,
        ready: state.ready,
        blockers: state.blockers,
        gasBalance: state.gasBalance?.toString() ?? null,
        minimumGasBalance: state.minimumGasBalance.toString(),
      }))
      .sort((a, b) => a.chainId - b.chainId);
    const signature = JSON.stringify(
      statuses.map(({ chainId, ready, blockers }) => ({
        chainId,
        ready,
        blockers,
      })),
    );
    if (signature !== runtime.readinessSignature) {
      runtime.readinessSignature = signature;
      const readyCount = statuses.filter((status) => status.ready).length;
      const log =
        readyCount > 0 ? logger.info.bind(logger) : logger.warn.bind(logger);
      log(
        { statuses },
        readyCount > 0
          ? "live execution readiness changed"
          : "live execution standing by — fund or repair at least one executor; no transaction can be sent",
      );
    }
    liveReadyChains = new Set(
      statuses.filter((status) => status.ready).map((status) => status.chainId),
    );
    if (liveReadyChains.size === 0) return;
  }

  const chainIds = [...chainClients.clients.keys()].filter(
    (chainId) => liveReadyChains === null || liveReadyChains.has(chainId),
  );
  const [perChain, requested] = await Promise.all([
    Promise.all(
      chainIds.map((chainId) =>
        fetchOpportunities(
          config.apiBaseUrl,
          CHAIN_QUERY_NAMES[chainId] ?? "all",
          0,
          config.scannerRequestTimeoutMs,
        ),
      ),
    ),
    config.requireManualExecution
      ? fetchExecutionRequests(config.apiBaseUrl)
      : Promise.resolve(new Set<string>()),
  ]);
  const opportunities = perChain.flat();
  const candidates = opportunities
    .filter(
      (opp) =>
        opp.executable &&
        opp.profit.netProfitUsd >=
          (config.minProfitUsdByChain[opp.chainId] ?? config.minProfitUsd),
    )
    .filter((opp) => chainClients.clients.has(opp.chainId))
    .filter((opp) => !config.requireManualExecution || requested.has(opp.id))
    .sort(
      (a, b) =>
        Number(requested.has(b.id)) - Number(requested.has(a.id)) ||
        Number(b.chainId === 56) - Number(a.chainId === 56) ||
        b.profit.netProfitUsd - a.profit.netProfitUsd,
    );

  logger.debug(
    { total: opportunities.length, candidates: candidates.length },
    "poll cycle",
  );

  for (const opportunity of candidates) {
    await evaluate(config, chainClients, limiter, opportunity);
    if (requested.has(opportunity.id))
      await completeExecutionRequest(config.apiBaseUrl, opportunity.id);
  }
}

async function evaluate(
  config: Config,
  chainClients: ChainClients,
  limiter: TradeLimiter,
  opportunity: ArbitrageOpportunity,
): Promise<void> {
  const log = logger.child({
    opportunityId: opportunity.id,
    token: opportunity.token,
    chainId: opportunity.chainId,
  });

  const chain = chainClients.clients.get(opportunity.chainId);
  if (!chain) return;
  if (!chain.executorAddress) {
    log.debug("skip: chain is watch-only (no ArbExecutor deployed here yet)");
    return;
  }

  if (!limiter.canTrade()) {
    log.info("skip: hourly trade limit reached");
    return;
  }

  const maxBorrowUsd = Math.min(
    opportunity.profit.recommendedBorrowUsd,
    config.maxBorrowUsd,
  );
  const pool = await chain.publicClient.readContract({
    address: chain.executorAddress,
    abi: arbExecutorAbi,
    functionName: "POOL",
  });
  const premiumBps = await chain.publicClient.readContract({
    address: pool,
    abi: aavePoolPremiumAbi,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
  });
  type ProfitableRoute = {
    route: Extract<
      Awaited<ReturnType<typeof buildRoute>>,
      { ok: true }
    >["route"];
    expectedProfitAfterPremium: bigint;
  };
  // Six-hop BNB cycles are the scanner's highest-priority routes, but a full
  // golden-section search would issue up to 72 sequential DEX quote calls
  // before even reaching the atomic simulation. The scanner has already
  // supplied its recommended size, so test that size plus a conservative
  // half-size. Every safety gate below (real quotes, gas, allow-list,
  // minProfit and full eth_call simulation) remains unchanged.
  const hopCount = opportunity.routeLegs?.length ?? 2;
  const fastLongRouteSizing = hopCount >= 5
    ? { coarseRatios: [0.5, 1], refinementIterations: 0 }
    : {};
  const optimized = await optimizeUsdSize<ProfitableRoute>({
    maxBorrowUsd,
    ...fastLongRouteSizing,
    evaluate: async (borrowUsd) => {
      const result = await buildRoute(chain.publicClient, opportunity, {
        executorAddress: chain.executorAddress!,
        borrowUsd,
        slippageBps: config.slippageBps,
      });
      if (!result.ok) return null;
      const premium = (result.route.amountIn * premiumBps) / 10_000n;
      const expectedProfitAfterPremium =
        result.route.estimatedGrossProfit - premium;
      return {
        score: Number(
          formatUnits(expectedProfitAfterPremium, result.route.assetDecimals),
        ),
        result: { route: result.route, expectedProfitAfterPremium },
      };
    },
  });
  if (!optimized || optimized.result.expectedProfitAfterPremium <= 0n) {
    log.debug("skip: no profitable on-chain quote at tested trade sizes");
    return;
  }

  const { route, expectedProfitAfterPremium } = optimized.result;
  const { legs, asset, amountIn, assetDecimals } = route;
  const gasReserveSettings: GasReserveSettings = {
    enabled: config.autoGasReserve,
    triggerWei: config.bscGasReserveTriggerWei,
    targetWei: config.bscGasReserveTargetWei,
    slippageBps: config.gasReserveSlippageBps,
  };

  // The deployed v1 executor measures its whole token balance when enforcing
  // minProfit. Requiring a clean starting balance prevents an old gain (or a
  // stray transfer) from making a later losing route appear profitable.
  const existingExecutorBalance = await readExecutorTokenBalance(chain, asset);
  if (existingExecutorBalance > 0n) {
    if (!config.enableLiveExecution) {
      log.warn(
        { asset, existingExecutorBalance: existingExecutorBalance.toString() },
        "skip: executor asset balance must be swept before this route can be simulated safely",
      );
      return;
    }
    try {
      const sweepHash = await sweepExecutorToken({
        chain,
        account: chainClients.account,
        token: asset,
        amount: existingExecutorBalance,
      });
      log.warn(
        {
          asset,
          amount: existingExecutorBalance.toString(),
          sweepHash,
        },
        "swept pre-existing executor balance; route deferred until the next fresh quote",
      );
    } catch (err) {
      log.error(
        { err, asset, amount: existingExecutorBalance.toString() },
        "cannot clear executor balance; refusing to trade this asset",
      );
    }
    return;
  }
  const allowlist = await routeTargetsAllowed(
    chainClients,
    opportunity.chainId,
    legs.map((leg) => leg.target),
  );
  if (!allowlist.ok) {
    log.warn(
      { blockedTargets: allowlist.blocked },
      "skip: route target is not allow-listed on ArbExecutor",
    );
    return;
  }
  const flashLoanPremium = (amountIn * premiumBps) / 10_000n;
  const minProfit = (amountIn * BigInt(config.minProfitBpsOnChain)) / 10_000n;

  const gasCheck = await checkGasVsProfit(chain.publicClient, {
    chainId: opportunity.chainId,
    executorAddress: chain.executorAddress,
    account: chainClients.account,
    asset,
    amount: amountIn,
    legs,
    minProfit,
    assetDecimals,
    estimatedGrossProfitAsset: expectedProfitAfterPremium,
    minMultiplier: config.minProfitOverGasMultiplier,
  });
  if (!gasCheck.ok) {
    log.debug(
      { reason: gasCheck.reason, detail: gasCheck.detail },
      "skip: gas-vs-profit check failed",
    );
    return;
  }
  const operatorGasBalance = await chain.publicClient.getBalance({
    address: chainClients.account.address,
  });
  const gasPriceWei = await chain.publicClient.getGasPrice();
  const projectedBalanceAfterArb =
    operatorGasBalance > gasCheck.gasCostWei
      ? operatorGasBalance - gasCheck.gasCostWei
      : 0n;
  const settlementGasBudgetWei = estimateSettlementGasBudgetWei({
    chainId: opportunity.chainId,
    gasPriceWei,
    projectedNativeBalance: projectedBalanceAfterArb,
    profitToken: asset,
    settings: gasReserveSettings,
  });
  const settlementGasUsd = await nativeEthAmountToUsd(
    chain.publicClient,
    opportunity.chainId,
    settlementGasBudgetWei,
  );
  if (settlementGasUsd === null) {
    log.debug("skip: cannot price mandatory profit-settlement gas");
    return;
  }
  const totalGasCostWei = gasCheck.gasCostWei + settlementGasBudgetWei;
  const totalGasCostUsd = gasCheck.gasCostUsd + settlementGasUsd;
  const expectedNetProfitUsd = gasCheck.expectedProfitUsd - totalGasCostUsd;
  const requiredMinProfitUsd =
    config.minProfitUsdByChain[opportunity.chainId] ?? config.minProfitUsd;
  if (expectedNetProfitUsd < requiredMinProfitUsd) {
    log.debug(
      { expectedNetProfitUsd, minProfitUsd: requiredMinProfitUsd },
      "skip: exact quote net profit is below configured USD minimum after settlement gas",
    );
    return;
  }
  if (
    gasCheck.expectedProfitUsd <
    totalGasCostUsd * config.minProfitOverGasMultiplier
  ) {
    log.debug(
      {
        expectedProfitUsd: gasCheck.expectedProfitUsd,
        totalGasCostUsd,
      },
      "skip: profit does not clear arbitrage plus settlement gas",
    );
    return;
  }
  if (
    !hasSufficientGasBalance(
      operatorGasBalance,
      minimumGasBalance(opportunity.chainId),
      totalGasCostWei,
    )
  ) {
    log.warn(
      {
        gasBalance: operatorGasBalance.toString(),
        estimatedTransactionCostWei: totalGasCostWei.toString(),
      },
      "skip: operator balance cannot cover this transaction's estimated gas with headroom",
    );
    return;
  }
  log.info(
    {
      gasCostUsd: gasCheck.gasCostUsd,
      settlementGasUsd,
      totalGasCostUsd,
      flashLoanPremium: flashLoanPremium.toString(),
      expectedNetProfitUsd,
      selectedBorrowUsd: optimized.borrowUsd,
      testedSizesUsd: optimized.sampledSizes,
    },
    "exact on-chain net-profit check passed",
  );

  let confirmed = false;
  try {
    const { request } = await chain.publicClient.simulateContract({
      address: chain.executorAddress,
      abi: arbExecutorAbi,
      functionName: "initiateArbitrage",
      args: [asset, amountIn, legs, minProfit, asset],
      account: chainClients.account,
    });

    log.info(
      {
        asset,
        amountIn: amountIn.toString(),
        minProfit: minProfit.toString(),
        expectedNetProfitUsd,
        legs: legs.length,
      },
      "simulation succeeded",
    );

    if (!config.enableLiveExecution) {
      log.info(
        "dry-run: would send transaction now (ENABLE_LIVE_EXECUTION=false)",
      );
      return;
    }

    limiter.record();
    const hash = await chain.walletClient.writeContract(request);
    log.info({ hash }, "transaction sent");

    const receipt = await chain.publicClient.waitForTransactionReceipt({
      hash,
    });
    confirmed = receipt.status === "success";
    log.info(
      { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() },
      "transaction confirmed",
    );
  } catch (err) {
    log.warn(
      { err },
      "simulation reverted — opportunity likely stale or below profit floor, no funds at risk",
    );
    return;
  }

  if (!confirmed) {
    log.error("arbitrage transaction reverted on-chain; no settlement attempted");
    return;
  }

  try {
    const confirmedProfit = await readExecutorTokenBalance(chain, asset);
    if (confirmedProfit <= 0n) {
      log.error(
        "confirmed arbitrage left no withdrawable asset profit; manual review required",
      );
      return;
    }
    const settlement = await settleConfirmedProfit({
      chainId: opportunity.chainId,
      chain,
      account: chainClients.account,
      profitToken: asset,
      confirmedProfit,
      settings: gasReserveSettings,
    });
    log.info(
      {
        asset,
        confirmedProfit: confirmedProfit.toString(),
        withdrawalHash: settlement.withdrawalHash,
        refill:
          settlement.refill.status === "completed"
            ? {
                ...settlement.refill,
                profitSpent: settlement.refill.profitSpent.toString(),
                nativeReceivedMinimum:
                  settlement.refill.nativeReceivedMinimum.toString(),
              }
            : settlement.refill,
      },
      "confirmed profit isolated and gas reserve maintained",
    );
  } catch (err) {
    log.error(
      { err, asset },
      "profit settlement failed; this asset remains blocked until it is swept safely",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
