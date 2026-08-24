/// Standalone diagnostic: compares our hand-maintained knownAssets.ts
/// against Aave's OWN live reserve list (`getReservesList()` on-chain, right
/// now) — the definitive source of truth for "what can even be liquidated on
/// this market". Anything Aave lists that we don't know about is a coverage
/// gap this bot silently never considers, no matter how good the rest of the
/// pipeline is.
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { CHAIN_DEFS } from "./competitorAnalysis";
import { isKnownAsset, KNOWN_ASSETS } from "./knownAssets";
import { marketsForChain } from "./aaveRegistry";

const aavePoolReservesAbi = [
  {
    type: "function",
    name: "getReservesList",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

const erc20SymbolDecimalsAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

async function describeToken(client: PublicClient, address: Address): Promise<{ symbol: string; decimals: number | null }> {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20SymbolDecimalsAbi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20SymbolDecimalsAbi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  } catch (err) {
    logger.debug({ err, address }, "failed to read symbol/decimals for unknown reserve");
    return { symbol: "?", decimals: null };
  }
}

async function main() {
  const config = loadConfig();

  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chainDef = CHAIN_DEFS[chainId];
    if (!chainDef) continue;

    const client = createPublicClient({ chain: chainDef, transport: http(chainConfig.rpcUrl) }) as PublicClient;

    // A chain can have several isolated Aave markets (see aaveRegistry.ts) —
    // audited separately, since each is its own Pool with its own reserves.
    for (const market of marketsForChain(chainId)) {
      const reserves = await client.readContract({ address: market.pool, abi: aavePoolReservesAbi, functionName: "getReservesList" });
      logger.info({ chainId, market: market.marketKey, liveReserveCount: reserves.length }, "fetched live Aave reserve list");

      const missing: Array<{ address: string; symbol: string; decimals: number | null }> = [];
      for (const reserve of reserves) {
        if (isKnownAsset(chainId, reserve)) continue;
        const info = await describeToken(client, reserve);
        missing.push({ address: reserve, ...info });
      }

      if (missing.length === 0) {
        logger.info({ chainId, market: market.marketKey }, "full coverage — every live Aave reserve is in knownAssets.ts");
      } else {
        logger.warn(
          { chainId, market: market.marketKey, missingCount: missing.length, missing },
          "GAP: these Aave reserves are not in knownAssets.ts — this bot will never consider them as debt or collateral in a liquidation",
        );
      }

      // Sanity check the other direction too: anything in knownAssets.ts
      // that Aave no longer lists on THIS market (delisted/frozen reserve,
      // or simply never listed here) is not itself a gap — knownAssets.ts is
      // a chain-wide allowlist shared across all of a chain's markets — but
      // worth knowing which of a market's reserves this covers.
      const liveSet = new Set(reserves.map((r) => r.toLowerCase()));
      const notOnThisMarket = Object.keys(KNOWN_ASSETS[chainId] ?? {}).filter((address) => !liveSet.has(address));
      logger.debug(
        { chainId, market: market.marketKey, notOnThisMarketCount: notOnThisMarket.length },
        "knownAssets.ts entries not listed on this specific market (expected — it's a chain-wide list, not per-market)",
      );
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, "asset coverage audit failed");
  process.exit(1);
});
