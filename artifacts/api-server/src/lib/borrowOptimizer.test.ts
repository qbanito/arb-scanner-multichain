import assert from "node:assert/strict";
import test from "node:test";
import { optimizeBorrowSize } from "./borrowOptimizer";

test("refines around a non-linear optimum", async () => {
  const quote = await optimizeBorrowSize({
    maxBorrowUsd: 1_000,
    refinementIterations: 8,
    evaluate: async (borrowUsd) => ({
      value: 200 - ((borrowUsd - 420) ** 2) / 1_000,
      result: borrowUsd,
    }),
  });
  assert.ok(quote);
  assert.ok(Math.abs(quote.borrowUsd - 420) < 15, `expected near 420, got ${quote.borrowUsd}`);
});

test("keeps the best result even when some quote sizes fail", async () => {
  const quote = await optimizeBorrowSize({
    maxBorrowUsd: 100,
    evaluate: async (borrowUsd) => borrowUsd > 70 ? null : { value: borrowUsd, result: borrowUsd },
  });
  assert.ok(quote);
  assert.ok(quote.borrowUsd <= 70);
});

test("does not sample dust when the strategy sets a viable minimum", async () => {
  const sampled: number[] = [];
  const quote = await optimizeBorrowSize({
    maxBorrowUsd: 10_000,
    minBorrowUsd: 1_000,
    preferredBorrowUsd: [1_000, 2_500, 5_000, 10_000],
    refinementIterations: 0,
    evaluate: async (borrowUsd) => {
      sampled.push(borrowUsd);
      return { value: borrowUsd, result: borrowUsd };
    },
  });
  assert.ok(quote);
  assert.ok(sampled.every((size) => size >= 1_000));
  assert.ok(sampled.includes(2_500));
  assert.equal(quote.borrowUsd, 10_000);
});
