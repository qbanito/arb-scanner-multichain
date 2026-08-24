import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCrossChainProfit,
  fetchAcrossQuote,
  validateAcrossRequest,
} from "./across";

const request = {
  originChainId: 42161,
  destinationChainId: 8453,
  inputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}`,
  outputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  amount: "100000000",
  depositor: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  recipient: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  tradeType: "exactInput" as const,
};

test("Across request validation rejects same-chain and malformed amounts", () => {
  const sameChainError = validateAcrossRequest({ ...request, destinationChainId: 42161 });
  const amountError = validateAcrossRequest({ ...request, amount: "1.5" });
  assert.ok(sameChainError);
  assert.ok(amountError);
  assert.match(sameChainError, /different/);
  assert.match(amountError, /positive integer/);
  assert.equal(validateAcrossRequest(request), null);
});

test("cross-chain profit includes bridge, both gas legs, slippage and inventory carry", () => {
  const profit = calculateCrossChainProfit({
    originSaleUsd: 100,
    destinationBuyUsd: 106,
    acrossFeeUsd: 0.8,
    originGasUsd: 0.3,
    destinationGasUsd: 0.2,
    slippageUsd: 0.7,
    inventoryCarryUsd: 0.5,
  });
  assert.equal(profit.grossSpreadUsd, 6);
  assert.equal(profit.totalCostsUsd, 2.5);
  assert.equal(profit.netProfitUsd, 3.5);
  assert.equal(profit.executable, false);
  assert.equal(profit.blocker, "cross-chain-inventory-required");
});

test("Across quote normalizes executable calldata without sending it", async () => {
  const env = {
    ACROSS_ENABLED: process.env["ACROSS_ENABLED"],
    ACROSS_API_BASE_URL: process.env["ACROSS_API_BASE_URL"],
    ACROSS_INTEGRATOR_ID: process.env["ACROSS_INTEGRATOR_ID"],
  };
  const originalFetch = globalThis.fetch;
  process.env["ACROSS_ENABLED"] = "true";
  process.env["ACROSS_API_BASE_URL"] = "https://testnet.across.to/api";
  process.env["ACROSS_INTEGRATOR_ID"] = "0x0001";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.match(url, /swap\/approval/);
    assert.match(url, /originChainId=42161/);
    assert.equal(init?.method, undefined);
    return new Response(JSON.stringify({
      id: "quote-1",
      expectedOutputAmount: "99800000",
      minOutputAmount: "99700000",
      expectedFillTime: 2,
      fees: { total: { amount: "200000", usd: 0.2 } },
      simulationSuccess: true,
      approvalTxns: [],
      swapTx: { to: "0x3333333333333333333333333333333333333333", data: "0x1234", value: "0" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const quote = await fetchAcrossQuote(request);
    assert.equal(quote.expectedOutputAmount, "99800000");
    assert.equal(quote.fees.totalUsd, 0.2);
    assert.equal(quote.swapTx.data, "0x1234");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
