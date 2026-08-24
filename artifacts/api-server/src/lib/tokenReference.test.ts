import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenReference } from "./tokenReference";

describe("tokenReference", () => {
  it("rejects a high-liquidity corrupted USD conversion", () => {
    const result = tokenReference([
      { priceUsd: 2_434, change24h: 0.8, liquidityUsd: 2_200_000 },
      { priceUsd: 2_440, change24h: 1.1, liquidityUsd: 850_000 },
      { priceUsd: 2_429, change24h: 0.7, liquidityUsd: 600_000 },
      { priceUsd: 518_832_975, change24h: 21_779_488, liquidityUsd: 35_000_000 },
    ]);
    assert.equal(result?.priceUsd, 2_434);
    assert.equal(result?.change24h, 0.8);
    assert.equal(result?.rejectedOutliers, 1);
  });

  it("returns null when no positive finite price exists", () => {
    assert.equal(tokenReference([{ priceUsd: 0, change24h: 0, liquidityUsd: 1 }]), null);
  });
});
