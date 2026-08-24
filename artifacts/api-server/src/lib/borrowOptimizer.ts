export type BorrowEvaluation<T> = { borrowUsd: number; value: number; result: T };

function uniqueSizes(values: number[], maximum: number): number[] {
  return [...new Set(values
    .map((value) => Math.min(maximum, Math.max(1, Number(value.toFixed(2)))))
    .filter((value) => Number.isFinite(value) && value <= maximum))]
    .sort((a, b) => a - b);
}

/**
 * Produces capital sizes that can actually pay a network transaction.  The
 * previous percentage-only samples could turn a $350 capacity into a $7
 * quote.  That is useful for a unit test but not for mainnet arbitrage where
 * gas is a mostly fixed cost.  Keep a few relative samples too, because they
 * are still valuable when a pool is much deeper than the standard ladder.
 */
function viableSizes(
  minimum: number,
  maximum: number,
  preferred: readonly number[],
): number[] {
  return uniqueSizes(
    [
      minimum,
      ...preferred,
      0.1 * maximum,
      0.25 * maximum,
      0.5 * maximum,
      0.75 * maximum,
      maximum,
    ].filter((value) => value >= minimum),
    maximum,
  ).filter((value) => value >= minimum);
}

/**
 * Finds the best flash-loan size without assuming a particular AMM invariant.
 * It first samples the full capital range, then performs a bounded golden
 * section refinement around the best sample. The evaluator is deliberately
 * asynchronous because each point is an exact on-chain route quote.
 */
export async function optimizeBorrowSize<T>(args: {
  maxBorrowUsd: number;
  /** Refuse dust-sized quote calls which cannot plausibly clear gas. */
  minBorrowUsd?: number;
  /** Fixed USD points, normally the strategy's capital ladder. */
  preferredBorrowUsd?: readonly number[];
  /**
   * AMM price impact is monotonic for the supported exact-input adapters. If
   * the smallest viable trade is already at or below this score, larger
   * sizes cannot rescue it and would only consume more RPC quote calls.
   */
  stopAfterFirstIfValueAtMost?: number;
  evaluate: (borrowUsd: number) => Promise<{ value: number; result: T } | null>;
  refinementIterations?: number;
}): Promise<BorrowEvaluation<T> | null> {
  const minimum = Math.max(1, args.minBorrowUsd ?? 1);
  if (!Number.isFinite(args.maxBorrowUsd) || args.maxBorrowUsd < minimum)
    return null;
  const coarse = viableSizes(
    minimum,
    args.maxBorrowUsd,
    args.preferredBorrowUsd ?? [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000],
  );
  const evaluated = new Map<number, BorrowEvaluation<T> | null>();
  const at = async (borrowUsd: number): Promise<BorrowEvaluation<T> | null> => {
    const size = Number(borrowUsd.toFixed(2));
    if (evaluated.has(size)) return evaluated.get(size) ?? null;
    const quote = await args.evaluate(size);
    const value = quote && Number.isFinite(quote.value)
      ? { borrowUsd: size, value: quote.value, result: quote.result }
      : null;
    evaluated.set(size, value);
    return value;
  };

  const first = await at(coarse[0]!);
  if (
    first &&
    args.stopAfterFirstIfValueAtMost !== undefined &&
    first.value <= args.stopAfterFirstIfValueAtMost
  )
    return first;
  for (const size of coarse.slice(1)) await at(size);
  const successful = () => [...evaluated.values()].filter((item): item is BorrowEvaluation<T> => item !== null);
  let best = successful().sort((a, b) => b.value - a.value)[0] ?? null;
  if (!best) return null;

  const ordered = [...coarse].sort((a, b) => a - b);
  const bestIndex = ordered.findIndex((size) => size === best!.borrowUsd);
  let left = bestIndex > 0 ? ordered[bestIndex - 1]! : minimum;
  let right = bestIndex < ordered.length - 1 ? ordered[bestIndex + 1]! : args.maxBorrowUsd;
  if (right - left < 0.02) return best;

  const inversePhi = (Math.sqrt(5) - 1) / 2;
  let x1 = right - (right - left) * inversePhi;
  let x2 = left + (right - left) * inversePhi;
  let q1 = await at(x1);
  let q2 = await at(x2);
  const score = (quote: BorrowEvaluation<T> | null) => quote?.value ?? Number.NEGATIVE_INFINITY;
  for (let iteration = 0; iteration < (args.refinementIterations ?? 4); iteration++) {
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

  best = successful().sort((a, b) => b.value - a.value)[0] ?? best;
  return best;
}
