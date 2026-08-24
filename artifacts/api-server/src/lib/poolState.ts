import type { CyclePool } from "./cycleDiscovery";

type PoolVenue = { dexId: string; labels?: string[]; pairAddress: string; feeBps?: number };
type PoolKind = "v2" | "v3" | "algebra" | "liquidity-book" | "solidly-auto";

const token0Abi = [{ type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const reservesAbi = [{
  type: "function",
  name: "getReserves",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }],
}] as const;
const slot0Abi = [{
  type: "function",
  name: "slot0",
  stateMutability: "view",
  inputs: [],
  outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" },
    { type: "uint16" }, { type: "uint8" }, { type: "bool" },
  ],
}] as const;
const feeAbi = [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }] as const;
const algebraGlobalStateAbi = [{
  type: "function",
  name: "globalState",
  stateMutability: "view",
  inputs: [],
  outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" },
    { type: "uint8" }, { type: "uint8" }, { type: "bool" },
  ],
}] as const;
const lbTokenXAbi = [{ type: "function", name: "getTokenX", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const lbActiveIdAbi = [{ type: "function", name: "getActiveId", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }] as const;
const lbBinStepAbi = [{ type: "function", name: "getBinStep", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }] as const;

function kindFor(venue: PoolVenue): PoolKind | null {
  const dex = venue.dexId.toLowerCase();
  const labels = new Set((venue.labels ?? []).map((label) => label.toLowerCase()));
  if (dex === "uniswap") return labels.has("v2") ? "v2" : labels.has("v4") ? null : "v3";
  if (dex === "sushiswap") return labels.has("v3") ? "v3" : "v2";
  if (dex === "pancakeswap") {
    if (labels.has("v1") || labels.has("infinity") || labels.has("v4")) return null;
    return labels.has("v2") ? "v2" : "v3";
  }
  if (dex === "velodrome") return labels.has("v2") ? "v2" : "solidly-auto";
  // Aerodrome's indexer currently omits a V2 label. Trying getReserves here
  // is safe: concentrated-liquidity pools fail the multicall and keep their
  // indexed spot only; exact getAmountOut() quoting later still fails closed.
  if (dex === "aerodrome") return "solidly-auto";
  // Camelot V2 includes both volatile x*y=k and stable-curve pools. The
  // reserve ratio is not the marginal price for a stable pool, and the
  // indexer label does not reliably expose that distinction. Keep its
  // indexed spot for graph ranking; the router quote remains authoritative.
  if (dex === "camelot") return null;
  if (dex === "traderjoe" || dex === "lfj") return labels.has("v1") ? null : "liquidity-book";
  if (dex === "agni") return "v3";
  if (dex === "lynex") return "algebra";
  return null;
}

export function v2BaseToQuote(args: {
  reserve0: bigint;
  reserve1: bigint;
  token0IsBase: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}): number {
  if (args.reserve0 <= 0n || args.reserve1 <= 0n) return 0;
  const rawRatio = args.token0IsBase
    ? Number(args.reserve1) / Number(args.reserve0)
    : Number(args.reserve0) / Number(args.reserve1);
  return rawRatio * 10 ** (args.baseDecimals - args.quoteDecimals);
}

export function v3BaseToQuote(args: {
  sqrtPriceX96: bigint;
  token0IsBase: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}): number {
  if (args.sqrtPriceX96 <= 0n) return 0;
  const token1RawPerToken0Raw = Number(args.sqrtPriceX96) ** 2 / 2 ** 192;
  const baseToQuoteRaw = args.token0IsBase ? token1RawPerToken0Raw : 1 / token1RawPerToken0Raw;
  return baseToQuoteRaw * 10 ** (args.baseDecimals - args.quoteDecimals);
}

export function liquidityBookBaseToQuote(args: {
  activeId: number;
  binStep: number;
  tokenXIsBase: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}): number {
  const rawTokenYPerTokenX = Math.pow(1 + args.binStep / 10_000, args.activeId - 2 ** 23);
  if (!Number.isFinite(rawTokenYPerTokenX) || rawTokenYPerTokenX <= 0) return 0;
  const rawBaseToQuote = args.tokenXIsBase ? rawTokenYPerTokenX : 1 / rawTokenYPerTokenX;
  return rawBaseToQuote * 10 ** (args.baseDecimals - args.quoteDecimals);
}

/**
 * Refreshes every supported graph edge from one on-chain multicall. The pool
 * catalog can therefore be cached for minutes while route prices stay tied
 * to the current block instead of a delayed indexer snapshot.
 */
export async function refreshCyclePoolRates<TVenue extends PoolVenue>(
  client: any,
  pools: CyclePool<TVenue>[],
  blockNumber?: number,
): Promise<{ pools: CyclePool<TVenue>[]; live: number; fallback: number }> {
  const contracts: any[] = [];
  const metadata: Array<{ pool: CyclePool<TVenue>; kind: PoolKind; token0Index: number; stateIndex: number; feeIndex?: number; binStepIndex?: number; clStateIndex?: number; clFeeIndex?: number }> = [];
  for (const pool of pools) {
    const kind = kindFor(pool.venue);
    if (!kind || !/^0x[a-fA-F0-9]{40}$/.test(pool.pairAddress)) continue;
    const address = pool.pairAddress as `0x${string}`;
    const token0Index = contracts.length;
    contracts.push({ address, abi: kind === "liquidity-book" ? lbTokenXAbi : token0Abi, functionName: kind === "liquidity-book" ? "getTokenX" : "token0" });
    const stateIndex = contracts.length;
    contracts.push({
      address,
      abi: kind === "v2" || kind === "solidly-auto" ? reservesAbi : kind === "v3" ? slot0Abi : kind === "algebra" ? algebraGlobalStateAbi : lbActiveIdAbi,
      functionName: kind === "v2" || kind === "solidly-auto" ? "getReserves" : kind === "v3" ? "slot0" : kind === "algebra" ? "globalState" : "getActiveId",
    });
    const binStepIndex = kind === "liquidity-book" ? contracts.length : undefined;
    if (binStepIndex !== undefined) contracts.push({ address, abi: lbBinStepAbi, functionName: "getBinStep" });
    const feeIndex = kind === "v3" ? contracts.length : undefined;
    if (feeIndex !== undefined) contracts.push({ address, abi: feeAbi, functionName: "fee" });
    const clStateIndex = kind === "solidly-auto" ? contracts.length : undefined;
    if (clStateIndex !== undefined) contracts.push({ address, abi: slot0Abi, functionName: "slot0" });
    const clFeeIndex = kind === "solidly-auto" ? contracts.length : undefined;
    if (clFeeIndex !== undefined) contracts.push({ address, abi: feeAbi, functionName: "fee" });
    metadata.push({ pool, kind, token0Index, stateIndex, feeIndex, binStepIndex, clStateIndex, clFeeIndex });
  }
  if (contracts.length === 0) return { pools, live: 0, fallback: pools.length };

  let results: Array<{ status: string; result?: unknown }>;
  try {
    results = await client.multicall({
      contracts,
      allowFailure: true,
      batchSize: 8_192,
      ...(blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) }),
    });
  } catch {
    return { pools, live: 0, fallback: pools.length };
  }

  const refreshed = new Map<string, CyclePool<TVenue>>();
  let live = 0;
  for (const entry of metadata) {
    const token0Result = results[entry.token0Index];
    let stateResult: { status: string; result?: unknown } | undefined = results[entry.stateIndex];
    let resolvedKind: Exclude<PoolKind, "solidly-auto"> = entry.kind === "solidly-auto" ? "v2" : entry.kind;
    let resolvedFeeIndex = entry.feeIndex;
    if (entry.kind === "solidly-auto" && stateResult?.status !== "success") {
      stateResult = entry.clStateIndex === undefined ? undefined : results[entry.clStateIndex];
      resolvedKind = "v3";
      resolvedFeeIndex = entry.clFeeIndex;
    }
    if (token0Result?.status !== "success" || stateResult?.status !== "success") continue;
    const token0 = String(token0Result.result).toLowerCase();
    const token0IsBase = token0 === entry.pool.base.address.toLowerCase();
    if (!token0IsBase && token0 !== entry.pool.quote.address.toLowerCase()) continue;
    const state = stateResult.result as readonly unknown[];
    const baseToQuote = resolvedKind === "v2"
      ? v2BaseToQuote({
        reserve0: state[0] as bigint,
        reserve1: state[1] as bigint,
        token0IsBase,
        baseDecimals: entry.pool.base.decimals,
        quoteDecimals: entry.pool.quote.decimals,
      })
      : resolvedKind === "v3" || resolvedKind === "algebra" ? v3BaseToQuote({
        sqrtPriceX96: state[0] as bigint,
        token0IsBase,
        baseDecimals: entry.pool.base.decimals,
        quoteDecimals: entry.pool.quote.decimals,
      }) : liquidityBookBaseToQuote({
        activeId: Number(stateResult.result),
        binStep: Number(entry.binStepIndex === undefined ? 0 : results[entry.binStepIndex]?.result),
        tokenXIsBase: token0IsBase,
        baseDecimals: entry.pool.base.decimals,
        quoteDecimals: entry.pool.quote.decimals,
      });
    if (!Number.isFinite(baseToQuote) || baseToQuote <= 0) continue;
    const feeResult = resolvedFeeIndex === undefined ? undefined : results[resolvedFeeIndex];
    const liveFeeBps = resolvedKind === "algebra"
      ? Number(state[2]) / 100
      : feeResult?.status === "success" ? Number(feeResult.result) / 100 : entry.pool.feeBps;
    refreshed.set(entry.pool.pairAddress.toLowerCase(), {
      ...entry.pool,
      baseToQuote,
      feeBps: liveFeeBps,
      venue: { ...entry.pool.venue, feeBps: liveFeeBps },
    });
    live++;
  }

  return {
    pools: pools.map((pool) => refreshed.get(pool.pairAddress.toLowerCase()) ?? pool),
    live,
    fallback: pools.length - live,
  };
}
