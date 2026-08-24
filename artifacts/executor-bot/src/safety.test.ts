import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PublicClient } from "viem";
import type { ChainClients } from "./chains";
import { TradeLimiter } from "./limiter";
import {
  priceFeedFor,
  tokenAmountToUsd,
  usdToTokenAmount,
} from "./priceOracle";
import { getExecutionReadiness, hasSufficientGasBalance } from "./readiness";
import {
  BSC_WBNB,
  estimateSettlementGasBudgetWei,
  planGasRefill,
} from "./profitSettlement";
import {
  optimizeUsdSize,
  resolveBorrowAmount,
  resolveUsdValue,
} from "./sizing";
import { isStableQuote } from "./stableQuotes";

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});

describe("TradeLimiter", () => {
  it("blocks after the configured number of trades", () => {
    Date.now = () => 10_000;
    const limiter = new TradeLimiter(2);

    assert.equal(limiter.canTrade(), true);
    limiter.record();
    assert.equal(limiter.canTrade(), true);
    limiter.record();
    assert.equal(limiter.canTrade(), false);
  });

  it("restores capacity after the rolling one-hour window", () => {
    let now = 10_000;
    Date.now = () => now;
    const limiter = new TradeLimiter(1);

    limiter.record();
    now += 60 * 60 * 1_000;
    assert.equal(limiter.canTrade(), true);
  });
});

describe("autonomous live readiness", () => {
  it("keeps an underfunded executor in standby and becomes ready after funding", async () => {
    const owner = "0x0000000000000000000000000000000000000001" as const;
    const executorAddress =
      "0x0000000000000000000000000000000000000002" as const;
    let balance = 1n;
    const publicClient = {
      getBytecode: async () => "0x1234",
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "owner" ? owner : false,
      getBalance: async () => balance,
    };
    const chainClients = {
      account: { address: owner },
      clients: new Map([[1, { executorAddress, publicClient }]]),
    } as unknown as ChainClients;

    const underfunded = (await getExecutionReadiness(chainClients)).get(1);
    assert.equal(underfunded?.ready, false);
    assert.deepEqual(underfunded?.blockers, ["insufficient-gas"]);

    balance = 1_000_000_000_000_000n;
    const funded = (await getExecutionReadiness(chainClients)).get(1);
    assert.equal(funded?.ready, true);
    assert.deepEqual(funded?.blockers, []);
  });

  it("requires the operator to cover both the chain reserve and the exact estimated transaction cost", () => {
    assert.equal(hasSufficientGasBalance(14n, 5n, 9n), true);
    assert.equal(hasSufficientGasBalance(13n, 5n, 9n), false);
    assert.equal(hasSufficientGasBalance(10n, 11n, 9n), false);
    assert.equal(hasSufficientGasBalance(10n, 5n, 11n), false);
  });
});

describe("profit-funded BNB reserve", () => {
  const settings = {
    enabled: true,
    triggerWei: 2_500n,
    targetWei: 4_000n,
    slippageBps: 100,
  };

  it("uses at most the just-confirmed profit to refill a low reserve", () => {
    assert.deepEqual(
      planGasRefill({
        chainId: 56,
        settings,
        nativeBalance: 2_000n,
        profitToken: "0x0000000000000000000000000000000000000001",
        confirmedProfit: 700n,
      }),
      {
        kind: "refill",
        shortfallWei: 2_000n,
        maxProfitAmount: 700n,
        unwrapWbnb: false,
      },
    );
  });

  it("unwraps WBNB 1:1 and does nothing while the reserve is healthy", () => {
    assert.equal(
      planGasRefill({
        chainId: 56,
        settings,
        nativeBalance: 2_000n,
        profitToken: BSC_WBNB,
        confirmedProfit: 3_000n,
      }).kind,
      "refill",
    );
    assert.deepEqual(
      planGasRefill({
        chainId: 56,
        settings,
        nativeBalance: 2_500n,
        profitToken: BSC_WBNB,
        confirmedProfit: 3_000n,
      }),
      { kind: "none", reason: "reserve-healthy" },
    );
  });

  it("budgets withdrawal and the worst-case refill before sending the arb", () => {
    const lowReserveBudget = estimateSettlementGasBudgetWei({
      chainId: 56,
      gasPriceWei: 10n,
      projectedNativeBalance: 2_000n,
      profitToken: "0x0000000000000000000000000000000000000001",
      settings,
    });
    const healthyReserveBudget = estimateSettlementGasBudgetWei({
      chainId: 56,
      gasPriceWei: 10n,
      projectedNativeBalance: 3_000n,
      profitToken: "0x0000000000000000000000000000000000000001",
      settings,
    });
    assert.ok(lowReserveBudget > healthyReserveBudget);
    assert.equal(healthyReserveBudget, 960_000n);
  });
});

describe("safe asset pricing", () => {
  const ethereumUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
  const ethereumWeth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
  const unknownToken = "0x0000000000000000000000000000000000000001" as const;

  it("recognizes stablecoins case-insensitively and sizes them without RPC", async () => {
    const clientThatMustNotBeCalled = {
      readContract: async () => {
        throw new Error("stablecoin sizing should not read an oracle");
      },
    } as unknown as PublicClient;

    assert.equal(isStableQuote(1, ethereumUsdc.toLowerCase()), true);
    assert.equal(
      await resolveBorrowAmount(
        clientThatMustNotBeCalled,
        1,
        ethereumUsdc,
        6,
        250.5,
      ),
      250_500_000n,
    );
    assert.equal(
      await resolveUsdValue(
        clientThatMustNotBeCalled,
        1,
        ethereumUsdc,
        6,
        12_345_678n,
      ),
      12.345678,
    );
  });

  it("refuses to guess when a token has no verified feed", async () => {
    const unusedClient = {} as PublicClient;

    assert.equal(priceFeedFor(1, unknownToken), null);
    assert.equal(
      await usdToTokenAmount(unusedClient, 1, unknownToken, 18, 100),
      null,
    );
    assert.equal(
      await tokenAmountToUsd(unusedClient, 1, unknownToken, 18, 1n),
      null,
    );
  });

  it("uses a fresh positive Chainlink answer for both conversion directions", async () => {
    const updatedAt = BigInt(Math.floor(Date.now() / 1_000) - 30);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return 8;
        if (functionName === "latestRoundData")
          return [1n, 2_000n * 10n ** 8n, 0n, updatedAt, 1n] as const;
        throw new Error(`unexpected read: ${functionName}`);
      },
    } as unknown as PublicClient;

    assert.equal(
      await usdToTokenAmount(client, 1, ethereumWeth, 18, 100),
      50_000_000_000_000_000n,
    );
    assert.equal(
      await tokenAmountToUsd(
        client,
        1,
        ethereumWeth,
        18,
        50_000_000_000_000_000n,
      ),
      100,
    );
  });

  it("rejects stale oracle data", async () => {
    const updatedAt = BigInt(Math.floor(Date.now() / 1_000) - 3_601);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "decimals"
          ? 8
          : ([1n, 2_000n * 10n ** 8n, 0n, updatedAt, 1n] as const),
    } as unknown as PublicClient;

    assert.equal(
      await usdToTokenAmount(client, 1, ethereumWeth, 18, 100),
      null,
    );
  });
});

describe("continuous execution sizing", () => {
  it("finds a narrow optimum between the fixed coarse samples", async () => {
    const optimized = await optimizeUsdSize({
      maxBorrowUsd: 1_000,
      refinementIterations: 8,
      evaluate: async (borrowUsd) => ({
        score: 50 - (borrowUsd - 430) ** 2 / 1_000,
        result: borrowUsd,
      }),
    });
    assert.ok(optimized);
    assert.ok(Math.abs(optimized.borrowUsd - 430) < 15);
    assert.ok(optimized.sampledSizes.length > 6);
  });

  it("can use a bounded coarse search for expensive long routes", async () => {
    const evaluated: number[] = [];
    const optimized = await optimizeUsdSize({
      maxBorrowUsd: 1_000,
      coarseRatios: [0.5, 1],
      refinementIterations: 0,
      evaluate: async (borrowUsd) => {
        evaluated.push(borrowUsd);
        return { score: borrowUsd, result: borrowUsd };
      },
    });

    assert.deepEqual(evaluated, [500, 1_000]);
    assert.deepEqual(optimized?.sampledSizes, [500, 1_000]);
    assert.equal(optimized?.borrowUsd, 1_000);
  });
});
