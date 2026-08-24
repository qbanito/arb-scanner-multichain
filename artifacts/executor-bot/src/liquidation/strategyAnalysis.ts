/// Standalone diagnostic: deeper behavioral profile of specific liquidator
/// addresses (defaults to the top earners found by competitorAnalysis.ts).
/// Everything here comes from public on-chain data plus Etherscan's public
/// contract-verification database — no private/internal information about
/// any of these addresses is available or used.
///
/// For each target address, reports:
///   - EOA vs contract (eth_getCode)
///   - Verified source available on Etherscan (and its declared name), which
///     — when present — directly reveals their flash-loan/DEX-routing setup
///   - Gas behavior on their actual liquidation transactions: priority fee
///     paid over the block's base fee, and position within the block
///     (transactionIndex). A consistently very-low transactionIndex or a
///     priority fee right at the minimum is a signal of private order flow
///     (Flashbots Protect / MEV-Share) rather than public mempool bidding —
///     this is inference from gas-auction behavior, not a certainty.
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { aaveOracleAbi } from "./aaveAbis";
import { marketByPool, marketsForChain } from "./aaveRegistry";
import {
  BLOCKS_PER_DAY,
  CHAIN_DEFS,
  ETHERSCAN_API_URL,
  ETHERSCAN_REQUEST_GAP_MS,
  fetchLiquidationEvents,
  sleep,
  type LiquidationEvent,
} from "./competitorAnalysis";
import { knownAssetDecimals } from "./knownAssets";

const DEFAULT_DAYS = 30;
const DEFAULT_TOP_N = 5;
const MAX_TX_SAMPLES_PER_ADDRESS = 10; // cap RPC calls (block fetches) per address

type AddressProfile = {
  isContract: boolean;
  verified: boolean;
  contractName: string | null;
};

async function fetchAddressProfile(client: PublicClient, etherscanApiKey: string, chainId: number, address: Address): Promise<AddressProfile> {
  const code = await client.getCode({ address });
  const isContract = !!code && code !== "0x";

  const url = new URL(ETHERSCAN_API_URL);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", etherscanApiKey);

  try {
    const res = await fetch(url);
    const body = (await res.json()) as { status: string; result: Array<{ ContractName?: string; SourceCode?: string }> };
    const entry = body.result?.[0];
    const verified = !!entry?.SourceCode && entry.SourceCode.length > 0;
    return { isContract, verified, contractName: verified ? (entry?.ContractName ?? null) : null };
  } catch (err) {
    logger.debug({ err, chainId, address }, "getsourcecode lookup failed");
    return { isContract, verified: false, contractName: null };
  }
}

type GasSample = { transactionIndex: number; priorityFeeGwei: number };

async function sampleGasBehavior(client: PublicClient, events: LiquidationEvent[]): Promise<GasSample[]> {
  const samples: GasSample[] = [];
  const chosen = events.slice(0, MAX_TX_SAMPLES_PER_ADDRESS);
  for (const ev of chosen) {
    try {
      const block = await client.getBlock({ blockNumber: ev.blockNumber });
      const baseFee = block.baseFeePerGas ?? 0n;
      const priorityFeeWei = ev.gasPriceWei > baseFee ? ev.gasPriceWei - baseFee : 0n;
      samples.push({
        transactionIndex: ev.transactionIndex,
        priorityFeeGwei: Number(priorityFeeWei) / 1e9,
      });
    } catch (err) {
      logger.debug({ err, blockNumber: ev.blockNumber.toString() }, "block fetch failed, skipping gas sample");
    }
  }
  return samples;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const config = loadConfig();
  const etherscanApiKey = process.env["ETHERSCAN_API_KEY"];
  if (!etherscanApiKey) throw new Error("ETHERSCAN_API_KEY is required for this script (add it to .env)");

  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? Number(daysArg) : DEFAULT_DAYS;
  const addressesArg = process.argv.find((a) => a.startsWith("--addresses="))?.split("=")[1];
  const explicitTargets = addressesArg ? addressesArg.split(",").map((a) => a.trim().toLowerCase()) : null;

  const clients = new Map<number, PublicClient>();
  const allEvents: LiquidationEvent[] = [];

  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chainDef = CHAIN_DEFS[chainId];
    if (!chainDef) continue;

    const client = createPublicClient({ chain: chainDef, transport: http(chainConfig.rpcUrl) }) as PublicClient;
    clients.set(chainId, client);

    for (const market of marketsForChain(chainId)) {
      try {
        const latest = await client.getBlockNumber();
        const lookbackBlocks = BigInt(Math.round((BLOCKS_PER_DAY[chainId] ?? 7_200) * days));
        const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
        logger.info({ chainId, market: market.marketKey, days }, "scanning LiquidationCall history...");
        const events = await fetchLiquidationEvents(etherscanApiKey, chainId, market.pool, fromBlock, latest);
        allEvents.push(...events);
        await sleep(ETHERSCAN_REQUEST_GAP_MS);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, chainId, market: market.marketKey }, "skipping market — scan failed");
      }
    }
  }

  if (allEvents.length === 0) {
    logger.warn("no LiquidationCall events found — nothing to analyze");
    return;
  }

  let targets: string[];
  if (explicitTargets) {
    targets = explicitTargets;
  } else {
    // Same current-price ranking approach as competitorAnalysis.ts — a
    // ranking aid, not a historical-fact reconstruction.
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

    const totals = new Map<string, number>();
    for (const ev of allEvents) {
      const decimals = knownAssetDecimals(ev.chainId, ev.debtAsset);
      if (decimals === null) continue;
      const price = await priceOf(ev.chainId, ev.pool, ev.debtAsset);
      if (price === null) continue;
      const key = ev.liquidator.toLowerCase();
      const usd = (Number(ev.debtToCover) / 10 ** decimals) * price;
      totals.set(key, (totals.get(key) ?? 0) + usd);
    }
    targets = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, DEFAULT_TOP_N).map(([addr]) => addr);
  }

  logger.info({ targets, windowDays: days }, "analyzing strategy for target addresses");

  for (const target of targets) {
    const events = allEvents.filter((ev) => ev.liquidator.toLowerCase() === target);
    if (events.length === 0) {
      logger.warn({ target }, "no events found for this address in the scanned window");
      continue;
    }

    // All of an address's events are on one chain in practice (Aave Pool
    // addresses differ per chain, and we only saw it liquidate where it
    // appeared), but handle multi-chain defensively.
    const byChain = new Map<number, LiquidationEvent[]>();
    for (const ev of events) {
      byChain.set(ev.chainId, [...(byChain.get(ev.chainId) ?? []), ev]);
    }

    for (const [chainId, chainEvents] of byChain) {
      const client = clients.get(chainId);
      if (!client) continue;

      const addressProfile = await fetchAddressProfile(client, etherscanApiKey, chainId, target as Address);
      await sleep(ETHERSCAN_REQUEST_GAP_MS);
      const gasSamples = await sampleGasBehavior(client, chainEvents);

      logger.info(
        {
          address: target,
          chainId,
          liquidations: chainEvents.length,
          isContract: addressProfile.isContract,
          verified: addressProfile.verified,
          contractName: addressProfile.contractName,
          avgTransactionIndex: Math.round(average(gasSamples.map((s) => s.transactionIndex)) * 10) / 10,
          avgPriorityFeeGwei: Math.round(average(gasSamples.map((s) => s.priorityFeeGwei)) * 100) / 100,
          sampledTxCount: gasSamples.length,
        },
        "strategy profile",
      );
    }
  }

  logger.info(
    "interpretation guide: very low avgTransactionIndex + near-zero avgPriorityFeeGwei suggests private order flow (Flashbots/MEV-Share) — " +
      "a public mempool bidder typically shows a higher, more variable priority fee and a transactionIndex that moves with how aggressively they bid.",
  );
}

main().catch((err) => {
  logger.fatal({ err }, "strategy analysis failed");
  process.exit(1);
});
