export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/// Standard Chainlink AggregatorV3Interface — used only to size USD trade
/// amounts into a non-stablecoin quote token's units (e.g. WETH). Never used
/// as a settlement/profit check — that's still enforced purely on-chain by
/// ArbExecutor's basis-points-of-principal `minProfit` floor.
export const chainlinkAggregatorAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  // Only on the EACAggregatorProxy contracts we call (priceOracle.ts's
  // PRICE_FEEDS), not on a raw aggregator — returns the underlying OCR
  // transmitter contract that actually receives price updates. Needed by
  // mempoolOracleWatcher's `toAddress` filter: pending txs land on the
  // transmitter, never on the proxy itself.
  {
    type: "function",
    name: "aggregator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/// Standard UniswapV2Router02-style interface — matches both Sushiswap V2
/// and Camelot V2's AMMv2 routers (both are UniswapV2Router02 forks).
export const uniswapV2RouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getAmountsIn",
    stateMutability: "view",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export const wrappedNativeAbi = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/// Velodrome/Aerodrome V2 pool quoting is pool-specific and already includes
/// the pool's stable/volatile invariant and configured dynamic fee.
export const solidlyV2PoolAbi = [
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "tokenIn", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "stable",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const solidlyV2RouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export const slipstreamPoolAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "factory", type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ name: "tickSpacing", type: "int24" }] },
] as const;

export const slipstreamQuoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "tickSpacing", type: "int24" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ] }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const slipstreamRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ] }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const liquidityBookPairAbi = [
  { type: "function", name: "getTokenX", stateMutability: "view", inputs: [], outputs: [{ name: "tokenX", type: "address" }] },
  { type: "function", name: "getTokenY", stateMutability: "view", inputs: [], outputs: [{ name: "tokenY", type: "address" }] },
  { type: "function", name: "getBinStep", stateMutability: "view", inputs: [], outputs: [{ name: "binStep", type: "uint16" }] },
  { type: "function", name: "getFactory", stateMutability: "view", inputs: [], outputs: [{ name: "factory", type: "address" }] },
  {
    type: "function",
    name: "getSwapOut",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint128" }, { name: "swapForY", type: "bool" }],
    outputs: [{ name: "amountInLeft", type: "uint128" }, { name: "amountOut", type: "uint128" }, { name: "fee", type: "uint128" }],
  },
] as const;

export const liquidityBookRouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const syncSwapV1PoolAbi = [
  { type: "function", name: "master", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "sender", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const syncSwapV1RouterAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "paths",
        type: "tuple[]",
        components: [
          {
            name: "steps",
            type: "tuple[]",
            components: [
              { name: "pool", type: "address" },
              { name: "data", type: "bytes" },
              { name: "callback", type: "address" },
              { name: "callbackData", type: "bytes" },
            ],
          },
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
        ],
      },
      { name: "amountOutMin", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }],
  },
] as const;

export const algebraPoolAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export const algebraQuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "limitSqrtPrice", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "fee", type: "uint16" }],
  },
] as const;

export const algebraSwapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "limitSqrtPrice", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/// Minimal fragment of Uniswap V3's IUniswapV3PoolState — just enough to
/// read the pool's fee tier, which `exactInputSingle` requires and the
/// scanner API does not currently expose.
export const uniswapV3PoolAbi = [
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
] as const;

/// Minimal fragment of Uniswap V3's Quoter (v1.0.0). The real contract
/// isn't `view` (it reverts internally to return data), but it's still
/// always called here via `eth_call` / viem's `readContract` — never sends a
/// transaction. Declared `view` in this local ABI purely so viem infers a
/// concrete return type instead of `never`; it has no effect on how the
/// call is actually made.
export const uniswapV3QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/// Minimal fragment of Uniswap's QuoterV2 (struct-based params, distinct
/// from the V1 Quoter's positional-args ABI above). Sushiswap's V3 fork
/// deploys QuoterV2, not V1 — see dexRegistry.ts.
export const uniswapV3QuoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/// Minimal fragment of Uniswap V3's ISwapRouter (SwapRouter v1.0.0).
export const uniswapV3SwapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/// SwapRouter02's exactInputSingle omits the `deadline` member used by the
/// legacy V3 SwapRouter. Uniswap's current per-chain deployments use this ABI
/// on the ten newly monitored networks.
export const uniswapV3SwapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/// Curve StableSwap pool — the pool contract IS the router (no separate
/// router/quoter). `int128` coin indices verified live against real deployed
/// pools (3pool, DOLA/sUSDe) — some newer factory pools use `uint256`
/// indices instead, but every pool in curveRegistry.ts has been confirmed
/// against this exact signature via `cast call`, not assumed from docs.
export const curvePoolAbi = [
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "dy", type: "uint256" }],
  },
  {
    type: "function",
    name: "exchange",
    stateMutability: "nonpayable",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "dy", type: "uint256" }],
  },
] as const;

export const curvePoolUintAbi = [
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "uint256" },
      { name: "j", type: "uint256" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "dy", type: "uint256" }],
  },
  {
    type: "function",
    name: "exchange",
    stateMutability: "nonpayable",
    inputs: [
      { name: "i", type: "uint256" },
      { name: "j", type: "uint256" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "dy", type: "uint256" }],
  },
] as const;

export const curvePoolCoinsAbi = [
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "coin", type: "address" }],
  },
] as const;

export const balancerPoolAbi = [
  { type: "function", name: "getPoolId", stateMutability: "view", inputs: [], outputs: [{ name: "poolId", type: "bytes32" }] },
] as const;

export const balancerVaultAbi = [
  {
    type: "function",
    name: "queryBatchSwap",
    stateMutability: "view",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "swaps", type: "tuple[]", components: [
        { name: "poolId", type: "bytes32" },
        { name: "assetInIndex", type: "uint256" },
        { name: "assetOutIndex", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "userData", type: "bytes" },
      ] },
      { name: "assets", type: "address[]" },
      { name: "funds", type: "tuple", components: [
        { name: "sender", type: "address" },
        { name: "fromInternalBalance", type: "bool" },
        { name: "recipient", type: "address" },
        { name: "toInternalBalance", type: "bool" },
      ] },
    ],
    outputs: [{ name: "assetDeltas", type: "int256[]" }],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      { name: "singleSwap", type: "tuple", components: [
        { name: "poolId", type: "bytes32" },
        { name: "kind", type: "uint8" },
        { name: "assetIn", type: "address" },
        { name: "assetOut", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "userData", type: "bytes" },
      ] },
      { name: "funds", type: "tuple", components: [
        { name: "sender", type: "address" },
        { name: "fromInternalBalance", type: "bool" },
        { name: "recipient", type: "address" },
        { name: "toInternalBalance", type: "bool" },
      ] },
      { name: "limit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountCalculated", type: "uint256" }],
  },
] as const;

/// Matches artifacts/arb-executor/src/ArbExecutor.sol.
export const arbExecutorAbi = [
  {
    type: "function",
    name: "withdrawToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "POOL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "initiateArbitrage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "minProfit", type: "uint256" },
      { name: "profitToken", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowedTargets",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const aavePoolPremiumAbi = [
  {
    type: "function",
    name: "FLASHLOAN_PREMIUM_TOTAL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;
