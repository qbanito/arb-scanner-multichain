import assert from "node:assert/strict";
import test from "node:test";
import { amountOutMinimumForHop } from "./routeBuilder";

test("intermediate hops can require the full same-block quote", () => {
  assert.equal(amountOutMinimumForHop(1_000_000n, 0), 1_000_000n);
});

test("the final hop applies the configured settlement tolerance once", () => {
  assert.equal(amountOutMinimumForHop(1_000_000n, 20), 998_000n);
});

test("slippage basis points are bounded before bigint arithmetic", () => {
  assert.equal(amountOutMinimumForHop(1_000_000n, -5), 1_000_000n);
  assert.equal(amountOutMinimumForHop(1_000_000n, 20_000), 0n);
});
