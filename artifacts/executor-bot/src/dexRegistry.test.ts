import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dexKindFor, factoryFor, quoterFor, resolveDex, routerFor, verifierFor } from "./dexRegistry";

describe("multi-network Uniswap registry", () => {
  it("has a router and quoter for every scanner network", () => {
    const chainIds = [1, 10, 56, 137, 146, 324, 1868, 5000, 8453, 42161, 42220, 43114, 59144, 534352];
    for (const chainId of chainIds) {
      assert.ok(routerFor("uniswap-v3", chainId), `missing router on ${chainId}`);
      assert.ok(quoterFor("uniswap-v3", chainId), `missing quoter on ${chainId}`);
    }
  });

  it("selects Router02 calldata only for current per-chain deployments", () => {
    assert.equal(dexKindFor("uniswap-v3", 8453), "univ3-quoter-v2-router02");
    assert.equal(dexKindFor("uniswap-v3", 42220), "univ3-quoter-v1");
    assert.equal(dexKindFor("uniswap-v3", 1), "univ3-quoter-v1");
  });

  it("resolves PancakeSwap versions without treating Infinity as V3", () => {
    assert.equal(resolveDex("pancakeswap", ["v2"]), "pancakeswap-v2");
    assert.equal(resolveDex("pancakeswap", ["v3"]), "pancakeswap-v3");
    assert.equal(resolveDex("pancakeswap", ["infinity"]), null);
    assert.equal(dexKindFor("pancakeswap-v3", 56), "univ3-quoter-v2");
    assert.ok(routerFor("pancakeswap-v2", 56));
    assert.ok(quoterFor("pancakeswap-v3", 42161));
  });

  it("uses Solidly route tuples for Velodrome and Aerodrome V2", () => {
    assert.equal(resolveDex("velodrome", ["v2"]), "velodrome-v2");
    assert.equal(resolveDex("velodrome", []), "velodrome-auto");
    assert.equal(resolveDex("aerodrome", []), "aerodrome-auto");
    assert.equal(dexKindFor("velodrome-v2", 10), "solidly-v2");
    assert.ok(routerFor("aerodrome-v2", 8453));
  });

  it("uses a dedicated bin-based adapter for LFJ Liquidity Book", () => {
    assert.equal(resolveDex("traderjoe", ["v2.2"]), "lfj-liquidity-book");
    assert.equal(resolveDex("lfj", []), "lfj-liquidity-book");
    assert.equal(resolveDex("traderjoe", ["v1"]), null);
    assert.equal(dexKindFor("lfj-liquidity-book", 43114), "liquidity-book");
    assert.ok(routerFor("lfj-liquidity-book", 42161));
  });

  it("routes Curve through its pool instead of a fake global router", () => {
    assert.equal(resolveDex("curve", []), "curve-pool");
    assert.equal(dexKindFor("curve-pool", 1), "curve-pool");
    assert.equal(routerFor("curve-pool", 1), null);
  });

  it("routes Balancer V2 through the canonical Vault", () => {
    assert.equal(resolveDex("balancer", ["v2"]), "balancer-v2");
    assert.equal(resolveDex("balancer", ["v3"]), null);
    assert.equal(dexKindFor("balancer-v2", 42161), "balancer-v2");
    assert.equal(routerFor("balancer-v2", 1)?.toLowerCase(), "0xba12222222228d8ba445958a75a0704d566bf2c8");
  });

  it("uses generation-specific SyncSwap deployments", () => {
    assert.equal(resolveDex("syncswap", []), "syncswap-v1");
    assert.equal(resolveDex("syncswap", ["v3"]), null);
    assert.equal(dexKindFor("syncswap-v1", 324), "syncswap-v1");
    assert.ok(routerFor("syncswap-v1", 59144));
    assert.ok(verifierFor("syncswap-v1", 324));
  });

  it("uses verified Algebra and Agni factories", () => {
    assert.equal(resolveDex("lynex", []), "lynex-algebra");
    assert.equal(dexKindFor("lynex-algebra", 59144), "algebra-v1.9");
    assert.ok(factoryFor("lynex-algebra", 59144));
    assert.ok(quoterFor("lynex-algebra", 59144));
    assert.equal(resolveDex("agni", []), "agni-v3");
    assert.equal(dexKindFor("agni-v3", 5000), "univ3-quoter-v2");
    assert.ok(factoryFor("agni-v3", 5000));
  });
});
