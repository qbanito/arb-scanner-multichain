import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBloxrouteBackrunSignal,
  simulateAndSubmitBloxrouteBackrun,
} from "./bloxrouteBackrun";

test("decodes BSC arbOnlyMEV targets and touched pool addresses", () => {
  const targetHash = `0x${"11".repeat(32)}`;
  const pool = `0x${"aa".repeat(20)}`;
  const signal = decodeBloxrouteBackrunSignal(JSON.stringify({
    params: {
      result: {
        transactions: [{
          txHash: targetHash,
          txContents: { logs: [{ address: pool }] },
        }],
        state: { [pool]: {} },
        nextBlockNumber: "123",
        maxBlockNumber: "125",
      },
    },
  }));
  assert.equal(signal?.targetHash, targetHash);
  assert.equal(signal?.nextBlockNumber, 123n);
  assert.deepEqual([...signal!.addresses], [pool]);
});

test("simulates a BSC private target before submitting its backrun", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    methods.push(request.method);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: request.method === "simulate_arb_only_bundle"
        ? { results: [{ status: "0x1" }] }
        : { bundleHash: "bundle-1" },
    }));
  }) as typeof fetch;

  const result = await simulateAndSubmitBloxrouteBackrun({
    rpcUrl: "https://backrun.example",
    authorization: "secret",
    signal: {
      targetHash: `0x${"11".repeat(32)}`,
      addresses: new Set(),
      nextBlockNumber: 123n,
      maxBlockNumber: 125n,
    },
    signedTransaction: `0x${"22".repeat(64)}`,
    fetchImpl,
  });
  assert.deepEqual(methods, [
    "simulate_arb_only_bundle",
    "submit_arb_only_bundle",
  ]);
  assert.equal(result.bundleHash, "bundle-1");
});
