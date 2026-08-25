import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { simulateAndSendMevShareBackrun } from "./flashbotsBackrun";

test("simulates a target-aware MEV-Share bundle before submission", async () => {
  const methods: string[] = [];
  const headers: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(payload.method);
    headers.push(new Headers(init?.headers).get("x-flashbots-signature") ?? "");
    const result = payload.method === "mev_simBundle"
      ? { success: true, gasUsed: "0x5208" }
      : { bundleHash: `0x${"ab".repeat(32)}` };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;

  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const result = await simulateAndSendMevShareBackrun({
    relayUrl: "https://relay.example",
    account,
    targetHash: `0x${"22".repeat(32)}`,
    signedTransaction: `0x${"33".repeat(64)}`,
    nextBlockNumber: 100n,
    fetchImpl,
  });

  assert.deepEqual(methods, ["mev_simBundle", "mev_sendBundle"]);
  assert.equal(result.simulationGasUsed, 21_000n);
  assert.ok(headers.every((header) => header.startsWith(`${account.address}:0x`)));
});

test("never submits when matched-bundle simulation fails", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { success: false, error: "target changed" },
    }));
  }) as typeof fetch;
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

  await assert.rejects(
    simulateAndSendMevShareBackrun({
      relayUrl: "https://relay.example",
      account,
      targetHash: `0x${"22".repeat(32)}`,
      signedTransaction: `0x${"33".repeat(64)}`,
      nextBlockNumber: 100n,
      fetchImpl,
    }),
    /simulation failed/,
  );
  assert.equal(calls, 1);
});
