import type { ArbitrageOpportunity } from "@workspace/api-zod";
import { encodeFunctionData, formatUnits, keccak256 } from "viem";
import { aavePoolPremiumAbi, arbExecutorAbi } from "./abis";
import {
  simulateAndSubmitBloxrouteBackrun,
  watchBloxrouteBackrunme,
  type BloxrouteBackrunSignal,
} from "./bloxrouteBackrun";
import type { ChainClients } from "./chains";
import type { Config } from "./config";
import { checkGasVsProfit } from "./gasGuard";
import { simulateAndSendMevShareBackrun } from "./flashbotsBackrun";
import { TradeLimiter } from "./limiter";
import { logger } from "./logger";
import {
  mevShareHintAddresses,
  isPotentialSwapHint,
  watchMevShareHints,
  type MevShareHint,
} from "./mevShareHints";
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
import { optimizeUsdSize, resolveBorrowAmount } from "./sizing";

export async function runLoop(
  config: Config,
  chainClients: ChainClients,
): Promise<never> {
  const limiter = new TradeLimiter(config.maxTradesPerHour);
  const runtime = { readinessSignatures: new Map<number, string>() };

  const wsChains = [...chainClients.clients.entries()]
    .filter(([, c]) => c.wsClient !== null)
    .map(([id]) => id);
  logger.info(
    {
      liveExecution: config.enableLiveExecution,
      requireManualExecution: config.requireManualExecution,
      chains: Object.keys(config.chains).map(Number),
      blockDrivenChains: [...chainClients.clients.keys()],
      websocketChains: wsChains,
      maxBorrowUsd: config.maxBorrowUsd,
      minProfitUsd: config.minProfitUsd,
      minProfitUsdByChain: config.minProfitUsdByChain,
      minProfitBpsOnChain: config.minProfitBpsOnChain,
      maxTradesPerHour: config.maxTradesPerHour,
      scannerRequestTimeoutMs: config.scannerRequestTimeoutMs,
      minTickGapMs: config.minTickGapMs,
      mevShareHints: config.enableMevShareHints,
      bloxrouteBackrunme: config.enableBloxrouteBackrunme,
      bloxrouteCredentialsReady: Boolean(config.bloxrouteAuthHeader),
      autoGasReserve: config.autoGasReserve,
      bscGasReserveTriggerWei: config.bscGasReserveTriggerWei.toString(),
      bscGasReserveTargetWei: config.bscGasReserveTargetWei.toString(),
    },
    config.enableLiveExecution
      ? "executor-bot starting in LIVE EXECUTION mode — real transactions will be sent"
      : "executor-bot starting in dry-run mode — no transactions will be sent",
  );

  // Each chain owns its lock and cadence. A slow Ethereum quote cycle must
  // never suppress a BNB or Arbitrum block trigger; transactions on distinct
  // chains also have independent nonce domains. Same-chain overlap remains
  // forbidden so one account can never race itself for a nonce.
  const ticking = new Set<number>();
  const lastTickAt = new Map<number, number>();
  const runTickSafely = (
    chainId: number,
    trigger: string,
    signal?: TickSignal,
  ) => {
    if (ticking.has(chainId)) return;
    const minTickGapMs =
      chainId === 8453
        ? config.flashblocksMinTickGapMs
        : config.minTickGapMs;
    if (Date.now() - (lastTickAt.get(chainId) ?? 0) < minTickGapMs)
      return;
    ticking.add(chainId);
    lastTickAt.set(chainId, Date.now());
    tick(config, chainClients, limiter, runtime, chainId, signal)
      .catch((err) =>
        logger.error(
          { err, trigger, chainId },
          "unhandled error in chain poll cycle",
        ),
      )
      .finally(() => {
        ticking.delete(chainId);
      });
  };

  // Block-driven: WebSocket chains subscribe directly. HTTP-only chains use
  // viem's block-number watcher, which polls only the lightweight head RPC;
  // the fixed interval below remains a heartbeat if either watcher fails.
  for (const [chainId, entry] of chainClients.clients) {
    if (entry.wsClient) {
      entry.wsClient.watchBlocks({
        onBlock: () => runTickSafely(chainId, `block:${chainId}:ws`),
        onError: (err) =>
          logger.warn({ err, chainId }, "block subscription error"),
      });
    } else {
      entry.publicClient.watchBlockNumber({
        pollingInterval: Math.max(1_000, config.minTickGapMs),
        onBlockNumber: () => runTickSafely(chainId, `block:${chainId}:http`),
        onError: (err) =>
          logger.warn({ err, chainId }, "block polling watcher error"),
      });
    }
  }

  if (config.enableMevShareHints) {
    void watchMevShareHints(config.mevShareStreamUrl, (hint) => {
      logger.debug({ hash: hint.hash }, "MEV-Share hint received");
      if (!isPotentialSwapHint(hint)) return;
      if (chainClients.clients.has(1))
        runTickSafely(1, `mev-share:${hint.hash}`, {
          kind: "mev-share",
          hint,
        });
    }).catch((err) =>
      logger.error({ err }, "MEV-Share watcher stopped unexpectedly"),
    );
  }

  if (
    config.enableBloxrouteBackrunme &&
    config.bloxrouteAuthHeader &&
    chainClients.clients.has(56)
  ) {
    void watchBloxrouteBackrunme({
      wsUrl: config.bloxrouteBackrunmeWsUrl,
      authorization: config.bloxrouteAuthHeader,
      onSignal: (backrunSignal) => {
        logger.debug(
          {
            targetHash: backrunSignal.targetHash,
            nextBlockNumber: backrunSignal.nextBlockNumber.toString(),
          },
          "bloXroute BSC private backrun target received",
        );
        runTickSafely(56, `bloxroute:${backrunSignal.targetHash}`, {
          kind: "bloxroute-bsc",
          signal: backrunSignal,
        });
      },
    }).catch((err) =>
      logger.error({ err }, "bloXroute BackRunMe watcher stopped unexpectedly"),
    );
  } else if (config.enableBloxrouteBackrunme) {
    logger.warn(
      {
        bscConfigured: chainClients.clients.has(56),
        authorizationConfigured: Boolean(config.bloxrouteAuthHeader),
      },
      "bloXroute BackRunMe standing by — BSC and an approved auth header are required",
    );
  }

  // Fixed-interval fallback/heartbeat — keeps working even if every chain's
  // WebSocket subscription is down, and bounds the worst-case reaction time
  // to `pollIntervalMs` regardless.
  for (;;) {
    for (const chainId of chainClients.clients.keys())
      runTickSafely(chainId, "timer");
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

type RuntimeState = { readinessSignatures: Map<number, string> };
type TickSignal =
  | { kind: "mev-share"; hint: MevShareHint }
  | { kind: "bloxroute-bsc"; signal: BloxrouteBackrunSignal };

function tickSignalAddresses(signal: TickSignal): Set<string> {
  return signal.kind === "mev-share"
    ? mevShareHintAddresses(signal.hint)
    : signal.signal.addresses;
}

function tickSignalTargetHash(signal: TickSignal) {
  return signal.kind === "mev-share"
    ? signal.hint.hash
    : signal.signal.targetHash;
}

function opportunityRelevantAddresses(opportunity: ArbitrageOpportunity) {
  return new Set(
    [
      opportunity.buyVenue.pairAddress,
      opportunity.sellVenue.pairAddress,
      opportunity.tokenAddress,
      opportunity.buyVenue.quoteTokenAddress,
      opportunity.sellVenue.quoteTokenAddress,
      ...(opportunity.routeLegs ?? []).map((leg) => leg.venue.pairAddress),
      ...(opportunity.routeLegs ?? []).flatMap((leg) => [
        leg.tokenInAddress,
        leg.tokenOutAddress,
      ]),
    ]
      .filter((address): address is string => typeof address === "string")
      .map((address) => address.toLowerCase()),
  );
}

function privateSignalMatchScore(
  opportunity: ArbitrageOpportunity,
  addresses: Set<string> | null,
) {
  if (!addresses) return 0;
  const pools = [
    opportunity.buyVenue.pairAddress,
    opportunity.sellVenue.pairAddress,
    ...(opportunity.routeLegs ?? []).map((leg) => leg.venue.pairAddress),
  ].map((address) => address.toLowerCase());
  if (pools.some((address) => addresses.has(address))) return 2;
  return 1;
}

async function tick(
  config: Config,
  chainClients: ChainClients,
  limiter: TradeLimiter,
  runtime: RuntimeState,
  chainId: number,
  signal?: TickSignal,
): Promise<void> {
  if (config.enableLiveExecution) {
    const readiness = await getExecutionReadiness(
      chainClients,
      new Set([chainId]),
    );
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
    if (signature !== runtime.readinessSignatures.get(chainId)) {
      runtime.readinessSignatures.set(chainId, signature);
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
    if (!statuses.some((status) => status.ready)) return;
  }

  const [opportunities, requested] = await Promise.all([
    fetchOpportunities(
      config.apiBaseUrl,
      CHAIN_QUERY_NAMES[chainId] ?? "all",
      0,
      config.scannerRequestTimeoutMs,
    ),
    config.requireManualExecution
      ? fetchExecutionRequests(config.apiBaseUrl)
      : Promise.resolve(new Set<string>()),
  ]);
  const hintedAddresses = signal ? tickSignalAddresses(signal) : null;
  if (hintedAddresses && hintedAddresses.size === 0) {
    logger.debug(
      { targetHash: tickSignalTargetHash(signal!) },
      "skip private order-flow signal: no pool or target address was disclosed",
    );
    return;
  }
  const candidates = opportunities
    .filter(
      (opp) =>
        signal
          ? opp.executable ||
            (opp.quoteStatus === "quoted" &&
              opp.executionBlocker === "negative-net" &&
              opp.profit.recommendedBorrowUsd > 0)
          : opp.executable &&
            opp.profit.netProfitUsd >=
              (config.minProfitUsdByChain[opp.chainId] ?? config.minProfitUsd),
    )
    .filter((opp) => chainClients.clients.has(opp.chainId))
    .filter((opp) => {
      if (!hintedAddresses) return true;
      for (const address of opportunityRelevantAddresses(opp))
        if (hintedAddresses.has(address)) return true;
      return false;
    })
    .filter((opp) => !config.requireManualExecution || requested.has(opp.id))
    .sort(
      (a, b) =>
        privateSignalMatchScore(b, hintedAddresses) -
          privateSignalMatchScore(a, hintedAddresses) ||
        Number(requested.has(b.id)) - Number(requested.has(a.id)) ||
        Number(b.chainId === 56) - Number(a.chainId === 56) ||
        b.profit.netProfitUsd - a.profit.netProfitUsd,
    );

  logger.debug(
    {
      total: opportunities.length,
      candidates: candidates.length,
      signal: signal?.kind ?? "normal",
      targetHash: signal ? tickSignalTargetHash(signal) : undefined,
    },
    "poll cycle",
  );

  // A private target has one short inclusion window and one backrun slot.
  // Evaluate the strongest pool/token match rather than signing several
  // competing transactions with the same account nonce.
  const evaluationCandidates = signal ? candidates.slice(0, 1) : candidates;
  for (const opportunity of evaluationCandidates) {
    await evaluate(config, chainClients, limiter, opportunity, signal);
    if (requested.has(opportunity.id))
      await completeExecutionRequest(config.apiBaseUrl, opportunity.id);
  }
}

async function evaluate(
  config: Config,
  chainClients: ChainClients,
  limiter: TradeLimiter,
  opportunity: ArbitrageOpportunity,
  signal?: TickSignal,
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
  if (
    !optimized ||
    (!signal && optimized.result.expectedProfitAfterPremium <= 0n)
  ) {
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
  let minProfit =
    (amountIn * BigInt(config.minProfitBpsOnChain)) / 10_000n;
  let privateGasLimit: bigint | undefined;
  let gasCheck:
    | {
        ok: true;
        gasCostUsd: number;
        gasCostWei: bigint;
        expectedProfitUsd: number;
        gasEstimate: bigint;
      }
    | null = null;
  if (signal) {
    // A pre-target eth_estimateGas can legitimately revert: the opportunity
    // may exist only after the private target. Sign with a conservative cap,
    // then let the provider's matched post-target simulation validate the
    // exact bundle. Gas is still priced and protected by on-chain minProfit.
    privateGasLimit = 350_000n + BigInt(legs.length) * 200_000n;
    const currentGasPrice = await chain.publicClient.getGasPrice();
    const gasCostWei =
      (privateGasLimit * currentGasPrice * 120n) / 100n;
    const gasCostUsd = await nativeEthAmountToUsd(
      chain.publicClient,
      opportunity.chainId,
      gasCostWei,
    );
    if (gasCostUsd === null) {
      log.debug("skip private backrun: cannot price conservative gas cap");
      return;
    }
    gasCheck = {
      ok: true,
      gasCostUsd,
      gasCostWei,
      expectedProfitUsd: 0,
      gasEstimate: privateGasLimit,
    };
  } else {
    const checked = await checkGasVsProfit(chain.publicClient, {
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
    if (!checked.ok) {
      log.debug(
        { reason: checked.reason, detail: checked.detail },
        "skip: gas-vs-profit check failed",
      );
      return;
    }
    gasCheck = checked;
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
  const requiredMinProfitUsd =
    config.minProfitUsdByChain[opportunity.chainId] ?? config.minProfitUsd;
  if (signal) {
    const protectedGrossProfitUsd = Math.max(
      requiredMinProfitUsd + totalGasCostUsd,
      totalGasCostUsd * config.minProfitOverGasMultiplier,
    );
    const protectedProfitAmount = await resolveBorrowAmount(
      chain.publicClient,
      opportunity.chainId,
      asset,
      assetDecimals,
      protectedGrossProfitUsd,
    );
    if (protectedProfitAmount === null) {
      log.debug(
        "skip private backrun: cannot translate gas-protected USD floor into the borrowed asset",
      );
      return;
    }
    if (protectedProfitAmount > minProfit) minProfit = protectedProfitAmount;
    gasCheck.expectedProfitUsd = protectedGrossProfitUsd;
  }
  const expectedNetProfitUsd = gasCheck.expectedProfitUsd - totalGasCostUsd;
  if (expectedNetProfitUsd < requiredMinProfitUsd) {
    log.debug(
      { expectedNetProfitUsd, minProfitUsd: requiredMinProfitUsd },
      "skip: exact quote net profit is below configured USD minimum after settlement gas",
    );
    return;
  }
  if (
    !signal &&
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
    if (!signal) {
      await chain.publicClient.simulateContract({
        address: chain.executorAddress,
        abi: arbExecutorAbi,
        functionName: "initiateArbitrage",
        args: [asset, amountIn, legs, minProfit, asset],
        account: chainClients.account,
        ...(opportunity.chainId === 8453
          ? { blockTag: "pending" as const }
          : {}),
      });
    }

    log.info(
      {
        asset,
        amountIn: amountIn.toString(),
        minProfit: minProfit.toString(),
        expectedNetProfitUsd,
        legs: legs.length,
      },
      signal
        ? "private backrun prepared for mandatory matched-bundle simulation"
        : "simulation succeeded",
    );

    if (!config.enableLiveExecution) {
      log.info(
        "dry-run: would send transaction now (ENABLE_LIVE_EXECUTION=false)",
      );
      return;
    }

    let hash: `0x${string}`;
    if (signal?.kind === "mev-share") {
      const prepared = await chain.walletClient.prepareTransactionRequest({
        account: chainClients.account,
        to: chain.executorAddress,
        gas: privateGasLimit,
        data: encodeFunctionData({
          abi: arbExecutorAbi,
          functionName: "initiateArbitrage",
          args: [asset, amountIn, legs, minProfit, asset],
        }),
      });
      const signedTransaction = await chain.walletClient.signTransaction(
        prepared,
      );
      const nextBlockNumber =
        (await chain.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
      const submitted = await simulateAndSendMevShareBackrun({
        relayUrl: config.mevShareRelayUrl,
        account: chainClients.account,
        targetHash: signal.hint.hash,
        signedTransaction,
        nextBlockNumber,
      });
      hash = keccak256(signedTransaction);
      limiter.record();
      log.info(
        {
          hash,
          bundleHash: submitted.bundleHash,
          targetHash: signal.hint.hash,
          simulationGasUsed: submitted.simulationGasUsed.toString(),
        },
        "target-aware MEV-Share backrun bundle simulated and submitted",
      );
    } else if (signal?.kind === "bloxroute-bsc") {
      if (!config.bloxrouteAuthHeader)
        throw new Error("bloXroute auth header disappeared at runtime");
      const prepared = await chain.walletClient.prepareTransactionRequest({
        account: chainClients.account,
        to: chain.executorAddress,
        gas: privateGasLimit,
        data: encodeFunctionData({
          abi: arbExecutorAbi,
          functionName: "initiateArbitrage",
          args: [asset, amountIn, legs, minProfit, asset],
        }),
      });
      const signedTransaction = await chain.walletClient.signTransaction(
        prepared,
      );
      const submitted = await simulateAndSubmitBloxrouteBackrun({
        rpcUrl: config.bloxrouteBackrunmeRpcUrl,
        authorization: config.bloxrouteAuthHeader,
        signal: signal.signal,
        signedTransaction,
      });
      hash = keccak256(signedTransaction);
      limiter.record();
      log.info(
        {
          hash,
          bundleHash: submitted.bundleHash,
          targetHash: signal.signal.targetHash,
        },
        "target-aware bloXroute BSC backrun simulated and submitted",
      );
    } else {
      limiter.record();
      hash = await chain.walletClient.writeContract({
        address: chain.executorAddress,
        abi: arbExecutorAbi,
        functionName: "initiateArbitrage",
        args: [asset, amountIn, legs, minProfit, asset],
        account: chainClients.account,
      });
      log.info({ hash }, "transaction sent");
    }

    const receipt = await chain.publicClient.waitForTransactionReceipt({
      hash,
      ...(signal ? { timeout: signal.kind === "mev-share" ? 45_000 : 15_000 } : {}),
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
