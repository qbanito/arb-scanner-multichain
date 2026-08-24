/// Read-only DEX quoting for the liquidation "strategy" detail endpoint —
/// how much of the debt asset a real swap of the seized collateral would
/// actually produce right now, across every venue the execution bot
/// supports, splitting across several venues when no single one has enough
/// depth. Quote-only: this never builds swap calldata (api-server never
/// holds a private key and never sends transactions), it only answers
/// "is there a route, and how much would it really return".
///
/// Addresses are the SAME verified set as artifacts/executor-bot/src/
/// dexRegistry.ts + curveRegistry.ts (Uniswap V3 SwapRouter/Quoter deploys,
/// Sushiswap's V3 fork and classic V2 fork, Camelot's AMMv2, Curve's 3pool)
/// — kept consistent rather than re-verified independently, same pattern
/// already used for KNOWN_ASSETS in this file's sibling aave.ts.
import type { PublicClient } from "viem";

type SupportedDex = "uniswap-v3" | "sushiswap-v3" | "sushiswap-v2" | "camelot-v2";
type Addresses = { router: `0x${string}`; quoter?: `0x${string}` };

const DEX_CONTRACTS: Record<SupportedDex, Record<number, Addresses>> = {
  "uniswap-v3": {
    1: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
    42161: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
  },
  "sushiswap-v3": {
    42161: { router: "0x8A21F6768C1f8075791D08546Dadf6daA0bE820c", quoter: "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1" },
  },
  "sushiswap-v2": {
    1: { router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" },
    42161: { router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  },
  "camelot-v2": {
    42161: { router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d" },
  },
};

// Same curated, individually-verified pool set as executor-bot's
// curveRegistry.ts — direct pools only, no multi-hop bridging (a real DOLA
// bridge was investigated and found to have no usable second hop to USDC;
// see the liquidations detail work this mirrors).
const CURVE_POOLS: Record<number, { pool: `0x${string}`; coins: readonly `0x${string}`[] }[]> = {
  1: [
    {
      pool: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", // 3pool: DAI/USDC/USDT
      coins: ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
    },
  ],
  42161: [],
};

function findCurvePool(chainId: number, tokenA: `0x${string}`, tokenB: `0x${string}`): { pool: `0x${string}`; i: number; j: number } | null {
  for (const p of CURVE_POOLS[chainId] ?? []) {
    const i = p.coins.findIndex((c) => c.toLowerCase() === tokenA.toLowerCase());
    const j = p.coins.findIndex((c) => c.toLowerCase() === tokenB.toLowerCase());
    if (i !== -1 && j !== -1 && i !== j) return { pool: p.pool, i, j };
  }
  return null;
}

const FEE_TIERS = [500, 3000, 10000] as const;
const FEE_TIERED_DEXES: readonly ("uniswap-v3" | "sushiswap-v3")[] = ["uniswap-v3", "sushiswap-v3"];
const V2_STYLE_DEXES: readonly ("sushiswap-v2" | "camelot-v2")[] = ["sushiswap-v2", "camelot-v2"];

const uniswapV3QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const uniswapV3QuoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const uniswapV2RouterAbi = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const curvePoolAbi = [
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "dy", type: "uint256" }],
  },
] as const;

type VenueCandidate =
  | { dex: "uniswap-v3" | "sushiswap-v3"; quoter: `0x${string}`; fee: number }
  | { dex: "sushiswap-v2" | "camelot-v2"; router: `0x${string}` }
  | { dex: "curve"; pool: `0x${string}`; i: number; j: number };

function listCandidates(chainId: number, tokenIn: `0x${string}`, tokenOut: `0x${string}`): VenueCandidate[] {
  const candidates: VenueCandidate[] = [];
  for (const dex of FEE_TIERED_DEXES) {
    const quoter = DEX_CONTRACTS[dex][chainId]?.quoter;
    if (!quoter) continue;
    for (const fee of FEE_TIERS) candidates.push({ dex, quoter, fee });
  }
  for (const dex of V2_STYLE_DEXES) {
    const router = DEX_CONTRACTS[dex][chainId]?.router;
    if (router) candidates.push({ dex, router });
  }
  const curve = findCurvePool(chainId, tokenIn, tokenOut);
  if (curve) candidates.push({ dex: "curve", pool: curve.pool, i: curve.i, j: curve.j });
  return candidates;
}

async function quoteVenue(client: PublicClient, candidate: VenueCandidate, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<bigint | null> {
  try {
    switch (candidate.dex) {
      case "uniswap-v3":
        return await client.readContract({ address: candidate.quoter, abi: uniswapV3QuoterAbi, functionName: "quoteExactInputSingle", args: [tokenIn, tokenOut, candidate.fee, amountIn, 0n] });
      case "sushiswap-v3":
        return (await client.readContract({ address: candidate.quoter, abi: uniswapV3QuoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: candidate.fee, sqrtPriceLimitX96: 0n }] }))[0];
      case "sushiswap-v2":
      case "camelot-v2": {
        const amounts = await client.readContract({ address: candidate.router, abi: uniswapV2RouterAbi, functionName: "getAmountsOut", args: [amountIn, [tokenIn, tokenOut]] });
        return amounts[1] ?? null;
      }
      case "curve":
        return await client.readContract({ address: candidate.pool, abi: curvePoolAbi, functionName: "get_dy", args: [BigInt(candidate.i), BigInt(candidate.j), amountIn] });
    }
  } catch {
    return null;
  }
}

export type BestQuote = { dex: string; quotedOut: bigint; venueCount: number };

const MAX_VENUE_IMPACT_BPS = 300n; // 3%, same bound as executor-bot's live route builder
const EXPANSION_ITERATIONS = 5; // 4^5 ≈ 1024x growth from the probe — covers the full probe-to-amountIn range (probe is amountIn/1000)
const BISECTION_ITERATIONS = 5; // resolves the bracket the expansion phase lands on to ~1/32 of its width

type VenueCapacity = { candidate: VenueCandidate; maxAmount: bigint; rateNum: bigint; rateDen: bigint };

/// Whether `quotedOut` for the full `amountIn` is still within
/// MAX_VENUE_IMPACT_BPS of this same venue's own near-zero-size rate — a
/// severely drained pool quotes successfully, just badly, so a raw
/// "did it not revert" check would silently accept it as the winner.
async function isWithinOwnBaselineRate(
  client: PublicClient,
  candidate: VenueCandidate,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  quotedOut: bigint,
): Promise<boolean> {
  const probeAmount = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
  if (probeAmount >= amountIn) return true;
  const probeOut = await quoteVenue(client, candidate, tokenIn, tokenOut, probeAmount);
  if (probeOut === null || probeOut === 0n) return true;
  return quotedOut * probeAmount * 10_000n >= probeOut * amountIn * (10_000n - MAX_VENUE_IMPACT_BPS);
}

/// See liquidationRouteBuilder.ts's findVenueCapacity for why this is a
/// two-phase (exponential-expansion then bisection) search rather than a
/// single bisection from [probe, amountIn] — that undershoots badly when
/// the probe is 1000x smaller than amountIn, which it always is here.
async function findVenueCapacity(client: PublicClient, candidate: VenueCandidate, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<VenueCapacity | null> {
  const probeAmount = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
  const probeOut = await quoteVenue(client, candidate, tokenIn, tokenOut, probeAmount);
  if (probeOut === null || probeOut === 0n) return null;

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
    const out = await quoteVenue(client, candidate, tokenIn, tokenOut, step);
    if (out !== null && withinTolerance(step, out)) {
      lo = step;
      bestOut = out;
      if (step >= amountIn) break;
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
      const out = await quoteVenue(client, candidate, tokenIn, tokenOut, mid);
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

/// Tries every supported venue for this chain and returns the single best
/// real quote for the whole amount when one venue can fill it. When none
/// can, splits the trade across whichever venues have real (if partial)
/// depth — same two-phase approach as executor-bot's liquidationRouteBuilder
/// .ts, kept in sync deliberately (this file exists only because api-server
/// runs in a separate process with no wallet/execution context, not because
/// the logic should differ).
export async function bestSellQuote(client: PublicClient, chainId: number, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<BestQuote | null> {
  const candidates = listCandidates(chainId, tokenIn, tokenOut);

  let best: { candidate: VenueCandidate; quotedOut: bigint } | null = null;
  for (const candidate of candidates) {
    const quotedOut = await quoteVenue(client, candidate, tokenIn, tokenOut, amountIn);
    if (quotedOut !== null && (best === null || quotedOut > best.quotedOut)) best = { candidate, quotedOut };
  }
  if (best && (await isWithinOwnBaselineRate(client, best.candidate, tokenIn, tokenOut, amountIn, best.quotedOut))) {
    return { dex: best.candidate.dex, quotedOut: best.quotedOut, venueCount: 1 };
  }

  // Either nothing quoted the full amount, or the one that did is quietly a
  // bad trade (a near-drained pool doesn't revert, it just returns a
  // terrible rate) — probe each venue group cheaply, binary-search the
  // winner's real capacity, then greedily allocate the full amount across
  // them by best rate first.
  const probeAmount = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
  const representativeByGroup = new Map<string, { candidate: VenueCandidate; probeOut: bigint }>();
  for (const candidate of candidates) {
    const probeOut = await quoteVenue(client, candidate, tokenIn, tokenOut, probeAmount);
    if (probeOut === null) continue;
    const existing = representativeByGroup.get(candidate.dex);
    if (!existing || probeOut > existing.probeOut) representativeByGroup.set(candidate.dex, { candidate, probeOut });
  }

  const capacities: VenueCapacity[] = [];
  for (const { candidate } of representativeByGroup.values()) {
    const capacity = await findVenueCapacity(client, candidate, tokenIn, tokenOut, amountIn);
    if (capacity) capacities.push(capacity);
  }
  if (capacities.length === 0) return null;

  capacities.sort((a, b) => {
    const left = a.rateNum * b.rateDen;
    const right = b.rateNum * a.rateDen;
    return left > right ? -1 : left < right ? 1 : 0;
  });

  let remaining = amountIn;
  let totalQuotedOut = 0n;
  let venuesUsed = 0;
  for (const cap of capacities) {
    if (remaining === 0n) break;
    const take = cap.maxAmount < remaining ? cap.maxAmount : remaining;
    if (take === 0n) continue;
    const preciseOut = await quoteVenue(client, cap.candidate, tokenIn, tokenOut, take);
    if (preciseOut === null) continue;
    totalQuotedOut += preciseOut;
    remaining -= take;
    venuesUsed++;
  }
  if (remaining > 0n) return null; // combined venue depth still isn't enough

  return { dex: `split across ${venuesUsed} venues`, quotedOut: totalQuotedOut, venueCount: venuesUsed };
}
