import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { arbitrum, mainnet } from "viem/chains";
import { bestSellQuote } from "./dexQuotes";
import { fetchMarketHistory } from "./historicalGas";
import { logger } from "./logger";

// Public information (which chains have a deployed ArbExecutor), not a
// secret — used only to explain, in the strategy panel, whether there's a
// contract to actually send a liquidation transaction from yet. Kept in
// sync by hand with artifacts/executor-bot/.env's ARB_EXECUTOR_* vars.
// Ethereum: 0x54aeB3ea939151b3A5fAC85e2f3B084872A2B544, deployed 2026-08-07,
// tx 0x529e4630535eadaf65264fed7f53792537ba80d1805f30f1a4765705bedbf02a.
const EXECUTOR_DEPLOYED: Record<number, boolean> = { 1: true, 42161: true };

// Same native-ETH/USD Chainlink feeds already verified in artifacts/
// executor-bot/src/priceOracle.ts, used only to price the historical gas
// estimate into USD.
const NATIVE_PRICE_FEED: Record<number, `0x${string}`> = {
  1: "0x5424384B256154046E9667dDFaaa5e550145215e",
  42161: "0xbD41b1548a5A06544cBcf87c0c54864312842C00",
};
const chainlinkAggregatorAbi = [
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
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// Verified against bgd-labs/aave-address-book (AaveV3Arbitrum.sol /
// AaveV3Ethereum.sol / AaveV3EthereumLido.sol / AaveV3EthereumEtherFi.sol —
// POOL / ORACLE / AAVE_PROTOCOL_DATA_PROVIDER), each cross-checked with real
// on-chain bytecode + a live getAssetPrice() / decimals() sanity call. This
// route is read-only display, but the data must be real, so it's held to the
// same verification standard as the execution bot.
//
// A chain can have several *isolated* Aave V3 markets — separate Pool
// deployments with their own borrowers/reserves, not just separate assets in
// one Pool. Ethereum alone has Main, Lido, and EtherFi markets (plus a
// Horizon RWA market deliberately left out — see below). Subgraph IDs from
// aave/protocol-subgraphs' README.md ("ETH Mainnet V3" / "ETH Mainnet V3
// Lido Market" / "ETH Mainnet V3 Etherfi Market" / "Arbitrum V3").
export type AaveMarket = {
  chainId: number;
  marketKey: string;
  marketName: string;
  pool: `0x${string}`;
  oracle: `0x${string}`;
  dataProvider: `0x${string}`;
  subgraphId: string;
};

// Horizon (Ethereum) is deliberately excluded: its reserves are tokenized
// RWA/treasury products (USTB, USYC, JAAA, ACRED...) which are near-certainly
// permissioned/whitelisted-transfer tokens — the same category of problem as
// Pendle PT tokens (see knownAssets.ts) — so a liquidator couldn't swap the
// seized collateral on any DEX this bot supports even if a position were
// found. Not worth the false confidence of listing it as "covered".
const AAVE_MARKETS: AaveMarket[] = [
  {
    chainId: 1,
    marketKey: "main",
    marketName: "Main Market",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    dataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
    subgraphId: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
  },
  {
    chainId: 1,
    marketKey: "lido",
    marketName: "Lido Market",
    pool: "0x4e033931ad43597d96D6bcc25c280717730B58B1",
    oracle: "0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6",
    dataProvider: "0xB85B2bFEbeC4F5f401dbf92ac147A3076391fCD5",
    subgraphId: "5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3",
  },
  {
    chainId: 1,
    marketKey: "etherfi",
    marketName: "EtherFi Market",
    pool: "0x0AA97c284e98396202b6A04024F5E2c65026F3c0",
    oracle: "0x43b64f28A678944E0655404B0B98E443851cC34F",
    dataProvider: "0x7c8509591f9693D21280d96e149a08A3bf69Cd0c",
    subgraphId: "8o4HGApJkAqnvxAHShG4w5xiXihHyL7HkeDdQdRUYmqZ",
  },
  {
    chainId: 42161,
    marketKey: "main",
    marketName: "Main Market",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    oracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    dataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    subgraphId: "DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B",
  },
];

function marketsForChain(chainId: number): AaveMarket[] {
  return AAVE_MARKETS.filter((m) => m.chainId === chainId);
}

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 42161: "Arbitrum One" };
const CHAIN_KEY: Record<number, string> = { 1: "ethereum", 42161: "arbitrum" };

// Verified from aave-v3-core's LiquidationLogic.sol (see
// artifacts/executor-bot/src/liquidation/liquidationExecutor.ts for the
// citation/line numbers).
const CLOSE_FACTOR_HF_THRESHOLD = 950_000_000_000_000_000n;
const DEFAULT_CLOSE_FACTOR_BPS = 5_000n;
const MAX_CLOSE_FACTOR_BPS = 10_000n;

type AssetInfo = { symbol: string; decimals: number };

/// The complete set of reserves for each Aave V3 market above (as of
/// writing), verified against bgd-labs/aave-address-book's `_UNDERLYING`
/// constants and cross-checked with real on-chain bytecode + decimals().
/// Only assets listed here are ever shown — an unlisted reserve is skipped,
/// never guessed.
const KNOWN_ASSETS: Record<number, Record<string, AssetInfo>> = {
  42161: {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18 },
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { symbol: "WBTC", decimals: 8 },
    "0x912ce59144191c1204e64559fe8253a0e49e6548": { symbol: "ARB", decimals: 18 },
    "0x5979d7b546e38e414f7e9822514be443a4800529": { symbol: "wstETH", decimals: 18 },
    "0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8": { symbol: "rETH", decimals: 18 },
    "0x35751007a407ca6feffe80b3cb397736d2cf4dbe": { symbol: "weETH", decimals: 18 },
    "0xf97f4df75117a78c1a5a0dbb814af92458539fb4": { symbol: "LINK", decimals: 18 },
    "0xba5ddd1f9d7f570dc94a51479a000e3bce967196": { symbol: "AAVE", decimals: 18 },
    "0xd22a58f79e9481d1a88e00c343885a588b34b68b": { symbol: "EURS", decimals: 2 },
    "0x3f56e0c36d275367b8c502090edf38289b3dea0d": { symbol: "MAI", decimals: 18 },
    "0x93b346b6bc2548da6a1e7d98e9a421b42541425b": { symbol: "LUSD", decimals: 18 },
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6 },
    "0x17fc002b466eec40dae837fc4be5c67993ddbd6f": { symbol: "FRAX", decimals: 18 },
    "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33": { symbol: "GHO", decimals: 18 },
    "0x2416092f143378750bb29b79ed961ab195cceea5": { symbol: "ezETH", decimals: 18 },
    "0x4186bfc76e2e237523cbc30fd220fe055156b41f": { symbol: "rsETH", decimals: 18 },
    "0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40": { symbol: "tBTC", decimals: 18 },
  },
  1: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": { symbol: "wstETH", decimals: 18 },
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { symbol: "WBTC", decimals: 8 },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
    "0x514910771af9ca656af840dff83e8264ecf986ca": { symbol: "LINK", decimals: 18 },
    "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9": { symbol: "AAVE", decimals: 18 },
    "0xbe9895146f7af43049ca1c1ae358b0541ea49704": { symbol: "cbETH", decimals: 18 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
    "0xae78736cd615f374d3085123a210448e74fc6393": { symbol: "rETH", decimals: 18 },
    "0x5f98805a4e8be255a32880fdec7f6728c6568ba0": { symbol: "LUSD", decimals: 18 },
    "0xd533a949740bb3306d119cc777fa900ba034cd52": { symbol: "CRV", decimals: 18 },
    "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2": { symbol: "MKR", decimals: 18 },
    "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f": { symbol: "SNX", decimals: 18 },
    "0xba100000625a3754423978a60c9317c58a424e3d": { symbol: "BAL", decimals: 18 },
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": { symbol: "UNI", decimals: 18 },
    "0x5a98fcbea516cf06857215779fd812ca3bef1b32": { symbol: "LDO", decimals: 18 },
    "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72": { symbol: "ENS", decimals: 18 },
    "0x111111111117dc0aa78b770fa6a738034120c302": { symbol: "1INCH", decimals: 18 },
    "0x853d955acef822db058eb8505911ed77f175b99e": { symbol: "FRAX", decimals: 18 },
    "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": { symbol: "GHO", decimals: 18 },
    "0xd33526068d116ce69f19a9ee46f0bd304f21a51f": { symbol: "RPL", decimals: 18 },
    "0x83f20f44975d03b1b09e64809b757c47f942beea": { symbol: "sDAI", decimals: 18 },
    "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6": { symbol: "STG", decimals: 18 },
    "0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202": { symbol: "KNC", decimals: 18 },
    "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0": { symbol: "FXS", decimals: 18 },
    "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e": { symbol: "crvUSD", decimals: 18 },
    "0x6c3ea9036406852006290770bedfcaba0e23a0e8": { symbol: "PYUSD", decimals: 6 },
    "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": { symbol: "weETH", decimals: 18 },
    "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38": { symbol: "osETH", decimals: 18 },
    "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": { symbol: "USDe", decimals: 18 },
    "0xa35b1b31ce002fbf2058d22f30f95d405200a15b": { symbol: "ETHx", decimals: 18 },
    "0x9d39a5de30e57443bff2a8307a4256c8797a3497": { symbol: "sUSDe", decimals: 18 },
    "0x18084fba666a33d37592fa2633fd49a74dd93a88": { symbol: "tBTC", decimals: 18 },
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8 },
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f": { symbol: "USDS", decimals: 18 },
    "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7": { symbol: "rsETH", decimals: 18 },
    "0x8236a87084f8b84306f72007f36f2618a5634494": { symbol: "LBTC", decimals: 8 },
    "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": { symbol: "eBTC", decimals: 8 },
    "0x8292bb45bf1ee4d140127049757c2e0ff06317ed": { symbol: "RLUSD", decimals: 18 },
    "0xc139190f447e929f090edeb554d95abb8b18ac1c": { symbol: "USDtb", decimals: 18 },
    "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f": { symbol: "eUSDe", decimals: 18 },
    "0xc96de26018a54d51c097160568752c4e3bd6c364": { symbol: "FBTC", decimals: 8 },
    "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c": { symbol: "EURC", decimals: 6 },
    "0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8": { symbol: "tETH", decimals: 18 },
    "0xbf5495efe5db9ce00f80364c8b423567e58d2110": { symbol: "ezETH", decimals: 18 },
    "0x68749665ff8d2d112fa859aa293f07a622782f38": { symbol: "XAUt", decimals: 6 },
    "0xaca92e438df0b2401ff60da7e4337b687a2435da": { symbol: "mUSD", decimals: 6 },
    "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d": { symbol: "syrupUSDT", decimals: 6 },
    "0xe343167631d89b6ffc58b88d6b7fb0228795491d": { symbol: "USDG", decimals: 6 },
    "0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072": { symbol: "BTCb", decimals: 8 },
  },
};

const aavePoolReadAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

const aaveOracleAbi = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const aaveDataProviderAbi = [
  {
    type: "function",
    name: "getReserveConfigurationData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const;

const clients = new Map<number, PublicClient>();
// Races two providers instead of depending on one — real, repeated 429s
// from the shared Alchemy key this session (this exact liquidation-scanning
// path is where the $2.17M position briefly vanished from results) are
// exactly the failure mode this exists to stop. `rank: true` continuously
// pings both and prefers whichever is currently healthier, so a provider
// mid-rate-limit gets naturally deprioritized. Same pattern as executor-bot's
// chains.ts, kept in sync deliberately — this file exists in a separate
// service, not because the fix should differ.
function getClient(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (client) return client;

  if (chainId === 1) {
    client = createPublicClient({
      chain: mainnet,
      transport: fallback(
        [http(process.env["ETHEREUM_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com"), http(process.env["ETHEREUM_RPC_URL_FALLBACK"] ?? "https://ethereum-rpc.publicnode.com")],
        { rank: true },
      ),
    });
  } else {
    client = createPublicClient({
      chain: arbitrum,
      transport: fallback(
        [http(process.env["ARBITRUM_RPC_URL"] ?? "https://arbitrum-one-rpc.publicnode.com"), http(process.env["ARBITRUM_RPC_URL_FALLBACK"] ?? "https://arbitrum-one-rpc.publicnode.com")],
        { rank: true },
      ),
    });
  }
  clients.set(chainId, client);
  return client;
}

type RawReserve = {
  usageAsCollateralEnabledOnUser: boolean;
  currentATokenBalance: string;
  currentTotalDebt: string;
  reserve: { underlyingAsset: string; symbol: string; decimals: string };
};

type BorrowerCandidate = {
  address: `0x${string}`;
  reserves: {
    underlyingAsset: string;
    currentATokenBalance: bigint;
    currentTotalDebt: bigint;
    usageAsCollateralEnabledOnUser: boolean;
  }[];
};

const PAGE_SIZE = 500;
// The Graph disallows `skip` beyond 5000 regardless — this stays well under
// that. Ethereum's main Aave market has far more than 500 active borrowers,
// and the subgraph orders by `id` (address), not by size, so only fetching
// one page means seeing an essentially arbitrary slice of them. Paginating
// several pages is what actually widens the net for finding more large
// positions, not any change to the pricing/ranking logic itself.
// Was 3 (1,500 candidates) — capped there because the sequential on-chain
// Health Factor check below was sharing a rate-limited public RPC with other
// services. Now on a dedicated Alchemy endpoint (see ETHEREUM_RPC_URL /
// ARBITRUM_RPC_URL), so widened back up to see more of each market.
const MAX_PAGES = 6; // up to 3,000 candidates per chain per request

async function fetchBorrowerCandidates(market: AaveMarket, graphApiKey: string): Promise<BorrowerCandidate[]> {
  const subgraphId = market.subgraphId;

  const query = `
    query Borrowers($first: Int!, $skip: Int!) {
      users(first: $first, skip: $skip, where: { borrowedReservesCount_gt: 0 }, orderBy: id) {
        id
        reserves(where: { or: [{ currentTotalDebt_gt: "0" }, { currentATokenBalance_gt: "0" }] }) {
          usageAsCollateralEnabledOnUser
          currentATokenBalance
          currentTotalDebt
          reserve { underlyingAsset symbol decimals }
        }
      }
    }
  `;

  // Pages are independent (skip-based), so fire them all in parallel rather
  // than awaiting one at a time — sequential fetching was the actual reason
  // this scan used to take 40+ seconds; The Graph just returns an empty
  // `users` array for a page past the real end, so over-requesting is cheap.
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, page) =>
      fetch(`https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { first: PAGE_SIZE, skip: page * PAGE_SIZE } }),
        signal: AbortSignal.timeout(20_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Aave subgraph ${response.status}`);
        const json = (await response.json()) as {
          data?: { users?: { id: string; reserves: RawReserve[] }[] };
          errors?: unknown;
        };
        if (json.errors) throw new Error(`Aave subgraph errors: ${JSON.stringify(json.errors)}`);
        return json.data?.users ?? [];
      }),
    ),
  );

  return pages.flat().map((user) => ({
    address: user.id as `0x${string}`,
    reserves: user.reserves.map((r) => ({
      underlyingAsset: r.reserve.underlyingAsset,
      currentATokenBalance: BigInt(r.currentATokenBalance),
      currentTotalDebt: BigInt(r.currentTotalDebt),
      usageAsCollateralEnabledOnUser: r.usageAsCollateralEnabledOnUser,
    })),
  }));
}

export type LiquidationStrategy = {
  executorDeployed: boolean;
  aaveLiquidityAvailableUsd: number | null;
  aaveLiquiditySufficient: boolean | null;
};

export type LiquidationOpportunity = {
  id: string;
  chain: string;
  chainId: number;
  userAddress: string;
  market: string;
  poolAddress: string;
  healthFactor: number;
  debt: { symbol: string; address: string; amount: string; amountUsd: number };
  collateral: { symbol: string; address: string; amount: string; amountUsd: number };
  liquidationBonusPct: number;
  maxDebtToCoverUsd: number;
  estimatedBonusUsd: number;
  detectedAt: string;
  liquidatable: boolean;
  strategy: LiquidationStrategy;
};

export type LiquidationCompetitor = { liquidator: string; count: number };

export type LiquidationStrategyDetail = {
  routeBuildable: boolean | null;
  routeBlockedReason: string | null;
  estimatedGasCostUsd: number | null;
  gasCostBasis: string | null;
  estimatedNetProfitUsd: number | null;
  topCompetitors: LiquidationCompetitor[];
  sampleCount: number;
};

const BASE_UNIT = 10n ** 8n; // Aave oracle BASE_CURRENCY_UNIT on both chains (USD, 8 decimals)

export function supportedLiquidationChainIds(): number[] {
  return [...new Set(AAVE_MARKETS.map((m) => m.chainId))];
}

export function chainIdForKey(key: string): number | null {
  const entry = Object.entries(CHAIN_KEY).find(([, v]) => v === key);
  return entry ? Number(entry[0]) : null;
}

/// Fetches Aave borrower candidates (subgraph) and checks each one's real
/// on-chain Health Factor (multicall) — the subgraph cannot compute HF
/// itself since it depends on live prices, not indexed events. Scans every
/// isolated market on this chain (see AAVE_MARKETS) sequentially — not in
/// parallel — since each market's own HF-check multicall is already chunked
/// sequentially internally, and firing several markets' worth of multicalls
/// concurrently against the same RPC key is exactly the burst pattern that
/// caused a real 429 incident earlier. Returns fully-priced opportunities,
/// restricted to the known/verified asset set for `chainId`, merged and
/// re-sorted by value across all of that chain's markets.
export async function findLiquidationOpportunities(
  chainId: number,
  graphApiKey: string,
  maxHealthFactor: number,
  limit: number,
): Promise<LiquidationOpportunity[]> {
  const markets = marketsForChain(chainId);
  if (markets.length === 0) return [];

  const perMarket: LiquidationOpportunity[] = [];
  for (const market of markets) {
    perMarket.push(...(await findOpportunitiesForMarket(market, graphApiKey, maxHealthFactor)));
  }

  // Value-first, across every market on this chain combined. Route/gas/
  // competitor checks are deliberately NOT done here — they cost several
  // extra RPC/Etherscan calls each and previously caused a real 429 storm
  // on the shared Alchemy key when run for several list items per request.
  // Call getLiquidationStrategyDetail on demand for one position at a time
  // instead (GET /liquidations/strategy), when a user opens its detail view.
  return perMarket.sort((a, b) => b.estimatedBonusUsd - a.estimatedBonusUsd).slice(0, limit);
}

export type LiquidationStrategyDetailParams = {
  chainId: number;
  poolAddress: string;
  debtAssetAddress: string;
  collateralAssetAddress: string;
  debtAmount: string;
  collateralAmount: string;
  estimatedBonusUsd: number;
};

/// On-demand deep readiness check for exactly one position — real DEX quote
/// for the collateral-sell leg, real historical gas cost, and who's actually
/// been winning liquidations on this market. Meant to be called once per
/// detail-view open, not for every item in a list (see
/// findLiquidationOpportunities above).
export async function getLiquidationStrategyDetail(params: LiquidationStrategyDetailParams): Promise<LiquidationStrategyDetail> {
  const { chainId, poolAddress, debtAssetAddress, collateralAssetAddress, debtAmount, collateralAmount, estimatedBonusUsd } = params;
  const client = getClient(chainId);

  let routeBuildable: boolean | null = null;
  let routeBlockedReason: string | null = null;

  try {
    if (debtAssetAddress.toLowerCase() === collateralAssetAddress.toLowerCase()) {
      routeBuildable = true; // same-asset liquidation — nothing to swap
    } else {
      const collateralRaw = BigInt(collateralAmount);
      const quote = await bestSellQuote(client, chainId, collateralAssetAddress as `0x${string}`, debtAssetAddress as `0x${string}`, collateralRaw);
      if (quote === null) {
        routeBuildable = false;
        routeBlockedReason = "no pool on any supported venue (Uniswap V3, Sushiswap V3/V2, Camelot V2, Curve) has enough combined depth at this size, even split across all of them";
      } else {
        const debtOwedRaw = BigInt(debtAmount);
        routeBuildable = quote.quotedOut > debtOwedRaw;
        if (!routeBuildable) routeBlockedReason = `best real quote (${quote.dex}) returns less than the debt owed — the trade size is too large for available liquidity`;
      }
    }
  } catch (err) {
    logger.debug({ err, chainId, poolAddress }, "route check failed");
    routeBlockedReason = "route check failed — see server logs";
  }

  let estimatedGasCostUsd: number | null = null;
  let gasCostBasis: string | null = null;
  let topCompetitors: LiquidationCompetitor[] = [];
  let sampleCount = 0;

  try {
    const etherscanApiKey = process.env["ETHERSCAN_API_KEY"];
    if (etherscanApiKey) {
      const latestBlock = await client.getBlockNumber();
      const history = await fetchMarketHistory(chainId, poolAddress as `0x${string}`, latestBlock, etherscanApiKey);
      sampleCount = history.sampleCount;
      topCompetitors = history.topCompetitors;
      if (history.avgGasUsed !== null) {
        const feed = NATIVE_PRICE_FEED[chainId];
        const gasPrice = await client.getGasPrice();
        if (feed) {
          const [decimals, roundData] = await Promise.all([
            client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
            client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
          ]);
          const nativePriceUsd = Number(roundData[1]) / 10 ** decimals;
          const gasCostNative = Number(history.avgGasUsed * gasPrice) / 1e18;
          estimatedGasCostUsd = gasCostNative * nativePriceUsd;
          gasCostBasis = `${LOOKBACK_DAYS_LABEL}d historical average (${history.sampleCount} real liquidations on this market), priced at the current gas price`;
        }
      }
    }
  } catch (err) {
    logger.debug({ err, chainId, poolAddress }, "gas cost / competitor check failed");
  }

  const estimatedNetProfitUsd = estimatedGasCostUsd !== null ? Math.round((estimatedBonusUsd - estimatedGasCostUsd) * 100) / 100 : null;

  return {
    routeBuildable,
    routeBlockedReason,
    estimatedGasCostUsd: estimatedGasCostUsd !== null ? Math.round(estimatedGasCostUsd * 100) / 100 : null,
    gasCostBasis,
    estimatedNetProfitUsd,
    topCompetitors,
    sampleCount,
  };
}

const LOOKBACK_DAYS_LABEL = 30;

async function findOpportunitiesForMarket(
  market: AaveMarket,
  graphApiKey: string,
  maxHealthFactor: number,
): Promise<LiquidationOpportunity[]> {
  const { chainId, pool, oracle, dataProvider } = market;
  const knownAssets = KNOWN_ASSETS[chainId];
  if (!knownAssets) return [];

  const candidates = await fetchBorrowerCandidates(market, graphApiKey);
  if (candidates.length === 0) return [];

  const publicClient = getClient(chainId);
  const maxHf = BigInt(Math.round(maxHealthFactor * 1e18));

  // Chunked AND sequential (not Promise.all) — this used to share a public
  // RPC endpoint with the arbitrage scanner and the bot's own polling, and
  // firing many multicall batches at once triggered a 429 for everything
  // else sharing that RPC. Now on a dedicated Alchemy endpoint, but kept
  // sequential anyway — no meaningful downside, and no reason to reintroduce
  // a burst pattern that's already caused a real incident once.
  const HF_BATCH_SIZE = 200;
  const fetchAccountDataBatch = (batch: typeof candidates) =>
    publicClient.multicall({
      contracts: batch.map((c) => ({
        address: pool,
        abi: aavePoolReadAbi,
        functionName: "getUserAccountData",
        args: [c.address],
      })),
      allowFailure: true,
    });
  const accountData: Awaited<ReturnType<typeof fetchAccountDataBatch>> = [];
  for (let i = 0; i < candidates.length; i += HF_BATCH_SIZE) {
    accountData.push(...(await fetchAccountDataBatch(candidates.slice(i, i + HF_BATCH_SIZE))));
  }

  // `allowFailure: true` means one transient RPC hiccup on a single call
  // inside a 200-wide batch silently drops just that account's HF read —
  // not because it isn't at risk, but because we simply don't know. Retried
  // once, individually, rather than treated as "not at risk": a real ~$2M
  // position disappeared from the UI for exactly this reason in practice
  // (one flaky read in one batch), even though nothing about the position
  // itself had changed a poll later.
  const failedIndexes = accountData.map((r, i) => (r.status === "failure" ? i : -1)).filter((i) => i >= 0);
  if (failedIndexes.length > 0 && failedIndexes.length <= 50) {
    const retried = await publicClient.multicall({
      contracts: failedIndexes.map((i) => ({
        address: pool,
        abi: aavePoolReadAbi,
        functionName: "getUserAccountData",
        args: [candidates[i]!.address],
      })),
      allowFailure: true,
    });
    failedIndexes.forEach((i, j) => {
      accountData[i] = retried[j]!;
    });
  }

  // Deliberately NOT truncated to `limit` here — a lowest-Health-Factor-first
  // cut would fill the entire page with worthless dust (there are always far
  // more near-zero positions than meaningful ones) and starve out large,
  // genuinely valuable positions that merely aren't in mortal danger yet.
  // `limit` is applied at the very end, after pricing, sorted by value.
  // Bounded independently of fetchBorrowerCandidates' own page count (now up
  // to 3,000 raw candidates, see MAX_PAGES) — this cap exists only as a
  // defensive ceiling on the pricing multicalls for the at-risk subset, not
  // as a value-blind cutoff (that's the bug being fixed here).
  const PRICING_CAP = 500;
  const atRisk = candidates
    .map((candidate, i) => ({ candidate, result: accountData[i] }))
    .filter(
      (
        entry,
      ): entry is { candidate: BorrowerCandidate; result: Extract<(typeof accountData)[number], { status: "success" }> } =>
        entry.result.status === "success" && entry.result.result[1] > 0n && entry.result.result[5] <= maxHf,
    )
    // Sorted by totalCollateralBase (Aave's own USD-ish base-currency figure,
    // already returned free by the same getUserAccountData call above — no
    // extra RPC) before the PRICING_CAP slice below. candidates arrives
    // ordered by subgraph `id` (address), which is not a value ordering at
    // all; without this, a wider raw candidate pool (MAX_PAGES) just means
    // PRICING_CAP is more likely to fill up on arbitrary low-address dust
    // before ever reaching the accounts actually worth pricing.
    .sort((a, b) => (b.result.result[0] > a.result.result[0] ? 1 : -1))
    .slice(0, PRICING_CAP);

  if (atRisk.length === 0) return [];

  // For each at-risk account, resolve its largest known-asset debt/collateral
  // reserve, then price both + read the collateral's liquidation bonus.
  const withReserves = atRisk
    .map(({ candidate, result }) => {
      const debtReserve = candidate.reserves
        .filter((r) => r.currentTotalDebt > 0n && r.underlyingAsset.toLowerCase() in knownAssets)
        .sort((a, b) => (a.currentTotalDebt > b.currentTotalDebt ? -1 : 1))[0];
      const collateralReserve = candidate.reserves
        .filter(
          (r) =>
            r.currentATokenBalance > 0n && r.usageAsCollateralEnabledOnUser && r.underlyingAsset.toLowerCase() in knownAssets,
        )
        .sort((a, b) => (a.currentATokenBalance > b.currentATokenBalance ? -1 : 1))[0];
      if (!debtReserve || !collateralReserve) return null;
      return { candidate, healthFactor: result.result[5], debtReserve, collateralReserve };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (withReserves.length === 0) return [];

  // Real available liquidity per unique debt asset — aToken supply minus
  // outstanding debt is what a flash loan can actually draw from right now.
  // Deduped: the same debt asset repeats across many positions, and this is
  // one more RPC round trip we don't want to pay per-position.
  const uniqueDebtAssets = [...new Set(withReserves.map((e) => e.debtReserve.underlyingAsset.toLowerCase()))];
  const reserveDataResults = await publicClient.multicall({
    contracts: uniqueDebtAssets.map((asset) => ({
      address: dataProvider,
      abi: aaveDataProviderAbi,
      functionName: "getReserveData",
      args: [asset as `0x${string}`],
    })),
    allowFailure: true,
  });
  const availableLiquidityByAsset = new Map<string, bigint>();
  uniqueDebtAssets.forEach((asset, i) => {
    const result = reserveDataResults[i];
    if (result?.status !== "success") return;
    const [, , totalAToken, totalStableDebt, totalVariableDebt] = result.result;
    availableLiquidityByAsset.set(asset, totalAToken - totalStableDebt - totalVariableDebt);
  });

  const [debtPriceResults, collateralPriceResults, configResults] = await Promise.all([
    publicClient.multicall({
      contracts: withReserves.map((entry) => ({
        address: oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [entry.debtReserve.underlyingAsset],
      })),
      allowFailure: true,
    }),
    publicClient.multicall({
      contracts: withReserves.map((entry) => ({
        address: oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [entry.collateralReserve.underlyingAsset],
      })),
      allowFailure: true,
    }),
    publicClient.multicall({
      contracts: withReserves.map((entry) => ({
        address: dataProvider,
        abi: aaveDataProviderAbi,
        functionName: "getReserveConfigurationData",
        args: [entry.collateralReserve.underlyingAsset],
      })),
      allowFailure: true,
    }),
  ]);

  const opportunities: LiquidationOpportunity[] = [];
  for (let i = 0; i < withReserves.length; i++) {
    const entry = withReserves[i]!;
    const debtPriceResult = debtPriceResults[i];
    const collateralPriceResult = collateralPriceResults[i];
    const configResult = configResults[i];
    if (
      debtPriceResult?.status !== "success" ||
      collateralPriceResult?.status !== "success" ||
      configResult?.status !== "success"
    ) {
      continue;
    }

    const debtAsset = knownAssets[entry.debtReserve.underlyingAsset.toLowerCase()]!;
    const collateralAsset = knownAssets[entry.collateralReserve.underlyingAsset.toLowerCase()]!;
    const debtPrice = debtPriceResult.result;
    const collateralPrice = collateralPriceResult.result;
    const liquidationBonusBps = configResult.result[3];

    const closeFactorBps = entry.healthFactor < CLOSE_FACTOR_HF_THRESHOLD ? MAX_CLOSE_FACTOR_BPS : DEFAULT_CLOSE_FACTOR_BPS;
    const debtToCover = (entry.debtReserve.currentTotalDebt * closeFactorBps) / 10_000n;

    // Step through USD-ish "base" units (Aave's own 8-decimal oracle
    // convention) rather than combining both assets' raw decimals in one
    // expression — debt and collateral assets can have very different
    // decimals (e.g. GHO 18 vs WBTC 8), and skipping the intermediate
    // normalization silently produces wildly wrong amounts for such pairs.
    const debtValueBase = (debtToCover * debtPrice) / 10n ** BigInt(debtAsset.decimals);
    const debtAmountUsd = Number(debtValueBase) / Number(BASE_UNIT);
    const bonusPct = Number(liquidationBonusBps - 10_000n) / 100;
    const estimatedBonusUsd = debtAmountUsd * (bonusPct / 100);
    const collateralValueBase = (debtValueBase * liquidationBonusBps) / 10_000n;
    const collateralAmount = (collateralValueBase * 10n ** BigInt(collateralAsset.decimals)) / collateralPrice;
    const collateralAmountUsd = Number(collateralValueBase) / Number(BASE_UNIT);

    const availableLiquidity = availableLiquidityByAsset.get(entry.debtReserve.underlyingAsset.toLowerCase());
    const aaveLiquidityAvailableUsd =
      availableLiquidity !== undefined
        ? Number((availableLiquidity * debtPrice) / 10n ** BigInt(debtAsset.decimals)) / Number(BASE_UNIT)
        : null;
    const aaveLiquiditySufficient = availableLiquidity !== undefined ? availableLiquidity >= debtToCover : null;

    opportunities.push({
      id: `${CHAIN_KEY[chainId]}-${market.marketKey}-${entry.candidate.address.toLowerCase()}`,
      chain: CHAIN_NAME[chainId]!,
      chainId,
      userAddress: entry.candidate.address,
      market: market.marketKey,
      poolAddress: pool,
      healthFactor: Number(entry.healthFactor) / 1e18,
      debt: {
        symbol: debtAsset.symbol,
        address: entry.debtReserve.underlyingAsset,
        amount: debtToCover.toString(),
        amountUsd: Number(debtAmountUsd.toFixed(2)),
      },
      collateral: {
        symbol: collateralAsset.symbol,
        address: entry.collateralReserve.underlyingAsset,
        amount: collateralAmount.toString(),
        amountUsd: Number(collateralAmountUsd.toFixed(2)),
      },
      liquidationBonusPct: bonusPct,
      maxDebtToCoverUsd: Number(debtAmountUsd.toFixed(2)),
      estimatedBonusUsd: Number(estimatedBonusUsd.toFixed(2)),
      strategy: {
        executorDeployed: EXECUTOR_DEPLOYED[chainId] ?? false,
        aaveLiquidityAvailableUsd: aaveLiquidityAvailableUsd !== null ? Number(aaveLiquidityAvailableUsd.toFixed(2)) : null,
        aaveLiquiditySufficient,
      },
      detectedAt: new Date().toISOString(),
      liquidatable: entry.healthFactor <= 10n ** 18n,
    });
  }

  logger.debug(
    { chainId, market: market.marketKey, candidates: candidates.length, atRisk: atRisk.length, priced: opportunities.length },
    "liquidation scan",
  );
  // Sorting/limiting happens once in findLiquidationOpportunities, after
  // merging every market on this chain — not here per-market.
  return opportunities;
}
