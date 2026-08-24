import { Router, type IRouter, type Response } from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetScannerOpportunitiesQueryParams,
  GetScannerOpportunityParams,
  GetScannerFundingParams,
  GetScannerFundingResponse,
  GetScannerOpportunitiesResponse,
  GetScannerOpportunityResponse,
  GetScannerNetworksResponse,
  GetScannerSummaryResponse,
  GetScannerTokensResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  isStableQuote,
  normalizeTrackedPair,
  routeEligible,
  venueSupported,
} from "../lib/arbitrageEligibility";
import {
  activeExecutionRequests,
  completeExecutionRequest,
  requestImmediateExecution,
} from "../lib/executionRequests";
import { quoteAtomicCycle, quoteClosedRoute } from "../lib/arbitrageQuotes";
import {
  cyclePoolEdgeKey,
  findAtomicCycles,
  findBestConversionPath,
  findPrioritizedCycles,
  type CyclePool,
} from "../lib/cycleDiscovery";
import { FairQuoteScheduler } from "../lib/quoteScheduler";
import { IncrementalPoolStateEngine } from "../lib/incrementalPoolState";
import { RateGate } from "../lib/rateGate";
import { mergeActiveMarketCatalog } from "../lib/marketCatalog";
import {
  tokenReference,
  type TokenPriceObservation,
} from "../lib/tokenReference";
import { createPublicClient, fallback, getAddress, http } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  celo,
  linea,
  mainnet,
  mantle,
  optimism,
  polygon,
  scroll,
  soneium,
  sonic,
  zkSync,
} from "viem/chains";

export const CHAIN_IDS = [
  "ethereum",
  "arbitrum",
  "optimism",
  "polygon",
  "base",
  "avalanche",
  "bsc",
  "celo",
  "linea",
  "mantle",
  "scroll",
  "sonic",
  "zksync",
  "soneium",
] as const;
export type ChainId = (typeof CHAIN_IDS)[number];
export type TokenDefinition = {
  symbol: string;
  name: string;
  decimals: number;
  addresses: Partial<Record<ChainId, string>>;
};
type Venue = {
  name: string;
  dexId: string;
  chain: string;
  priceUsd: number;
  liquidityUsd: number;
  feeBps: number;
  pairAddress: string;
  dexUrl: string;
  volume24h?: number;
  labels?: string[];
  quoteTokenAddress?: string;
  quoteTokenSymbol?: string;
};
type Opportunity = {
  id: string;
  token: string;
  tokenAddress: string;
  tokenDecimals: number;
  pair: string;
  chain: string;
  chainId: number;
  spreadBps: number;
  spreadPct: number;
  buyVenue: Venue;
  sellVenue: Venue;
  routeKind?: "two-pool" | "cross-stable" | "triangular" | "multi-hop";
  routeLegs?: Array<{
    tokenInAddress: string;
    tokenInSymbol: string;
    tokenInDecimals: number;
    tokenOutAddress: string;
    tokenOutSymbol: string;
    tokenOutDecimals: number;
    venue: Venue;
  }>;
  profit: {
    grossProfitUsd: number;
    flashLoanFeeUsd: number;
    gasCostUsd: number;
    dexFeesUsd: number;
    slippageUsd: number;
    netProfitUsd: number;
    recommendedBorrowUsd: number;
    confidence: "high" | "medium" | "low";
  };
  detectedAt: string;
  blockNumber: number;
  executable: boolean;
  executorDeployed?: boolean;
  quoteStatus?: "estimated" | "quoted" | "unavailable";
  executionBlocker?:
    | "negative-net"
    | "executor-not-deployed"
    | "quote-budget"
    | "quote-failed"
    | "target-not-allowed"
    | "unsupported-or-open-route";
  status: "new" | "monitoring" | "stale";
};

/**
 * Rank opportunities by conservative expected value, not headline spread.
 * A raw or queued dislocation has zero execution probability until its whole
 * cycle has been quoted. The failure term charges the estimated gas that can
 * still be lost when a quoted route races another searcher or changes before
 * inclusion. This keeps a spectacular-looking but unverified spread below a
 * smaller route whose executable net has actually been established.
 */
export function opportunityExpectedValue(
  opportunity: Opportunity,
  now = Date.now(),
): number {
  if (opportunity.quoteStatus !== "quoted")
    return -opportunity.profit.gasCostUsd;
  const baseProbability =
    opportunity.profit.confidence === "high"
      ? 0.8
      : opportunity.profit.confidence === "medium"
        ? 0.55
        : 0.2;
  const detectedAt = Date.parse(opportunity.detectedAt);
  const ageMs = Number.isFinite(detectedAt)
    ? Math.max(0, now - detectedAt)
    : 30_000;
  // A quote loses roughly half of its confidence every 12 seconds. The
  // executor still performs a fresh quote + complete transaction simulation.
  const freshness = 2 ** (-ageMs / 12_000);
  const successProbability = baseProbability * freshness;
  return (
    successProbability * opportunity.profit.netProfitUsd -
    (1 - successProbability) * opportunity.profit.gasCostUsd
  );
}

function compareOpportunities(a: Opportunity, b: Opportunity): number {
  return (
    Number(b.executable) - Number(a.executable) ||
    Number(b.quoteStatus === "quoted") - Number(a.quoteStatus === "quoted") ||
    opportunityExpectedValue(b) - opportunityExpectedValue(a) ||
    b.profit.netProfitUsd - a.profit.netProfitUsd ||
    b.spreadBps - a.spreadBps
  );
}

export const TOKEN_DEFINITIONS: TokenDefinition[] = [
  [
    "WETH",
    "Wrapped Ether",
    18,
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "0x4200000000000000000000000000000000000006",
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  ],
  [
    "USDC",
    "USD Coin",
    6,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  ],
  [
    "USDT",
    "Tether USD",
    6,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "0xFd086Bc7CD5C481dcc9C85ebe478A1C0b69FCbb9",
    "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  ],
  [
    "DAI",
    "Dai Stablecoin",
    18,
    "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  ],
  [
    "WBTC",
    "Wrapped Bitcoin",
    8,
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  ],
  [
    "LINK",
    "Chainlink",
    18,
    "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  ],
  [
    "UNI",
    "Uniswap",
    18,
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "0xfa7F8980b0f1E64A2067F7cA8F97C3d7aC4f6E2A",
    "0x6fd9d7AD17242c41f7131d257212c54A0e816691",
    "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
  ],
  [
    "AAVE",
    "Aave",
    18,
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DdAe9",
    "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    "0x76FB31fb4af56892A25e32cFC43De717950c9278",
    "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  ],
  [
    "OP",
    "Optimism",
    18,
    undefined,
    undefined,
    "0x4200000000000000000000000000000000000042",
  ],
  [
    "WMATIC",
    "Wrapped Matic",
    18,
    undefined,
    undefined,
    undefined,
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  ],
  [
    "ARB",
    "Arbitrum",
    18,
    "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
    "0x912CE59144191C1204E64559FE8253a0e49E6548",
  ],
  [
    "CRV",
    "Curve DAO Token",
    18,
    "0xD533a949740bb3306d119CC777fa900bA034cd52",
    "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",
  ],
  [
    "COMP",
    "Compound",
    18,
    "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    "0x354A6dA3fcde098F8389cad84b0182725c6C91dE",
  ],
  [
    "SNX",
    "Synthetix Network Token",
    18,
    "0xC011a72400E58ecD99ee497CF89E3775d4bd732F",
  ],
  ["SUSHI", "Sushi", 18, "0x6B3595068778DD592e39A122f4f5a5Cf09C90fE"],
  ["LDO", "Lido DAO", 18, "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32"],
  ["MKR", "Maker", 18, "0x9f8F72aA9304c8B593d555F12eF6589Cc3A579A2"],
  [
    "ENS",
    "Ethereum Name Service",
    18,
    "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
  ],
  ["1INCH", "1inch", 18, "0x111111111117dC0aa78b770fA6A738034120C302"],
  ["YFI", "yearn.finance", 18, "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e"],
  ["GRT", "The Graph", 18, "0xc944E90C64B2c07662A292be6244BDf05Cda44a7"],
  [
    "STETH",
    "Lido Staked Ether",
    18,
    "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  ],
  [
    "PENDLE",
    "Pendle",
    18,
    "0x808507121B80C02388fAd14726482e061B8da827",
    "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
  ],
  [
    "WSTETH",
    "Wrapped liquid staked Ether 2.0",
    18,
    "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    "0x5979D7b546E38E414F7E9822514be443A4800529",
  ],
  [
    "CBETH",
    "Coinbase Wrapped Staked ETH",
    18,
    "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    "0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f",
  ],
  [
    "GHO",
    "GHO Token",
    18,
    "0x40D16FC0246a4149b17E7c6314655F6a9F7C8B33",
    "0x7dfF72693f6A4149B17e7c6314655F6a9F7C8B33",
  ],
  [
    "FRAX",
    "Frax",
    18,
    "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    "0x7468a5d8E02245B00E8C0217fCE021C70Bc51305",
  ],
  [
    "LUSD",
    "Liquity USD",
    18,
    "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
    "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b",
  ],
  [
    "BAL",
    "Balancer",
    18,
    "0xba100000625a3754423978a60c9317c58a424e3D",
    "0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8",
  ],
  [
    "RPL",
    "Rocket Pool Protocol",
    18,
    "0xD33526068D116cE69F19A9ee46F0bd304F21A51f",
    "0xB766039cc6DB368759C1E56B79AFfE831d0Cc507",
  ],
  [
    "PEPE",
    "Pepe",
    18,
    "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    "0x35E6A59F786d9266c7961eA28c7b768B33959cbB",
  ],
  [
    "FLOKI",
    "Floki",
    9,
    "0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E",
    "0xA8C25FdC09763A176353CC6a76882e05b4905FAe",
  ],
  [
    "MOG",
    "Mog Coin",
    18,
    "0xaaee1a9723aadb7afa2810263653a34ba2c21c7a",
    "0x96c42662820F6Ea32f0A61A06a38a72B206aABaC",
  ],
  [
    "SHIB",
    "Shiba Inu",
    18,
    "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce",
    "0x5033833c9fe8B9d3E09EEd2f73d2aaF7E3872fd1",
  ],
  [
    "TURBO",
    "Turbo",
    18,
    "0xA35923162C49cF95e6BF26623385eb431ad920D3",
    "0x5C816d4582c857dcadb1bB1F62Ad6c9DEde4576a",
  ],
  [
    "USDC.E",
    "Bridged USDC",
    6,
    undefined,
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
  ],
  ["GMX", "GMX", 18, undefined, "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a"],
  ["APE", "ApeCoin", 18, "0x4d224452801ACEd8B2F0aebe155379bb5D594381"],
  [
    "MAGIC",
    "Magic",
    18,
    undefined,
    "0x539bdE0d7Dbd336b79148AA742883198BBF60342",
  ],
  [
    "RDNT",
    "Radiant Capital",
    18,
    undefined,
    "0x3082CC23568eA640225c2467653dB90e9250AaA0",
  ],
  [
    "JONES",
    "Jones DAO",
    18,
    undefined,
    "0x10393c20975cF177a3513071BC110f7962CD67da",
  ],
  [
    "LPT",
    "Livepeer",
    18,
    "0x58b6A8A3302369DAEc383334672404Ee733aB239",
    "0x289ba1701C2f088cf0faf8B3705246331cb8A839",
  ],
].map(
  ([
    symbol,
    name,
    decimals,
    ethereum,
    arbitrum,
    optimismAddress,
    polygonAddress,
  ]) => ({
    symbol: symbol as string,
    name: name as string,
    decimals: decimals as number,
    addresses: {
      ethereum: ethereum as string | undefined,
      arbitrum: arbitrum as string | undefined,
      optimism: optimismAddress as string | undefined,
      polygon: polygonAddress as string | undefined,
    },
  }),
);

// Canonical assets published by Aave's address book for the ten additional
// chains. Reusing the existing symbols lets the UI aggregate one asset across
// networks while preserving each chain's actual contract address.
const EXTRA_TOKEN_ADDRESSES: Record<
  string,
  Partial<Record<ChainId, string>>
> = {
  WETH: {
    base: "0x4200000000000000000000000000000000000006",
    avalanche: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
    bsc: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    celo: "0xD221812de1BD094f35587EE8E174B07B6167D9Af",
    linea: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
    mantle: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
    scroll: "0x5300000000000000000000000000000000000004",
    sonic: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b",
    zksync: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
    soneium: "0x4200000000000000000000000000000000000006",
  },
  LINK: {
    bsc: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
  },
  UNI: {
    bsc: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1",
  },
  SUSHI: {
    bsc: "0x947950BcC74888a40Ffa2593C5798F11Fc9124C4",
  },
  USDC: {
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    celo: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    linea: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    mantle: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
    scroll: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
    sonic: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    zksync: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
  },
  USDT: {
    avalanche: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
    bsc: "0x55d398326f99059fF775485246999027B3197955",
    celo: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    linea: "0xA219439258ca9da29E9Cc4cE5596924745e12B93",
    zksync: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C",
    soneium: "0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35",
  },
  DAI: { avalanche: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70" },
  WBTC: {
    avalanche: "0x50b7545627a5162F82A992c33b87aDc75187B218",
    linea: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4",
  },
  WSTETH: {
    base: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    bsc: "0x26c5e01524d2E6280A48F2c50fF6De7e52E9611C",
    linea: "0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F",
    scroll: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",
    zksync: "0x703b52F2b28fEbcB60E1372858AF5b18849FE867",
  },
  CBETH: { base: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  GHO: {
    base: "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee",
    avalanche: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73",
    mantle: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73",
  },
  FRAX: { avalanche: "0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64" },
  AAVE: { base: "0x63706e401c06ac8513145b7687A14804d17f814b" },
  PEPE: { optimism: "0xC1c167CC44f7923cd0062c4370Df962f9DDB16f5" },
  FLOKI: { bsc: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E" },
  TURBO: { optimism: "0x1E4339318EcE1d6D9d2Fb129b31C06b9F2d202A1" },
  "USDC.E": { soneium: "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369" },
};

for (const token of TOKEN_DEFINITIONS) {
  token.addresses = {
    ...token.addresses,
    ...EXTRA_TOKEN_ADDRESSES[token.symbol],
  };
}

TOKEN_DEFINITIONS.push(
  {
    symbol: "USDB.C",
    name: "USD Base Coin",
    decimals: 6,
    addresses: { base: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
  },
  {
    symbol: "WAVAX",
    name: "Wrapped AVAX",
    decimals: 18,
    addresses: { avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" },
  },
  {
    symbol: "BTCB",
    name: "Bitcoin BEP-20",
    decimals: 18,
    addresses: { bsc: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  },
  {
    symbol: "WBNB",
    name: "Wrapped BNB",
    decimals: 18,
    addresses: { bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  },
  {
    symbol: "FDUSD",
    name: "First Digital USD",
    decimals: 18,
    addresses: { bsc: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409" },
  },
  {
    symbol: "CAKE",
    name: "PancakeSwap Token",
    decimals: 18,
    addresses: { bsc: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
  },
  {
    symbol: "XVS",
    name: "Venus Token",
    decimals: 18,
    addresses: { bsc: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63" },
  },
  {
    symbol: "DOT",
    name: "Polkadot Token",
    decimals: 18,
    addresses: { bsc: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402" },
  },
  {
    symbol: "ADA",
    name: "Cardano Token",
    decimals: 18,
    addresses: { bsc: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47" },
  },
  {
    symbol: "DOGE",
    name: "Dogecoin",
    decimals: 8,
    addresses: { bsc: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43" },
  },
  {
    symbol: "TWT",
    name: "Trust Wallet Token",
    decimals: 18,
    addresses: { bsc: "0x4B0F1812e5Df2A09796481Ff14017e6005508003" },
  },
  {
    symbol: "XRP",
    name: "XRP Token",
    decimals: 18,
    addresses: { bsc: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE" },
  },
  {
    symbol: "INJ",
    name: "Injective Protocol",
    decimals: 18,
    addresses: { bsc: "0xa2B726B1145A4773F68593CF171187d8EBe4d495" },
  },
  {
    symbol: "ATOM",
    name: "Cosmos Token",
    decimals: 18,
    addresses: { bsc: "0x0Eb3a705fc54725037CC9e008bDede697f62F335" },
  },
  {
    symbol: "AXS",
    name: "Axie Infinity Shard",
    decimals: 18,
    addresses: { bsc: "0x715D400F88C167884bbCc41C5FeA407ed4D2f8A0" },
  },
  {
    symbol: "TRX",
    name: "TRON",
    decimals: 18,
    addresses: { bsc: "0x85EAC5Ac2F758618dFa09bDbe0cf174e7d574D5B" },
  },
  {
    symbol: "VAI",
    name: "VAI Stablecoin",
    decimals: 18,
    addresses: { bsc: "0x4BD17003473389A42DAF6a0a729f6Fdb328BbBd7" },
  },
  {
    symbol: "SFP",
    name: "SafePal Token",
    decimals: 18,
    addresses: { bsc: "0xD41FDb03Ba84762dD66a0af1a6C8540FF1ba5dfb" },
  },
  {
    symbol: "C98",
    name: "Coin98",
    decimals: 18,
    addresses: { bsc: "0xaEC945e04baF28b135Fa7c640f624f8D90F1C3a6" },
  },
  {
    symbol: "USD1",
    name: "World Liberty Financial USD",
    decimals: 18,
    addresses: { bsc: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" },
  },
  {
    symbol: "SHIB",
    name: "Binance-Peg SHIBA INU",
    decimals: 18,
    addresses: { bsc: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D" },
  },
  {
    symbol: "FLOKI",
    name: "FLOKI",
    decimals: 9,
    addresses: { bsc: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E" },
  },
  {
    symbol: "PEPE",
    name: "Binance-Peg Pepe",
    decimals: 18,
    addresses: { bsc: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00" },
  },
  {
    // Verified directly from token0() on PancakeSwap V3 QUQ/USDT pool
    // 0x9485ff32b6b4444c21d5abe4d9a2283d127075a2. This is intentionally
    // an explicit address allow-list entry, never a ticker-only discovery.
    symbol: "QUQ",
    name: "quq",
    decimals: 18,
    addresses: { bsc: "0x4FA7C69a7B69f8bC48233024d546bC299d6b03bf" },
  },
  {
    symbol: "CELO",
    name: "Celo",
    decimals: 18,
    addresses: { celo: "0x471EcE3750Da237f93B8E339c536989b8978a438" },
  },
  {
    symbol: "USDM",
    name: "Mento Dollar",
    decimals: 18,
    addresses: { celo: "0x765DE816845861e75A25fCA122bb6898B8B1282a" },
  },
  {
    symbol: "WMNT",
    name: "Wrapped Mantle",
    decimals: 18,
    addresses: { mantle: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" },
  },
  {
    symbol: "USDT0",
    name: "USDT0",
    decimals: 6,
    addresses: { mantle: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" },
  },
  {
    symbol: "SCR",
    name: "Scroll",
    decimals: 18,
    addresses: { scroll: "0xd29687c813D741E2F938F4aC377128810E217b1b" },
  },
  {
    symbol: "WS",
    name: "Wrapped Sonic",
    decimals: 18,
    addresses: { sonic: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38" },
  },
  {
    symbol: "STS",
    name: "Staked Sonic",
    decimals: 18,
    addresses: { sonic: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955" },
  },
  {
    symbol: "ZK",
    name: "ZKsync",
    decimals: 18,
    addresses: { zksync: "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E" },
  },
);

const TOKEN_DECIMAL_OVERRIDES: Partial<
  Record<ChainId, Record<string, number>>
> = {
  bsc: { USDC: 18, USDT: 18 },
};

export function tokenDecimals(token: TokenDefinition, chain: ChainId): number {
  return TOKEN_DECIMAL_OVERRIDES[chain]?.[token.symbol] ?? token.decimals;
}

// Second RPC source per chain — real, repeated 429s from the shared Alchemy
// key this session (this exact function throwing `RPC 429 on ethereum`,
// which cascaded into the scanner briefly going blank and a $2.17M
// liquidation vanishing from results) are exactly what this exists to stop.
// Defaults to a well-known public node (verified reachable) when no
// explicit fallback is configured, same convention as executor-bot's
// ETHEREUM_RPC_URL_FALLBACK.
export const RPCS: Record<
  ChainId,
  {
    chainId: number;
    name: string;
    url: string;
    fallbackUrl: string;
    explorer: string;
  }
> = {
  ethereum: {
    chainId: 1,
    name: "Ethereum",
    url:
      process.env["ETHEREUM_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com",
    fallbackUrl:
      process.env["ETHEREUM_RPC_URL_FALLBACK"] ??
      "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
  },
  arbitrum: {
    chainId: 42161,
    name: "Arbitrum One",
    url:
      process.env["ARBITRUM_RPC_URL"] ??
      "https://arbitrum-one-rpc.publicnode.com",
    fallbackUrl:
      process.env["ARBITRUM_RPC_URL_FALLBACK"] ??
      "https://arbitrum-one-rpc.publicnode.com",
    explorer: "https://arbiscan.io",
  },
  optimism: {
    chainId: 10,
    name: "Optimism",
    url:
      process.env["OPTIMISM_RPC_URL"] ?? "https://optimism-rpc.publicnode.com",
    fallbackUrl:
      process.env["OPTIMISM_RPC_URL_FALLBACK"] ??
      "https://optimism-rpc.publicnode.com",
    explorer: "https://optimistic.etherscan.io",
  },
  polygon: {
    chainId: 137,
    name: "Polygon",
    url:
      process.env["POLYGON_RPC_URL"] ??
      "https://polygon-bor-rpc.publicnode.com",
    fallbackUrl:
      process.env["POLYGON_RPC_URL_FALLBACK"] ??
      "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
  },
  base: {
    chainId: 8453,
    name: "Base",
    url: process.env["BASE_RPC_URL"] ?? "https://base-rpc.publicnode.com",
    fallbackUrl:
      process.env["BASE_RPC_URL_FALLBACK"] ?? "https://base-rpc.publicnode.com",
    explorer: "https://basescan.org",
  },
  avalanche: {
    chainId: 43114,
    name: "Avalanche C-Chain",
    url:
      process.env["AVALANCHE_RPC_URL"] ??
      "https://avalanche-c-chain-rpc.publicnode.com",
    fallbackUrl:
      process.env["AVALANCHE_RPC_URL_FALLBACK"] ??
      "https://avalanche-c-chain-rpc.publicnode.com",
    explorer: "https://snowtrace.io",
  },
  bsc: {
    chainId: 56,
    name: "BNB Chain",
    url: process.env["BSC_RPC_URL"] ?? "https://bsc-rpc.publicnode.com",
    fallbackUrl:
      process.env["BSC_RPC_URL_FALLBACK"] ?? "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
  },
  celo: {
    chainId: 42220,
    name: "Celo",
    url: process.env["CELO_RPC_URL"] ?? "https://celo-rpc.publicnode.com",
    fallbackUrl:
      process.env["CELO_RPC_URL_FALLBACK"] ?? "https://celo-rpc.publicnode.com",
    explorer: "https://celoscan.io",
  },
  linea: {
    chainId: 59144,
    name: "Linea",
    url: process.env["LINEA_RPC_URL"] ?? "https://linea-rpc.publicnode.com",
    fallbackUrl:
      process.env["LINEA_RPC_URL_FALLBACK"] ??
      "https://linea-rpc.publicnode.com",
    explorer: "https://lineascan.build",
  },
  mantle: {
    chainId: 5000,
    name: "Mantle",
    url: process.env["MANTLE_RPC_URL"] ?? "https://mantle-rpc.publicnode.com",
    fallbackUrl:
      process.env["MANTLE_RPC_URL_FALLBACK"] ??
      "https://mantle-rpc.publicnode.com",
    explorer: "https://mantlescan.xyz",
  },
  scroll: {
    chainId: 534352,
    name: "Scroll",
    url: process.env["SCROLL_RPC_URL"] ?? "https://scroll-rpc.publicnode.com",
    fallbackUrl:
      process.env["SCROLL_RPC_URL_FALLBACK"] ??
      "https://scroll-rpc.publicnode.com",
    explorer: "https://scrollscan.com",
  },
  sonic: {
    chainId: 146,
    name: "Sonic",
    url: process.env["SONIC_RPC_URL"] ?? "https://sonic-rpc.publicnode.com",
    fallbackUrl:
      process.env["SONIC_RPC_URL_FALLBACK"] ??
      "https://sonic-rpc.publicnode.com",
    explorer: "https://sonicscan.org",
  },
  zksync: {
    chainId: 324,
    name: "zkSync Era",
    url: process.env["ZKSYNC_RPC_URL"] ?? "https://mainnet.era.zksync.io",
    fallbackUrl:
      process.env["ZKSYNC_RPC_URL_FALLBACK"] ?? "https://mainnet.era.zksync.io",
    explorer: "https://era.zksync.network",
  },
  soneium: {
    chainId: 1868,
    name: "Soneium",
    url: process.env["SONEIUM_RPC_URL"] ?? "https://soneium-rpc.publicnode.com",
    fallbackUrl:
      process.env["SONEIUM_RPC_URL_FALLBACK"] ??
      "https://soneium-rpc.publicnode.com",
    explorer: "https://soneium.blockscout.com",
  },
};

// Different chains have different transaction envelope unions (for example
// Optimism's deposit transaction), so keep the heterogeneous client registry
// erased here; quote helpers validate every contract call at runtime.
function scannerTransport(chain: ChainId) {
  const { url, fallbackUrl } = RPCS[chain];
  return fallback(
    fallbackUrl === url ? [http(url)] : [http(fallbackUrl), http(url)],
  );
}

const CHAIN_CLIENTS: Record<ChainId, any> = {
  ethereum: createPublicClient({
    chain: mainnet,
    transport: scannerTransport("ethereum"),
  }),
  arbitrum: createPublicClient({
    chain: arbitrum,
    transport: scannerTransport("arbitrum"),
  }),
  optimism: createPublicClient({
    chain: optimism,
    transport: scannerTransport("optimism"),
  }),
  polygon: createPublicClient({
    chain: polygon,
    transport: scannerTransport("polygon"),
  }),
  base: createPublicClient({
    chain: base,
    transport: scannerTransport("base"),
  }),
  avalanche: createPublicClient({
    chain: avalanche,
    transport: scannerTransport("avalanche"),
  }),
  bsc: createPublicClient({
    chain: bsc,
    transport: scannerTransport("bsc"),
  }),
  celo: createPublicClient({
    chain: celo,
    transport: scannerTransport("celo"),
  }),
  linea: createPublicClient({
    chain: linea,
    transport: scannerTransport("linea"),
  }),
  mantle: createPublicClient({
    chain: mantle,
    transport: scannerTransport("mantle"),
  }),
  scroll: createPublicClient({
    chain: scroll,
    transport: scannerTransport("scroll"),
  }),
  sonic: createPublicClient({
    chain: sonic,
    transport: scannerTransport("sonic"),
  }),
  zksync: createPublicClient({
    chain: zkSync,
    transport: scannerTransport("zksync"),
  }),
  soneium: createPublicClient({
    chain: soneium,
    transport: scannerTransport("soneium"),
  }),
};

const QUOTE_DECIMALS: Record<string, number> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,
  "0x6b175474e89094c44da98b954eedeac495271d0f": 18,
  "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": 18,
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6,
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6,
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": 18,
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": 6,
  "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33": 18,
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": 6,
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": 6,
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6,
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 6,
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": 18,
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": 6,
  "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee": 18,
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": 6,
  "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": 6,
  "0xd586e7f844cea2f87f50152665bcbc2c279d8d70": 18,
  "0xd24c2ad096400b6fbcd2ad8b24e7acbc21a1da64": 18,
  "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73": 18,
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18,
  "0x55d398326f99059ff775485246999027b3197955": 18,
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": 18,
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": 18,
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": 18,
  "0xceba9300f2b948710d2653dd7b07f33a8b32118c": 6,
  "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e": 6,
  "0x765de816845861e75a25fca122bb6898b8b1282a": 18,
  "0x176211869ca2b568f2a7d4ee941e073a821ee1ff": 6,
  "0xa219439258ca9da29e9cc4ce5596924745e12b93": 6,
  "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9": 6,
  "0x779ded0c9e1022225f8e0630b35a9b54be713736": 6,
  "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4": 6,
  "0x29219dd400f2bf60e5a23d13be72b486d4038894": 6,
  "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4": 6,
  "0x493257fd37edb34451f62edf8d2a0c418852ba4c": 6,
  "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369": 6,
  "0x3a337a6ada9d885b6ad95ec48f9b75f197b5ae35": 6,
};

const BSC_WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BSC_USD1 = "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d";
const BSC_PANCAKE_V2_FACTORY =
  "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as const;
const PANCAKE_V2_FACTORY_ABI = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;
const BORROW_ASSET_USD_FEEDS: Partial<
  Record<number, Record<string, `0x${string}`>>
> = {
  56: {
    // Chainlink BNB/USD, also used by the executor's independent sizing gate.
    [BSC_WBNB]: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  },
};
const CHAINLINK_FEED_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
  },
] as const;
const EXTRA_FLASH_BORROW_ASSETS: Partial<Record<ChainId, ReadonlySet<string>>> = {
  // Verified active and flash-loan-enabled in Aave V3 BNB at runtime.
  bsc: new Set([BSC_WBNB]),
};
const NON_FLASH_BORROW_ASSETS: Partial<Record<ChainId, ReadonlySet<string>>> = {
  // USD1 is a valid stable quote/intermediate, but is not assumed to be an
  // Aave reserve merely because it trades near $1.
  bsc: new Set([BSC_USD1]),
};

const BSC_CORE_PRIORITY_ROUTE_SYMBOLS = [
  ["USDT", "WBNB", "USDC", "USDT"],
  ["USDT", "BTCB", "WBNB", "USDT"],
  ["USDT", "WETH", "WBNB", "USDT"],
  ["WBNB", "BTCB", "WETH", "WBNB"],
  ["USDT", "CAKE", "WBNB", "USDT"],
  ["USDC", "WBNB", "USDT", "USDC"],
  ["USDT", "USD1", "WBNB", "USDT"],
] as const;

// These are canonical BSC token addresses from the static allow-list above,
// not symbols discovered from an indexer. A two-pool path deliberately uses
// WBNB as both the flash asset and settlement asset: the same pool cannot be
// selected twice, so this only considers a real cross-pool (for example
// Pancake V2 -> V3) price difference and never a wash swap in one pool.
const BSC_MEME_PRIORITY_ROUTE_SYMBOLS = [
  ["WBNB", "PEPE", "WBNB"],
  ["WBNB", "FLOKI", "WBNB"],
  ["WBNB", "SHIB", "WBNB"],
  ["WBNB", "DOGE", "WBNB"],
  // QUQ is anchored to the high-volume Pancake V3 QUQ/USDT pool supplied by
  // the operator. USDT is retained here because it is the pool's actual quote
  // asset; a WBNB leg is not fabricated when no WBNB/QUQ pool is present.
  ["USDT", "QUQ", "USDT"],
] as const;

const BSC_MEME_PRIORITY_SYMBOLS = new Set([
  "PEPE",
  "FLOKI",
  "SHIB",
  "DOGE",
  "QUQ",
]);
const BSC_MEME_MIN_POOL_LIQUIDITY_USD = 100_000;
const BSC_MEME_MIN_ROUTE_VOLUME_24H_USD = 250_000;

const BSC_PRIORITY_ROUTE_SYMBOLS = [
  ...BSC_CORE_PRIORITY_ROUTE_SYMBOLS,
  ...BSC_MEME_PRIORITY_ROUTE_SYMBOLS,
] as const;

function boundedEnvInt(
  name: string,
  fallbackValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallbackValue;
}

const cache = new Map<string, { expiresAt: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_TTL_MS = {
  network: boundedEnvInt("SCANNER_NETWORK_CACHE_MS", 1_000, 250, 30_000),
  scan: boundedEnvInt("SCANNER_SCAN_CACHE_MS", 1_000, 250, 30_000),
  poolCatalog: boundedEnvInt(
    "SCANNER_POOL_CATALOG_CACHE_MS",
    5 * 60_000,
    30_000,
    30 * 60_000,
  ),
};

const SEARCH_LIMITS = {
  maxHops: boundedEnvInt("SCANNER_MAX_HOPS", 6, 3, 6),
  maxGraphCandidates: boundedEnvInt("SCANNER_MAX_GRAPH_CANDIDATES", 64, 1, 300),
  maxPoolsPerPair: boundedEnvInt("SCANNER_MAX_POOLS_PER_PAIR", 6, 1, 12),
  maxExploredPaths: boundedEnvInt(
    "SCANNER_MAX_EXPLORED_PATHS",
    750_000,
    10_000,
    3_000_000,
  ),
  maxExactQuotes: boundedEnvInt(
    "SCANNER_MAX_EXACT_QUOTES_PER_CHAIN",
    24,
    8,
    300,
  ),
  quoteConcurrency: boundedEnvInt("SCANNER_QUOTE_CONCURRENCY", 8, 1, 20),
};
const RPC_PRIMARY_COOLDOWN_MS = boundedEnvInt(
  "SCANNER_RPC_PRIMARY_COOLDOWN_MS",
  5 * 60_000,
  5_000,
  30 * 60_000,
);
const GLOBAL_CHAIN_WAIT_MS = boundedEnvInt(
  "SCANNER_GLOBAL_CHAIN_WAIT_MS",
  15_000,
  3_000,
  60_000,
);
const rpcPrimaryDisabledUntil = new Map<ChainId, number>();
const quoteScheduler = new FairQuoteScheduler();
const poolStateEngine = new IncrementalPoolStateEngine();
// DexScreener documents a 300 requests/minute limit for pair endpoints. Keep
// one process-wide gate because `chain=all` scans fourteen networks in
// parallel and per-chain concurrency alone otherwise creates a 429 burst.
const dexScreenerGate = new RateGate(
  boundedEnvInt("SCANNER_DEX_REQUEST_GAP_MS", 220, 200, 2_000),
);
const geckoTerminalGate = new RateGate(
  boundedEnvInt("SCANNER_GECKO_REQUEST_GAP_MS", 6_500, 3_000, 15_000),
);
const GECKO_RETRY_COOLDOWN_MS = boundedEnvInt(
  "SCANNER_GECKO_RETRY_COOLDOWN_MS",
  65_000,
  15_000,
  5 * 60_000,
);
let dexHealthExpiresAt = 0;
let dexHealthValue = true;
let dexHealthInflight: Promise<boolean> | null = null;
let geckoCooldownUntil = 0;
const GAS_COST_USD: Record<
  ChainId,
  { standard: number; graphBase: number; extraHop: number }
> = {
  ethereum: { standard: 18, graphBase: 24, extraHop: 6 },
  arbitrum: { standard: 1.75, graphBase: 2.5, extraHop: 0.6 },
  optimism: { standard: 0.35, graphBase: 0.55, extraHop: 0.15 },
  polygon: { standard: 0.15, graphBase: 0.25, extraHop: 0.08 },
  base: { standard: 0.08, graphBase: 0.12, extraHop: 0.03 },
  avalanche: { standard: 0.2, graphBase: 0.35, extraHop: 0.1 },
  bsc: { standard: 0.08, graphBase: 0.12, extraHop: 0.03 },
  celo: { standard: 0.03, graphBase: 0.05, extraHop: 0.02 },
  linea: { standard: 0.08, graphBase: 0.12, extraHop: 0.03 },
  mantle: { standard: 0.04, graphBase: 0.07, extraHop: 0.02 },
  scroll: { standard: 0.12, graphBase: 0.18, extraHop: 0.05 },
  sonic: { standard: 0.02, graphBase: 0.04, extraHop: 0.01 },
  zksync: { standard: 0.08, graphBase: 0.12, extraHop: 0.03 },
  soneium: { standard: 0.05, graphBase: 0.08, extraHop: 0.02 },
};

const addressFromEnv = (key: string): `0x${string}` | undefined => {
  const value = process.env[key];
  return value && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? getAddress(value)
    : undefined;
};

// Public deployment addresses. Ethereum and Arbitrum are the two deployments
// already verified in this workspace; additional networks become fundable as
// soon as their public executor address is configured for the API server.
const EXECUTOR_ADDRESSES: Partial<Record<number, `0x${string}`>> = {
  1:
    addressFromEnv("ARB_EXECUTOR_ETHEREUM") ??
    "0x54aeB3ea939151b3A5fAC85e2f3B084872A2B544",
  42161:
    addressFromEnv("ARB_EXECUTOR_ARBITRUM") ??
    "0x3BADbd179144785F8D90E421657F0a1ee20c688F",
  10: addressFromEnv("ARB_EXECUTOR_OPTIMISM"),
  137: addressFromEnv("ARB_EXECUTOR_POLYGON"),
  8453: addressFromEnv("ARB_EXECUTOR_BASE"),
  43114: addressFromEnv("ARB_EXECUTOR_AVALANCHE"),
  56: addressFromEnv("ARB_EXECUTOR_BSC"),
  42220: addressFromEnv("ARB_EXECUTOR_CELO"),
  59144: addressFromEnv("ARB_EXECUTOR_LINEA"),
  5000: addressFromEnv("ARB_EXECUTOR_MANTLE"),
  534352: addressFromEnv("ARB_EXECUTOR_SCROLL"),
  146: addressFromEnv("ARB_EXECUTOR_SONIC"),
  324: addressFromEnv("ARB_EXECUTOR_ZKSYNC"),
  1868: addressFromEnv("ARB_EXECUTOR_SONEIUM"),
};
const EXECUTOR_DEPLOYED = new Set<number>(
  Object.entries(EXECUTOR_ADDRESSES).flatMap(([chainId, address]) =>
    address ? [Number(chainId)] : [],
  ),
);
const MIN_GAS_BALANCE_WEI: Record<number, bigint> = {
  1: 1_000_000_000_000_000n,
  42161: 50_000_000_000_000n,
  10: 50_000_000_000_000n,
  137: 100_000_000_000_000_000n,
  8453: 50_000_000_000_000n,
  43114: 10_000_000_000_000_000n,
  56: 2_000_000_000_000_000n,
  42220: 100_000_000_000_000_000n,
  59144: 50_000_000_000_000n,
  5000: 50_000_000_000_000_000n,
  534352: 50_000_000_000_000n,
  146: 1_000_000_000_000_000_000n,
  324: 50_000_000_000_000n,
  1868: 50_000_000_000_000n,
};
const NATIVE_SYMBOL: Record<ChainId, string> = {
  ethereum: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "POL",
  base: "ETH",
  avalanche: "AVAX",
  bsc: "BNB",
  celo: "CELO",
  linea: "ETH",
  mantle: "MNT",
  scroll: "ETH",
  sonic: "S",
  zksync: "ETH",
  soneium: "ETH",
};
const EXECUTOR_READ_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowedTargets",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

function chainFromOpportunityId(id: string): ChainId {
  return CHAIN_IDS.find((chain) => id.startsWith(`${chain}-`)) ?? "ethereum";
}

async function jsonFetch<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      `Upstream ${response.status} from ${new URL(url).hostname}`,
    );
  return response.json() as Promise<T>;
}

async function dexScreenerHealthy(): Promise<boolean> {
  if (dexHealthExpiresAt > Date.now()) return dexHealthValue;
  if (dexHealthInflight) return dexHealthInflight;
  dexHealthInflight = dexScreenerGate
    .run(() =>
      jsonFetch<unknown>(
        "https://api.dexscreener.com/latest/dex/search?q=USDC",
        3_000,
      ),
    )
    .then(
      () => true,
      () => false,
    )
    .then((healthy) => {
      dexHealthValue = healthy;
      dexHealthExpiresAt = Date.now() + (healthy ? 60_000 : 5 * 60_000);
      return healthy;
    })
    .finally(() => {
      dexHealthInflight = null;
    });
  return dexHealthInflight;
}

async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = CACHE_TTL_MS.scan,
  staleWhileRevalidate = false,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const pending = inflight.get(key);
  if (pending)
    return hit && staleWhileRevalidate
      ? (hit.value as T)
      : (pending as Promise<T>);
  const request = loader()
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + ttlMs, value });
      return value;
    })
    .catch((err) => {
      // A transient upstream throttle must not erase the last real snapshot.
      // The stale value is never fabricated and will be refreshed next tick.
      if (hit) {
        logger.warn(
          { key, err },
          "upstream refresh failed; serving last real snapshot",
        );
        return hit.value as T;
      }
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  if (hit && staleWhileRevalidate) return hit.value as T;
  return request;
}

async function borrowAssetUsdPrice(
  chain: ChainId,
  tokenAddress: string,
): Promise<number | null> {
  if (isStableQuote(RPCS[chain].chainId, tokenAddress)) return 1;
  const feed = BORROW_ASSET_USD_FEEDS[RPCS[chain].chainId]?.[tokenAddress.toLowerCase()];
  if (!feed) return null;
  return cached(
    `borrow-usd-price:${chain}:${tokenAddress.toLowerCase()}`,
    async () => {
      const [decimals, round] = await Promise.all([
        CHAIN_CLIENTS[chain].readContract({
          address: feed,
          abi: CHAINLINK_FEED_ABI,
          functionName: "decimals",
        }),
        CHAIN_CLIENTS[chain].readContract({
          address: feed,
          abi: CHAINLINK_FEED_ABI,
          functionName: "latestRoundData",
        }),
      ]);
      const answer = round[1];
      const updatedAt = Number(round[3]);
      const ageSeconds = Math.floor(Date.now() / 1_000) - updatedAt;
      if (answer <= 0n || ageSeconds > 3_600) return null;
      return Number(answer) / 10 ** decimals;
    },
    30_000,
  );
}

async function rpcAt(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${response.status}`);
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

async function rpc(
  chain: ChainId,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const { url, fallbackUrl } = RPCS[chain];
  const hasDistinctFallback = url !== fallbackUrl;
  const disabledUntil = rpcPrimaryDisabledUntil.get(chain) ?? 0;
  if (hasDistinctFallback && disabledUntil > Date.now()) {
    return rpcAt(fallbackUrl, method, params);
  }
  try {
    return await rpcAt(url, method, params);
  } catch (err) {
    if (!hasDistinctFallback) throw err; // no distinct fallback configured — nothing to gain by retrying the same URL
    const retryAt = Date.now() + RPC_PRIMARY_COOLDOWN_MS;
    rpcPrimaryDisabledUntil.set(chain, retryAt);
    logger.warn(
      {
        chain,
        method,
        err,
        primaryDisabledUntil: new Date(retryAt).toISOString(),
      },
      "primary RPC failed; circuit opened and fallback selected",
    );
    try {
      return await rpcAt(fallbackUrl, method, params);
    } catch (fallbackErr) {
      throw new Error(
        `RPC failed on both primary and fallback for ${chain}: ${(fallbackErr as Error).message}`,
      );
    }
  }
}

function hexNumber(value: unknown): number {
  return typeof value === "string" ? Number.parseInt(value, 16) : 0;
}

async function networkStatus(chain: ChainId) {
  return cached(
    `network:${chain}`,
    async () => {
      const blockHex = await rpc(chain, "eth_blockNumber");
      const [gasHex, latest, previous] = await Promise.all([
        rpc(chain, "eth_gasPrice"),
        rpc(chain, "eth_getBlockByNumber", ["latest", false]),
        rpc(chain, "eth_getBlockByNumber", [
          `0x${Math.max(0, hexNumber(blockHex) - 1).toString(16)}`,
          false,
        ]),
      ]);
      const current = latest as { timestamp?: string } | null;
      const parent = previous as { timestamp?: string } | null;
      const blockNumber = hexNumber(blockHex);
      const currentTime = hexNumber(current?.timestamp);
      const parentTime = hexNumber(parent?.timestamp);
      return {
        id: chain,
        name: RPCS[chain].name,
        chainId: RPCS[chain].chainId,
        status: "healthy" as const,
        blockNumber,
        gasGwei: hexNumber(gasHex) / 1e9,
        blockTimeMs: Math.max(0, (currentTime - parentTime) * 1000),
        pools: 0,
        lastBlockAt: currentTime
          ? new Date(currentTime * 1000).toISOString()
          : new Date().toISOString(),
      };
    },
    CACHE_TTL_MS.network,
  );
}

export type DexPair = {
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  labels?: string[];
};

export type LiveMarket = { token: TokenDefinition; pairs: DexPair[] };

// Keep the last real pool catalog across API restarts. A cold scan may need
// more than a minute when a public indexer rate-limits fourteen networks; the
// persisted snapshot lets the UI render immediately while the normal
// stale-while-revalidate path refreshes it in the background.
const persistentCatalogLoaded = new Set<ChainId>();
const persistentCatalogDirectory = process.env["SCANNER_CACHE_DIR"]
  ? path.resolve(process.env["SCANNER_CACHE_DIR"]!)
  : path.resolve(process.cwd(), ".cache", "scanner-market-catalog");

function isLiveMarketCatalog(value: unknown): value is LiveMarket[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const market = entry as Partial<LiveMarket>;
      return Boolean(
        market.token &&
        typeof market.token.symbol === "string" &&
        typeof market.token.name === "string" &&
        Number.isInteger(market.token.decimals) &&
        market.token.addresses &&
        Array.isArray(market.pairs),
      );
    })
  );
}

async function hydratePersistentMarkets(chain: ChainId): Promise<void> {
  if (persistentCatalogLoaded.has(chain)) return;
  persistentCatalogLoaded.add(chain);
  try {
    const raw = await readFile(
      path.join(persistentCatalogDirectory, `${chain}.json`),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { markets?: unknown };
    if (!isLiveMarketCatalog(parsed.markets)) return;
    cache.set(`markets:${chain}`, { expiresAt: 0, value: parsed.markets });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ chain, err }, "persisted market catalog unavailable");
    }
  }
}

async function persistMarkets(
  chain: ChainId,
  markets: LiveMarket[],
): Promise<void> {
  try {
    await mkdir(persistentCatalogDirectory, { recursive: true });
    const target = path.join(persistentCatalogDirectory, `${chain}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ savedAt: new Date().toISOString(), markets }),
      "utf8",
    );
    await rename(temporary, target);
  } catch (err) {
    logger.warn(
      { chain, err },
      "market catalog snapshot could not be persisted",
    );
  }
}

const GECKO_NETWORKS: Record<ChainId, string> = {
  ethereum: "eth",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon_pos",
  base: "base",
  avalanche: "avax",
  bsc: "bsc",
  celo: "celo",
  linea: "linea",
  mantle: "mantle",
  scroll: "scroll",
  sonic: "sonic",
  zksync: "zksync",
  soneium: "soneium",
};

type GeckoResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string } }>;
};
type GeckoPoolResponse = { data?: GeckoResource[]; included?: GeckoResource[] };

function normalizeGeckoDex(id: string): { dexId: string; labels: string[] } {
  const normalized = id.toLowerCase();
  const labels = ["v2", "v3", "v4"].filter((label) =>
    normalized.includes(label),
  );
  if (normalized.includes("uniswap")) return { dexId: "uniswap", labels };
  if (normalized.includes("sushiswap")) return { dexId: "sushiswap", labels };
  if (normalized.includes("pancakeswap"))
    return { dexId: "pancakeswap", labels };
  if (normalized.includes("aerodrome")) return { dexId: "aerodrome", labels };
  if (normalized.includes("velodrome")) return { dexId: "velodrome", labels };
  if (normalized.includes("camelot")) return { dexId: "camelot", labels };
  if (normalized.includes("trader-joe") || normalized.includes("lfj"))
    return { dexId: "lfj", labels };
  if (normalized.includes("curve")) return { dexId: "curve", labels };
  if (normalized.includes("balancer")) return { dexId: "balancer", labels };
  return { dexId: normalized.split("-")[0] ?? normalized, labels };
}

export function geckoPoolsToDexPairs(
  chain: ChainId,
  response: GeckoPoolResponse,
): DexPair[] {
  const included = new Map(
    (response.included ?? []).map((resource) => [resource.id, resource]),
  );
  return (response.data ?? []).flatMap((pool) => {
    const attributes = pool.attributes ?? {};
    const baseId = pool.relationships?.base_token?.data?.id;
    const quoteId = pool.relationships?.quote_token?.data?.id;
    const dexId = pool.relationships?.dex?.data?.id;
    const base = baseId ? included.get(baseId)?.attributes : undefined;
    const quote = quoteId ? included.get(quoteId)?.attributes : undefined;
    const address = String(attributes.address ?? "");
    const baseAddress = String(base?.address ?? "");
    const quoteAddress = String(quote?.address ?? "");
    if (
      !validTokenAddress(address) ||
      !validTokenAddress(baseAddress) ||
      !validTokenAddress(quoteAddress) ||
      !dexId
    )
      return [];
    const dex = normalizeGeckoDex(dexId);
    const network = GECKO_NETWORKS[chain];
    return [
      {
        dexId: dex.dexId,
        labels: dex.labels,
        url: `https://www.geckoterminal.com/${network}/pools/${address}`,
        pairAddress: address,
        baseToken: {
          address: baseAddress,
          symbol: String(base?.symbol ?? "TOKEN"),
        },
        quoteToken: {
          address: quoteAddress,
          symbol: String(quote?.symbol ?? "TOKEN"),
        },
        priceUsd: String(attributes.base_token_price_usd ?? "0"),
        priceNative: String(attributes.base_token_price_quote_token ?? "0"),
        liquidity: { usd: Number(attributes.reserve_in_usd ?? 0) },
        volume: {
          h24: Number(
            (attributes.volume_usd as Record<string, unknown> | undefined)
              ?.h24 ?? 0,
          ),
        },
        priceChange: {
          h24: Number(
            (
              attributes.price_change_percentage as
                Record<string, unknown> | undefined
            )?.h24 ?? 0,
          ),
        },
      },
    ];
  });
}

async function geckoPairsFor(
  chain: ChainId,
  address: string,
): Promise<DexPair[]> {
  const network = GECKO_NETWORKS[chain];
  // One network snapshot is shared by every seed token. The public fallback
  // is intentionally a degradation path: querying Gecko once per token would
  // exceed its free request budget during a fourteen-chain cold start.
  const pairs = await cached(
    `gecko-network-pairs:${chain}`,
    async () => {
      const pages = boundedEnvInt("SCANNER_GECKO_PAGES_PER_CHAIN", 1, 1, 3);
      const output: DexPair[] = [];
      for (let page = 1; page <= pages; page++) {
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}&include=base_token%2Cquote_token%2Cdex`;
        let response: GeckoPoolResponse | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            response = await geckoTerminalGate.run(async () => {
              // Re-check inside the process-wide gate. Concurrent chains may
              // have queued before another request observed a 429; checking
              // outside the gate would let that whole queue ignore cooldown.
              const cooldown = geckoCooldownUntil - Date.now();
              if (cooldown > 0)
                await new Promise((resolve) => setTimeout(resolve, cooldown));
              return jsonFetch<GeckoPoolResponse>(url, 10_000);
            });
            break;
          } catch (err) {
            if (
              !(err instanceof Error) ||
              !err.message.includes("Upstream 429")
            )
              throw err;
            // Demo limits are rolling and can also be consumed by another local
            // process. A shared cooldown lets the window recover instead of
            // failing every token request in the current scan.
            geckoCooldownUntil = Math.max(
              geckoCooldownUntil,
              Date.now() + GECKO_RETRY_COOLDOWN_MS,
            );
            logger.warn(
              { chain, attempt: attempt + 1 },
              "GeckoTerminal rate limited; backing off catalog fallback",
            );
          }
        }
        if (!response)
          throw new Error(
            `GeckoTerminal catalog unavailable for ${chain} after backoff`,
          );
        output.push(...geckoPoolsToDexPairs(chain, response));
      }
      return output;
    },
    CACHE_TTL_MS.poolCatalog,
  );
  const normalized = address.toLowerCase();
  return pairs.filter(
    (pair) =>
      pair.baseToken?.address?.toLowerCase() === normalized ||
      pair.quoteToken?.address?.toLowerCase() === normalized,
  );
}

const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

function validTokenAddress(
  address: string | undefined,
): address is `0x${string}` {
  return Boolean(address && /^0x[a-fA-F0-9]{40}$/.test(address));
}

// Tokens proven incompatible by a full ArbExecutor eth_estimateGas are kept
// out of the executable cycle graph. VIN and YFSX both reverted when a
// Pancake V2 router tried to spend the output of the preceding hop, so their
// pool quotes can look profitable while the atomic transaction cannot settle.
// Key by address (not symbol) so an unrelated token cannot be excluded merely
// by reusing the same ticker on another chain.
const NON_EXECUTABLE_ROUTE_TOKENS: Partial<
  Record<ChainId, ReadonlySet<string>>
> = {
  bsc: new Set([
    "0x85e43bf8faaf04ceddcd03d6c07438b72606a988", // VIN
    "0xb7ec60cf8ef96ed48b119277bc7a954a87f27388", // YFSX
  ]),
};

function isNonExecutableRouteToken(chain: ChainId, address: string): boolean {
  return NON_EXECUTABLE_ROUTE_TOKENS[chain]?.has(address.toLowerCase()) ?? false;
}

async function executorAllowsRouteTokens(
  chain: ChainId,
  addresses: string[],
): Promise<boolean> {
  const executorAddress = EXECUTOR_ADDRESSES[RPCS[chain].chainId];
  if (!executorAddress) return false;
  const targets = [
    ...new Set(
      addresses
        .filter(validTokenAddress)
        .map((address) => address.toLowerCase()),
    ),
  ].sort();
  if (targets.length === 0) return false;

  return cached(
    `executor-targets:${chain}:${targets.join(":")}`,
    async () => {
      try {
        const results = await CHAIN_CLIENTS[chain].multicall({
          contracts: targets.map((target) => ({
            address: executorAddress,
            abi: EXECUTOR_READ_ABI,
            functionName: "allowedTargets" as const,
            args: [getAddress(target)],
          })),
          allowFailure: true,
          batchSize: 8_192,
        });
        return results.every(
          (result: { status: string; result?: unknown }) =>
            result.status === "success" && result.result === true,
        );
      } catch (err) {
        logger.debug(
          { err, chain, targets: targets.length },
          "executor target allow-list unavailable",
        );
        return false;
      }
    },
    30_000,
  );
}

async function readTokenDecimals(
  chain: ChainId,
  tokens: Array<{ address: `0x${string}`; symbol: string }>,
): Promise<Array<{ address: string; symbol: string; decimals: number }>> {
  if (tokens.length === 0) return [];
  try {
    const results = await CHAIN_CLIENTS[chain].multicall({
      contracts: tokens.map(({ address }) => ({
        address,
        abi: erc20DecimalsAbi,
        functionName: "decimals",
      })),
      allowFailure: true,
      batchSize: 8_192,
    });
    return tokens.flatMap((token, index) => {
      const result = results[index];
      const decimals =
        result?.status === "success" ? Number(result.result) : -1;
      return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36
        ? [{ ...token, decimals }]
        : [];
    });
  } catch (err) {
    logger.debug(
      { err, chain, tokens: tokens.length },
      "dynamic token metadata unavailable",
    );
    return [];
  }
}

export async function pairsFor(chain: ChainId, address: string): Promise<DexPair[]> {
  const raw = await cached(
    `pairs:${chain}:${address.toLowerCase()}`,
    async () => {
      if (await dexScreenerHealthy()) {
        try {
          return await dexScreenerGate.run(() =>
            jsonFetch<unknown[]>(
              `https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`,
              8_000,
            ),
          );
        } catch (err) {
          dexHealthValue = false;
          dexHealthExpiresAt = Date.now() + 5 * 60_000;
          logger.warn(
            { err },
            "DexScreener pool catalog unavailable; switching to GeckoTerminal fallback",
          );
        }
      }
      return geckoPairsFor(chain, address);
    },
    CACHE_TTL_MS.poolCatalog,
  );
  return Array.isArray(raw) ? (raw as DexPair[]) : [];
}

export async function liveMarkets(chain: ChainId): Promise<LiveMarket[]> {
  await hydratePersistentMarkets(chain);
  const cacheKey = `markets:${chain}`;
  const previousCatalog = cache.get(cacheKey)?.value;
  const hasPreviousCatalog = isLiveMarketCatalog(previousCatalog);
  const definitions = TOKEN_DEFINITIONS.map((token) => ({
    token,
    address: token.addresses[chain],
  })).filter((item): item is { token: TokenDefinition; address: string } =>
    Boolean(item.address),
  );
  return cached(
    cacheKey,
    async () => {
      const markets: LiveMarket[] = [];
      let failures = 0;
      // /token-pairs returns the complete pool set for one asset; /tokens/v1
      // accepts 30 addresses but only returns a small top-pair sample and would
      // remove most graph edges. Coalescing `markets:${chain}` above guarantees
      // these bounded batches run once per snapshot, even when four dashboard
      // widgets request the same scan concurrently.
      for (let offset = 0; offset < definitions.length; offset += 4) {
        const batch = await Promise.allSettled(
          definitions
            .slice(offset, offset + 4)
            .map(async ({ token, address }) => ({
              token,
              pairs: await pairsFor(chain, address),
            })),
        );
        for (const result of batch) {
          if (result.status === "fulfilled") markets.push(result.value);
          else failures++;
        }
      }
      if (markets.length === 0)
        throw new Error(`All market-data requests failed for ${chain}`);

      // Expand one frontier beyond the static seed list. Ranking by aggregate
      // connected liquidity adds liquid assets that the indexer reveals at
      // runtime, then fetches their complete pool catalogs. This exposes paths
      // such as stable -> newly discovered token -> second protocol -> WETH ->
      // stable without hard-coding every token deployed on fourteen chains.
      const knownAddresses = new Set(
        definitions.map(({ address }) => address.toLowerCase()),
      );
      const frontier = new Map<
        string,
        { address: `0x${string}`; symbol: string; score: number }
      >();
      for (const { pairs } of markets) {
        for (const pair of pairs) {
          const liquidity = Number(pair.liquidity?.usd ?? 0);
          if (liquidity < 25_000) continue;
          for (const token of [pair.baseToken, pair.quoteToken]) {
            if (
              !validTokenAddress(token?.address) ||
              knownAddresses.has(token.address.toLowerCase())
            )
              continue;
            const key = token.address.toLowerCase();
            const current = frontier.get(key);
            const symbol =
              (token.symbol ?? "TOKEN").replace(/[^\w.\-]/g, "").slice(0, 24) ||
              "TOKEN";
            frontier.set(key, {
              address: token.address,
              symbol,
              score: (current?.score ?? 0) + liquidity,
            });
          }
        }
      }
      const expansionLimit = boundedEnvInt(
        `SCANNER_DISCOVERY_TOKENS_${chain.toUpperCase()}`,
        boundedEnvInt("SCANNER_DISCOVERY_TOKENS_PER_CHAIN", 8, 0, 50),
        0,
        50,
      );
      const selectedFrontier = [...frontier.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, expansionLimit);
      const requestedAddresses = new Set([
        ...knownAddresses,
        ...selectedFrontier.map(({ address }) => address.toLowerCase()),
      ]);
      const expandedTokens = await readTokenDecimals(chain, selectedFrontier);
      for (let offset = 0; offset < expandedTokens.length; offset += 4) {
        const batch = await Promise.allSettled(
          expandedTokens.slice(offset, offset + 4).map(async (discovered) => {
            const token: TokenDefinition = {
              symbol: discovered.symbol,
              name: discovered.symbol,
              decimals: discovered.decimals,
              addresses: { [chain]: discovered.address },
            };
            return { token, pairs: await pairsFor(chain, discovered.address) };
          }),
        );
        for (const result of batch) {
          if (result.status === "fulfilled") markets.push(result.value);
          else failures++;
        }
      }
      if (failures > 0) {
        logger.warn(
          { chain, failures, successes: markets.length },
          "partial market-data scan",
        );
      }
      // One throttled token must not discard every successful addition in the
      // same refresh. Fill only missing active addresses from the last real
      // snapshot; old frontier tokens that are no longer selected are dropped.
      const mergedMarkets = mergeActiveMarketCatalog(
        chain,
        requestedAddresses,
        markets,
        hasPreviousCatalog ? previousCatalog : [],
      );
      if (mergedMarkets.length === 0)
        throw new Error(`No usable market data returned for ${chain}`);
      await persistMarkets(chain, mergedMarkets);
      return mergedMarkets;
    },
    CACHE_TTL_MS.poolCatalog,
    true,
  );
}

async function graphTokenMap(
  chain: ChainId,
  markets: Awaited<ReturnType<typeof liveMarkets>>,
): Promise<Map<string, { address: string; symbol: string; decimals: number }>> {
  return cached(
    `graph-tokens:${chain}`,
    async () => {
      const tokens = new Map<
        string,
        { address: string; symbol: string; decimals: number }
      >();
      // Static, canonical definitions remain available to on-chain priority
      // pool discovery even if an indexer throttles that token's catalog call.
      for (const token of TOKEN_DEFINITIONS) {
        const address = token.addresses[chain];
        if (address)
          tokens.set(address.toLowerCase(), {
            address,
            symbol: token.symbol,
            decimals: tokenDecimals(token, chain),
          });
      }
      for (const { token } of markets) {
        const address = token.addresses[chain];
        if (address)
          tokens.set(address.toLowerCase(), {
            address,
            symbol: token.symbol,
            decimals: tokenDecimals(token, chain),
          });
      }
      const unknown = new Map<
        string,
        { address: `0x${string}`; symbol: string; score: number }
      >();
      for (const { pairs } of markets) {
        for (const pair of pairs) {
          const liquidity = Number(pair.liquidity?.usd ?? 0);
          if (liquidity < 25_000) continue;
          for (const token of [pair.baseToken, pair.quoteToken]) {
            if (
              !validTokenAddress(token?.address) ||
              tokens.has(token.address.toLowerCase())
            )
              continue;
            const key = token.address.toLowerCase();
            const current = unknown.get(key);
            unknown.set(key, {
              address: token.address,
              symbol:
                (token.symbol ?? "TOKEN")
                  .replace(/[^\w.\-]/g, "")
                  .slice(0, 24) || "TOKEN",
              score: Math.max(current?.score ?? 0, liquidity),
            });
          }
        }
      }
      const limit = boundedEnvInt(
        "SCANNER_MAX_DISCOVERED_GRAPH_TOKENS",
        400,
        0,
        2_000,
      );
      const discovered = await readTokenDecimals(
        chain,
        [...unknown.values()].sort((a, b) => b.score - a.score).slice(0, limit),
      );
      for (const token of discovered)
        tokens.set(token.address.toLowerCase(), token);
      return tokens;
    },
    CACHE_TTL_MS.poolCatalog,
  ) as Promise<
    Map<string, { address: string; symbol: string; decimals: number }>
  >;
}

function buildOpportunities(
  chain: ChainId,
  markets: Awaited<ReturnType<typeof liveMarkets>>,
  blockNumber: number,
  livePoolStates: Map<
    string,
    { baseToQuote: number; feeBps: number }
  > = new Map(),
): Opportunity[] {
  const output: Opportunity[] = [];
  for (const { token, pairs } of markets) {
    const address = token.addresses[chain];
    if (!address) continue;
    const priced = pairs
      .map((pair) => {
        const normalized = normalizeTrackedPair(pair, address);
        const stateKey =
          pair.pairAddress &&
          pair.baseToken?.address &&
          pair.quoteToken?.address
            ? `${pair.pairAddress.toLowerCase()}:${pair.baseToken.address.toLowerCase()}:${pair.quoteToken.address.toLowerCase()}`
            : undefined;
        const liveState = stateKey ? livePoolStates.get(stateKey) : undefined;
        if (
          !normalized ||
          !liveState ||
          !normalized.counterTokenAddress ||
          QUOTE_DECIMALS[normalized.counterTokenAddress.toLowerCase()] ===
            undefined
        ) {
          return { pair, normalized };
        }
        const trackedIsBase =
          pair.baseToken?.address?.toLowerCase() === address.toLowerCase();
        return {
          pair,
          normalized: {
            ...normalized,
            priceUsd: trackedIsBase
              ? liveState.baseToQuote
              : 1 / liveState.baseToQuote,
          },
        };
      })
      .filter(
        ({ pair, normalized }) =>
          normalized !== null &&
          normalized.priceUsd > 0 &&
          Number(pair.liquidity?.usd ?? 0) > 10_000 &&
          pair.dexId &&
          pair.pairAddress,
      );
    const prices = priced
      .map(({ normalized }) => normalized!.priceUsd)
      .sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const usable: Venue[] = priced
      .filter(
        ({ normalized }) =>
          median > 0 &&
          normalized!.priceUsd >= median * 0.7 &&
          normalized!.priceUsd <= median * 1.3,
      )
      .map(({ pair, normalized }) => ({
        name: pair
          .dexId!.replace(/-/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase()),
        dexId: pair.dexId!,
        chain: RPCS[chain].name,
        priceUsd: normalized!.priceUsd,
        liquidityUsd: Number(pair.liquidity?.usd ?? 0),
        feeBps:
          (pair.pairAddress
            ? livePoolStates.get(pair.pairAddress.toLowerCase())?.feeBps
            : undefined) ??
          (pair.dexId === "curve"
            ? 4
            : pair.dexId === "pancakeswap" &&
                pair.labels?.some((label) => label.toLowerCase() === "v2")
              ? 25
              : 30),
        pairAddress: pair.pairAddress!,
        dexUrl:
          pair.url ?? `${RPCS[chain].explorer}/address/${pair.pairAddress}`,
        volume24h: Number(pair.volume?.h24 ?? 0),
        labels: pair.labels,
        quoteTokenAddress: normalized!.counterTokenAddress,
        quoteTokenSymbol: normalized!.counterTokenSymbol,
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    for (const buy of usable) {
      for (const sell of usable) {
        if (
          sell.pairAddress === buy.pairAddress ||
          sell.priceUsd <= buy.priceUsd
        )
          continue;
        const spreadPct = ((sell.priceUsd - buy.priceUsd) / buy.priceUsd) * 100;
        const spreadBps = spreadPct * 100;
        if (spreadBps < 2) continue;
        const borrow = Math.min(
          100_000,
          buy.liquidityUsd * 0.05,
          sell.liquidityUsd * 0.05,
        );
        const gross = (borrow * spreadPct) / 100;
        const dexFees = (borrow * (buy.feeBps + sell.feeBps)) / 10_000;
        // Price impact from a constant-product AMM (x*y=k): trading `borrow`
        // against a pool moves the price by roughly borrow / (reserve + borrow),
        // where `liquidityUsd / 2` approximates one side's USD reserve for a
        // balanced pool. Applied per leg (buying pushes the cheap venue's
        // price up, selling pushes the expensive venue's price down), unlike
        // the previous flat 25%-of-gross-profit estimate, which was the same
        // regardless of whether the pool was deep or nearly empty.
        const buyImpactPct = borrow / (buy.liquidityUsd / 2 + borrow);
        const sellImpactPct = borrow / (sell.liquidityUsd / 2 + borrow);
        const slippage = borrow * (buyImpactPct + sellImpactPct);
        const flashLoan = borrow * 0.0005;
        const gas = GAS_COST_USD[chain].standard;
        const net = gross - dexFees - slippage - flashLoan - gas;
        const eligible =
          spreadBps > 10 &&
          routeEligible(RPCS[chain].chainId, address, buy, sell);
        output.push({
          id: `${chain}-${token.symbol.toLowerCase()}-${buy.pairAddress.toLowerCase().replace(/[^a-f0-9]/g, "")}-${sell.pairAddress.toLowerCase().replace(/[^a-f0-9]/g, "")}`,
          token: token.symbol,
          tokenAddress: address,
          tokenDecimals: tokenDecimals(token, chain),
          pair:
            buy.quoteTokenSymbol === sell.quoteTokenSymbol
              ? `${token.symbol}/${buy.quoteTokenSymbol ?? "quote"}`
              : `${buy.quoteTokenSymbol ?? "?"} → ${token.symbol} → ${sell.quoteTokenSymbol ?? "?"}`,
          chain: RPCS[chain].name,
          chainId: RPCS[chain].chainId,
          spreadBps: Number(spreadBps.toFixed(2)),
          spreadPct: Number(spreadPct.toFixed(4)),
          buyVenue: buy,
          sellVenue: sell,
          routeKind:
            buy.quoteTokenAddress?.toLowerCase() ===
            sell.quoteTokenAddress?.toLowerCase()
              ? "two-pool"
              : "cross-stable",
          profit: {
            grossProfitUsd: eligible ? Number(gross.toFixed(2)) : 0,
            flashLoanFeeUsd: eligible ? Number(flashLoan.toFixed(2)) : 0,
            gasCostUsd: eligible ? Number(gas.toFixed(2)) : 0,
            dexFeesUsd: eligible ? Number(dexFees.toFixed(2)) : 0,
            slippageUsd: eligible ? Number(slippage.toFixed(2)) : 0,
            // A cross-quote price dislocation is not a closed cycle and has
            // no realizable net profit until entry/exit legs exist. Never
            // present its partial two-market arithmetic as money available.
            netProfitUsd: eligible ? Number(net.toFixed(2)) : 0,
            recommendedBorrowUsd: eligible ? Number(borrow.toFixed(2)) : 0,
            confidence: eligible && spreadBps > 15 ? "medium" : "low",
          },
          detectedAt: new Date().toISOString(),
          blockNumber,
          executable: eligible,
          executorDeployed: EXECUTOR_DEPLOYED.has(RPCS[chain].chainId),
          quoteStatus: eligible ? "estimated" : "unavailable",
          executionBlocker: eligible ? undefined : "unsupported-or-open-route",
          status: "new",
        });
      }
    }
  }
  return output.sort((a, b) => b.profit.netProfitUsd - a.profit.netProfitUsd);
}

function buildCyclePools(
  chain: ChainId,
  markets: Awaited<ReturnType<typeof liveMarkets>>,
  tokenByAddress: Map<
    string,
    { address: string; symbol: string; decimals: number }
  >,
): Array<CyclePool<Venue>> {
  const chainId = RPCS[chain].chainId;
  const seenPools = new Set<string>();
  const pools: Array<CyclePool<Venue>> = [];

  for (const { pairs } of markets) {
    for (const pair of pairs) {
      const pairAddress = pair.pairAddress;
      const baseAddress = pair.baseToken?.address;
      const quoteAddress = pair.quoteToken?.address;
      if (!pairAddress || !baseAddress || !quoteAddress || !pair.dexId)
        continue;
      if (
        isNonExecutableRouteToken(chain, baseAddress) ||
        isNonExecutableRouteToken(chain, quoteAddress)
      )
        continue;
      const base = tokenByAddress.get(baseAddress.toLowerCase());
      const quote = tokenByAddress.get(quoteAddress.toLowerCase());
      const baseToQuote = Number(pair.priceNative ?? 0);
      const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
      if (!base || !quote || baseToQuote <= 0 || liquidityUsd < 25_000)
        continue;
      const venue: Venue = {
        name: pair.dexId
          .replace(/-/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase()),
        dexId: pair.dexId,
        chain: RPCS[chain].name,
        priceUsd: Number(pair.priceUsd ?? 0),
        liquidityUsd,
        feeBps:
          pair.dexId === "curve"
            ? 4
            : pair.dexId === "pancakeswap" &&
                pair.labels?.some((label) => label.toLowerCase() === "v2")
              ? 25
              : 30,
        pairAddress,
        dexUrl: pair.url ?? `${RPCS[chain].explorer}/address/${pairAddress}`,
        volume24h: Number(pair.volume?.h24 ?? 0),
        labels: pair.labels,
      };
      if (!venueSupported(chainId, venue)) continue;
      const pool = {
        pairAddress,
        liquidityUsd,
        feeBps: venue.feeBps,
        base,
        quote,
        baseToQuote,
        venue,
      };
      const edgeKey = cyclePoolEdgeKey(pool);
      if (seenPools.has(edgeKey)) continue;
      seenPools.add(edgeKey);
      pools.push(pool);
    }
  }

  return pools;
}

/**
 * Seed the requested BSC cycles from Pancake V2's on-chain factory. Indexers
 * cap token-pair responses, so a deep but non-top-30 edge can otherwise vanish
 * from the graph even though the pool exists. Reserves and spot rates are
 * refreshed on-chain immediately afterwards; the conservative fallback
 * liquidity only bounds sizing if no indexer record exists for that pool.
 */
async function bscPriorityV2Pools(
  chain: ChainId,
  tokenByAddress: Map<
    string,
    { address: string; symbol: string; decimals: number }
  >,
  indexedPools: Array<CyclePool<Venue>>,
): Promise<Array<CyclePool<Venue>>> {
  if (chain !== "bsc") return [];
  const tokenBySymbol = new Map(
    [...tokenByAddress.values()].map((token) => [token.symbol, token]),
  );
  const requestedPairs = new Map<
    string,
    [
      { address: string; symbol: string; decimals: number },
      { address: string; symbol: string; decimals: number },
    ]
  >();
  for (const symbols of BSC_PRIORITY_ROUTE_SYMBOLS) {
    for (let index = 0; index < symbols.length - 1; index++) {
      const left = tokenBySymbol.get(symbols[index]!);
      const right = tokenBySymbol.get(symbols[index + 1]!);
      if (!left || !right) continue;
      const key = [left.address.toLowerCase(), right.address.toLowerCase()]
        .sort()
        .join(":");
      requestedPairs.set(key, [left, right]);
    }
  }
  const pairs = [...requestedPairs.values()];
  if (pairs.length === 0) return [];
  const results = await CHAIN_CLIENTS.bsc.multicall({
    contracts: pairs.map(([left, right]) => ({
      address: BSC_PANCAKE_V2_FACTORY,
      abi: PANCAKE_V2_FACTORY_ABI,
      functionName: "getPair" as const,
      args: [getAddress(left.address), getAddress(right.address)],
    })),
    allowFailure: true,
    batchSize: 8_192,
  });
  return results.flatMap(
    (result: { status: string; result?: unknown }, index: number) => {
    if (result.status !== "success") return [];
    const pairAddress = String(result.result);
    if (!validTokenAddress(pairAddress) || /^0x0{40}$/i.test(pairAddress))
      return [];
    const [base, quote] = pairs[index]!;
    const indexed = indexedPools.find(
      (pool) => pool.pairAddress.toLowerCase() === pairAddress.toLowerCase(),
    );
    const indexedRate = indexed
      ? indexed.base.address.toLowerCase() === base.address.toLowerCase()
        ? indexed.baseToQuote
        : 1 / indexed.baseToQuote
      : 1;
    const liquidityUsd = Math.max(25_000, indexed?.liquidityUsd ?? 0);
    const venue: Venue = {
      name: "PancakeSwap V2",
      dexId: "pancakeswap",
      chain: RPCS.bsc.name,
      priceUsd: indexed?.venue.priceUsd ?? 0,
      liquidityUsd,
      feeBps: 25,
      pairAddress,
      dexUrl: `${RPCS.bsc.explorer}/address/${pairAddress}`,
      volume24h: indexed?.venue.volume24h ?? 0,
      labels: ["v2"],
    };
    return [
      {
        pairAddress,
        liquidityUsd,
        feeBps: 25,
        base,
        quote,
        baseToQuote: indexedRate,
        venue,
      },
    ];
    },
  );
}

function buildGraphOpportunities(
  chain: ChainId,
  pools: Array<CyclePool<Venue>>,
  blockNumber: number,
): Opportunity[] {
  const chainId = RPCS[chain].chainId;
  const tokenByAddress = new Map(
    TOKEN_DEFINITIONS.flatMap((token) => {
      const address = token.addresses[chain];
      return address
        ? [
            [
              address.toLowerCase(),
              {
                address,
                symbol: token.symbol,
                decimals: tokenDecimals(token, chain),
              },
            ] as const,
          ]
        : [];
    }),
  );
  const borrowAssets = new Set(
    [...tokenByAddress.keys()].filter(
      (address) =>
        QUOTE_DECIMALS[address] !== undefined &&
        !NON_FLASH_BORROW_ASSETS[chain]?.has(address),
    ),
  );
  for (const address of EXTRA_FLASH_BORROW_ASSETS[chain] ?? [])
    borrowAssets.add(address);

  const priorityTemplates =
    chain === "bsc"
      ? BSC_PRIORITY_ROUTE_SYMBOLS.flatMap((symbols, index) => {
          const addresses = symbols.map((symbol) =>
            [...tokenByAddress.values()].find((token) => token.symbol === symbol)
              ?.address,
          );
          return addresses.every((address): address is string => Boolean(address))
            ? [{ id: `route-${index + 1}`, tokenAddresses: addresses }]
            : [];
        })
      : [];
  const prioritizedCycles = findPrioritizedCycles(
    pools,
    priorityTemplates,
    borrowAssets,
    {
      minEstimatedBps: 2,
      maxPoolsPerLeg: SEARCH_LIMITS.maxPoolsPerPair,
      maxResultsPerTemplate: 2,
    },
  );
  const prioritizedSignatures = new Set(
    prioritizedCycles.map(
      (cycle) =>
        `${cycle.start.address.toLowerCase()}:${cycle.legs
          .map((leg) => leg.poolAddress.toLowerCase())
          .join(":")}`,
    ),
  );
  const genericCycles = findAtomicCycles(pools, borrowAssets, {
    minHops: 3,
    maxHops: SEARCH_LIMITS.maxHops,
    minEstimatedBps: 8,
    maxResults: SEARCH_LIMITS.maxGraphCandidates,
    maxPoolsPerPair: SEARCH_LIMITS.maxPoolsPerPair,
    maxExploredPaths: SEARCH_LIMITS.maxExploredPaths,
  }).filter(
    (cycle) =>
      !prioritizedSignatures.has(
        `${cycle.start.address.toLowerCase()}:${cycle.legs
          .map((leg) => leg.poolAddress.toLowerCase())
          .join(":")}`,
      ),
  );
  return [...prioritizedCycles, ...genericCycles].map((cycle) => {
    const routeLegs = cycle.legs.map((leg) => ({
      tokenInAddress: leg.tokenIn.address,
      tokenInSymbol: leg.tokenIn.symbol,
      tokenInDecimals: leg.tokenIn.decimals,
      tokenOutAddress: leg.tokenOut.address,
      tokenOutSymbol: leg.tokenOut.symbol,
      tokenOutDecimals: leg.tokenOut.decimals,
      venue: leg.venue,
    }));
    const path = [
      ...routeLegs.map((leg) => leg.tokenInSymbol),
      routeLegs.at(-1)!.tokenOutSymbol,
    ];
    const spreadBps = Number(cycle.estimatedGrossBps.toFixed(2));
    return {
      id: `${chain}-${"templateId" in cycle ? `priority-${cycle.templateId}` : `${cycle.legs.length}hop`}-${cycle.legs.map((leg) => leg.poolAddress.toLowerCase().replace(/[^a-f0-9]/g, "")).join("-")}`,
      token: path.slice(1, -1).join("/") || cycle.start.symbol,
      tokenAddress: routeLegs[0]!.tokenOutAddress,
      tokenDecimals: routeLegs[0]!.tokenOutDecimals,
      pair: path.join(" → "),
      chain: RPCS[chain].name,
      chainId,
      spreadBps,
      spreadPct: Number((spreadBps / 100).toFixed(4)),
      buyVenue: routeLegs[0]!.venue,
      sellVenue: routeLegs.at(-1)!.venue,
      routeKind:
        cycle.legs.length === 2
          ? ("two-pool" as const)
          : cycle.legs.length === 3
            ? ("triangular" as const)
            : ("multi-hop" as const),
      routeLegs,
      profit: {
        grossProfitUsd: 0,
        flashLoanFeeUsd: 0,
        gasCostUsd: 0,
        dexFeesUsd: 0,
        slippageUsd: 0,
        netProfitUsd: 0,
        recommendedBorrowUsd: Number(cycle.maxBorrowUsd.toFixed(2)),
        confidence: "medium" as const,
      },
      detectedAt: new Date().toISOString(),
      blockNumber,
      executable: true,
      executorDeployed: EXECUTOR_DEPLOYED.has(chainId),
      quoteStatus: "estimated" as const,
      status: "new" as const,
    };
  });
}

/**
 * Turns A -> token -> B price differences into explicit atomic cycles by
 * finding a supported B -> ... -> A conversion path in the live pool graph.
 * Unsupported quote assets and routes that cannot return the flash-loaned
 * stablecoin are removed from the actionable feed instead of being shown as
 * misleading "cross-stable" opportunities with zero-valued economics.
 */
function closeDirectOpportunities(
  chain: ChainId,
  opportunities: Opportunity[],
  pools: Array<CyclePool<Venue>>,
): Opportunity[] {
  const chainId = RPCS[chain].chainId;
  return opportunities.flatMap((opportunity) => {
    const buyQuote = opportunity.buyVenue.quoteTokenAddress?.toLowerCase();
    const sellQuote = opportunity.sellVenue.quoteTokenAddress?.toLowerCase();
    if (!buyQuote || !sellQuote) return [];
    if (
      !venueSupported(chainId, opportunity.buyVenue) ||
      !venueSupported(chainId, opportunity.sellVenue)
    )
      return [];
    if (!isStableQuote(chainId, buyQuote) || !isStableQuote(chainId, sellQuote))
      return [];

    if (buyQuote === sellQuote)
      return opportunity.executable ? [opportunity] : [];

    const closingPath = findBestConversionPath(pools, sellQuote, buyQuote, {
      maxHops: 4,
      maxPoolsPerPair: SEARCH_LIMITS.maxPoolsPerPair,
      excludedPoolAddresses: new Set([
        opportunity.buyVenue.pairAddress,
        opportunity.sellVenue.pairAddress,
      ]),
      excludedTokenAddresses: new Set([opportunity.tokenAddress]),
    });
    if (!closingPath || closingPath.length === 0 || closingPath.length > 4)
      return [];

    const buyDecimals = QUOTE_DECIMALS[buyQuote];
    const sellDecimals = QUOTE_DECIMALS[sellQuote];
    if (buyDecimals === undefined || sellDecimals === undefined) return [];
    const buySymbol =
      opportunity.buyVenue.quoteTokenSymbol ??
      closingPath.at(-1)!.tokenOut.symbol;
    const sellSymbol =
      opportunity.sellVenue.quoteTokenSymbol ?? closingPath[0]!.tokenIn.symbol;
    const routeLegs: NonNullable<Opportunity["routeLegs"]> = [
      {
        tokenInAddress: buyQuote,
        tokenInSymbol: buySymbol,
        tokenInDecimals: buyDecimals,
        tokenOutAddress: opportunity.tokenAddress,
        tokenOutSymbol: opportunity.token,
        tokenOutDecimals: opportunity.tokenDecimals,
        venue: opportunity.buyVenue,
      },
      {
        tokenInAddress: opportunity.tokenAddress,
        tokenInSymbol: opportunity.token,
        tokenInDecimals: opportunity.tokenDecimals,
        tokenOutAddress: sellQuote,
        tokenOutSymbol: sellSymbol,
        tokenOutDecimals: sellDecimals,
        venue: opportunity.sellVenue,
      },
      ...closingPath.map((leg) => ({
        tokenInAddress: leg.tokenIn.address,
        tokenInSymbol: leg.tokenIn.symbol,
        tokenInDecimals: leg.tokenIn.decimals,
        tokenOutAddress: leg.tokenOut.address,
        tokenOutSymbol: leg.tokenOut.symbol,
        tokenOutDecimals: leg.tokenOut.decimals,
        venue: leg.venue,
      })),
    ];
    if (routeLegs.length > 6) return [];

    const closingReturn = closingPath.reduce(
      (value, leg) => value * leg.spotRate * (1 - leg.feeBps / 10_000),
      1,
    );
    const directReturn =
      (opportunity.sellVenue.priceUsd / opportunity.buyVenue.priceUsd) *
      (1 - opportunity.buyVenue.feeBps / 10_000) *
      (1 - opportunity.sellVenue.feeBps / 10_000);
    const estimatedGrossBps = (directReturn * closingReturn - 1) * 10_000;
    if (!Number.isFinite(estimatedGrossBps) || estimatedGrossBps < 2) return [];

    const recommendedBorrowUsd = Math.min(
      100_000,
      opportunity.buyVenue.liquidityUsd * 0.03,
      opportunity.sellVenue.liquidityUsd * 0.03,
      ...closingPath.map((leg) => leg.liquidityUsd * 0.03),
    );
    const gasCostUsd =
      GAS_COST_USD[chain].graphBase +
      Math.max(0, routeLegs.length - 3) * GAS_COST_USD[chain].extraHop;
    const estimatedGrossUsd =
      (recommendedBorrowUsd * estimatedGrossBps) / 10_000;
    const estimatedFlashLoanFeeUsd = recommendedBorrowUsd * 0.0005;
    const estimatedSlippageUsd =
      recommendedBorrowUsd * (1 - Math.pow(1 - 20 / 10_000, routeLegs.length));
    const estimatedNetUsd =
      estimatedGrossUsd -
      estimatedFlashLoanFeeUsd -
      estimatedSlippageUsd -
      gasCostUsd;
    const path = [
      buySymbol,
      opportunity.token,
      sellSymbol,
      ...closingPath.map((leg) => leg.tokenOut.symbol),
    ];

    return [
      {
        ...opportunity,
        id: `${opportunity.id}-${closingPath.map((leg) => leg.poolAddress.toLowerCase().replace(/[^a-f0-9]/g, "")).join("-")}`,
        pair: path.join(" → "),
        spreadBps: Number(estimatedGrossBps.toFixed(2)),
        spreadPct: Number((estimatedGrossBps / 100).toFixed(4)),
        routeKind:
          routeLegs.length === 3
            ? ("triangular" as const)
            : ("multi-hop" as const),
        routeLegs,
        executable: true,
        quoteStatus: "estimated" as const,
        executionBlocker: undefined,
        profit: {
          grossProfitUsd: Number(estimatedGrossUsd.toFixed(2)),
          flashLoanFeeUsd: Number(estimatedFlashLoanFeeUsd.toFixed(2)),
          gasCostUsd,
          dexFeesUsd: 0,
          slippageUsd: Number(estimatedSlippageUsd.toFixed(2)),
          netProfitUsd: Number(estimatedNetUsd.toFixed(2)),
          recommendedBorrowUsd: Number(recommendedBorrowUsd.toFixed(2)),
          confidence: "medium" as const,
        },
      },
    ];
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        output[index] = await mapper(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function withinGlobalScanBudget<T>(
  promise: Promise<T>,
  chain: ChainId,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Initial ${chain} snapshot exceeded the ${GLOBAL_CHAIN_WAIT_MS}ms global response budget`,
          ),
        ),
      GLOBAL_CHAIN_WAIT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function preliminaryNetScore(chain: ChainId, candidate: Opportunity): number {
  if (!candidate.routeLegs?.length) {
    const crossProtocol =
      candidate.buyVenue.dexId.toLowerCase() !==
      candidate.sellVenue.dexId.toLowerCase();
    const diversityBonus = crossProtocol
      ? (candidate.profit.recommendedBorrowUsd * 2) / 10_000
      : 0;
    return candidate.profit.netProfitUsd + diversityBonus;
  }
  const borrow = candidate.profit.recommendedBorrowUsd;
  const conservativeCostBps = 5 + candidate.routeLegs.length * 20;
  const protocolCount = new Set(
    candidate.routeLegs.map((leg) => leg.venue.dexId.toLowerCase()),
  ).size;
  // A small diversity premium prevents the quote budget from being consumed
  // entirely by duplicate same-router cycles while keeping estimated profit
  // and liquidity as the dominant ranking signals.
  const protocolDiversityBps = Math.max(0, protocolCount - 1) * 2;
  const gas =
    GAS_COST_USD[chain].graphBase +
    Math.max(0, candidate.routeLegs.length - 3) * GAS_COST_USD[chain].extraHop;
  return (
    (borrow *
      (candidate.spreadBps - conservativeCostBps + protocolDiversityBps)) /
      10_000 -
    gas
  );
}

/**
 * Meme routes are volatile enough that headline spread alone is a poor signal.
 * Give first quote access only to the canonical meme templates when every leg
 * has meaningful exit liquidity and the full route has current trading flow.
 * Lower-quality meme candidates remain visible and are still served fairly by
 * the normal priority queue instead of being silently discarded.
 */
function isHighPotentialBscMeme(candidate: Opportunity): boolean {
  if (candidate.chainId !== RPCS.bsc.chainId || !candidate.routeLegs?.length)
    return false;
  if (
    !candidate.routeLegs.some((leg) =>
      BSC_MEME_PRIORITY_SYMBOLS.has(leg.tokenInSymbol.toUpperCase()) ||
      BSC_MEME_PRIORITY_SYMBOLS.has(leg.tokenOutSymbol.toUpperCase()),
    )
  )
    return false;
  const lowestLiquidity = Math.min(
    ...candidate.routeLegs.map((leg) => leg.venue.liquidityUsd),
  );
  const routeVolume24h = candidate.routeLegs.reduce(
    (sum, leg) => sum + Math.max(0, leg.venue.volume24h ?? 0),
    0,
  );
  return (
    lowestLiquidity >= BSC_MEME_MIN_POOL_LIQUIDITY_USD &&
    routeVolume24h >= BSC_MEME_MIN_ROUTE_VOLUME_24H_USD
  );
}

async function scan(chain: "all" | ChainId) {
  const chains: ChainId[] = chain === "all" ? [...CHAIN_IDS] : [chain];
  const pendingScans = chains.map((item) =>
    cached(
      `scan:${item}`,
      async () => {
        const [status, markets] = await Promise.all([
          networkStatus(item),
          liveMarkets(item),
        ]);
        const discoveredTokens = await graphTokenMap(item, markets);
        const indexedPools = buildCyclePools(item, markets, discoveredTokens);
        const priorityPools = await bscPriorityV2Pools(
          item,
          discoveredTokens,
          indexedPools,
        );
        const indexedPoolAddresses = new Set(
          indexedPools.map((pool) => pool.pairAddress.toLowerCase()),
        );
        const catalogPools = [
          ...indexedPools,
          ...priorityPools.filter(
            (pool) => !indexedPoolAddresses.has(pool.pairAddress.toLowerCase()),
          ),
        ];
        const refreshedPools = await poolStateEngine.refresh({
          chain: item,
          client: CHAIN_CLIENTS[item],
          pools: catalogPools,
          blockNumber: status.blockNumber,
        });
        const livePoolStates = new Map(
          refreshedPools.pools.map((pool) => [
            cyclePoolEdgeKey(pool),
            { baseToQuote: pool.baseToQuote, feeBps: pool.feeBps },
          ]),
        );
        logger.debug(
          {
            chain: item,
            catalogPools: catalogPools.length,
            livePoolRates: refreshedPools.live,
            indexedFallbackRates: refreshedPools.fallback,
            touchedPools: refreshedPools.touched,
            refreshMode: refreshedPools.mode,
          },
          "refreshed graph pool state",
        );
        const graphOpportunities = buildGraphOpportunities(
          item,
          refreshedPools.pools,
          status.blockNumber,
        );
        const discoveredDirectOpportunities = buildOpportunities(
          item,
          markets,
          status.blockNumber,
          livePoolStates,
        );
        const closedDirectOpportunities = closeDirectOpportunities(
          item,
          discoveredDirectOpportunities,
          refreshedPools.pools,
        );
        const candidates = [
          ...graphOpportunities,
          ...closedDirectOpportunities,
        ];
        const graphCandidates = candidates
          .filter(
            (candidate) => candidate.executable && candidate.routeLegs?.length,
          )
          .sort(
            (a, b) =>
              preliminaryNetScore(item, b) - preliminaryNetScore(item, a) ||
              b.spreadBps - a.spreadBps,
          );
        const directCandidates = candidates
          .filter(
            (candidate) => candidate.executable && !candidate.routeLegs?.length,
          )
          .sort(
            (a, b) =>
              preliminaryNetScore(item, b) - preliminaryNetScore(item, a) ||
              b.spreadBps - a.spreadBps,
          );
        // The established chains retain the full quote budget. New networks use
        // a bounded live-quote budget so a fourteen-chain scan remains responsive
        // on public RPCs while still validating the strongest candidates exactly.
        const defaultExactQuoteBudget =
          item === "ethereum" || item === "arbitrum"
            ? SEARCH_LIMITS.maxExactQuotes
            : Math.min(8, SEARCH_LIMITS.maxExactQuotes);
        const exactQuoteBudget = boundedEnvInt(
          `SCANNER_EXACT_QUOTE_BUDGET_${item.toUpperCase()}`,
          defaultExactQuoteBudget,
          1,
          SEARCH_LIMITS.maxExactQuotes,
        );
        // Operator-selected BSC cycles get first access to exact quotes whenever
        // their fee-adjusted spot estimate is positive. The remaining budget is
        // shared fairly between generic graph and direct-route candidates.
        const priorityCandidates = graphCandidates.filter((candidate) =>
          candidate.id.startsWith("bsc-priority-"),
        );
        const highPotentialMemeCandidates = priorityCandidates.filter(
          isHighPotentialBscMeme,
        );
        const otherPriorityCandidates = priorityCandidates.filter(
          (candidate) => !isHighPotentialBscMeme(candidate),
        );
        const regularGraphCandidates = graphCandidates.filter(
          (candidate) => !candidate.id.startsWith("bsc-priority-"),
        );
        // Reserve most of BSC's priority quote capacity for liquid, actively
        // traded canonical meme routes. Any unused meme capacity immediately
        // flows back to the existing core templates and generic graph.
        const memePriorityBudget = Math.min(
          highPotentialMemeCandidates.length,
          Math.max(2, Math.ceil(exactQuoteBudget * 0.6)),
        );
        const corePriorityBudget = Math.min(
          otherPriorityCandidates.length,
          exactQuoteBudget - memePriorityBudget,
        );
        const priorityBudget = Math.min(
          exactQuoteBudget,
          memePriorityBudget + corePriorityBudget,
        );
        const remainingQuoteBudget = exactQuoteBudget - priorityBudget;
        let graphBudget = Math.min(
          regularGraphCandidates.length,
          Math.ceil(remainingQuoteBudget * 0.6),
        );
        let directBudget = Math.min(
          directCandidates.length,
          remainingQuoteBudget - graphBudget,
        );
        graphBudget = Math.min(
          regularGraphCandidates.length,
          graphBudget +
            Math.max(0, remainingQuoteBudget - graphBudget - directBudget),
        );
        directBudget = Math.min(
          directCandidates.length,
          remainingQuoteBudget - graphBudget,
        );
        const selectedForExactQuote = new Set([
          ...quoteScheduler.select(
            `${item}:meme-priority`,
            highPotentialMemeCandidates.map((candidate) => candidate.id),
            memePriorityBudget,
            status.blockNumber,
          ),
          ...quoteScheduler.select(
            `${item}:priority`,
            otherPriorityCandidates.map((candidate) => candidate.id),
            corePriorityBudget,
            status.blockNumber,
          ),
          ...quoteScheduler.select(
            `${item}:graph`,
            regularGraphCandidates.map((candidate) => candidate.id),
            graphBudget,
            status.blockNumber,
          ),
          ...quoteScheduler.select(
            `${item}:direct`,
            directCandidates.map((candidate) => candidate.id),
            directBudget,
            status.blockNumber,
          ),
        ]);
        logger.debug(
          {
            chain: item,
            exactQuoteBudget,
            selected: selectedForExactQuote.size,
            highPotentialMemeCandidates: highPotentialMemeCandidates.length,
            memePriorityBudget,
            priorityQueue: quoteScheduler.stats(`${item}:priority`),
            memePriorityQueue: quoteScheduler.stats(`${item}:meme-priority`),
            graphQueue: quoteScheduler.stats(`${item}:graph`),
            directQueue: quoteScheduler.stats(`${item}:direct`),
          },
          "scheduled exact route quotes",
        );
        const budgetedCandidates = candidates.map((candidate) => {
          if (!candidate.executable || selectedForExactQuote.has(candidate.id))
            return candidate;
          return {
            ...candidate,
            executable: false,
            quoteStatus: "estimated" as const,
            executionBlocker: "quote-budget" as const,
            profit: {
              ...candidate.profit,
              netProfitUsd: 0,
              confidence: "low" as const,
            },
          };
        });
        const opportunities = await mapWithConcurrency(
          budgetedCandidates,
          SEARCH_LIMITS.quoteConcurrency,
          async (opportunity) => {
            if (!opportunity.executable) return opportunity;
            try {
              if (
                (opportunity.routeKind === "two-pool" ||
                  opportunity.routeKind === "triangular" ||
                  opportunity.routeKind === "multi-hop") &&
                opportunity.routeLegs
              ) {
                const borrowedAsset = opportunity.routeLegs[0]!.tokenInAddress;
                const borrowTokenPriceUsd = await borrowAssetUsdPrice(
                  item,
                  borrowedAsset,
                );
                const quote = borrowTokenPriceUsd
                  ? await quoteAtomicCycle(CHAIN_CLIENTS[item], {
                      chainId: opportunity.chainId,
                      borrowDecimals:
                        opportunity.routeLegs[0]!.tokenInDecimals,
                      borrowTokenPriceUsd,
                      legs: opportunity.routeLegs.map((leg) => ({
                        tokenInAddress: leg.tokenInAddress,
                        tokenOutAddress: leg.tokenOutAddress,
                        venue: leg.venue,
                      })),
                      maxBorrowUsd: opportunity.profit.recommendedBorrowUsd,
                      slippageBps: 20,
                    })
                  : null;
                const gasCostUsd =
                  GAS_COST_USD[item].graphBase +
                  Math.max(0, opportunity.routeLegs.length - 3) *
                    GAS_COST_USD[item].extraHop;
                const netProfitUsd = quote
                  ? quote.netBeforeGasUsd - gasCostUsd
                  : 0;
                if (!quote)
                  return {
                    ...opportunity,
                    executable: false,
                    quoteStatus: "unavailable" as const,
                    executionBlocker: "quote-failed" as const,
                    profit: {
                      ...opportunity.profit,
                      netProfitUsd: 0,
                      recommendedBorrowUsd: 0,
                      confidence: "low" as const,
                    },
                  };
                const executorDeployed = EXECUTOR_DEPLOYED.has(
                  opportunity.chainId,
                );
                const targetsAllowed =
                  executorDeployed && netProfitUsd > 0
                    ? await executorAllowsRouteTokens(
                        item,
                        opportunity.routeLegs.flatMap((leg) => [
                          leg.tokenInAddress,
                          leg.tokenOutAddress,
                        ]),
                      )
                    : false;
                return {
                  ...opportunity,
                  executable:
                    netProfitUsd > 0 && executorDeployed && targetsAllowed,
                  quoteStatus: "quoted" as const,
                  executionBlocker:
                    netProfitUsd <= 0
                      ? ("negative-net" as const)
                      : !executorDeployed
                        ? ("executor-not-deployed" as const)
                        : targetsAllowed
                          ? undefined
                          : ("target-not-allowed" as const),
                  profit: {
                    grossProfitUsd: Number(quote.grossProfitUsd.toFixed(2)),
                    flashLoanFeeUsd: Number(quote.flashLoanFeeUsd.toFixed(2)),
                    gasCostUsd,
                    dexFeesUsd: 0,
                    slippageUsd: Number(quote.slippageUsd.toFixed(2)),
                    netProfitUsd: Number(netProfitUsd.toFixed(2)),
                    recommendedBorrowUsd: quote.borrowUsd,
                    confidence:
                      netProfitUsd > 0 ? ("high" as const) : ("low" as const),
                  },
                };
              }
              const buyQuoteAddress =
                opportunity.buyVenue.quoteTokenAddress?.toLowerCase();
              const sellQuoteAddress =
                opportunity.sellVenue.quoteTokenAddress?.toLowerCase();
              const buyQuoteDecimals = buyQuoteAddress
                ? QUOTE_DECIMALS[buyQuoteAddress]
                : undefined;
              const sellQuoteDecimals = sellQuoteAddress
                ? QUOTE_DECIMALS[sellQuoteAddress]
                : undefined;
              if (
                !buyQuoteAddress ||
                !sellQuoteAddress ||
                buyQuoteDecimals === undefined ||
                sellQuoteDecimals === undefined
              )
                return {
                  ...opportunity,
                  executable: false,
                  quoteStatus: "unavailable" as const,
                  executionBlocker: "unsupported-or-open-route" as const,
                  profit: {
                    ...opportunity.profit,
                    netProfitUsd: 0,
                    recommendedBorrowUsd: 0,
                    confidence: "low" as const,
                  },
                };
              const borrowTokenPriceUsd = await borrowAssetUsdPrice(
                item,
                buyQuoteAddress,
              );
              const quote = borrowTokenPriceUsd
                ? await quoteClosedRoute(CHAIN_CLIENTS[item], {
                    chainId: opportunity.chainId,
                    tokenAddress: opportunity.tokenAddress,
                    tokenDecimals: opportunity.tokenDecimals,
                    buyQuoteAddress,
                    buyQuoteDecimals,
                    sellQuoteAddress,
                    sellQuoteDecimals,
                    buy: opportunity.buyVenue,
                    sell: opportunity.sellVenue,
                    maxBorrowUsd: opportunity.profit.recommendedBorrowUsd,
                    slippageBps: 20,
                    borrowTokenPriceUsd,
                  })
                : null;
              const gasCostUsd = GAS_COST_USD[item].standard;
              const netProfitUsd = quote
                ? quote.netBeforeGasUsd - gasCostUsd
                : 0;
              if (!quote)
                return {
                  ...opportunity,
                  executable: false,
                  quoteStatus: "unavailable" as const,
                  executionBlocker: "quote-failed" as const,
                  profit: {
                    ...opportunity.profit,
                    netProfitUsd: 0,
                    recommendedBorrowUsd: 0,
                    confidence: "low" as const,
                  },
                };
              const executorDeployed = EXECUTOR_DEPLOYED.has(
                opportunity.chainId,
              );
              const targetsAllowed =
                executorDeployed && netProfitUsd > 0
                  ? await executorAllowsRouteTokens(item, [
                      opportunity.tokenAddress,
                      buyQuoteAddress,
                      sellQuoteAddress,
                    ])
                  : false;
              return {
                ...opportunity,
                executable:
                  netProfitUsd > 0 && executorDeployed && targetsAllowed,
                quoteStatus: "quoted" as const,
                executionBlocker:
                  netProfitUsd <= 0
                    ? ("negative-net" as const)
                    : !executorDeployed
                      ? ("executor-not-deployed" as const)
                      : targetsAllowed
                        ? undefined
                        : ("target-not-allowed" as const),
                profit: {
                  grossProfitUsd: Number(quote.grossProfitUsd.toFixed(2)),
                  flashLoanFeeUsd: Number(quote.flashLoanFeeUsd.toFixed(2)),
                  gasCostUsd,
                  dexFeesUsd: 0, // already included in the DEX's exact quoted output
                  slippageUsd: Number(quote.slippageUsd.toFixed(2)),
                  netProfitUsd: Number(netProfitUsd.toFixed(2)),
                  recommendedBorrowUsd: quote.borrowUsd,
                  confidence:
                    netProfitUsd > 0 ? ("high" as const) : ("low" as const),
                },
              };
            } catch (err) {
              logger.debug(
                { err, opportunityId: opportunity.id, chain: item },
                "exact route quote unavailable",
              );
              return {
                ...opportunity,
                executable: false,
                quoteStatus: "unavailable" as const,
                executionBlocker: "quote-failed" as const,
                profit: {
                  ...opportunity.profit,
                  netProfitUsd: 0,
                  recommendedBorrowUsd: 0,
                  confidence: "low" as const,
                },
              };
            }
          },
        );
        const pools = markets.reduce(
          (sum, market) => sum + market.pairs.length,
          0,
        );
        // Keep fully quoted routes ahead of raw price dislocations. An unsupported
        // route has a display net of $0, which must not hide a closed route whose
        // real quote is negative (and therefore useful evidence for the operator).
        opportunities.sort(compareOpportunities);
        return {
          status: { ...status, pools },
          markets,
          opportunities,
          diagnostics: {
            candidatesDiscovered:
              graphOpportunities.length + discoveredDirectOpportunities.length,
            routableCandidates: candidates.length,
          },
        };
      },
      CACHE_TTL_MS.scan,
      true,
    ),
  );
  // A throttled or newly added network must not hold the entire dashboard
  // hostage. Its real refresh continues and populates the persistent catalog;
  // the global response returns the chains that completed within the budget.
  const settled = await Promise.allSettled(
    chain === "all"
      ? pendingScans.map((pending, index) =>
          withinGlobalScanBudget(pending, chains[index]!),
        )
      : pendingScans,
  );
  const successful = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  settled.forEach((result, index) => {
    if (result.status === "rejected")
      logger.warn(
        { chain: chains[index], err: result.reason },
        "chain scan failed",
      );
  });
  const failures = settled.length - successful.length;
  if (successful.length === 0)
    throw new Error(`No requested chain completed its live scan`);
  if (failures > 0)
    logger.warn(
      { chain, failures, successes: successful.length },
      "partial multi-chain scan",
    );
  return successful;
}

function error(res: Response, message: string) {
  res.status(503).json({ error: message });
}

const router: IRouter = Router();

router.get("/scanner/networks", async (_req, res) => {
  try {
    const networks = await Promise.all(
      (Object.keys(RPCS) as ChainId[]).map(async (chain) => {
        const [statusResult, marketsResult] = await Promise.allSettled([
          networkStatus(chain),
          liveMarkets(chain),
        ]);
        if (statusResult.status === "rejected") {
          logger.warn(
            { chain, err: statusResult.reason },
            "network RPC unavailable",
          );
          return {
            id: chain,
            name: RPCS[chain].name,
            chainId: RPCS[chain].chainId,
            status: "unavailable" as const,
            blockNumber: 0,
            gasGwei: 0,
            blockTimeMs: 0,
            pools:
              marketsResult.status === "fulfilled"
                ? marketsResult.value.reduce(
                    (sum, market) => sum + market.pairs.length,
                    0,
                  )
                : 0,
            lastBlockAt: new Date(0).toISOString(),
          };
        }
        return {
          ...statusResult.value,
          status:
            marketsResult.status === "fulfilled"
              ? statusResult.value.status
              : ("degraded" as const),
          pools:
            marketsResult.status === "fulfilled"
              ? marketsResult.value.reduce(
                  (sum, market) => sum + market.pairs.length,
                  0,
                )
              : 0,
        };
      }),
    );
    res.json(GetScannerNetworksResponse.parse(networks));
  } catch (err) {
    logger.warn({ err }, "live network status unavailable");
    error(
      res,
      "Live network status is unavailable. No network data was fabricated.",
    );
  }
});

router.get("/scanner/tokens", async (_req, res) => {
  try {
    const markets = await Promise.all(
      (Object.keys(RPCS) as ChainId[]).map(async (chain) => ({
        chain,
        markets: await liveMarkets(chain),
      })),
    );
    const bySymbol = new Map<
      string,
      {
        symbol: string;
        name: string;
        address: string;
        decimals: number;
        chains: string[];
        liquidityUsd: number;
        pools: number;
        priceUsd: number;
        change24h: number;
        observations: TokenPriceObservation[];
      }
    >();
    markets.forEach(({ chain, markets: chainMarkets }) =>
      chainMarkets.forEach(({ token, pairs }) => {
        const address = token.addresses[chain];
        if (!address) return;
        const usable = pairs
          .map((pair) => ({
            pair,
            priceUsd: normalizeTrackedPair(pair, address)?.priceUsd ?? 0,
          }))
          .filter(({ priceUsd }) => priceUsd > 0);
        const observations = usable.map(({ pair, priceUsd }) => ({
          priceUsd,
          change24h: Number(pair.priceChange?.h24 ?? 0),
          liquidityUsd: Number(pair.liquidity?.usd ?? 0),
        }));
        const existing = bySymbol.get(token.symbol);
        bySymbol.set(token.symbol, {
          symbol: token.symbol,
          name: token.name,
          address: existing?.address ?? address,
          decimals: tokenDecimals(token, chain),
          chains: existing?.chains.includes(RPCS[chain].name)
            ? existing.chains
            : [...(existing?.chains ?? []), RPCS[chain].name],
          liquidityUsd: 0,
          pools: (existing?.pools ?? 0) + usable.length,
          priceUsd: 0,
          change24h: 0,
          observations: [...(existing?.observations ?? []), ...observations],
        });
      }),
    );
    const tokens = [...bySymbol.values()].flatMap(
      ({ observations, ...token }) => {
        const reference = tokenReference(observations);
        if (!reference) return [];
        if (reference.rejectedOutliers > 0) {
          logger.debug(
            {
              symbol: token.symbol,
              rejectedOutliers: reference.rejectedOutliers,
            },
            "ignored token price outliers",
          );
        }
        return [
          {
            ...token,
            liquidityUsd: reference.liquidityUsd,
            pools: reference.pools,
            priceUsd: reference.priceUsd,
            change24h: reference.change24h,
          },
        ];
      },
    );
    res.json(
      GetScannerTokensResponse.parse(
        tokens.filter((token) => token.pools > 0 && token.priceUsd > 0),
      ),
    );
  } catch (err) {
    logger.warn({ err }, "live token universe unavailable");
    error(
      res,
      "Live token coverage is unavailable. No token data was fabricated.",
    );
  }
});

router.get("/scanner/funding/:chainId", async (req, res) => {
  const parsed = GetScannerFundingParams.safeParse(req.params);
  if (!parsed.success || !Number.isInteger(parsed.data.chainId)) {
    res.status(400).json({ error: "Invalid chain id" });
    return;
  }

  const chain = CHAIN_IDS.find(
    (candidate) => RPCS[candidate].chainId === parsed.data.chainId,
  );
  const executorAddress = EXECUTOR_ADDRESSES[parsed.data.chainId];
  if (!chain || !executorAddress) {
    res
      .status(404)
      .json({ error: "No ArbExecutor is configured for this network" });
    return;
  }

  try {
    const client = CHAIN_CLIENTS[chain];
    const [bytecode, ownerResult, paused] = await Promise.all([
      client.getBytecode({ address: executorAddress }),
      client.readContract({
        address: executorAddress,
        abi: EXECUTOR_READ_ABI,
        functionName: "owner",
      }),
      client.readContract({
        address: executorAddress,
        abi: EXECUTOR_READ_ABI,
        functionName: "paused",
      }),
    ]);
    if (!bytecode || bytecode === "0x")
      throw new Error("Configured executor has no deployed bytecode");

    const operatorAddress = getAddress(ownerResult as `0x${string}`);
    const balance = await client.getBalance({ address: operatorAddress });
    const minimum = MIN_GAS_BALANCE_WEI[parsed.data.chainId] ?? 0n;
    const shortfall = balance < minimum ? minimum - balance : 0n;
    const bufferedTarget = minimum * 2n;
    const recommendedDeposit =
      balance < bufferedTarget ? bufferedTarget - balance : 0n;

    res.json(
      GetScannerFundingResponse.parse({
        chainId: parsed.data.chainId,
        chain: RPCS[chain].name,
        nativeSymbol: NATIVE_SYMBOL[chain],
        operatorAddress,
        executorAddress,
        balanceWei: balance.toString(),
        minimumBalanceWei: minimum.toString(),
        shortfallWei: shortfall.toString(),
        recommendedDepositWei: recommendedDeposit.toString(),
        ready: balance >= minimum && !paused,
        paused: Boolean(paused),
        explorerUrl: RPCS[chain].explorer,
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn(
      { chain, chainId: parsed.data.chainId, executorAddress, err },
      "operator funding readiness unavailable",
    );
    error(res, "Could not verify the executor owner and gas balance on-chain");
  }
});

router.get("/scanner/opportunities", async (req, res) => {
  const parsed = GetScannerOpportunitiesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scanner filters" });
    return;
  }
  try {
    const results = await scan(parsed.data.chain);
    const token = parsed.data.token?.toLowerCase();
    const opportunities = results
      .flatMap((item) => item.opportunities)
      .filter(
        (item) =>
          item.spreadBps >= parsed.data.minProfitBps &&
          (!token || item.token.toLowerCase() === token),
      )
      .sort(compareOpportunities)
      .slice(0, parsed.data.limit);
    res.json(GetScannerOpportunitiesResponse.parse(opportunities));
  } catch (err) {
    logger.warn({ err }, "live opportunity scan unavailable");
    error(
      res,
      "Live pool scan is unavailable. No opportunities were fabricated.",
    );
  }
});

router.get("/scanner/opportunities/:id", async (req, res) => {
  const parsed = GetScannerOpportunityParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid opportunity id" });
    return;
  }
  try {
    const chain = chainFromOpportunityId(parsed.data.id);
    const results = await scan(chain);
    const opportunity = results
      .flatMap((item) => item.opportunities)
      .find((item) => item.id === parsed.data.id);
    if (!opportunity) {
      res
        .status(404)
        .json({ error: "Live opportunity is no longer available" });
      return;
    }
    res.json(GetScannerOpportunityResponse.parse(opportunity));
  } catch (err) {
    logger.warn({ err }, "live opportunity detail unavailable");
    error(
      res,
      "Live opportunity detail is unavailable. No opportunity was fabricated.",
    );
  }
});

router.post("/scanner/opportunities/:id/execute", async (req, res) => {
  const parsed = GetScannerOpportunityParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid opportunity id" });
    return;
  }
  try {
    const chain = chainFromOpportunityId(parsed.data.id);
    const results = await scan(chain);
    const opportunity = results
      .flatMap((item) => item.opportunities)
      .find((item) => item.id === parsed.data.id);
    if (!opportunity) {
      res.status(404).json({ error: "Opportunity is no longer live" });
      return;
    }
    if (!opportunity.executable) {
      res
        .status(409)
        .json({ error: "Route is not eligible for atomic execution" });
      return;
    }
    requestImmediateExecution(opportunity.id);
    res.status(202).json({
      status: "queued",
      opportunityId: opportunity.id,
      message: "Queued for immediate on-chain quote and simulation",
    });
  } catch (err) {
    logger.warn({ err }, "manual execution request failed validation");
    error(res, "Could not validate this route for execution");
  }
});

router.get("/scanner/execution-requests", (_req, res) => {
  res.json({ opportunityIds: activeExecutionRequests() });
});

router.delete("/scanner/execution-requests/:id", (req, res) => {
  completeExecutionRequest(req.params.id);
  res.status(204).end();
});

router.get("/scanner/summary", async (_req, res) => {
  try {
    const started = Date.now();
    const results = await scan("all");
    const opportunities = results.flatMap((item) => item.opportunities);
    const candidatesDiscovered = results.reduce(
      (sum, item) => sum + item.diagnostics.candidatesDiscovered,
      0,
    );
    const routableCandidates = results.reduce(
      (sum, item) => sum + item.diagnostics.routableCandidates,
      0,
    );
    const routesQuoted = opportunities.filter(
      (item) => item.quoteStatus === "quoted",
    ).length;
    const routesUnavailable = opportunities.filter(
      (item) => item.quoteStatus === "unavailable",
    ).length;
    const summary = {
      activeOpportunities: opportunities.filter((item) => item.executable)
        .length,
      poolsScanned: results.reduce((sum, item) => sum + item.status.pools, 0),
      tokensTracked: new Set(
        results.flatMap((item) =>
          item.markets.map((market) => market.token.symbol),
        ),
      ).size,
      estimatedNetProfit24h: Number(
        opportunities
          .filter((item) => item.executable && item.profit.netProfitUsd > 0)
          .reduce((sum, item) => sum + item.profit.netProfitUsd, 0)
          .toFixed(2),
      ),
      lastScanAt: new Date().toISOString(),
      scanLatencyMs: Date.now() - started,
      candidatesDiscovered,
      routableCandidates,
      routesQuoted,
      routesUnavailable,
      routeCoveragePct:
        candidatesDiscovered > 0
          ? Number(
              ((routableCandidates / candidatesDiscovered) * 100).toFixed(1),
            )
          : 0,
      quoteCoveragePct:
        routableCandidates > 0
          ? Number(((routesQuoted / routableCandidates) * 100).toFixed(1))
          : 0,
    };
    res.json(GetScannerSummaryResponse.parse(summary));
  } catch (err) {
    logger.warn({ err }, "live scanner summary unavailable");
    error(
      res,
      "Live scanner summary is unavailable. No metrics were fabricated.",
    );
  }
});

export default router;
