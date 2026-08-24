import { GetLiquidationOpportunitiesResponse } from "@workspace/api-zod";
import { logger } from "../logger";

export type WatchlistEntry = {
  chainId: number;
  /// Which Aave market this position is in and its Pool contract — a chain
  /// can have several isolated markets (see aaveRegistry.ts), so chainId
  /// alone isn't enough to know which contract to check/liquidate against.
  market: string;
  pool: `0x${string}`;
  userAddress: `0x${string}`;
  debtAsset: `0x${string}`;
  debtToCover: bigint;
  collateralAsset: `0x${string}`;
  estimatedBonusUsd: number;
};

/// Pulls the current highest-value at-risk positions from our own
/// api-server (which already does the subgraph fetch + full pricing — see
/// artifacts/api-server/src/lib/aave.ts). This is deliberately the *slow*
/// discovery path; highValueWatcher.ts uses its result only as a seed list,
/// then re-checks Health Factor directly on-chain every block so the
/// subgraph's own indexing lag never gates the actual trigger.
export async function fetchWatchlist(apiBaseUrl: string, limit: number): Promise<WatchlistEntry[]> {
  const url = new URL("/api/liquidations/opportunities", apiBaseUrl);
  url.searchParams.set("chain", "all");
  url.searchParams.set("maxHealthFactor", "1.1");
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    logger.warn({ status: response.status }, "watchlist refresh: liquidations API returned a non-OK status");
    return [];
  }

  const parsed = GetLiquidationOpportunitiesResponse.safeParse(await response.json());
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, "watchlist refresh: response failed validation");
    return [];
  }

  return parsed.data.map((o) => ({
    chainId: o.chainId,
    market: o.market,
    pool: o.poolAddress as `0x${string}`,
    userAddress: o.userAddress as `0x${string}`,
    debtAsset: o.debt.address as `0x${string}`,
    debtToCover: BigInt(o.debt.amount),
    collateralAsset: o.collateral.address as `0x${string}`,
    estimatedBonusUsd: o.estimatedBonusUsd,
  }));
}
