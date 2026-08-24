import type { PublicClient } from "viem";
import { aavePoolReadAbi } from "./aaveAbis";
import { logger } from "../logger";

export type AccountHealth = {
  address: `0x${string}`;
  healthFactor: bigint; // 18-decimal fixed point; 1e18 == HF of 1.0
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
};

const HF_ONE = 10n ** 18n;
const BATCH_SIZE = 100;

/// Batch-reads real-time Health Factor for each candidate directly from
/// Aave's Pool contract via multicall — the subgraph can't tell us this (it
/// depends on live prices), so this is the actual, authoritative check.
/// Returns only accounts at or below `maxHealthFactor` (pass 1e18 for
/// "already liquidatable"; something above it, e.g. 1.02e18, to also see
/// accounts approaching risk).
export async function findAtRiskAccounts(
  client: PublicClient,
  poolAddress: `0x${string}`,
  candidates: `0x${string}`[],
  maxHealthFactor: bigint = HF_ONE,
): Promise<AccountHealth[]> {
  const results: AccountHealth[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    try {
      const batchResults = await client.multicall({
        contracts: batch.map((address) => ({
          address: poolAddress,
          abi: aavePoolReadAbi,
          functionName: "getUserAccountData",
          args: [address],
        })),
        allowFailure: true,
      });

      batchResults.forEach((result, idx) => {
        if (result.status !== "success") return;
        const [totalCollateralBase, totalDebtBase, , , , healthFactor] = result.result;
        // A user with no debt returns healthFactor = type(uint256).max —
        // not at risk, just not currently borrowing.
        if (totalDebtBase === 0n) return;
        if (healthFactor <= maxHealthFactor) {
          results.push({ address: batch[idx]!, healthFactor, totalCollateralBase, totalDebtBase });
        }
      });
    } catch (err) {
      logger.warn({ err, batchStart: i }, "multicall batch failed while checking health factors");
    }
  }

  return results.sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));
}
