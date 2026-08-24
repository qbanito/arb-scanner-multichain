import assert from "node:assert/strict";
import test from "node:test";
import { mergeActiveMarketCatalog } from "./marketCatalog";

type Chain = "bsc";
type Market = {
  token: { addresses: Partial<Record<Chain, string>> };
  pairs: string[];
};

const market = (address: string, pairs: string[]): Market => ({
  token: { addresses: { bsc: address } },
  pairs,
});

test("keeps successful additions and fills only missing active markets from the previous snapshot", () => {
  const refreshed = [market("0xaaa", ["new-a"]), market("0xbbb", [])];
  const previous = [
    market("0xaaa", ["old-a"]),
    market("0xbbb", ["old-b"]),
    market("0xccc", ["stale-c"]),
  ];

  const merged = mergeActiveMarketCatalog(
    "bsc",
    new Set(["0xaaa", "0xbbb"]),
    refreshed,
    previous,
  );

  assert.deepEqual(merged, [market("0xaaa", ["new-a"]), market("0xbbb", ["old-b"])]);
});
