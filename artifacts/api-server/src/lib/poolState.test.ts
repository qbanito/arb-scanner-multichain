import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liquidityBookBaseToQuote, v2BaseToQuote, v3BaseToQuote } from "./poolState";

describe("live pool spot-rate math", () => {
  it("normalizes V2 reserves with different token decimals", () => {
    const rate = v2BaseToQuote({
      reserve0: 50n * 10n ** 18n,
      reserve1: 100_000n * 10n ** 6n,
      token0IsBase: true,
      baseDecimals: 18,
      quoteDecimals: 6,
    });
    assert.ok(Math.abs(rate - 2_000) < 1e-9);
  });

  it("normalizes V3 sqrtPriceX96 in either token direction", () => {
    const oneToOne = 2n ** 96n;
    assert.equal(v3BaseToQuote({ sqrtPriceX96: oneToOne, token0IsBase: true, baseDecimals: 18, quoteDecimals: 18 }), 1);
    assert.equal(v3BaseToQuote({ sqrtPriceX96: oneToOne, token0IsBase: false, baseDecimals: 18, quoteDecimals: 18 }), 1);
  });

  it("derives Liquidity Book spot price from active bin and bin step", () => {
    assert.equal(liquidityBookBaseToQuote({
      activeId: 2 ** 23,
      binStep: 20,
      tokenXIsBase: true,
      baseDecimals: 6,
      quoteDecimals: 6,
    }), 1);
    const nextBin = liquidityBookBaseToQuote({
      activeId: 2 ** 23 + 1,
      binStep: 20,
      tokenXIsBase: true,
      baseDecimals: 18,
      quoteDecimals: 18,
    });
    assert.ok(Math.abs(nextBin - 1.002) < 1e-12);
  });
});
