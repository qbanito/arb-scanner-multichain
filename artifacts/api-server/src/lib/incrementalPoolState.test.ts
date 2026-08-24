import assert from "node:assert/strict";
import { test } from "node:test";
import { IncrementalPoolStateEngine } from "./incrementalPoolState";

test("preserves multiple token edges exposed by one multi-asset pool", async () => {
  const sharedAddress = `0x${"12".repeat(20)}`;
  const tokenA = { address: `0x${"aa".repeat(20)}`, symbol: "A", decimals: 18 };
  const tokenB = { address: `0x${"bb".repeat(20)}`, symbol: "B", decimals: 18 };
  const tokenC = { address: `0x${"cc".repeat(20)}`, symbol: "C", decimals: 6 };
  const venue = { dexId: "curve", pairAddress: sharedAddress, labels: [] };
  const pools = [
    { pairAddress: sharedAddress, liquidityUsd: 1_000_000, feeBps: 4, base: tokenA, quote: tokenB, baseToQuote: 2, venue },
    { pairAddress: sharedAddress, liquidityUsd: 1_000_000, feeBps: 4, base: tokenA, quote: tokenC, baseToQuote: 3, venue },
  ];
  const engine = new IncrementalPoolStateEngine();
  const first = await engine.refresh({ chain: "test", client: {}, pools, blockNumber: 10 });
  assert.equal(first.pools.length, 2);
  const cached = await engine.refresh({ chain: "test", client: {}, pools, blockNumber: 10 });
  assert.equal(cached.pools.length, 2);
  assert.deepEqual(cached.pools.map((pool) => pool.quote.symbol).sort(), ["B", "C"]);
});
