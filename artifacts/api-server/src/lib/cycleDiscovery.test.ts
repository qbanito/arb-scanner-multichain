import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findAtomicCycles, findBestConversionPath, findPrioritizedCycles, findTriangularCycles, type CyclePool, type CycleToken } from "./cycleDiscovery";

const usdc: CycleToken = { address: "0x0000000000000000000000000000000000000001", symbol: "USDC", decimals: 6 };
const weth: CycleToken = { address: "0x0000000000000000000000000000000000000002", symbol: "WETH", decimals: 18 };
const link: CycleToken = { address: "0x0000000000000000000000000000000000000003", symbol: "LINK", decimals: 18 };
const uni: CycleToken = { address: "0x0000000000000000000000000000000000000004", symbol: "UNI", decimals: 18 };
const aave: CycleToken = { address: "0x0000000000000000000000000000000000000005", symbol: "AAVE", decimals: 18 };
const crv: CycleToken = { address: "0x0000000000000000000000000000000000000006", symbol: "CRV", decimals: 18 };
const wbnb: CycleToken = { address: "0x0000000000000000000000000000000000000007", symbol: "WBNB", decimals: 18 };
const pepe: CycleToken = { address: "0x0000000000000000000000000000000000000008", symbol: "PEPE", decimals: 18 };

function pool(id: number, base: CycleToken, quote: CycleToken, rate: number): CyclePool<string> {
  return { pairAddress: `0x${id.toString(16).padStart(40, "0")}`, liquidityUsd: 1_000_000, feeBps: 30, base, quote, baseToQuote: rate, venue: `venue-${id}` };
}

describe("findTriangularCycles", () => {
  it("finds a profitable complete A -> B -> C -> A route", () => {
    const result = findTriangularCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
      pool(3, link, usdc, 21),
    ], new Set([usdc.address]), { minEstimatedBps: 1 });

    assert.equal(result.length, 1);
    assert.deepEqual(result[0]!.legs.map((leg) => leg.tokenIn.symbol), ["USDC", "WETH", "LINK"]);
    assert.equal(result[0]!.legs[2].tokenOut.symbol, "USDC");
    assert.ok(result[0]!.estimatedGrossBps > 0);
  });

  it("rejects an open path and a cycle whose fees consume its spread", () => {
    const open = findTriangularCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
    ], new Set([usdc.address]));
    const feeLoss = findTriangularCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
      pool(3, link, usdc, 20),
    ], new Set([usdc.address]));

    assert.equal(open.length, 0);
    assert.equal(feeLoss.length, 0);
  });
});

describe("findAtomicCycles", () => {
  it("finds four-hop cycles while keeping every token and pool unique", () => {
    const result = findAtomicCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
      pool(3, uni, link, 0.5),
      pool(4, uni, usdc, 11),
    ], new Set([usdc.address]), { minHops: 4, maxHops: 4, minEstimatedBps: 1 });

    assert.equal(result.length, 1);
    assert.deepEqual(result[0]!.legs.map((leg) => leg.tokenIn.symbol), ["USDC", "WETH", "LINK", "UNI"]);
    assert.equal(result[0]!.legs.at(-1)!.tokenOut.symbol, "USDC");
  });

  it("honors the global path exploration budget", () => {
    const result = findAtomicCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
      pool(3, link, usdc, 21),
    ], new Set([usdc.address]), { maxExploredPaths: 1 });

    assert.equal(result.length, 0);
  });

  it("finds a six-hop route and closes it in the flash-borrowed asset", () => {
    const result = findAtomicCycles([
      pool(1, weth, usdc, 2_000),
      pool(2, link, weth, 0.01),
      pool(3, uni, link, 0.5),
      pool(4, aave, uni, 2),
      pool(5, crv, aave, 0.5),
      pool(6, crv, usdc, 11),
    ], new Set([usdc.address]), { minHops: 6, maxHops: 6, minEstimatedBps: 1 });

    assert.equal(result.length, 1);
    assert.equal(result[0]!.legs.length, 6);
    assert.equal(result[0]!.legs.at(-1)!.tokenOut.symbol, "USDC");
  });
});

describe("findPrioritizedCycles", () => {
  it("constructs the requested sequence even when unrelated graph branches rank first", () => {
    const result = findPrioritizedCycles(
      [
        pool(1, weth, usdc, 2_000),
        pool(2, link, weth, 0.01),
        pool(3, link, usdc, 21),
        pool(4, uni, usdc, 10_000),
      ],
      [{ id: "usdc-weth-link", tokenAddresses: [usdc.address, weth.address, link.address, usdc.address] }],
      new Set([usdc.address]),
      { minEstimatedBps: 1 },
    );

    assert.equal(result.length, 1);
    assert.equal(result[0]!.templateId, "usdc-weth-link");
    assert.deepEqual(result[0]!.legs.map((leg) => leg.tokenIn.symbol), ["USDC", "WETH", "LINK"]);
    assert.equal(result[0]!.legs.at(-1)!.tokenOut.symbol, "USDC");
  });

  it("does not invent a priority route when an edge or flash-borrow asset is missing", () => {
    const pools = [pool(1, weth, usdc, 2_000), pool(2, link, weth, 0.01)];
    const template = [{ id: "missing-close", tokenAddresses: [usdc.address, weth.address, link.address, usdc.address] }];

    assert.equal(findPrioritizedCycles(pools, template, new Set([usdc.address])).length, 0);
    assert.equal(
      findPrioritizedCycles([...pools, pool(3, link, usdc, 21)], template, new Set([weth.address])).length,
      0,
    );
  });

  it("requires two independent pools for a WBNB meme-token flash cycle", () => {
    const template = [{ id: "bsc-meme-pepe", tokenAddresses: [wbnb.address, pepe.address, wbnb.address] }];
    const onePool = pool(7, wbnb, pepe, 1_000_000);
    const twoPoolCycle = findPrioritizedCycles(
      [
        onePool,
        // The second pool has a genuine, fee-adjusted price difference.
        pool(8, wbnb, pepe, 1_015_000),
      ],
      template,
      new Set([wbnb.address]),
      { minEstimatedBps: 1 },
    );

    assert.equal(
      findPrioritizedCycles([onePool], template, new Set([wbnb.address]), { minEstimatedBps: 1 }).length,
      0,
    );
    assert.equal(twoPoolCycle.length, 1);
    assert.deepEqual(twoPoolCycle[0]!.legs.map((leg) => leg.tokenIn.symbol), ["WBNB", "PEPE"]);
    assert.notEqual(twoPoolCycle[0]!.legs[0]!.poolAddress, twoPoolCycle[0]!.legs[1]!.poolAddress);
    assert.equal(twoPoolCycle[0]!.legs.at(-1)!.tokenOut.symbol, "WBNB");
  });
});

describe("findBestConversionPath", () => {
  it("closes two stable assets through the best fee-adjusted path", () => {
    const usdt: CycleToken = { address: "0x0000000000000000000000000000000000000007", symbol: "USDT", decimals: 6 };
    const dai: CycleToken = { address: "0x0000000000000000000000000000000000000008", symbol: "DAI", decimals: 18 };
    const direct = pool(7, usdt, usdc, 0.997);
    const viaDaiA = pool(8, usdt, dai, 1.002);
    const viaDaiB = pool(9, dai, usdc, 1.002);
    direct.feeBps = 30;
    viaDaiA.feeBps = 4;
    viaDaiB.feeBps = 4;

    const result = findBestConversionPath([direct, viaDaiA, viaDaiB], usdt.address, usdc.address);

    assert.deepEqual(result?.map((leg) => leg.tokenOut.symbol), ["DAI", "USDC"]);
  });

  it("honors excluded pools and tokens while closing a route", () => {
    const usdt: CycleToken = { address: "0x0000000000000000000000000000000000000007", symbol: "USDT", decimals: 6 };
    const result = findBestConversionPath(
      [pool(7, usdt, usdc, 1), pool(8, usdt, weth, 0.0005), pool(9, weth, usdc, 2_000)],
      usdt.address,
      usdc.address,
      {
        excludedPoolAddresses: new Set([`0x${(7).toString(16).padStart(40, "0")}`]),
        excludedTokenAddresses: new Set([weth.address]),
      },
    );
    assert.equal(result, null);
  });
});
