import { cyclePoolEdgeKey, type CyclePool } from "./cycleDiscovery";
import { refreshCyclePoolRates } from "./poolState";

type PoolVenue = { dexId: string; labels?: string[]; pairAddress: string; feeBps?: number };
type ChainSnapshot<TVenue> = {
  blockNumber: number;
  pools: Map<string, CyclePool<TVenue>>;
};

export type IncrementalRefreshResult<TVenue> = {
  pools: CyclePool<TVenue>[];
  live: number;
  fallback: number;
  touched: number;
  mode: "full" | "incremental" | "cached";
};

function validAddress(address: string): address is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) output.push(items.slice(offset, offset + size));
  return output;
}

/**
 * Maintains block-aligned pool state and invalidates only contracts that
 * emitted logs since the previous scan. Any log is considered relevant:
 * this covers V2 Sync, V3 Swap/Mint/Burn, dynamic-fee updates and protocol-
 * specific events without pretending their ABIs are interchangeable.
 */
export class IncrementalPoolStateEngine {
  private readonly snapshots = new Map<string, ChainSnapshot<any>>();

  constructor(
    private readonly maxIncrementalBlockGap = 64,
    private readonly addressBatchSize = 96,
    private readonly logConcurrency = 4,
  ) {}

  async refresh<TVenue extends PoolVenue>(args: {
    chain: string;
    client: any;
    pools: CyclePool<TVenue>[];
    blockNumber: number;
  }): Promise<IncrementalRefreshResult<TVenue>> {
    const existing = this.snapshots.get(args.chain) as ChainSnapshot<TVenue> | undefined;
    // Multi-asset Curve/Balancer pools expose several tradable token pairs at
    // the same contract address. Key snapshots by edge, while invalidating all
    // edges whenever that shared contract emits a log.
    const catalog = new Map(args.pools.map((pool) => [cyclePoolEdgeKey(pool), pool]));
    const addressToKeys = new Map<string, string[]>();
    for (const [key, pool] of catalog) {
      const address = pool.pairAddress.toLowerCase();
      addressToKeys.set(address, [...(addressToKeys.get(address) ?? []), key]);
    }
    const fullRefresh = async (): Promise<IncrementalRefreshResult<TVenue>> => {
      const refreshed = await refreshCyclePoolRates(
        args.client,
        args.pools,
        args.blockNumber,
      );
      this.snapshots.set(args.chain, {
        blockNumber: args.blockNumber,
        pools: new Map(refreshed.pools.map((pool) => [cyclePoolEdgeKey(pool), pool])),
      });
      return { ...refreshed, touched: args.pools.length, mode: "full" };
    };

    if (!existing || args.blockNumber < existing.blockNumber
      || args.blockNumber - existing.blockNumber > this.maxIncrementalBlockGap) {
      return fullRefresh();
    }

    const merged = new Map<string, CyclePool<TVenue>>();
    for (const [address, pool] of catalog) {
      const cached = existing.pools.get(address);
      merged.set(address, cached
        ? {
          ...pool,
          baseToQuote: cached.baseToQuote,
          feeBps: cached.feeBps,
          venue: { ...pool.venue, feeBps: cached.feeBps },
        }
        : pool);
    }

    const newKeys = [...catalog.keys()].filter((key) => !existing.pools.has(key));
    if (args.blockNumber === existing.blockNumber && newKeys.length === 0) {
      const pools = [...merged.values()];
      return { pools, live: pools.length, fallback: 0, touched: 0, mode: "cached" };
    }

    const touched = new Set(newKeys);
    const addresses = [...addressToKeys.keys()].filter(validAddress);
    try {
      if (args.blockNumber > existing.blockNumber && addresses.length > 0) {
        const batches = chunks(addresses, this.addressBatchSize);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(this.logConcurrency, batches.length) }, async () => {
          for (;;) {
            const index = cursor++;
            if (index >= batches.length) return;
            const logs = await args.client.getLogs({
              address: batches[index],
              fromBlock: BigInt(existing.blockNumber + 1),
              toBlock: BigInt(args.blockNumber),
              strict: false,
            });
            for (const log of logs as Array<{ address?: string }>) {
              if (log.address) {
                for (const key of addressToKeys.get(log.address.toLowerCase()) ?? []) touched.add(key);
              }
            }
          }
        });
        await Promise.all(workers);
      }
    } catch {
      // Missing logs would make the graph stale. A full multicall is slower,
      // but it preserves correctness when an RPC rejects address arrays or a
      // historical log range.
      return fullRefresh();
    }

    const changedPools = [...touched].flatMap((key) => {
      const pool = merged.get(key);
      return pool ? [pool] : [];
    });
    let live = 0;
    let fallback = 0;
    if (changedPools.length > 0) {
      const refreshed = await refreshCyclePoolRates(
        args.client,
        changedPools,
        args.blockNumber,
      );
      live = refreshed.live;
      fallback = refreshed.fallback;
      for (const pool of refreshed.pools) merged.set(cyclePoolEdgeKey(pool), pool);
    }

    const pools = [...merged.values()];
    this.snapshots.set(args.chain, { blockNumber: args.blockNumber, pools: merged });
    return { pools, live, fallback, touched: changedPools.length, mode: "incremental" };
  }
}
