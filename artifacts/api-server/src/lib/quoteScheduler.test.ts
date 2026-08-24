import assert from "node:assert/strict";
import test from "node:test";
import { FairQuoteScheduler } from "./quoteScheduler";

test("eventually quotes candidates below the initial top-N cutoff", () => {
  const scheduler = new FairQuoteScheduler(2);
  const ids = ["a", "b", "c", "d", "e", "f"];
  const selected = new Set<string>();
  for (let block = 1; block <= 8; block++) {
    for (const id of scheduler.select("arbitrum:graph", ids, 2, block)) selected.add(id);
  }
  assert.deepEqual(selected, new Set(ids));
});

test("forgets stale candidates without disturbing the live queue", () => {
  const scheduler = new FairQuoteScheduler(1, 2);
  scheduler.select("base:direct", ["old", "live"], 1, 1);
  scheduler.select("base:direct", ["live"], 1, 4);
  assert.equal(scheduler.stats("base:direct").tracked, 1);
});

