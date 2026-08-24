import { logger } from "../logger";

export type BorrowerCandidate = {
  address: `0x${string}`;
  reserves: {
    underlyingAsset: `0x${string}`;
    symbol: string;
    decimals: number;
    currentATokenBalance: bigint;
    currentTotalDebt: bigint;
    usageAsCollateralEnabledOnUser: boolean;
  }[];
};

/// Fetches every address that has ever borrowed on Aave V3, with their
/// current per-reserve collateral/debt balances. This is a *candidate* list
/// only — the subgraph doesn't (can't) compute Health Factor, since that
/// depends on live prices, not indexed events. Real risk is checked
/// on-chain per candidate (see healthFactor.ts).
export async function fetchBorrowerCandidates(
  subgraphId: string,
  graphApiKey: string,
  options: { first: number; skip: number },
): Promise<BorrowerCandidate[]> {
  const query = `
    query Borrowers($first: Int!, $skip: Int!) {
      users(first: $first, skip: $skip, where: { borrowedReservesCount_gt: 0 }, orderBy: id) {
        id
        reserves(where: { or: [{ currentTotalDebt_gt: "0" }, { currentATokenBalance_gt: "0" }] }) {
          usageAsCollateralEnabledOnUser
          currentATokenBalance
          currentTotalDebt
          reserve {
            underlyingAsset
            symbol
            decimals
          }
        }
      }
    }
  `;

  const response = await fetch(`https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: options }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    logger.warn({ status: response.status }, "Aave subgraph request failed");
    return [];
  }

  const json = (await response.json()) as {
    data?: { users?: { id: string; reserves: unknown[] }[] };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    logger.warn({ errors: json.errors }, "Aave subgraph returned errors");
    return [];
  }

  type RawReserve = {
    usageAsCollateralEnabledOnUser: boolean;
    currentATokenBalance: string;
    currentTotalDebt: string;
    reserve: { underlyingAsset: string; symbol: string; decimals: string };
  };

  return (json.data?.users ?? []).map((user) => ({
    address: user.id as `0x${string}`,
    reserves: (user.reserves as RawReserve[]).map((r) => ({
      underlyingAsset: r.reserve.underlyingAsset as `0x${string}`,
      symbol: r.reserve.symbol,
      decimals: Number(r.reserve.decimals),
      currentATokenBalance: BigInt(r.currentATokenBalance),
      currentTotalDebt: BigInt(r.currentTotalDebt),
      usageAsCollateralEnabledOnUser: r.usageAsCollateralEnabledOnUser,
    })),
  }));
}
