export type TokenPriceObservation = {
  priceUsd: number;
  change24h: number;
  liquidityUsd: number;
};

/**
 * Select a liquid market near the cross-pool median instead of blindly
 * trusting the largest pool. Indexers can occasionally report one pool with
 * a corrupted USD conversion and an equally inflated liquidity figure.
 */
export function tokenReference(observations: TokenPriceObservation[]) {
  const valid = observations.filter((item) =>
    Number.isFinite(item.priceUsd)
    && item.priceUsd > 0
    && Number.isFinite(item.liquidityUsd)
    && item.liquidityUsd >= 0,
  );
  if (!valid.length) return null;

  const prices = valid.map((item) => item.priceUsd).sort((a, b) => a - b);
  const median = prices[Math.floor((prices.length - 1) / 2)]!;
  const inliers = valid.filter((item) => item.priceUsd >= median * 0.5 && item.priceUsd <= median * 2);
  const reference = [...inliers].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
  if (!reference) return null;

  return {
    priceUsd: reference.priceUsd,
    change24h: Number.isFinite(reference.change24h) ? reference.change24h : 0,
    liquidityUsd: inliers.reduce((sum, item) => sum + item.liquidityUsd, 0),
    pools: valid.length,
    rejectedOutliers: valid.length - inliers.length,
  };
}
