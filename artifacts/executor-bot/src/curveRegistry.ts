/// Curated set of verified Curve StableSwap pools this bot knows how to
/// quote/route through directly — deliberately NOT a generic Curve
/// registry/factory lookup (that would mean trusting whatever pool the
/// factory returns at execution time, unverified) and deliberately NOT
/// multi-hop (no bridging through an intermediate asset like DOLA or sDAI —
/// see liquidationRouteBuilder.ts's split-sell logic, which only uses these
/// as one more *direct* candidate venue alongside Uniswap/Sushiswap/Camelot).
///
/// Every pool/coin address below was verified live via `cast call` against
/// the deployed contract (coins(0..n), never assumed from docs or an
/// address list), same discipline as dexRegistry.ts.
export type CurvePool = {
  pool: `0x${string}`;
  /// Token addresses in on-chain `coins(i)` index order.
  coins: readonly `0x${string}`[];
};

export const CURVE_POOLS: Record<number, CurvePool[]> = {
  1: [
    {
      // "3pool" — DAI/USDC/USDT. Verified: coins(0)=DAI, coins(1)=USDC, coins(2)=USDT.
      pool: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      coins: [
        "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
        "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      ],
    },
  ],
  42161: [],
};

/// Finds a verified Curve pool holding both tokens directly (no bridging)
/// and returns its `coins(i)` indices for `get_dy`/`exchange`. Returns null
/// if no known pool has this exact pair — callers fall back to other venues
/// or skip, never guess a pool.
export function findCurvePool(chainId: number, tokenA: `0x${string}`, tokenB: `0x${string}`): { pool: `0x${string}`; i: number; j: number } | null {
  const pools = CURVE_POOLS[chainId] ?? [];
  for (const p of pools) {
    const i = p.coins.findIndex((c) => c.toLowerCase() === tokenA.toLowerCase());
    const j = p.coins.findIndex((c) => c.toLowerCase() === tokenB.toLowerCase());
    if (i !== -1 && j !== -1 && i !== j) return { pool: p.pool, i, j };
  }
  return null;
}
