import { formatUnits, parseUnits, type PublicClient } from "viem";
import { isStableQuote } from "./stableQuotes";
import { tokenAmountToUsd, usdToTokenAmount } from "./priceOracle";

/// Converts a USD trade-size target into the flash-borrowed quote token's
/// units, or `null` if this quote token can't be sized safely — a
/// stablecoin sizes 1:1, anything else needs a verified price feed
/// (priceOracle.ts). Never falls back to guessing.
export async function resolveBorrowAmount(
  client: PublicClient,
  chainId: number,
  quoteAddress: `0x${string}`,
  quoteDecimals: number,
  borrowUsd: number,
): Promise<bigint | null> {
  if (isStableQuote(chainId, quoteAddress)) {
    return parseUnits(borrowUsd.toFixed(quoteDecimals), quoteDecimals);
  }
  return usdToTokenAmount(client, chainId, quoteAddress, quoteDecimals, borrowUsd);
}

/// Inverse — the USD value of an amount already denominated in the
/// flash-borrowed quote token, used to weigh expected profit against gas
/// cost before sending. `null` if this quote token can't be priced safely.
export async function resolveUsdValue(
  client: PublicClient,
  chainId: number,
  quoteAddress: `0x${string}`,
  quoteDecimals: number,
  amount: bigint,
): Promise<number | null> {
  if (isStableQuote(chainId, quoteAddress)) {
    return Number(formatUnits(amount, quoteDecimals));
  }
  return tokenAmountToUsd(client, chainId, quoteAddress, quoteDecimals, amount);
}

export async function optimizeUsdSize<T>(args: {
  maxBorrowUsd: number;
  evaluate: (borrowUsd: number) => Promise<{ score: number; result: T } | null>;
  refinementIterations?: number;
  coarseRatios?: number[];
}): Promise<{ borrowUsd: number; score: number; result: T; sampledSizes: number[] } | null> {
  if (!Number.isFinite(args.maxBorrowUsd) || args.maxBorrowUsd <= 0) return null;
  const samples = new Map<number, { borrowUsd: number; score: number; result: T } | null>();
  const at = async (rawSize: number) => {
    const borrowUsd = Number(Math.min(args.maxBorrowUsd, Math.max(0.01, rawSize)).toFixed(2));
    if (samples.has(borrowUsd)) return samples.get(borrowUsd) ?? null;
    const evaluated = await args.evaluate(borrowUsd);
    const value = evaluated && Number.isFinite(evaluated.score) ? { borrowUsd, ...evaluated } : null;
    samples.set(borrowUsd, value);
    return value;
  };
  const coarseRatios = args.coarseRatios ?? [0.02, 0.06, 0.15, 0.35, 0.65, 1];
  const coarse = [...new Set(coarseRatios
    .filter((ratio) => Number.isFinite(ratio) && ratio > 0)
    .map((ratio) => Number((args.maxBorrowUsd * ratio).toFixed(2))))]
    .filter((size) => size > 0)
    .sort((a, b) => a - b);
  for (const size of coarse) await at(size);
  const successful = () => [...samples.values()].filter((item): item is NonNullable<typeof item> => item !== null);
  let best = successful().sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const refinementIterations = args.refinementIterations ?? 4;
  if (refinementIterations <= 0 || coarse.length < 2) {
    return { ...best, sampledSizes: [...samples.keys()].sort((a, b) => a - b) };
  }
  const bestIndex = coarse.indexOf(best.borrowUsd);
  let left = bestIndex > 0 ? coarse[bestIndex - 1]! : 0.01;
  let right = bestIndex < coarse.length - 1 ? coarse[bestIndex + 1]! : args.maxBorrowUsd;
  const inversePhi = (Math.sqrt(5) - 1) / 2;
  let x1 = right - (right - left) * inversePhi;
  let x2 = left + (right - left) * inversePhi;
  let q1 = await at(x1);
  let q2 = await at(x2);
  const score = (quote: Awaited<ReturnType<typeof at>>) => quote?.score ?? Number.NEGATIVE_INFINITY;
  for (let iteration = 0; iteration < refinementIterations; iteration++) {
    if (score(q1) < score(q2)) {
      left = x1;
      x1 = x2;
      q1 = q2;
      x2 = left + (right - left) * inversePhi;
      q2 = await at(x2);
    } else {
      right = x2;
      x2 = x1;
      q2 = q1;
      x1 = right - (right - left) * inversePhi;
      q1 = await at(x1);
    }
  }
  best = successful().sort((a, b) => b.score - a.score)[0] ?? best;
  return { ...best, sampledSizes: [...samples.keys()].sort((a, b) => a - b) };
}
