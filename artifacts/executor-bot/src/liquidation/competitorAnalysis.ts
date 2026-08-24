/// Standalone diagnostic: profiles who has actually been winning Aave
/// liquidations recently, by scanning the Pool's on-chain LiquidationCall
/// event history (the subgraph only gives current borrower snapshots, not
/// historical liquidation events).
///
/// This answers "how much competition is there and how fast/active are the
/// top bots" — it does NOT answer "who is about to strike next". Serious
/// MEV searchers submit through private order flow (Flashbots Protect,
/// MEV-Share, etc.) specifically to stay invisible until their transaction
/// has already landed, so there is no reliable way to see them coming; this
/// can only ever report on liquidations that already happened on-chain.
///
/// Uses the Etherscan v2 multichain "logs" API rather than raw eth_getLogs:
/// free-tier RPC (both a plain public endpoint and Alchemy's free plan) hard
/// -caps eth_getLogs to either no historical range at all (archive access
/// required) or a handful of blocks per call, making a multi-day scan
/// impractical without a paid RPC plan. Etherscan's indexed logs endpoint is
/// built for exactly this query shape and has no such block-range limit.
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http, toEventSelector, type Address, type PublicClient } from "viem";
import { arbitrum, mainnet } from "viem/chains";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { aaveOracleAbi, liquidationCallEventAbi } from "./aaveAbis";
import { marketByPool, marketsForChain } from "./aaveRegistry";
import { knownAssetDecimals } from "./knownAssets";

export const CHAIN_DEFS: Record<number, typeof mainnet | typeof arbitrum> = { 1: mainnet, 42161: arbitrum };

// Rough, deliberately conservative block-time estimates used only to size
// the scan window — not used for any financial math. Real block times drift
// (Arbitrum's especially, since it tracks sequencer load), so --days is a
// ballpark control, not a precise cutoff.
export const BLOCKS_PER_DAY: Record<number, number> = { 1: 7_200, 42161: 300_000 };
const DEFAULT_DAYS = 7;
const TOP_N = 25;

export const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const ETHERSCAN_PAGE_SIZE = 1_000;
const ETHERSCAN_MAX_PAGES = 20; // safety cap — 20k records is far more than a few days of liquidations
export const ETHERSCAN_REQUEST_GAP_MS = 250; // stay well under the free-tier rate limit

const LIQUIDATION_CALL_TOPIC0 = toEventSelector(liquidationCallEventAbi[0]);

export type LiquidationEvent = {
  chainId: number;
  /// Which Aave market's Pool this event came from — a chain can have
  /// several isolated markets (see aaveRegistry.ts).
  pool: Address;
  blockNumber: bigint;
  txHash: `0x${string}`;
  transactionIndex: number;
  gasPriceWei: bigint;
  gasUsed: bigint;
  liquidator: Address;
  user: Address;
  debtAsset: Address;
  collateralAsset: Address;
  debtToCover: bigint;
};

type EtherscanLogEntry = {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  gasPrice: string;
  gasUsed: string;
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchLiquidationEvents(
  apiKey: string,
  chainId: number,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<LiquidationEvent[]> {
  const events: LiquidationEvent[] = [];

  for (let page = 1; page <= ETHERSCAN_MAX_PAGES; page++) {
    const url = new URL(ETHERSCAN_API_URL);
    url.searchParams.set("chainid", String(chainId));
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("address", pool);
    url.searchParams.set("topic0", LIQUIDATION_CALL_TOPIC0);
    url.searchParams.set("fromBlock", fromBlock.toString());
    url.searchParams.set("toBlock", toBlock.toString());
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(ETHERSCAN_PAGE_SIZE));
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Etherscan logs API HTTP ${res.status} for chain ${chainId}`);
    const body = (await res.json()) as { status: string; message: string; result: EtherscanLogEntry[] | string };

    if (body.status !== "1") {
      // "No records found" just means an empty (rest-of-)window, not an error.
      if (body.message === "No records found") break;
      throw new Error(`Etherscan logs API error for chain ${chainId}: ${body.message}`);
    }

    const entries = Array.isArray(body.result) ? body.result : [];
    for (const entry of entries) {
      try {
        const decoded = decodeEventLog({
          abi: liquidationCallEventAbi,
          topics: entry.topics as [`0x${string}`, ...`0x${string}`[]],
          data: entry.data as `0x${string}`,
        });
        events.push({
          chainId,
          pool,
          blockNumber: BigInt(entry.blockNumber),
          txHash: entry.transactionHash as `0x${string}`,
          transactionIndex: Number(entry.transactionIndex),
          gasPriceWei: BigInt(entry.gasPrice),
          gasUsed: BigInt(entry.gasUsed),
          liquidator: decoded.args.liquidator,
          user: decoded.args.user,
          debtAsset: decoded.args.debtAsset,
          collateralAsset: decoded.args.collateralAsset,
          debtToCover: decoded.args.debtToCover,
        });
      } catch (err) {
        logger.debug({ err, chainId }, "skipping undecodable log entry");
      }
    }

    if (entries.length < ETHERSCAN_PAGE_SIZE) break;
    await sleep(ETHERSCAN_REQUEST_GAP_MS);
  }

  return events;
}

type Profile = {
  liquidator: Address;
  count: number;
  chains: Set<number>;
  firstBlock: bigint;
  lastBlock: bigint;
  estimatedDebtCoveredUsd: number;
};

async function main() {
  const config = loadConfig();
  const etherscanApiKey = process.env["ETHERSCAN_API_KEY"];
  if (!etherscanApiKey) throw new Error("ETHERSCAN_API_KEY is required for this script (add it to .env)");

  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? Number(daysArg) : DEFAULT_DAYS;

  // Only used for getBlockNumber() (to size the scan window) and current
  // Aave oracle prices below — neither needs archive access, so the plain
  // configured RPC (even a free public one) is fine here. All the actual
  // historical log data comes from Etherscan's indexed API instead.
  const clients = new Map<number, PublicClient>();
  const allEvents: LiquidationEvent[] = [];

  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chainDef = CHAIN_DEFS[chainId];
    if (!chainDef) continue;

    const client = createPublicClient({ chain: chainDef, transport: http(chainConfig.rpcUrl) }) as PublicClient;
    clients.set(chainId, client);

    // A chain can have several isolated Aave markets (see aaveRegistry.ts) —
    // each has its own Pool contract and therefore its own LiquidationCall
    // event history. Throttled between markets — firing several back-to-back
    // tripped Etherscan's rate limit ("NOTOK") in practice.
    for (const market of marketsForChain(chainId)) {
      try {
        const latest = await client.getBlockNumber();
        const lookbackBlocks = BigInt(Math.round((BLOCKS_PER_DAY[chainId] ?? 7_200) * days));
        const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

        logger.info(
          { chainId, market: market.marketKey, fromBlock: fromBlock.toString(), toBlock: latest.toString(), days },
          "scanning LiquidationCall history...",
        );
        const events = await fetchLiquidationEvents(etherscanApiKey, chainId, market.pool, fromBlock, latest);
        logger.info({ chainId, market: market.marketKey, count: events.length }, "market scan complete");
        allEvents.push(...events);
        await sleep(ETHERSCAN_REQUEST_GAP_MS);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, chainId, market: market.marketKey }, "skipping market — scan failed");
      }
    }
  }

  if (allEvents.length === 0) {
    logger.warn("no LiquidationCall events found in the scanned window — try a larger --days or check RPC connectivity");
    return;
  }

  // Sizing uses each chain's CURRENT Aave oracle price, not the price at
  // the time of each historical event — a ranking aid for "who's active and
  // how big", not a reconstruction of what any single liquidation actually
  // earned.
  const priceCache = new Map<string, number | null>();
  const priceOf = async (chainId: number, pool: Address, asset: Address): Promise<number | null> => {
    const key = `${chainId}:${asset.toLowerCase()}`;
    if (priceCache.has(key)) return priceCache.get(key)!;
    const client = clients.get(chainId);
    const oracle = marketByPool(pool)?.oracle;
    if (!client || !oracle) {
      priceCache.set(key, null);
      return null;
    }
    try {
      const [rawPrice, baseUnit] = await Promise.all([
        client.readContract({ address: oracle, abi: aaveOracleAbi, functionName: "getAssetPrice", args: [asset] }),
        client.readContract({ address: oracle, abi: aaveOracleAbi, functionName: "BASE_CURRENCY_UNIT" }),
      ]);
      const price = Number(rawPrice) / Number(baseUnit);
      priceCache.set(key, price);
      return price;
    } catch {
      priceCache.set(key, null);
      return null;
    }
  };

  const profiles = new Map<string, Profile>();
  for (const ev of allEvents) {
    const key = ev.liquidator.toLowerCase();
    const profile = profiles.get(key) ?? {
      liquidator: ev.liquidator,
      count: 0,
      chains: new Set<number>(),
      firstBlock: ev.blockNumber,
      lastBlock: ev.blockNumber,
      estimatedDebtCoveredUsd: 0,
    };
    profile.count += 1;
    profile.chains.add(ev.chainId);
    if (ev.blockNumber < profile.firstBlock) profile.firstBlock = ev.blockNumber;
    if (ev.blockNumber > profile.lastBlock) profile.lastBlock = ev.blockNumber;

    const decimals = knownAssetDecimals(ev.chainId, ev.debtAsset);
    if (decimals !== null) {
      const price = await priceOf(ev.chainId, ev.pool, ev.debtAsset);
      if (price !== null) {
        profile.estimatedDebtCoveredUsd += (Number(ev.debtToCover) / 10 ** decimals) * price;
      }
    }

    profiles.set(key, profile);
  }

  const ranked = [...profiles.values()].sort((a, b) => b.count - a.count);

  logger.info(
    { uniqueLiquidators: ranked.length, totalEvents: allEvents.length, windowDays: days },
    "competitor profile summary — estimatedDebtCoveredUsd uses CURRENT prices, ranking aid only, not historical fact",
  );

  for (const profile of ranked.slice(0, TOP_N)) {
    logger.info(
      {
        liquidator: profile.liquidator,
        liquidations: profile.count,
        chains: [...profile.chains],
        firstBlock: profile.firstBlock.toString(),
        lastBlock: profile.lastBlock.toString(),
        estimatedDebtCoveredUsd: Math.round(profile.estimatedDebtCoveredUsd),
      },
      "competitor",
    );
  }
}

// Guard against running main() as a side effect of another script importing
// fetchLiquidationEvents/etc. from this module — without this, `import`
// alone (e.g. from strategyAnalysis.ts) would trigger a full second scan
// concurrently with the importer's own, doubling Etherscan API load for no
// reason and risking a rate-limit rejection on both.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.fatal({ err }, "competitor analysis failed");
    process.exit(1);
  });
}
