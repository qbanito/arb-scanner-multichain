/// Real history of actual past liquidations on a given Aave market — used
/// for the "strategy" detail panel's gas estimate AND its competitor list,
/// both derived from the SAME Etherscan query (one fetch, two answers,
/// rather than paying for the same event log twice). api-server has no
/// wallet/execution context to run a live eth_estimateGas simulation
/// against (it never holds a private key), so gas cost here is always the
/// real historical average, not a live simulation. Same event topic and
/// Etherscan v2 endpoint as artifacts/executor-bot/src/liquidation/
/// competitorAnalysis.ts.
import { logger } from "./logger";

const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
// keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)")
// — verified against aave-v3-core's IPool.sol in the same way executor-bot's
// liquidationCallEventAbi was; recomputing here rather than importing across
// the app boundary (api-server and executor-bot are separate deployables).
const LIQUIDATION_CALL_TOPIC0 = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286" as `0x${string}`;

export type CompetitorSummary = { liquidator: string; count: number };
export type MarketHistory = { avgGasUsed: bigint | null; sampleCount: number; topCompetitors: CompetitorSummary[] };

type CacheEntry = { value: MarketHistory; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60_000; // gas usage / who's active on a market don't shift minute to minute

const BLOCKS_PER_DAY: Record<number, number> = { 1: 7_200, 42161: 300_000 };
const LOOKBACK_DAYS = 30;
const TOP_COMPETITORS = 5;

/// Decodes just the `liquidator` field from a LiquidationCall log's `data`
/// blob — 4 non-indexed words in emit order (debtToCover,
/// liquidatedCollateralAmount, liquidator, receiveAToken), each a 32-byte
/// word; liquidator is an address, right-padded in the low 20 bytes of its
/// word. Hand-decoded rather than pulling in viem's full ABI decoder here
/// since this is the only field this file needs from `data`.
function decodeLiquidator(data: string): string | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const liquidatorWord = hex.slice(128, 192); // 3rd word (0-indexed: word 2)
  if (liquidatorWord.length !== 64) return null;
  return `0x${liquidatorWord.slice(24)}`;
}

export async function fetchMarketHistory(chainId: number, pool: `0x${string}`, latestBlock: bigint, etherscanApiKey: string): Promise<MarketHistory> {
  const cacheKey = `${chainId}:${pool.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const empty: MarketHistory = { avgGasUsed: null, sampleCount: 0, topCompetitors: [] };
  const lookbackBlocks = BigInt(Math.round((BLOCKS_PER_DAY[chainId] ?? 7_200) * LOOKBACK_DAYS));
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const url = new URL(ETHERSCAN_API_URL);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("address", pool);
  url.searchParams.set("topic0", LIQUIDATION_CALL_TOPIC0);
  url.searchParams.set("fromBlock", fromBlock.toString());
  url.searchParams.set("toBlock", latestBlock.toString());
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "1000");
  url.searchParams.set("apikey", etherscanApiKey);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return empty;
    const body = (await res.json()) as { status: string; message: string; result: Array<{ gasUsed: string; data: string }> | string };
    if (body.status !== "1" || !Array.isArray(body.result) || body.result.length === 0) return empty;

    const gasValues = body.result.map((r) => BigInt(r.gasUsed));
    const avgGasUsed = gasValues.reduce((sum, v) => sum + v, 0n) / BigInt(gasValues.length);

    const countByLiquidator = new Map<string, number>();
    for (const entry of body.result) {
      const liquidator = decodeLiquidator(entry.data);
      if (!liquidator) continue;
      const key = liquidator.toLowerCase();
      countByLiquidator.set(key, (countByLiquidator.get(key) ?? 0) + 1);
    }
    const topCompetitors = [...countByLiquidator.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_COMPETITORS)
      .map(([liquidator, count]) => ({ liquidator, count }));

    const value: MarketHistory = { avgGasUsed, sampleCount: gasValues.length, topCompetitors };
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.debug({ err, chainId, pool }, "market history lookup failed");
    return empty;
  }
}
