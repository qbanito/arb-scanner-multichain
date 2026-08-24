import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStableQuote, normalizeTrackedPair, routeEligible, venueSupported } from "./arbitrageEligibility";

const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("normalizeTrackedPair", () => {
  it("uses the quote token as counterasset when the tracked token is base", () => {
    const result = normalizeTrackedPair({
      baseToken: { address: CRV, symbol: "CRV" },
      quoteToken: { address: USDC, symbol: "USDC" },
      priceUsd: "0.32",
    }, CRV);
    assert.deepEqual(result, { priceUsd: 0.32, counterTokenAddress: USDC, counterTokenSymbol: "USDC" });
  });

  it("uses the base token as counterasset when the tracked token is quote", () => {
    const crvUsd = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
    const result = normalizeTrackedPair({
      baseToken: { address: crvUsd, symbol: "crvUSD" },
      quoteToken: { address: CRV, symbol: "CRV" },
      priceUsd: "1.00",
      priceNative: "3.125",
    }, CRV);
    assert.deepEqual(result, { priceUsd: 0.32, counterTokenAddress: crvUsd, counterTokenSymbol: "crvUSD" });
  });
});

describe("routeEligible", () => {
  it("accepts two supported Uniswap V3 legs sharing USDC", () => {
    const venue = { dexId: "uniswap", labels: ["v3"], quoteTokenAddress: USDC };
    assert.equal(routeEligible(1, CRV, venue, venue), true);
  });

  it("accepts Curve through its dedicated adapter and rejects malformed quote assets", () => {
    const uniswap = { dexId: "uniswap", labels: ["v3"], quoteTokenAddress: USDC };
    assert.equal(routeEligible(1, CRV, uniswap, { dexId: "curve", quoteTokenAddress: USDC }), true);
    assert.equal(routeEligible(1, CRV, uniswap, { ...uniswap, quoteTokenAddress: CRV }), false);
    assert.equal(routeEligible(1, CRV, { ...uniswap, quoteTokenAddress: CRV }, { ...uniswap, quoteTokenAddress: CRV }), false);
  });

  it("accepts current Uniswap V3 routes on additional networks but never V4", () => {
    const baseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const baseWeth = "0x4200000000000000000000000000000000000006";
    const v3 = { dexId: "uniswap", labels: ["v3"], quoteTokenAddress: baseUsdc };
    assert.equal(routeEligible(8453, baseWeth, v3, v3), true);
    assert.equal(routeEligible(8453, baseWeth, { ...v3, labels: ["v4"] }, v3), false);
  });

  it("accepts dedicated Pancake and Solidly adapters only on verified versions", () => {
    assert.equal(venueSupported(56, { dexId: "pancakeswap", labels: ["v2"] }), true);
    assert.equal(venueSupported(42161, { dexId: "pancakeswap", labels: ["v3"] }), true);
    assert.equal(venueSupported(56, { dexId: "pancakeswap", labels: ["infinity"] }), false);
    assert.equal(venueSupported(10, { dexId: "velodrome", labels: ["v2"] }), true);
    assert.equal(venueSupported(10, { dexId: "velodrome", labels: [] }), true);
    assert.equal(venueSupported(8453, { dexId: "aerodrome", labels: [] }), true);
  });

  it("allows same-WBNB Pancake meme arbitrage but not an unpriced mixed quote", () => {
    const shib = "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D";
    const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const usdt = "0x55d398326f99059fF775485246999027B3197955";
    const v2 = { dexId: "pancakeswap", labels: ["v2"], quoteTokenAddress: wbnb };
    const v3 = { dexId: "pancakeswap", labels: ["v3"], quoteTokenAddress: wbnb };

    assert.equal(routeEligible(56, shib, v2, v3), true);
    assert.equal(routeEligible(56, shib, v2, { ...v3, quoteTokenAddress: usdt }), false);
    assert.equal(isStableQuote(56, "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d"), true);
  });

  it("enables verified SyncSwap, Lynex and Agni deployments", () => {
    assert.equal(venueSupported(324, { dexId: "syncswap", labels: [] }), true);
    assert.equal(venueSupported(324, { dexId: "syncswap", labels: ["v3"] }), false);
    assert.equal(venueSupported(59144, { dexId: "lynex", labels: [] }), true);
    assert.equal(venueSupported(5000, { dexId: "agni", labels: [] }), true);
    assert.equal(venueSupported(8453, { dexId: "agni", labels: [] }), false);
    assert.equal(isStableQuote(59144, "0x176211869cA2b568f2A7D4EE941E073a821EE1ff"), true);
  });
});
