import { formatUnits, parseUnits, type PublicClient } from "viem";
import { chainlinkAggregatorAbi } from "./abis";
import { logger } from "./logger";

/// Chainlink price feeds. Used to size `MAX_BORROW_USD` into a
/// non-stablecoin quote token's units (e.g. WETH), and to convert a gas
/// estimate (always paid in the chain's native ETH) into USD so it can be
/// weighed against expected profit before ever sending a transaction. Never
/// used as the on-chain profitability check itself — that backstop is
/// ArbExecutor's basis-points-of-principal `minProfit` floor, which needs no
/// price data at all.
///
/// Addresses are Aave V3's own configured price sources for these assets
/// (bgd-labs/aave-address-book's AaveV3Ethereum/AaveV3Arbitrum `*_ORACLE`
/// constants, fetched from the raw source file — not WebFetch's AI summary,
/// which has mangled a hex address before) — reusing oracle addresses Aave
/// itself trusts enough to price loan collateral with. Added WBTC/wstETH/
/// LINK/UNI after backtestLiquidations.ts showed these as the debt asset on
/// real historical liquidations that this bot would otherwise silently skip
/// pricing (and therefore skip entirely) for lack of a feed.
const PRICE_FEEDS: Record<number, Record<string, `0x${string}`>> = {
  1: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "0x5424384B256154046E9667dDFaaa5e550145215e", // WETH/USD
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "0xDaa4B74C6bAc4e25188e64ebc68DB5050b690cAc", // WBTC/USD
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "0xe1D97bF61901B075E9626c8A2340a7De385861Ef", // wstETH/USD
    "0x514910771af9ca656af840dff83e8264ecf986ca": "0xC7e9b623ed51F033b32AE7f1282b1AD62C28C183", // LINK/USD
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "0x553303d460EE0afB37EdFf9bE42922D8FF63220e", // UNI/USD
  },
  42161: {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "0xbD41b1548a5A06544cBcf87c0c54864312842C00", // WETH/USD
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": "0xDe4Af8b4747192Ea29339D0FeB36d9830d399134", // WBTC/USD
    "0x5979d7b546e38e414f7e9822514be443a4800529": "0xb4a28DF1b926646f94e6fE6f15828c491b4def5F", // wstETH/USD
  },
  10: {
    "0x4200000000000000000000000000000000000006": "0x13e3Ee699D1909E989722E753853AE30b17e08c5", // WETH/USD
  },
  137: {
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "0xF9680D99D6C9589e2a93a78A04A279e509205945", // WETH/USD
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", // WPOL/USD
  },
  8453: { "0x4200000000000000000000000000000000000006": "0x9dA00D23465282005DB222a441a663eE7B9dfCc8" }, // WETH/USD
  43114: { "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": "0x0A77230d17318075983913bC2145DB16C7366156" }, // WAVAX/USD
  56: { "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE" }, // WBNB/USD
  42220: { "0x471ece3750da237f93b8e339c536989b8978a438": "0x0568fD19986748cEfF3301e55c0eb1E729E0Ab7e" }, // CELO/USD
  59144: { "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f": "0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA" }, // WETH/USD
  5000: { "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8": "0xD97F20bEbeD74e8144134C4b148fE93417dd0F96" }, // WMNT/USD
  534352: { "0x5300000000000000000000000000000000000004": "0x6bF14CB0A831078629D993FDeBcB182b21A8774C" }, // WETH/USD
  146: { "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38": "0xc76dFb89fF298145b417d221B2c747d84952e01d" }, // wS/USD
  324: { "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91": "0x6D41d1dc818112880b40e26BD6FD347E41008eDA" }, // WETH/USD
  1868: { "0x4200000000000000000000000000000000000006": "0x291cF980BA12505D65ee01BDe0882F1d5e533525" }, // WETH/USD
};

// The wrapped native asset's USD feed prices gas: WETH on ETH L1/L2s and
// WPOL on Polygon. Never use WETH/USD for Polygon gas.
const WRAPPED_NATIVE_ADDRESS: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  10: "0x4200000000000000000000000000000000000006",
  137: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  8453: "0x4200000000000000000000000000000000000006",
  43114: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  42220: "0x471ece3750da237f93b8e339c536989b8978a438",
  59144: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f",
  5000: "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8",
  534352: "0x5300000000000000000000000000000000000004",
  146: "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38",
  324: "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91",
  1868: "0x4200000000000000000000000000000000000006",
};

export function priceFeedFor(chainId: number, tokenAddress: string): `0x${string}` | null {
  return PRICE_FEEDS[chainId]?.[tokenAddress.toLowerCase()] ?? null;
}

type OraclePrice = { answer: bigint; decimals: number };

async function readUsdPrice(client: PublicClient, feed: `0x${string}`): Promise<OraclePrice | null> {
  try {
    const [decimals, roundData] = await Promise.all([
      client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
      client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
    ]);
    const [, answer, , updatedAt] = roundData;

    // Refuse a stale price rather than size/gate a trade off it. 1 hour is
    // generous relative to this feed's ~300s heartbeat; it exists to catch
    // a genuinely broken/paused feed, not to fine-tune freshness.
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
    if (answer <= 0n || ageSeconds > 3600) {
      logger.warn({ feed, answer: answer.toString(), ageSeconds }, "price feed answer is stale or non-positive");
      return null;
    }

    return { answer, decimals };
  } catch (err) {
    logger.warn({ err, feed }, "failed to read price feed");
    return null;
  }
}

/// Returns how many of `tokenAddress`'s smallest units are worth `usdAmount`,
/// or `null` if there's no verified price feed for this token/chain — the
/// caller should skip rather than guess.
export async function usdToTokenAmount(
  client: PublicClient,
  chainId: number,
  tokenAddress: string,
  tokenDecimals: number,
  usdAmount: number,
): Promise<bigint | null> {
  const feed = priceFeedFor(chainId, tokenAddress);
  if (!feed) return null;
  const price = await readUsdPrice(client, feed);
  if (price === null || !Number.isFinite(usdAmount) || usdAmount <= 0) return null;

  // Keep sizing entirely in integer space. The old number division could
  // turn exactly 0.05 WETH into 0.050000000000000003 WETH, adding a few wei
  // before parseUnits. Eight USD decimal places match the precision of the
  // feeds currently configured here while still supporting fractional
  // MAX_BORROW_USD values.
  const usdDecimals = 8;
  const usdUnits = parseUnits(usdAmount.toFixed(usdDecimals), usdDecimals);
  if (usdUnits <= 0n) return null;

  return (
    usdUnits * 10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.decimals)
  ) / (10n ** BigInt(usdDecimals) * price.answer);
}

/// Inverse of `usdToTokenAmount` — how many USD is `amount` of `tokenAddress`
/// worth, or `null` if there's no verified price feed.
export async function tokenAmountToUsd(
  client: PublicClient,
  chainId: number,
  tokenAddress: string,
  tokenDecimals: number,
  amount: bigint,
): Promise<number | null> {
  const feed = priceFeedFor(chainId, tokenAddress);
  if (!feed) return null;
  const price = await readUsdPrice(client, feed);
  if (price === null) return null;

  return Number(formatUnits(amount, tokenDecimals)) * (Number(price.answer) / 10 ** price.decimals);
}

/// USD value of `weiAmount` of the chain's native ETH — used to convert a
/// gas estimate into a comparable unit before checking it against expected
/// profit. `null` if this chain has no verified WETH/USD feed.
export async function nativeEthAmountToUsd(client: PublicClient, chainId: number, weiAmount: bigint): Promise<number | null> {
  const wrappedNative = WRAPPED_NATIVE_ADDRESS[chainId];
  if (!wrappedNative) return null;
  return tokenAmountToUsd(client, chainId, wrappedNative, 18, weiAmount);
}

/// Inverse of `nativeEthAmountToUsd` — how much native-ETH wei `usdAmount` is
/// worth right now. Used by dynamicPriorityFee.ts to convert "how much extra
/// tip we're willing to pay" from USD into wei-per-gas.
export async function usdToNativeEthAmount(client: PublicClient, chainId: number, usdAmount: number): Promise<bigint | null> {
  const wrappedNative = WRAPPED_NATIVE_ADDRESS[chainId];
  if (!wrappedNative) return null;
  return usdToTokenAmount(client, chainId, wrappedNative, 18, usdAmount);
}
