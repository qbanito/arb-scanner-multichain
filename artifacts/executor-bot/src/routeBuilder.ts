import { type PublicClient, encodeAbiParameters, encodeFunctionData } from "viem";
import type { ArbitrageOpportunity } from "@workspace/api-zod";
import {
  erc20Abi,
  curvePoolAbi,
  curvePoolUintAbi,
  curvePoolCoinsAbi,
  uniswapV2RouterAbi,
  uniswapV3PoolAbi,
  uniswapV3QuoterAbi,
  uniswapV3QuoterV2Abi,
  uniswapV3SwapRouterAbi,
  uniswapV3SwapRouter02Abi,
  solidlyV2PoolAbi,
  solidlyV2RouterAbi,
  liquidityBookPairAbi,
  liquidityBookRouterAbi,
  balancerPoolAbi,
  balancerVaultAbi,
  slipstreamPoolAbi,
  slipstreamQuoterV2Abi,
  slipstreamRouterAbi,
  syncSwapV1PoolAbi,
  syncSwapV1RouterAbi,
  algebraPoolAbi,
  algebraQuoterAbi,
  algebraSwapRouterAbi,
} from "./abis";
import { dexKindFor, factoryFor, quoterFor, resolveDex, routerFor, verifierFor, type SupportedDex } from "./dexRegistry";
import { logger } from "./logger";
import { resolveBorrowAmount } from "./sizing";
import { findCurvePool } from "./curveRegistry";
import { isStableQuote } from "./stableQuotes";
import { slipstreamDeployment } from "./slipstreamRegistry";

export type Leg = { target: `0x${string}`; data: `0x${string}` };

const curveCoinCache = new Map<string, string[]>();
const curveIndexKindCache = new Map<string, "int128" | "uint256">();

export type BuiltRoute = {
  legs: Leg[];
  /// The flash-borrowed asset — the quote token shared by both venues.
  asset: `0x${string}`;
  amountIn: bigint;
  /// Sell hop's *undiscounted* quoted output minus principal — an estimate
  /// of gross profit in `asset` units, before Aave's premium and before
  /// gas. Used only to decide whether a route is worth simulating/sending
  /// at all (see executor.ts's gas-cost check); never a settlement value —
  /// the contract's own on-chain `minProfit` floor is what actually gates
  /// funds moving.
  estimatedGrossProfit: bigint;
  assetDecimals: number;
};

type SkipReason =
  | "unsupported-buy-venue"
  | "unsupported-sell-venue"
  | "unsupported-route-leg"
  | "open-route"
  | "mismatched-quote-token"
  | "missing-quote-token"
  | "missing-quote-decimals"
  | "unsizable-quote-token"
  | "quote-call-failed";

export type RouteResult = { ok: true; route: BuiltRoute } | { ok: false; reason: SkipReason };

/// Translates a scanner opportunity into flash-loan-ready calldata. Returns
/// a skip reason instead of throwing for anything this bot doesn't yet know
/// how to route safely — see dexRegistry.ts and README.md for coverage.
///
/// Both legs' `amountOutMinimum` come from a real on-chain quote — not from
/// the scanner's USD price estimate, which isn't precise enough to size an
/// actual swap. Leg 2's `amountIn` is deliberately set to leg 1's
/// *discounted* (slippage-adjusted) minimum, so the sell leg can never try
/// to spend more than the buy leg is guaranteed to have delivered.
export async function buildRoute(
  client: PublicClient,
  opportunity: ArbitrageOpportunity,
  params: { executorAddress: `0x${string}`; borrowUsd: number; slippageBps: number },
): Promise<RouteResult> {
  if (opportunity.routeLegs && opportunity.routeLegs.length > 0) {
    return buildExplicitCycle(client, opportunity, params);
  }
  const buyDex = resolveDex(opportunity.buyVenue.dexId, opportunity.buyVenue.labels);
  const sellDex = resolveDex(opportunity.sellVenue.dexId, opportunity.sellVenue.labels);
  if (!buyDex) return { ok: false, reason: "unsupported-buy-venue" };
  if (!sellDex) return { ok: false, reason: "unsupported-sell-venue" };

  const quoteAddress = opportunity.buyVenue.quoteTokenAddress;
  if (!quoteAddress) return { ok: false, reason: "missing-quote-token" };
  const sellQuoteAddress = opportunity.sellVenue.quoteTokenAddress;
  if (!sellQuoteAddress) return { ok: false, reason: "missing-quote-token" };
  const needsClosingHop = quoteAddress.toLowerCase() !== sellQuoteAddress.toLowerCase();
  if (needsClosingHop && (!isStableQuote(opportunity.chainId, quoteAddress) || !isStableQuote(opportunity.chainId, sellQuoteAddress))) {
    return { ok: false, reason: "mismatched-quote-token" };
  }

  const asset = quoteAddress as `0x${string}`;
  const quoteDecimals = await readDecimals(client, asset);
  if (quoteDecimals === null) return { ok: false, reason: "missing-quote-decimals" };

  const amountIn = await resolveBorrowAmount(client, opportunity.chainId, asset, quoteDecimals, params.borrowUsd);
  if (amountIn === null) return { ok: false, reason: "unsizable-quote-token" };

  const tokenOut = opportunity.tokenAddress as `0x${string}`;

  try {
    const buyHop = await buildHop(client, {
      dex: buyDex,
      chainId: opportunity.chainId,
      poolAddress: opportunity.buyVenue.pairAddress as `0x${string}`,
      tokenIn: asset,
      tokenOut,
      amountIn,
      recipient: params.executorAddress,
      slippageBps: params.slippageBps,
    });
    if (!buyHop) return { ok: false, reason: "unsupported-buy-venue" };

    // Leg 2 spends exactly what leg 1 is guaranteed (by its own
    // amountOutMinimum) to have produced — never the optimistic quote.
    const sellHop = await buildHop(client, {
      dex: sellDex,
      chainId: opportunity.chainId,
      poolAddress: opportunity.sellVenue.pairAddress as `0x${string}`,
      tokenIn: tokenOut,
      tokenOut: sellQuoteAddress as `0x${string}`,
      amountIn: buyHop.amountOutMinimum,
      recipient: params.executorAddress,
      slippageBps: params.slippageBps,
    });
    if (!sellHop) return { ok: false, reason: "unsupported-sell-venue" };

    let closingLegs: Leg[] = [];
    let guaranteedFinalOut = sellHop.amountOutMinimum;
    if (needsClosingHop) {
      const curve = findCurvePool(opportunity.chainId, sellQuoteAddress as `0x${string}`, asset);
      if (!curve) return { ok: false, reason: "mismatched-quote-token" };
      const closingQuote = await client.readContract({
        address: curve.pool,
        abi: curvePoolAbi,
        functionName: "get_dy",
        args: [BigInt(curve.i), BigInt(curve.j), sellHop.amountOutMinimum],
      });
      guaranteedFinalOut = closingQuote * BigInt(10_000 - params.slippageBps) / 10_000n;
      closingLegs = [
        { target: sellQuoteAddress as `0x${string}`, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [curve.pool, sellHop.amountOutMinimum] }) },
        { target: curve.pool, data: encodeFunctionData({ abi: curvePoolAbi, functionName: "exchange", args: [BigInt(curve.i), BigInt(curve.j), sellHop.amountOutMinimum, guaranteedFinalOut] }) },
      ];
    }

    // Use every leg's guaranteed minimum, not its optimistic spot quote.
    // This makes every downstream "net profit" gate conservative with
    // respect to configured slippage on both legs.
    const estimatedGrossProfit = guaranteedFinalOut - amountIn;

    return {
      ok: true,
      route: { legs: [...buyHop.legs, ...sellHop.legs, ...closingLegs], asset, amountIn, estimatedGrossProfit, assetDecimals: quoteDecimals },
    };
  } catch (err) {
    logger.warn({ err, opportunityId: opportunity.id }, "quote failed while building route");
    return { ok: false, reason: "quote-call-failed" };
  }
}

async function buildExplicitCycle(
  client: PublicClient,
  opportunity: ArbitrageOpportunity,
  params: { executorAddress: `0x${string}`; borrowUsd: number; slippageBps: number },
): Promise<RouteResult> {
  const route = opportunity.routeLegs;
  if (!route || route.length < 2 || route.length > 6) return { ok: false, reason: "open-route" };
  const asset = route[0]!.tokenInAddress as `0x${string}`;
  if (route.at(-1)!.tokenOutAddress.toLowerCase() !== asset.toLowerCase()) {
    return { ok: false, reason: "open-route" };
  }
  for (let index = 1; index < route.length; index++) {
    if (route[index - 1]!.tokenOutAddress.toLowerCase() !== route[index]!.tokenInAddress.toLowerCase()) {
      return { ok: false, reason: "open-route" };
    }
  }
  const assetDecimals = route[0]!.tokenInDecimals;
  const amountIn = await resolveBorrowAmount(client, opportunity.chainId, asset, assetDecimals, params.borrowUsd);
  if (amountIn === null) return { ok: false, reason: "unsizable-quote-token" };

  try {
    const legs: Leg[] = [];
    let currentAmount = amountIn;
    for (const routeLeg of route) {
      const dex = resolveDex(routeLeg.venue.dexId, routeLeg.venue.labels);
      if (!dex) return { ok: false, reason: "unsupported-route-leg" };
      const hop = await buildHop(client, {
        dex,
        chainId: opportunity.chainId,
        poolAddress: routeLeg.venue.pairAddress as `0x${string}`,
        tokenIn: routeLeg.tokenInAddress as `0x${string}`,
        tokenOut: routeLeg.tokenOutAddress as `0x${string}`,
        amountIn: currentAmount,
        recipient: params.executorAddress,
        slippageBps: params.slippageBps,
      });
      if (!hop) return { ok: false, reason: "unsupported-route-leg" };
      legs.push(...hop.legs);
      currentAmount = hop.amountOutMinimum;
    }

    return {
      ok: true,
      route: {
        legs,
        asset,
        amountIn,
        estimatedGrossProfit: currentAmount - amountIn,
        assetDecimals,
      },
    };
  } catch (err) {
    logger.warn({ err, opportunityId: opportunity.id }, "quote failed while building explicit cycle");
    return { ok: false, reason: "quote-call-failed" };
  }
}

async function buildHop(
  client: PublicClient,
  args: {
    dex: SupportedDex;
    chainId: number;
    poolAddress: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    recipient: `0x${string}`;
    slippageBps: number;
  },
): Promise<{ legs: Leg[]; amountOutMinimum: bigint; quotedOut: bigint } | null> {
  const kind = dexKindFor(args.dex, args.chainId);
  let router = kind === "curve-pool" ? args.poolAddress : routerFor(args.dex, args.chainId);
  if (!router) return null;

  let solidlyRoute: { stable: boolean; factory: `0x${string}` } | null = null;
  let liquidityBookRoute: { binStep: number; version: number } | null = null;
  let curveRoute: { i: number; j: number; indexKind: "int128" | "uint256" } | null = null;
  let balancerPoolId: `0x${string}` | null = null;
  let autoResolvedKind: "solidly-v2" | "slipstream" | null = null;
  let slipstreamTickSpacing: number | null = null;
  let syncSwapStepData: `0x${string}` | null = null;
  let quotedOut: bigint | null;
  const expectedFactory = factoryFor(args.dex, args.chainId);
  if (expectedFactory && kind !== "algebra-v1.9") {
    const poolFactory = await client.readContract({ address: args.poolAddress, abi: algebraPoolAbi, functionName: "factory" });
    if (poolFactory.toLowerCase() !== expectedFactory.toLowerCase()) return null;
  }
  if (kind === "univ2") {
    quotedOut = await quoteV2(client, router, args.tokenIn, args.tokenOut, args.amountIn);
  } else if (kind === "solidly-v2") {
    const [amountOut, stable, factory] = await Promise.all([
      client.readContract({
        address: args.poolAddress,
        abi: solidlyV2PoolAbi,
        functionName: "getAmountOut",
        args: [args.amountIn, args.tokenIn],
      }),
      client.readContract({ address: args.poolAddress, abi: solidlyV2PoolAbi, functionName: "stable" }),
      client.readContract({ address: args.poolAddress, abi: solidlyV2PoolAbi, functionName: "factory" }),
    ]);
    quotedOut = amountOut;
    solidlyRoute = { stable, factory };
  } else if (kind === "solidly-slipstream-auto") {
    try {
      const [amountOut, stable, factory] = await Promise.all([
        client.readContract({ address: args.poolAddress, abi: solidlyV2PoolAbi, functionName: "getAmountOut", args: [args.amountIn, args.tokenIn] }),
        client.readContract({ address: args.poolAddress, abi: solidlyV2PoolAbi, functionName: "stable" }),
        client.readContract({ address: args.poolAddress, abi: solidlyV2PoolAbi, functionName: "factory" }),
      ]);
      quotedOut = amountOut;
      solidlyRoute = { stable, factory };
      autoResolvedKind = "solidly-v2";
    } catch {
      const [factory, tickSpacing] = await Promise.all([
        client.readContract({ address: args.poolAddress, abi: slipstreamPoolAbi, functionName: "factory" }),
        client.readContract({ address: args.poolAddress, abi: slipstreamPoolAbi, functionName: "tickSpacing" }),
      ]);
      const deployment = slipstreamDeployment(args.chainId, factory);
      if (!deployment) return null;
      router = deployment.router;
      const [amountOut] = await client.readContract({
        address: deployment.quoter,
        abi: slipstreamQuoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
      });
      quotedOut = amountOut;
      slipstreamTickSpacing = tickSpacing;
      autoResolvedKind = "slipstream";
    }
  } else if (kind === "liquidity-book") {
    if (args.amountIn > (1n << 128n) - 1n) return null;
    const [tokenX, tokenY, binStep, factory] = await Promise.all([
      client.readContract({ address: args.poolAddress, abi: liquidityBookPairAbi, functionName: "getTokenX" }),
      client.readContract({ address: args.poolAddress, abi: liquidityBookPairAbi, functionName: "getTokenY" }),
      client.readContract({ address: args.poolAddress, abi: liquidityBookPairAbi, functionName: "getBinStep" }),
      client.readContract({ address: args.poolAddress, abi: liquidityBookPairAbi, functionName: "getFactory" }),
    ]);
    const input = args.tokenIn.toLowerCase();
    const output = args.tokenOut.toLowerCase();
    const swapForY = input === tokenX.toLowerCase() && output === tokenY.toLowerCase();
    const swapForX = input === tokenY.toLowerCase() && output === tokenX.toLowerCase();
    if (!swapForY && !swapForX) return null;
    const [amountInLeft, amountOut] = await client.readContract({
      address: args.poolAddress,
      abi: liquidityBookPairAbi,
      functionName: "getSwapOut",
      args: [args.amountIn, swapForY],
    });
    if (amountInLeft !== 0n || amountOut === 0n) return null;
    quotedOut = amountOut;
    const normalizedFactory = factory.toLowerCase();
    // ILBRouter.Version: V1=0, V2=1, V2_1=2, V2_2=3.
    const version = normalizedFactory === "0xb43120c4745967fa9b93e79c149e66b0f2d6fe0c"
      ? 3
      : normalizedFactory === "0x8e42f2f4101563bf679975178e880fd87d3efd4e"
        ? 2
        : normalizedFactory === "0x6e77932a92582f504ff6c4bdbcef7da6c198aeef"
          ? 1
          : -1;
    if (version < 1) return null;
    liquidityBookRoute = { binStep, version };
  } else if (kind === "syncswap-v1") {
    const expectedMaster = verifierFor(args.dex, args.chainId);
    if (!expectedMaster) return null;
    const master = await client.readContract({ address: args.poolAddress, abi: syncSwapV1PoolAbi, functionName: "master" });
    if (master.toLowerCase() !== expectedMaster.toLowerCase()) return null;
    quotedOut = await client.readContract({
      address: args.poolAddress,
      abi: syncSwapV1PoolAbi,
      functionName: "getAmountOut",
      args: [args.tokenIn, args.amountIn, args.recipient],
    });
    syncSwapStepData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint8" }],
      [args.tokenIn, args.recipient, 2],
    );
  } else if (kind === "algebra-v1.9") {
    const [factory, quoter] = [factoryFor(args.dex, args.chainId), quoterFor(args.dex, args.chainId)];
    if (!factory || !quoter) return null;
    const poolFactory = await client.readContract({ address: args.poolAddress, abi: algebraPoolAbi, functionName: "factory" });
    if (poolFactory.toLowerCase() !== factory.toLowerCase()) return null;
    [quotedOut] = await client.readContract({
      address: quoter,
      abi: algebraQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [args.tokenIn, args.tokenOut, args.amountIn, 0n],
    });
  } else if (kind === "curve-pool") {
    const quote = await quoteGenericCurve(client, args.chainId, args.poolAddress, args.tokenIn, args.tokenOut, args.amountIn);
    quotedOut = quote.amountOut;
    curveRoute = quote;
  } else if (kind === "balancer-v2") {
    balancerPoolId = await client.readContract({ address: args.poolAddress, abi: balancerPoolAbi, functionName: "getPoolId" });
    const deltas = await client.readContract({
      address: router,
      abi: balancerVaultAbi,
      functionName: "queryBatchSwap",
      args: [
        0,
        [{ poolId: balancerPoolId, assetInIndex: 0n, assetOutIndex: 1n, amount: args.amountIn, userData: "0x" }],
        [args.tokenIn, args.tokenOut],
        { sender: args.recipient, fromInternalBalance: false, recipient: args.recipient, toInternalBalance: false },
      ],
    });
    const outputDelta = deltas[1];
    if (outputDelta === undefined || outputDelta >= 0n) return null;
    quotedOut = -outputDelta;
  } else {
    quotedOut = await quoteV3(client, args.dex, args.chainId, args.poolAddress, args.tokenIn, args.tokenOut, args.amountIn, kind);
  }
  if (quotedOut === null) return null;

  const amountOutMinimum = (quotedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [router, args.amountIn],
  });

  let swapData: `0x${string}`;
  if ((kind === "solidly-v2" || autoResolvedKind === "solidly-v2") && solidlyRoute) {
    swapData = encodeFunctionData({
      abi: solidlyV2RouterAbi,
      functionName: "swapExactTokensForTokens",
      args: [
        args.amountIn,
        amountOutMinimum,
        [{ from: args.tokenIn, to: args.tokenOut, stable: solidlyRoute.stable, factory: solidlyRoute.factory }],
        args.recipient,
        BigInt(Math.floor(Date.now() / 1000) + 120),
      ],
    });
  } else if (autoResolvedKind === "slipstream" && slipstreamTickSpacing !== null) {
    swapData = encodeFunctionData({
      abi: slipstreamRouterAbi,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        tickSpacing: slipstreamTickSpacing,
        recipient: args.recipient,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
        amountIn: args.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
    });
  } else if (kind === "liquidity-book" && liquidityBookRoute) {
    swapData = encodeFunctionData({
      abi: liquidityBookRouterAbi,
      functionName: "swapExactTokensForTokens",
      args: [
        args.amountIn,
        amountOutMinimum,
        {
          pairBinSteps: [BigInt(liquidityBookRoute.binStep)],
          versions: [liquidityBookRoute.version],
          tokenPath: [args.tokenIn, args.tokenOut],
        },
        args.recipient,
        BigInt(Math.floor(Date.now() / 1000) + 120),
      ],
    });
  } else if (kind === "syncswap-v1" && syncSwapStepData) {
    swapData = encodeFunctionData({
      abi: syncSwapV1RouterAbi,
      functionName: "swap",
      args: [
        [{
          steps: [{
            pool: args.poolAddress,
            data: syncSwapStepData,
            callback: "0x0000000000000000000000000000000000000000",
            callbackData: "0x",
          }],
          tokenIn: args.tokenIn,
          amountIn: args.amountIn,
        }],
        amountOutMinimum,
        BigInt(Math.floor(Date.now() / 1000) + 120),
      ],
    });
  } else if (kind === "algebra-v1.9") {
    swapData = encodeFunctionData({
      abi: algebraSwapRouterAbi,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        recipient: args.recipient,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
        amountIn: args.amountIn,
        amountOutMinimum,
        limitSqrtPrice: 0n,
      }],
    });
  } else if (kind === "curve-pool" && curveRoute) {
    swapData = encodeFunctionData({
      abi: curveRoute.indexKind === "int128" ? curvePoolAbi : curvePoolUintAbi,
      functionName: "exchange",
      args: [BigInt(curveRoute.i), BigInt(curveRoute.j), args.amountIn, amountOutMinimum],
    });
  } else if (kind === "balancer-v2" && balancerPoolId) {
    swapData = encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "swap",
      args: [
        {
          poolId: balancerPoolId,
          kind: 0,
          assetIn: args.tokenIn,
          assetOut: args.tokenOut,
          amount: args.amountIn,
          userData: "0x",
        },
        {
          sender: args.recipient,
          fromInternalBalance: false,
          recipient: args.recipient,
          toInternalBalance: false,
        },
        amountOutMinimum,
        BigInt(Math.floor(Date.now() / 1000) + 120),
      ],
    });
  } else if (kind === "univ2") {
    swapData = encodeFunctionData({
          abi: uniswapV2RouterAbi,
          functionName: "swapExactTokensForTokens",
          args: [
            args.amountIn,
            amountOutMinimum,
            [args.tokenIn, args.tokenOut],
            args.recipient,
            BigInt(Math.floor(Date.now() / 1000) + 120),
          ],
        });
  } else if (kind === "univ3-quoter-v2-router02") {
    swapData = encodeFunctionData({
      abi: uniswapV3SwapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: await readPoolFee(client, args.poolAddress),
          recipient: args.recipient,
          amountIn: args.amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  } else {
    swapData = encodeFunctionData({
          abi: uniswapV3SwapRouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: args.tokenIn,
              tokenOut: args.tokenOut,
              fee: await readPoolFee(client, args.poolAddress),
              recipient: args.recipient,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
              amountIn: args.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
  }

  return {
    legs: [
      { target: args.tokenIn, data: approveData },
      { target: router, data: swapData },
    ],
    amountOutMinimum,
    quotedOut,
  };
}

async function quoteGenericCurve(
  client: PublicClient,
  chainId: number,
  pool: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
): Promise<{ amountOut: bigint; i: number; j: number; indexKind: "int128" | "uint256" }> {
  const key = `${chainId}:${pool.toLowerCase()}`;
  let coins = curveCoinCache.get(key);
  if (!coins) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      client.readContract({ address: pool, abi: curvePoolCoinsAbi, functionName: "coins", args: [BigInt(index)] }) as Promise<string>,
    ));
    coins = results.flatMap((result) => result.status === "fulfilled" ? [result.value.toLowerCase()] : []);
    if (coins.length < 2) throw new Error("Curve coin discovery failed");
    curveCoinCache.set(key, coins);
  }
  const i = coins.indexOf(tokenIn.toLowerCase());
  const j = coins.indexOf(tokenOut.toLowerCase());
  if (i < 0 || j < 0 || i === j) throw new Error("Curve pair token mismatch");
  const quoteAs = async (indexKind: "int128" | "uint256") => client.readContract({
    address: pool,
    abi: indexKind === "int128" ? curvePoolAbi : curvePoolUintAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), amountIn],
  });
  const cachedKind = curveIndexKindCache.get(key);
  if (cachedKind) return { amountOut: await quoteAs(cachedKind), i, j, indexKind: cachedKind };
  try {
    const amountOut = await quoteAs("int128");
    curveIndexKindCache.set(key, "int128");
    return { amountOut, i, j, indexKind: "int128" };
  } catch {
    const amountOut = await quoteAs("uint256");
    curveIndexKindCache.set(key, "uint256");
    return { amountOut, i, j, indexKind: "uint256" };
  }
}

async function quoteV2(
  client: PublicClient,
  router: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
): Promise<bigint | null> {
  const amounts = await client.readContract({
    address: router,
    abi: uniswapV2RouterAbi,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut]],
  });
  return amounts[1] ?? null;
}

async function quoteV3(
  client: PublicClient,
  dex: SupportedDex,
  chainId: number,
  poolAddress: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  kind: "univ3-quoter-v1" | "univ3-quoter-v2" | "univ3-quoter-v2-router02",
): Promise<bigint | null> {
  const quoter = quoterFor(dex, chainId);
  if (!quoter) return null;
  const fee = await readPoolFee(client, poolAddress);

  if (kind === "univ3-quoter-v1") {
    return client.readContract({
      address: quoter,
      abi: uniswapV3QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [tokenIn, tokenOut, fee, amountIn, 0n],
    });
  }

  const [amountOut] = await client.readContract({
    address: quoter,
    abi: uniswapV3QuoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return amountOut;
}

async function readPoolFee(client: PublicClient, poolAddress: `0x${string}`): Promise<number> {
  return client.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "fee" });
}

async function readDecimals(client: PublicClient, token: `0x${string}`): Promise<number | null> {
  try {
    return await client.readContract({
      address: token,
      abi: [
        {
          type: "function",
          name: "decimals",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint8" }],
        },
      ] as const,
      functionName: "decimals",
    });
  } catch (err) {
    logger.warn({ err, token }, "failed to read quote token decimals");
    return null;
  }
}
