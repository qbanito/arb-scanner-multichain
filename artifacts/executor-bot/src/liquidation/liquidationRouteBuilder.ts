import { type PublicClient, encodeFunctionData } from "viem";
import { curvePoolAbi, erc20Abi, uniswapV2RouterAbi, uniswapV3QuoterAbi, uniswapV3QuoterV2Abi, uniswapV3SwapRouterAbi } from "../abis";
import { findCurvePool } from "../curveRegistry";
import { quoterFor, routerFor } from "../dexRegistry";
import { logger } from "../logger";
import type { Leg } from "../routeBuilder";
import { aaveDataProviderAbi, aaveOracleAbi, aavePoolWriteAbi } from "./aaveAbis";

export type LiquidationRoute = {
  legs: Leg[];
  asset: `0x${string}`; // debt asset — also the flash-borrowed asset
  amountIn: bigint; // debtToCover
  estimatedGrossProfit: bigint; // in `asset` units, before gas
  assetDecimals: number;
  /// USD value of estimatedGrossProfit, computed from the same Aave oracle
  /// price already read to size this route — not a separate Chainlink feed
  /// lookup. This covers every asset Aave itself prices (i.e. every asset in
  /// knownAssets.ts), which priceOracle.ts's small hand-maintained Chainlink
  /// feed list does not. See gasGuard.ts for how this is weighed against gas
  /// cost before a trade is sent.
  estimatedGrossProfitUsd: number;
  /// How many separate venues the collateral-sell leg was split across.
  /// 1 means a single venue absorbed the whole trade (the common case); >1
  /// means no single venue had enough depth and the sale was divided to
  /// keep each slice's price impact bounded — see splitSellAcrossVenues.
  sellVenueCount: number;
};

type SkipReason = "same-asset-no-swap-route" | "no-liquidity-pool-for-collateral" | "price-read-failed";

export type LiquidationRouteResult = { ok: true; route: LiquidationRoute } | { ok: false; reason: SkipReason };

// Standard Uniswap/Sushiswap V3-style fee tiers — tried in order since
// there's no guaranteed pool for an arbitrary collateral/debt pair; each is a
// real on-chain check via the Quoter (reverts cleanly if that tier's pool
// doesn't exist).
const FEE_TIERS = [500, 3000, 10000] as const;

// Every venue this bot knows how to route a swap through (see
// dexRegistry.ts) — tried for every liquidation's collateral-sell leg, not
// just Uniswap V3. A collateral asset with no Uniswap V3 pool but real
// liquidity on Sushiswap or Camelot was previously an unbuildable route
// (skip: no-liquidity-pool-for-collateral) purely because we never asked.
const FEE_TIERED_DEXES: readonly ("uniswap-v3" | "sushiswap-v3")[] = ["uniswap-v3", "sushiswap-v3"];
const V2_STYLE_DEXES: readonly ("sushiswap-v2" | "camelot-v2")[] = ["sushiswap-v2", "camelot-v2"];

export async function buildLiquidationRoute(
  client: PublicClient,
  params: {
    chainId: number;
    /// Which Aave market to build against — a chain can have several
    /// isolated markets (see aaveRegistry.ts), each with its own Pool/
    /// Oracle/DataProvider, so the caller resolves and passes these rather
    /// than this function guessing "the" market for a chain.
    pool: `0x${string}`;
    oracle: `0x${string}`;
    dataProvider: `0x${string}`;
    executorAddress: `0x${string}`;
    user: `0x${string}`;
    debtAsset: `0x${string}`;
    debtDecimals: number;
    collateralAsset: `0x${string}`;
    collateralDecimals: number;
    debtToCover: bigint;
    slippageBps: number;
    /// Reads Aave price/config and the Uniswap quote as of this historical
    /// block instead of the chain tip. Only used by backtestLiquidations.ts
    /// — omit (or leave undefined) for the live trading path, which always
    /// wants the current block.
    blockNumber?: bigint;
  },
): Promise<LiquidationRouteResult> {
  const { pool, oracle, dataProvider } = params;

  let debtPrice: bigint, collateralPrice: bigint, collateralConfig: readonly [bigint, bigint, bigint, bigint, ...unknown[]], baseCurrencyUnit: bigint;
  try {
    [debtPrice, collateralPrice, collateralConfig, baseCurrencyUnit] = await Promise.all([
      client.readContract({ address: oracle, abi: aaveOracleAbi, functionName: "getAssetPrice", args: [params.debtAsset], blockNumber: params.blockNumber }),
      client.readContract({
        address: oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [params.collateralAsset],
        blockNumber: params.blockNumber,
      }),
      client.readContract({
        address: dataProvider,
        abi: aaveDataProviderAbi,
        functionName: "getReserveConfigurationData",
        args: [params.collateralAsset],
        blockNumber: params.blockNumber,
      }),
      client.readContract({ address: oracle, abi: aaveOracleAbi, functionName: "BASE_CURRENCY_UNIT", blockNumber: params.blockNumber }),
    ]);
  } catch (err) {
    logger.warn({ err }, "failed to read Aave oracle/config for liquidation route");
    return { ok: false, reason: "price-read-failed" };
  }

  // debtPrice is USD-per-whole-token scaled by baseCurrencyUnit (1e8 on both
  // markets we support, but read live rather than assumed) — this is the
  // same price already used above to size expectedCollateral, just also
  // expressed in USD for the profitability gate.
  const profitUsdOf = (amount: bigint): number => (Number(amount) / 10 ** params.debtDecimals) * (Number(debtPrice) / Number(baseCurrencyUnit));

  const liquidationBonusBps = collateralConfig[3]; // e.g. 10500 == 5% bonus
  // Value of collateral seized = debt repaid (in USD-ish base units) * bonus.
  // Convert through each asset's own decimals since debt/collateral tokens
  // can differ (e.g. repay USDC, seize WETH).
  const debtValueBase = (params.debtToCover * debtPrice) / 10n ** BigInt(params.debtDecimals);
  const collateralValueBase = (debtValueBase * liquidationBonusBps) / 10_000n;
  const expectedCollateral = (collateralValueBase * 10n ** BigInt(params.collateralDecimals)) / collateralPrice;

  const legs: Leg[] = [
    {
      target: params.debtAsset,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, params.debtToCover] }),
    },
    {
      target: pool,
      data: encodeFunctionData({
        abi: aavePoolWriteAbi,
        functionName: "liquidationCall",
        args: [params.collateralAsset, params.debtAsset, params.user, params.debtToCover, false],
      }),
    },
  ];

  if (params.collateralAsset.toLowerCase() === params.debtAsset.toLowerCase()) {
    // Same-asset liquidation (collateral and debt are the same token) —
    // nothing to swap, the seized amount already repays the flash loan.
    const estimatedGrossProfit = expectedCollateral - params.debtToCover;
    return {
      ok: true,
      route: {
        legs,
        asset: params.debtAsset,
        amountIn: params.debtToCover,
        estimatedGrossProfit,
        assetDecimals: params.debtDecimals,
        estimatedGrossProfitUsd: profitUsdOf(estimatedGrossProfit),
        sellVenueCount: 0,
      },
    };
  }

  const sellLeg = await buildCollateralSellLeg(client, {
    chainId: params.chainId,
    tokenIn: params.collateralAsset,
    tokenOut: params.debtAsset,
    amountIn: expectedCollateral,
    recipient: params.executorAddress,
    slippageBps: params.slippageBps,
    blockNumber: params.blockNumber,
  });
  if (!sellLeg) return { ok: false, reason: "no-liquidity-pool-for-collateral" };

  const estimatedGrossProfit = sellLeg.quotedOut - params.debtToCover;
  return {
    ok: true,
    route: {
      legs: [...legs, ...sellLeg.legs],
      asset: params.debtAsset,
      amountIn: params.debtToCover,
      estimatedGrossProfit,
      assetDecimals: params.debtDecimals,
      estimatedGrossProfitUsd: profitUsdOf(estimatedGrossProfit),
      sellVenueCount: sellLeg.venueCount,
    },
  };
}

/// One concrete, quotable/tradeable venue for a specific tokenIn/tokenOut
/// pair — a fee tier for V3-style venues, or coin indices for Curve. This is
/// the unit both the "try the whole amount on one venue" fast path and the
/// "split across several venues" fallback operate on, so both paths quote
/// and build calldata identically instead of duplicating the logic twice.
type VenueCandidate =
  | { dex: "uniswap-v3" | "sushiswap-v3"; router: `0x${string}`; quoter: `0x${string}`; fee: number }
  | { dex: "sushiswap-v2" | "camelot-v2"; router: `0x${string}` }
  | { dex: "curve"; pool: `0x${string}`; i: number; j: number };

function venueLabel(candidate: VenueCandidate): string {
  return candidate.dex === "uniswap-v3" || candidate.dex === "sushiswap-v3" ? `${candidate.dex}:${candidate.fee}` : candidate.dex === "curve" ? `curve:${candidate.pool}` : candidate.dex;
}

/// Every venue that *could* have a pool for this pair, purely from the
/// registries (dexRegistry.ts, curveRegistry.ts) — no RPC calls yet.
function listCandidates(chainId: number, tokenIn: `0x${string}`, tokenOut: `0x${string}`): VenueCandidate[] {
  const candidates: VenueCandidate[] = [];
  for (const dex of FEE_TIERED_DEXES) {
    const router = routerFor(dex, chainId);
    const quoter = quoterFor(dex, chainId);
    if (!router || !quoter) continue;
    for (const fee of FEE_TIERS) candidates.push({ dex, router, quoter, fee });
  }
  for (const dex of V2_STYLE_DEXES) {
    const router = routerFor(dex, chainId);
    if (router) candidates.push({ dex, router });
  }
  const curve = findCurvePool(chainId, tokenIn, tokenOut);
  if (curve) candidates.push({ dex: "curve", pool: curve.pool, i: curve.i, j: curve.j });
  return candidates;
}

/// Real on-chain quote for exactly `amountIn` of tokenIn -> tokenOut through
/// this one venue. `null` means the venue can't fill this (no pool, or this
/// amount reverts against it) — never a guessed/estimated number.
async function quoteVenue(
  client: PublicClient,
  candidate: VenueCandidate,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    switch (candidate.dex) {
      case "uniswap-v3":
        return await client.readContract({
          address: candidate.quoter,
          abi: uniswapV3QuoterAbi,
          blockNumber,
          functionName: "quoteExactInputSingle",
          args: [tokenIn, tokenOut, candidate.fee, amountIn, 0n],
        });
      case "sushiswap-v3": {
        const [amountOut] = await client.readContract({
          address: candidate.quoter,
          abi: uniswapV3QuoterV2Abi,
          blockNumber,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee: candidate.fee, sqrtPriceLimitX96: 0n }],
        });
        return amountOut;
      }
      case "sushiswap-v2":
      case "camelot-v2": {
        const amounts = await client.readContract({
          address: candidate.router,
          abi: uniswapV2RouterAbi,
          blockNumber,
          functionName: "getAmountsOut",
          args: [amountIn, [tokenIn, tokenOut]],
        });
        return amounts[1] ?? null;
      }
      case "curve":
        return await client.readContract({
          address: candidate.pool,
          abi: curvePoolAbi,
          blockNumber,
          functionName: "get_dy",
          args: [BigInt(candidate.i), BigInt(candidate.j), amountIn],
        });
    }
  } catch {
    // No pool at this tier/venue, or this amount is more than it can fill —
    // expected for most candidates, not an error.
    return null;
  }
}

/// Builds the [approve, swap] legs to actually sell `amountIn` through this
/// venue, with `amountOutMinimum` as the on-chain slippage floor.
function buildSwapLegs(
  candidate: VenueCandidate,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: `0x${string}`,
): Leg[] {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const target = candidate.dex === "curve" ? candidate.pool : candidate.router;

  const swapData =
    candidate.dex === "uniswap-v3" || candidate.dex === "sushiswap-v3"
      ? encodeFunctionData({
          abi: uniswapV3SwapRouterAbi,
          functionName: "exactInputSingle",
          args: [{ tokenIn, tokenOut, fee: candidate.fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
        })
      : candidate.dex === "curve"
        ? encodeFunctionData({ abi: curvePoolAbi, functionName: "exchange", args: [BigInt(candidate.i), BigInt(candidate.j), amountIn, amountOutMinimum] })
        : encodeFunctionData({
            abi: uniswapV2RouterAbi,
            functionName: "swapExactTokensForTokens",
            args: [amountIn, amountOutMinimum, [tokenIn, tokenOut], recipient, deadline],
          });

  return [
    { target: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, amountIn] }) },
    { target, data: swapData },
  ];
}

async function buildCollateralSellLeg(
  client: PublicClient,
  args: {
    chainId: number;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    recipient: `0x${string}`;
    slippageBps: number;
    blockNumber?: bigint;
  },
): Promise<{ legs: Leg[]; quotedOut: bigint; venueCount: number } | null> {
  const candidates = listCandidates(args.chainId, args.tokenIn, args.tokenOut);

  // Fast path: can any single venue fill the whole trade? This is the
  // common case (small/medium liquidations) and was the only path before —
  // unchanged cost, unchanged behavior, sequential RPC (never Promise.all —
  // see the 429 incident notes elsewhere in this codebase for why).
  let best: { candidate: VenueCandidate; quotedOut: bigint } | null = null;
  for (const candidate of candidates) {
    const quotedOut = await quoteVenue(client, candidate, args.tokenIn, args.tokenOut, args.amountIn, args.blockNumber);
    if (quotedOut !== null && (best === null || quotedOut > best.quotedOut)) best = { candidate, quotedOut };
  }

  if (best && (await isWithinOwnBaselineRate(client, best.candidate, args.tokenIn, args.tokenOut, args.amountIn, best.quotedOut, args.blockNumber))) {
    const amountOutMinimum = (best.quotedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
    return {
      legs: buildSwapLegs(best.candidate, args.tokenIn, args.tokenOut, args.amountIn, amountOutMinimum, args.recipient),
      quotedOut: amountOutMinimum,
      venueCount: 1,
    };
  }

  // Either no single venue could quote the whole trade at all, or the one
  // that did is quietly a bad trade (a near-drained pool doesn't revert, it
  // just returns a terrible rate — a raw "did it not revert" check would
  // silently accept e.g. a pool giving back 4% of fair value on a large
  // trade). Either way, fall back to splitting across whichever venues have
  // real depth instead of taking that bad quote or giving up. Only reached
  // for genuinely large trades, so the extra RPC cost here is paid rarely,
  // not on every candidate in a scan tick.
  logger.debug({ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn.toString() }, "no single venue has a fair-rate fit — trying a split sell across venues");
  return splitSellAcrossVenues(client, candidates, args);
}

/// Whether `quotedOut` for the full `amountIn` is still within
/// MAX_VENUE_IMPACT_BPS of this same venue's own near-zero-size rate — the
/// same bar findVenueCapacity holds every split allocation to, applied here
/// to the "one venue takes it all" fast path so a severely drained pool
/// (which quotes successfully, just badly) doesn't get accepted just
/// because it didn't revert.
async function isWithinOwnBaselineRate(
  client: PublicClient,
  candidate: VenueCandidate,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  quotedOut: bigint,
  blockNumber?: bigint,
): Promise<boolean> {
  const probeAmount = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
  if (probeAmount >= amountIn) return true; // amountIn already this small — nothing to compare against
  const probeOut = await quoteVenue(client, candidate, tokenIn, tokenOut, probeAmount, blockNumber);
  if (probeOut === null || probeOut === 0n) return true; // can't establish a baseline — don't block on it
  // quotedOut/amountIn >= probeOut/probeAmount * (1 - MAX_VENUE_IMPACT_BPS/10000)
  return quotedOut * probeAmount * 10_000n >= probeOut * amountIn * (10_000n - MAX_VENUE_IMPACT_BPS);
}

const MAX_VENUE_IMPACT_BPS = 300n; // 3% — how far a venue's rate may drop from its own near-zero-size rate before we stop allocating more volume to it and route the rest elsewhere
const EXPANSION_ITERATIONS = 5; // 4^5 ≈ 1024x growth from the probe — covers the full probe-to-amountIn range (probe is amountIn/1000)
const BISECTION_ITERATIONS = 5; // resolves the bracket the expansion phase lands on to ~1/32 of its width

type VenueCapacity = { candidate: VenueCandidate; maxAmount: bigint; rateNum: bigint; rateDen: bigint };

/// Finds the largest amount this one venue can take while its effective
/// rate stays within MAX_VENUE_IMPACT_BPS of its own small-size rate — i.e.
/// "how much can we sell here before the price moves too much", determined
/// from real on-chain quotes, not an estimate.
///
/// Two phases rather than a single bisection from [probe, amountIn]: the
/// probe is deliberately amountIn/1000, so a plain bisection starting that
/// wide needs ~10 iterations just to resolve a 1000x range, and 6 was not
/// enough — it silently returned capacity far below the real figure. First
/// exponentially grow from the probe (4x per step) to land a *tight*
/// bracket around the real boundary, then bisect only that.
async function findVenueCapacity(
  client: PublicClient,
  candidate: VenueCandidate,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<VenueCapacity | null> {
  const probeAmount = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
  const probeOut = await quoteVenue(client, candidate, tokenIn, tokenOut, probeAmount, blockNumber);
  if (probeOut === null || probeOut === 0n) return null;

  // A candidate amount `amt` is "within tolerance" when
  // out(amt)/amt >= probeOut/probeAmount * (1 - MAX_VENUE_IMPACT_BPS/10000).
  // Cross-multiplied to stay in integer bigint math throughout.
  const minRateNum = probeOut * (10_000n - MAX_VENUE_IMPACT_BPS);
  const minRateDen = probeAmount * 10_000n;
  const withinTolerance = (amt: bigint, out: bigint) => out * minRateDen >= amt * minRateNum;

  let lo = probeAmount;
  let bestOut = probeOut;
  let hi = amountIn;
  let needsBisection = false;

  let step = probeAmount;
  for (let i = 0; i < EXPANSION_ITERATIONS; i++) {
    step = step * 4n < amountIn ? step * 4n : amountIn;
    const out = await quoteVenue(client, candidate, tokenIn, tokenOut, step, blockNumber);
    if (out !== null && withinTolerance(step, out)) {
      lo = step;
      bestOut = out;
      if (step >= amountIn) break; // whole trade fits at this venue alone
    } else {
      hi = step;
      needsBisection = true;
      break;
    }
    if (step >= amountIn) break;
  }

  if (needsBisection) {
    for (let i = 0; i < BISECTION_ITERATIONS && hi > lo; i++) {
      const mid = lo + (hi - lo) / 2n;
      if (mid <= lo) break;
      const out = await quoteVenue(client, candidate, tokenIn, tokenOut, mid, blockNumber);
      if (out !== null && withinTolerance(mid, out)) {
        lo = mid;
        bestOut = out;
      } else {
        hi = mid;
      }
    }
  }

  return { candidate, maxAmount: lo, rateNum: bestOut, rateDen: lo };
}

/// Splits `args.amountIn` across the best available venues instead of
/// requiring one to take it all. For fee-tiered DEXes, first probes each
/// tier cheaply to find the one with any real depth at all, then only
/// binary-searches that winner — keeps the worst-case RPC cost bounded
/// (roughly one probe pass + a handful of binary-search calls per venue
/// group, all sequential) rather than searching every fee tier fully.
async function splitSellAcrossVenues(
  client: PublicClient,
  candidates: VenueCandidate[],
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; recipient: `0x${string}`; slippageBps: number; blockNumber?: bigint },
): Promise<{ legs: Leg[]; quotedOut: bigint; venueCount: number } | null> {
  const probeAmount = args.amountIn / 1000n > 0n ? args.amountIn / 1000n : args.amountIn;

  // One representative candidate per venue group — for fee-tiered DEXes,
  // whichever tier gives the best small-size quote (picked from a cheap
  // probe, not the earlier full-amount attempt which reverted for all of
  // them by definition of reaching this function).
  const representativeByGroup = new Map<string, { candidate: VenueCandidate; probeOut: bigint }>();
  for (const candidate of candidates) {
    const group = candidate.dex;
    const probeOut = await quoteVenue(client, candidate, args.tokenIn, args.tokenOut, probeAmount, args.blockNumber);
    if (probeOut === null) continue;
    const existing = representativeByGroup.get(group);
    if (!existing || probeOut > existing.probeOut) representativeByGroup.set(group, { candidate, probeOut });
  }

  const capacities: VenueCapacity[] = [];
  for (const { candidate } of representativeByGroup.values()) {
    const capacity = await findVenueCapacity(client, candidate, args.tokenIn, args.tokenOut, args.amountIn, args.blockNumber);
    if (capacity) capacities.push(capacity);
  }
  if (capacities.length === 0) return null;

  // Greedy: fill from the best-rate venue down, capped at each venue's own
  // capacity, until the full amount is allocated or venues run out.
  capacities.sort((a, b) => {
    const left = a.rateNum * b.rateDen;
    const right = b.rateNum * a.rateDen;
    return left > right ? -1 : left < right ? 1 : 0;
  });

  let remaining = args.amountIn;
  const allocations: { candidate: VenueCandidate; amount: bigint }[] = [];
  for (const cap of capacities) {
    if (remaining === 0n) break;
    const take = cap.maxAmount < remaining ? cap.maxAmount : remaining;
    if (take === 0n) continue;
    allocations.push({ candidate: cap.candidate, amount: take });
    remaining -= take;
  }
  if (remaining > 0n) {
    // Combined depth across every venue we know about still isn't enough.
    logger.debug({ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn.toString(), remaining: remaining.toString() }, "split sell still short — combined venue liquidity insufficient");
    return null;
  }

  const legs: Leg[] = [];
  let totalQuotedOut = 0n;
  for (const alloc of allocations) {
    // Re-quote precisely at the exact allocated amount — the binary search
    // above only found a *bound* that stays within tolerance, not this
    // trade's exact output.
    const preciseOut = await quoteVenue(client, alloc.candidate, args.tokenIn, args.tokenOut, alloc.amount, args.blockNumber);
    if (preciseOut === null) {
      logger.warn({ venue: venueLabel(alloc.candidate) }, "split sell: allocated venue stopped quoting between capacity search and final quote — aborting route");
      return null;
    }
    const amountOutMinimum = (preciseOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
    legs.push(...buildSwapLegs(alloc.candidate, args.tokenIn, args.tokenOut, alloc.amount, amountOutMinimum, args.recipient));
    totalQuotedOut += amountOutMinimum;
  }

  logger.info(
    { tokenIn: args.tokenIn, tokenOut: args.tokenOut, venues: allocations.map((a) => venueLabel(a.candidate)) },
    "collateral sell split across multiple venues",
  );

  return { legs, quotedOut: totalQuotedOut, venueCount: allocations.length };
}
