export type CycleToken = {
  address: string;
  symbol: string;
  decimals: number;
};

export type CyclePool<TVenue> = {
  pairAddress: string;
  liquidityUsd: number;
  feeBps: number;
  base: CycleToken;
  quote: CycleToken;
  /** Quote-token units received for one base-token unit at the observed spot. */
  baseToQuote: number;
  venue: TVenue;
};

/** Stable identity for one directed asset edge inside a pool contract. */
export function cyclePoolEdgeKey<TVenue>(pool: CyclePool<TVenue>): string {
  return `${pool.pairAddress.toLowerCase()}:${pool.base.address.toLowerCase()}:${pool.quote.address.toLowerCase()}`;
}

export type CycleLeg<TVenue> = {
  poolAddress: string;
  tokenIn: CycleToken;
  tokenOut: CycleToken;
  spotRate: number;
  liquidityUsd: number;
  feeBps: number;
  venue: TVenue;
};

export type TriangularCycle<TVenue> = {
  legs: [CycleLeg<TVenue>, CycleLeg<TVenue>, CycleLeg<TVenue>];
  start: CycleToken;
  estimatedGrossBps: number;
  maxBorrowUsd: number;
};

export type AtomicCycle<TVenue> = {
  legs: CycleLeg<TVenue>[];
  start: CycleToken;
  estimatedGrossBps: number;
  maxBorrowUsd: number;
};

export type PriorityCycleTemplate = {
  id: string;
  /** Ordered token addresses, including the repeated closing asset. */
  tokenAddresses: string[];
};

export type PrioritizedCycle<TVenue> = AtomicCycle<TVenue> & {
  templateId: string;
};

export type PriorityCycleSearchOptions = {
  minEstimatedBps?: number;
  maxPoolsPerLeg?: number;
  maxResultsPerTemplate?: number;
};

export type CycleSearchOptions = {
  minHops?: number;
  maxHops?: number;
  minEstimatedBps?: number;
  maxResults?: number;
  maxPoolsPerPair?: number;
  maxExploredPaths?: number;
};

export type ConversionPathOptions = {
  maxHops?: number;
  maxPoolsPerPair?: number;
  excludedPoolAddresses?: Set<string>;
  excludedTokenAddresses?: Set<string>;
};

/**
 * Finds the strongest simple same-chain conversion path between two assets.
 * This is used to close otherwise incomplete A -> token -> B opportunities
 * back into the flash-borrowed asset A. Rates include every pool fee while
 * ranking, but exact on-chain quotes remain authoritative before execution.
 */
export function findBestConversionPath<TVenue>(
  pools: CyclePool<TVenue>[],
  tokenInAddress: string,
  tokenOutAddress: string,
  options: ConversionPathOptions = {},
): CycleLeg<TVenue>[] | null {
  const start = tokenInAddress.toLowerCase();
  const target = tokenOutAddress.toLowerCase();
  if (start === target) return [];

  const maxHops = Math.min(4, Math.max(1, options.maxHops ?? 3));
  const maxPoolsPerPair = Math.max(1, options.maxPoolsPerPair ?? 4);
  const excludedPools = new Set(
    [...(options.excludedPoolAddresses ?? [])].map((address) => address.toLowerCase()),
  );
  const excludedTokens = new Set(
    [...(options.excludedTokenAddresses ?? [])].map((address) => address.toLowerCase()),
  );
  const pairCounts = new Map<string, number>();
  const outgoing = new Map<string, CycleLeg<TVenue>[]>();

  for (const pool of [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd)) {
    if (excludedPools.has(pool.pairAddress.toLowerCase())) continue;
    if (!Number.isFinite(pool.baseToQuote) || pool.baseToQuote <= 0 || pool.liquidityUsd <= 0) continue;
    const baseAddress = pool.base.address.toLowerCase();
    const quoteAddress = pool.quote.address.toLowerCase();
    const pairKey = [baseAddress, quoteAddress].sort().join(":");
    const count = pairCounts.get(pairKey) ?? 0;
    if (count >= maxPoolsPerPair) continue;
    pairCounts.set(pairKey, count + 1);
    const edges: CycleLeg<TVenue>[] = [
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.base,
        tokenOut: pool.quote,
        spotRate: pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.quote,
        tokenOut: pool.base,
        spotRate: 1 / pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
    ];
    for (const edge of edges) {
      const key = edge.tokenIn.address.toLowerCase();
      outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
    }
  }

  let best: { legs: CycleLeg<TVenue>[]; score: number; liquidity: number } | null = null;
  const walk = (
    current: string,
    legs: CycleLeg<TVenue>[],
    usedTokens: Set<string>,
    usedPools: Set<string>,
    score: number,
  ) => {
    if (legs.length >= maxHops) return;
    for (const edge of outgoing.get(current) ?? []) {
      const poolAddress = edge.poolAddress.toLowerCase();
      const next = edge.tokenOut.address.toLowerCase();
      if (usedPools.has(poolAddress)) continue;
      if (next !== target && (usedTokens.has(next) || excludedTokens.has(next))) continue;
      const feeFactor = 1 - edge.feeBps / 10_000;
      if (feeFactor <= 0) continue;
      const nextScore = score + Math.log(edge.spotRate) + Math.log(feeFactor);
      const nextLegs = [...legs, edge];
      if (next === target) {
        const liquidity = Math.min(...nextLegs.map((leg) => leg.liquidityUsd));
        if (!best || nextScore > best.score || (nextScore === best.score && liquidity > best.liquidity)) {
          best = { legs: nextLegs, score: nextScore, liquidity };
        }
        continue;
      }
      walk(
        next,
        nextLegs,
        new Set([...usedTokens, next]),
        new Set([...usedPools, poolAddress]),
        nextScore,
      );
    }
  };

  walk(start, [], new Set([start]), new Set(), 0);
  // TypeScript does not track assignments made from the recursive closure.
  const resolvedBest = best as { legs: CycleLeg<TVenue>[]; score: number; liquidity: number } | null;
  return resolvedBest?.legs ?? null;
}

/**
 * Finds A -> B -> C -> A cycles without inventing a synthetic bridge.
 * The calculation is only a cheap ranking prefilter; every returned cycle
 * still needs exact on-chain quotes before it can be called executable.
 */
export function findTriangularCycles<TVenue>(
  pools: CyclePool<TVenue>[],
  borrowAssets: Set<string>,
  options: { minEstimatedBps?: number; maxResults?: number; maxPoolsPerPair?: number } = {},
): TriangularCycle<TVenue>[] {
  return findAtomicCycles(pools, borrowAssets, {
    ...options,
    minHops: 3,
    maxHops: 3,
  }).map((cycle) => ({ ...cycle, legs: cycle.legs as TriangularCycle<TVenue>["legs"] }));
}

/**
 * Evaluates operator-selected token sequences independently from the bounded
 * generic DFS. Every leg must be backed by a real indexed pool and every pool
 * combination is fee-adjusted before it can become a candidate. This prevents
 * a busy graph/path budget from hiding important cycles without inventing a
 * route when one of the requested edges is missing.
 */
export function findPrioritizedCycles<TVenue>(
  pools: CyclePool<TVenue>[],
  templates: PriorityCycleTemplate[],
  borrowAssets: Set<string>,
  options: PriorityCycleSearchOptions = {},
): PrioritizedCycle<TVenue>[] {
  const minEstimatedBps = options.minEstimatedBps ?? 2;
  const maxPoolsPerLeg = Math.max(1, options.maxPoolsPerLeg ?? 4);
  const maxResultsPerTemplate = Math.max(1, options.maxResultsPerTemplate ?? 2);
  const edges: CycleLeg<TVenue>[] = [];

  for (const pool of pools) {
    if (!Number.isFinite(pool.baseToQuote) || pool.baseToQuote <= 0 || pool.liquidityUsd <= 0)
      continue;
    edges.push(
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.base,
        tokenOut: pool.quote,
        spotRate: pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.quote,
        tokenOut: pool.base,
        spotRate: 1 / pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
    );
  }

  const byDirectedPair = new Map<string, CycleLeg<TVenue>[]>();
  for (const edge of edges) {
    const key = `${edge.tokenIn.address.toLowerCase()}:${edge.tokenOut.address.toLowerCase()}`;
    byDirectedPair.set(key, [...(byDirectedPair.get(key) ?? []), edge]);
  }
  for (const candidates of byDirectedPair.values()) {
    candidates.sort((a, b) => {
      const scoreA = Math.log(a.spotRate) + Math.log1p(-a.feeBps / 10_000);
      const scoreB = Math.log(b.spotRate) + Math.log1p(-b.feeBps / 10_000);
      return scoreB - scoreA || b.liquidityUsd - a.liquidityUsd;
    });
  }

  const result: PrioritizedCycle<TVenue>[] = [];
  for (const template of templates) {
    const addresses = template.tokenAddresses.map((address) => address.toLowerCase());
    const start = addresses[0];
    const hopCount = addresses.length - 1;
    if (
      !start ||
      hopCount < 2 ||
      hopCount > 6 ||
      addresses.at(-1) !== start ||
      !borrowAssets.has(start) ||
      new Set(addresses.slice(0, -1)).size !== addresses.length - 1
    )
      continue;

    const choices: CycleLeg<TVenue>[][] = [];
    let complete = true;
    for (let index = 0; index < hopCount; index++) {
      const candidates = byDirectedPair
        .get(`${addresses[index]}:${addresses[index + 1]}`)
        ?.slice(0, maxPoolsPerLeg) ?? [];
      if (candidates.length === 0) {
        complete = false;
        break;
      }
      choices.push(candidates);
    }
    if (!complete) continue;

    const templateCycles: PrioritizedCycle<TVenue>[] = [];
    const select = (index: number, legs: CycleLeg<TVenue>[], usedPools: Set<string>) => {
      if (index === choices.length) {
        const logReturn = legs.reduce(
          (sum, leg) => sum + Math.log(leg.spotRate) + Math.log1p(-leg.feeBps / 10_000),
          0,
        );
        const estimatedGrossBps = Math.expm1(logReturn) * 10_000;
        if (!Number.isFinite(estimatedGrossBps) || estimatedGrossBps < minEstimatedBps) return;
        templateCycles.push({
          templateId: template.id,
          legs: [...legs],
          start: legs[0]!.tokenIn,
          estimatedGrossBps,
          maxBorrowUsd: Math.min(100_000, ...legs.map((leg) => leg.liquidityUsd * 0.03)),
        });
        return;
      }
      for (const edge of choices[index]!) {
        const poolAddress = edge.poolAddress.toLowerCase();
        if (usedPools.has(poolAddress)) continue;
        select(index + 1, [...legs, edge], new Set([...usedPools, poolAddress]));
      }
    };
    select(0, [], new Set());
    result.push(
      ...templateCycles
        .sort(
          (a, b) =>
            b.estimatedGrossBps - a.estimatedGrossBps ||
            b.maxBorrowUsd - a.maxBorrowUsd,
        )
        .slice(0, maxResultsPerTemplate),
    );
  }

  return result;
}

/**
 * Bounded depth-first graph search for closed, simple, same-chain cycles.
 * Tokens and pools cannot repeat inside a path. This prevents wash loops and
 * bounds the route builder to calldata that can settle atomically.
 *
 * Candidate returns are accumulated in logarithmic space. That is equivalent
 * to multiplying every exchange rate and fee factor, but is more stable for
 * long routes and lets the search rank outgoing edges by additive weight
 * (the same transformation used by negative-cycle arbitrage detectors).
 */
export function findAtomicCycles<TVenue>(
  pools: CyclePool<TVenue>[],
  borrowAssets: Set<string>,
  options: CycleSearchOptions = {},
): AtomicCycle<TVenue>[] {
  const minHops = Math.max(2, options.minHops ?? 3);
  const maxHops = Math.min(6, Math.max(minHops, options.maxHops ?? 6));
  const minEstimatedBps = options.minEstimatedBps ?? 2;
  const maxResults = options.maxResults ?? 32;
  const maxPoolsPerPair = options.maxPoolsPerPair ?? 4;
  const maxExploredPaths = options.maxExploredPaths ?? 250_000;
  const pairCounts = new Map<string, number>();
  const edges: CycleLeg<TVenue>[] = [];

  for (const pool of [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd)) {
    if (!Number.isFinite(pool.baseToQuote) || pool.baseToQuote <= 0 || pool.liquidityUsd <= 0) continue;
    const pairKey = [pool.base.address.toLowerCase(), pool.quote.address.toLowerCase()].sort().join(":");
    const count = pairCounts.get(pairKey) ?? 0;
    if (count >= maxPoolsPerPair) continue;
    pairCounts.set(pairKey, count + 1);
    edges.push(
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.base,
        tokenOut: pool.quote,
        spotRate: pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
      {
        poolAddress: pool.pairAddress,
        tokenIn: pool.quote,
        tokenOut: pool.base,
        spotRate: 1 / pool.baseToQuote,
        liquidityUsd: pool.liquidityUsd,
        feeBps: pool.feeBps,
        venue: pool.venue,
      },
    );
  }

  const outgoing = new Map<string, CycleLeg<TVenue>[]>();
  for (const edge of edges) {
    const key = edge.tokenIn.address.toLowerCase();
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  for (const candidates of outgoing.values()) {
    candidates.sort((a, b) => {
      const logA = Math.log(a.spotRate) + Math.log1p(-a.feeBps / 10_000);
      const logB = Math.log(b.spotRate) + Math.log1p(-b.feeBps / 10_000);
      return logB - logA || b.liquidityUsd - a.liquidityUsd;
    });
  }

  const cycles: AtomicCycle<TVenue>[] = [];
  const seen = new Set<string>();
  let exploredPaths = 0;
  for (const startAddress of borrowAssets) {
    const normalizedStart = startAddress.toLowerCase();
    const walk = (
      currentAddress: string,
      legs: CycleLeg<TVenue>[],
      usedTokens: Set<string>,
      usedPools: Set<string>,
    ) => {
      if (exploredPaths >= maxExploredPaths) return;
      for (const edge of outgoing.get(currentAddress) ?? []) {
        exploredPaths++;
        if (exploredPaths > maxExploredPaths) return;
        const poolAddress = edge.poolAddress.toLowerCase();
        if (usedPools.has(poolAddress)) continue;
        const nextAddress = edge.tokenOut.address.toLowerCase();
        const nextLegs = [...legs, edge];

        if (nextAddress === normalizedStart) {
          if (nextLegs.length < minHops || nextLegs.length > maxHops) continue;
          const id = `${normalizedStart}:${nextLegs.map((leg) => leg.poolAddress.toLowerCase()).join(":")}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const logReturn = nextLegs.reduce(
            (sum, leg) => sum + Math.log(leg.spotRate) + Math.log1p(-leg.feeBps / 10_000),
            0,
          );
          const estimatedGrossBps = Math.expm1(logReturn) * 10_000;
          if (!Number.isFinite(estimatedGrossBps) || estimatedGrossBps < minEstimatedBps) continue;
          cycles.push({
            legs: nextLegs,
            start: nextLegs[0]!.tokenIn,
            estimatedGrossBps,
            maxBorrowUsd: Math.min(100_000, ...nextLegs.map((leg) => leg.liquidityUsd * 0.03)),
          });
          continue;
        }

        if (nextLegs.length >= maxHops || usedTokens.has(nextAddress)) continue;
        walk(
          nextAddress,
          nextLegs,
          new Set([...usedTokens, nextAddress]),
          new Set([...usedPools, poolAddress]),
        );
      }
    };
    walk(normalizedStart, [], new Set([normalizedStart]), new Set());
    if (exploredPaths >= maxExploredPaths) break;
  }

  return cycles
    .sort((a, b) => b.estimatedGrossBps - a.estimatedGrossBps || b.maxBorrowUsd - a.maxBorrowUsd)
    .slice(0, maxResults);
}
