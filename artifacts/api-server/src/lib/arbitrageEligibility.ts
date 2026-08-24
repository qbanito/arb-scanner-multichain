export type PairToken = { address?: string; symbol?: string };

export type MarketPair = {
  baseToken?: PairToken;
  quoteToken?: PairToken;
  priceUsd?: string;
  priceNative?: string;
};

export type RouteVenue = {
  dexId: string;
  labels?: string[];
  quoteTokenAddress?: string;
};

const STABLE_QUOTES: Record<number, Set<string>> = {
  1: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", // GHO
  ]),
  42161: new Set([
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // native USDC
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e
    "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33", // GHO
  ]),
  10: new Set([
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  ]),
  137: new Set([
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // native USDC
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  ]),
  8453: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
    "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee", // GHO
  ]),
  43114: new Set([
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDt
    "0xd586e7f844cea2f87f50152665bcbc2c279d8d70", // DAI.e
    "0xd24c2ad096400b6fbcd2ad8b24e7acbc21a1da64", // FRAX
    "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", // GHO
  ]),
  56: new Set([
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC (18 decimals on BNB)
    "0x55d398326f99059ff775485246999027b3197955", // USDT (18 decimals on BNB)
    "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD
    "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", // USD1
  ]),
  42220: new Set([
    "0xceba9300f2b948710d2653dd7b07f33a8b32118c", // USDC
    "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", // USDT
    "0x765de816845861e75a25fca122bb6898b8b1282a", // USDm
  ]),
  59144: new Set([
    "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", // USDC
    "0xa219439258ca9da29e9cc4ce5596924745e12b93", // USDT
  ]),
  5000: new Set([
    "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", // USDC
    "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0
    "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73", // GHO
  ]),
  534352: new Set(["0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4"]), // USDC
  146: new Set(["0x29219dd400f2bf60e5a23d13be72b486d4038894"]), // USDC
  324: new Set([
    "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4", // USDC
    "0x493257fd37edb34451f62edf8d2a0c418852ba4c", // USDT
  ]),
  1868: new Set([
    "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369", // USDC.e
    "0x3a337a6ada9d885b6ad95ec48f9b75f197b5ae35", // USDT
  ]),
};

const UNISWAP_V3_CHAINS = new Set([
  1, 10, 56, 137, 146, 324, 1868, 5000, 8453, 42161, 42220, 43114, 59144, 534352,
]);

// PancakeSwap's official Smart Router / V2 Router deployments. Infinity
// pools deliberately stay out until their dedicated planner and calldata
// encoder are implemented; they are not ABI-compatible with V2/V3.
const PANCAKESWAP_CHAINS = new Set([1, 56, 324, 8453, 42161, 59144]);
const SOLIDLY_V2_CHAINS: Record<string, Set<number>> = {
  velodrome: new Set([10]),
  aerodrome: new Set([8453]),
};
const LIQUIDITY_BOOK_CHAINS = new Set([42161, 43114]);
const CURVE_CHAINS = new Set([1, 10, 56, 137, 146, 324, 5000, 8453, 42161, 42220, 43114, 59144, 534352]);
const BALANCER_V2_CHAINS = new Set([1, 10, 56, 137, 42161, 43114]);
const SYNCSWAP_V1_CHAINS = new Set([324, 59144, 534352]);
const LYNEX_ALGEBRA_CHAINS = new Set([59144]);
const AGNI_V3_CHAINS = new Set([5000]);

const ORACLE_PRICED_QUOTES: Record<number, Set<string>> = {
  1: new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", // wstETH
    "0x514910771af9ca656af840dff83e8264ecf986ca", // LINK
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", // UNI
  ]),
  42161: new Set([
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", // WBTC
    "0x5979d7b546e38e414f7e9822514be443a4800529", // wstETH
  ]),
  56: new Set([
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  ]),
};

/** Normalize a DexScreener pair from the tracked token's point of view. */
export function normalizeTrackedPair(pair: MarketPair, trackedAddress: string) {
  const tracked = trackedAddress.toLowerCase();
  const base = pair.baseToken?.address?.toLowerCase();
  const quote = pair.quoteToken?.address?.toLowerCase();
  const basePriceUsd = Number(pair.priceUsd ?? 0);

  if (base === tracked) {
    return {
      priceUsd: basePriceUsd,
      counterTokenAddress: pair.quoteToken?.address,
      counterTokenSymbol: pair.quoteToken?.symbol,
    };
  }

  if (quote === tracked) {
    const basePerQuote = Number(pair.priceNative ?? 0);
    return {
      priceUsd: basePriceUsd > 0 && basePerQuote > 0 ? basePriceUsd / basePerQuote : 0,
      counterTokenAddress: pair.baseToken?.address,
      counterTokenSymbol: pair.baseToken?.symbol,
    };
  }

  return null;
}

export function venueSupported(chainId: number, venue: RouteVenue): boolean {
  const dex = venue.dexId.toLowerCase();
  const labels = new Set((venue.labels ?? []).map((label) => label.toLowerCase()));

  if (dex === "uniswap") {
    if (labels.has("v4")) return false;
    if (labels.has("v2")) return chainId === 1;
    return UNISWAP_V3_CHAINS.has(chainId);
  }
  if (dex === "sushiswap") return labels.has("v3") ? chainId === 42161 : chainId === 1 || chainId === 42161;
  if (dex === "camelot") return chainId === 42161 && !labels.has("v3") && !labels.has("v4");
  if (dex === "pancakeswap") {
    if (labels.has("v1") || labels.has("infinity") || labels.has("v4")) return false;
    return PANCAKESWAP_CHAINS.has(chainId);
  }
  if (dex === "velodrome") {
    // DexScreener labels concentrated-liquidity Slipstream pools with no
    // version, while its constant-product pools carry `v2` on Optimism.
    return !labels.has("v1") && SOLIDLY_V2_CHAINS.velodrome.has(chainId);
  }
  if (dex === "aerodrome") {
    // Aerodrome currently omits the V2 label. The auto adapter probes the
    // invariant-aware V2 quote first, then the pool's verified Slipstream
    // factory/tick-spacing deployment; neither is guessed from the label.
    return SOLIDLY_V2_CHAINS.aerodrome.has(chainId);
  }
  if (dex === "traderjoe" || dex === "lfj") {
    // Liquidity Book is bin-based and has dynamic fees. It is handled by a
    // dedicated pair quote/router adapter, never by the V2 reserve formula.
    return !labels.has("v1") && LIQUIDITY_BOOK_CHAINS.has(chainId);
  }
  if (dex === "curve") return CURVE_CHAINS.has(chainId);
  if (dex === "balancer") return !labels.has("v3") && BALANCER_V2_CHAINS.has(chainId);
  if (dex === "syncswap") {
    // V1 Classic/Stable pools are capability-checked against their verified
    // Pool Master during quoting. V2/V3 have distinct execution interfaces.
    return !labels.has("v3") && SYNCSWAP_V1_CHAINS.has(chainId);
  }
  if (dex === "lynex") return LYNEX_ALGEBRA_CHAINS.has(chainId);
  if (dex === "agni") return AGNI_V3_CHAINS.has(chainId);
  return false;
}

export function isStableQuote(chainId: number, tokenAddress: string): boolean {
  return STABLE_QUOTES[chainId]?.has(tokenAddress.toLowerCase()) ?? false;
}

/** Cheap preflight matching executor-bot's currently routable universe. */
export function routeEligible(chainId: number, trackedAddress: string, buy: RouteVenue, sell: RouteVenue): boolean {
  const buyQuote = buy.quoteTokenAddress?.toLowerCase();
  const sellQuote = sell.quoteTokenAddress?.toLowerCase();
  if (!buyQuote || !sellQuote) return false;
  if (buyQuote === trackedAddress.toLowerCase()) return false;
  const buyIsStable = STABLE_QUOTES[chainId]?.has(buyQuote) ?? false;
  const sellIsStable = STABLE_QUOTES[chainId]?.has(sellQuote) ?? false;
  const buyIsOraclePriced = ORACLE_PRICED_QUOTES[chainId]?.has(buyQuote) ?? false;
  const sellIsOraclePriced = ORACLE_PRICED_QUOTES[chainId]?.has(sellQuote) ?? false;
  if (!(buyIsStable || buyIsOraclePriced) || !(sellIsStable || sellIsOraclePriced))
    return false;
  // Ethereum's verified Curve 3pool closes DAI/USDC/USDT cross-quote cycles.
  // GHO is stable-priced but is not a 3pool coin, so it still requires the
  // same quote on both legs. Arbitrum has no curated closing pool yet.
  if (buyQuote !== sellQuote) {
    const ethereum3Pool = new Set([
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
    ]);
    if (
      !buyIsStable ||
      !sellIsStable ||
      chainId !== 1 ||
      !ethereum3Pool.has(buyQuote) ||
      !ethereum3Pool.has(sellQuote)
    )
      return false;
  }
  return venueSupported(chainId, buy) && venueSupported(chainId, sell);
}
