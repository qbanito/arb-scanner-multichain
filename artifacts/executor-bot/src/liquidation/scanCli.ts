/// Standalone diagnostic entrypoint — fetches real borrower candidates from
/// Aave's subgraph and checks their real on-chain Health Factor. Not part of
/// the live trading loop; run manually to validate the liquidation pipeline
/// or check current market conditions.
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import { loadConfig } from "../config";
import { fetchBorrowerCandidates } from "./graphClient";
import { findAtRiskAccounts } from "./healthFactor";
import { marketsForChain } from "./aaveRegistry";
import { logger } from "../logger";

async function main() {
  const config = loadConfig();
  if (!config.graphApiKey) throw new Error("GRAPH_API_KEY is required for this script");

  const chainId = 42161;
  const rpcUrl = config.chains[chainId]?.rpcUrl;
  if (!rpcUrl) throw new Error("ARBITRUM_RPC_URL / ARB_EXECUTOR_ARBITRUM not configured");

  // Arbitrum only has the one (main) market today — this diagnostic doesn't
  // need multi-market support the way the live pipeline does.
  const market = marketsForChain(chainId)[0];
  if (!market) throw new Error("no Aave market registered for this chain");

  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

  logger.info("fetching borrower candidates from Aave subgraph...");
  const candidates = await fetchBorrowerCandidates(market.subgraphId, config.graphApiKey, { first: 500, skip: 0 });
  logger.info({ count: candidates.length }, "candidates fetched");

  if (candidates.length === 0) {
    logger.warn("no candidates returned — check subgraph query / API key");
    return;
  }

  logger.info("checking real on-chain health factor for all candidates (multicall)...");
  // Widen above 1.0 (1.05e18) so we can see accounts *approaching* risk too,
  // not just ones that are already liquidatable this instant.
  const atRisk = await findAtRiskAccounts(
    client,
    market.pool,
    candidates.map((c) => c.address),
    1_050_000_000_000_000_000n,
  );

  logger.info({ atRiskCount: atRisk.length }, "scan complete");
  for (const account of atRisk.slice(0, 20)) {
    const candidate = candidates.find((c) => c.address.toLowerCase() === account.address.toLowerCase());
    logger.info(
      {
        address: account.address,
        healthFactor: (Number(account.healthFactor) / 1e18).toFixed(4),
        totalCollateralBase: account.totalCollateralBase.toString(),
        totalDebtBase: account.totalDebtBase.toString(),
        reserves: candidate?.reserves.map((r) => ({
          symbol: r.symbol,
          collateral: r.currentATokenBalance.toString(),
          debt: r.currentTotalDebt.toString(),
        })),
      },
      "at-risk account",
    );
  }
}

main().catch((err) => {
  logger.fatal({ err }, "scan failed");
  process.exit(1);
});
