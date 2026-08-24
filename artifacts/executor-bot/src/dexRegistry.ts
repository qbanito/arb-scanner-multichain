/// Registry of DEX venues this bot knows how to build swap calldata for.
///
/// Every address below is verified against a primary source (see comments)
/// and, where practical, cross-checked with real bytecode on Arbitrum via
/// `cast code` — never guessed. Unknown/unverified `dexId`s are deliberately
/// left out so the route builder skips them instead of routing through a
/// wrong address. See README.md for how to add a new venue safely.

export type SupportedDex =
  | "uniswap-v2"
  | "uniswap-v3"
  | "sushiswap-v2"
  | "sushiswap-v3"
  | "camelot-v2"
  | "pancakeswap-v2"
  | "pancakeswap-v3"
  | "velodrome-v2"
  | "aerodrome-v2"
  | "aerodrome-auto"
  | "velodrome-auto"
  | "lfj-liquidity-book"
  | "syncswap-v1"
  | "lynex-algebra"
  | "agni-v3"
  | "curve-pool"
  | "balancer-v2";

export type DexKind = "univ3-quoter-v1" | "univ3-quoter-v2" | "univ3-quoter-v2-router02" | "univ2" | "solidly-v2" | "solidly-slipstream-auto" | "liquidity-book" | "syncswap-v1" | "algebra-v1.9" | "curve-pool" | "balancer-v2";

export const DEX_KIND: Record<SupportedDex, DexKind> = {
  "uniswap-v2": "univ2",
  "uniswap-v3": "univ3-quoter-v1",
  "sushiswap-v3": "univ3-quoter-v2",
  "sushiswap-v2": "univ2",
  "camelot-v2": "univ2",
  "pancakeswap-v2": "univ2",
  "pancakeswap-v3": "univ3-quoter-v2",
  "velodrome-v2": "solidly-v2",
  "aerodrome-v2": "solidly-v2",
  "aerodrome-auto": "solidly-slipstream-auto",
  "velodrome-auto": "solidly-slipstream-auto",
  "lfj-liquidity-book": "liquidity-book",
  "syncswap-v1": "syncswap-v1",
  "lynex-algebra": "algebra-v1.9",
  "agni-v3": "univ3-quoter-v2",
  "curve-pool": "curve-pool",
  "balancer-v2": "balancer-v2",
};

type Addresses = { router: `0x${string}`; quoter?: `0x${string}`; factory?: `0x${string}`; verifier?: `0x${string}`; kind?: DexKind };

export const DEX_CONTRACTS: Record<SupportedDex, Record<number, Addresses>> = {
  // Uniswap V2 Router02, Ethereum mainnet deployment.
  "uniswap-v2": {
    1: { router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" },
  },
  // Uniswap SwapRouter + Quoter (v1.0.0), same address across most chains.
  // Source: https://github.com/Uniswap/v3-periphery/blob/main/deploys.md
  "uniswap-v3": {
    1: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
    42161: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
    10: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
    137: { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
    8453: { router: "0x2626664c2603336E57B271c5C0b26F421741e481", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", kind: "univ3-quoter-v2-router02" },
    43114: { router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F", kind: "univ3-quoter-v2-router02" },
    56: { router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", kind: "univ3-quoter-v2-router02" },
    42220: { router: "0x5615CDAb10dc425a742d643d949a7F474C01abc4", quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8" },
    59144: { router: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", quoter: "0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1", kind: "univ3-quoter-v2-router02" },
    5000: { router: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2", quoter: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf", kind: "univ3-quoter-v2-router02" },
    534352: { router: "0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636", quoter: "0x2566e082Cb1656d22BCbe5644F5b997D194b5299", kind: "univ3-quoter-v2-router02" },
    146: { router: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455", quoter: "0x5911cB3633e764939edc2d92b7e1ad375Bb57649", kind: "univ3-quoter-v2-router02" },
    324: { router: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3", quoter: "0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28", kind: "univ3-quoter-v2-router02" },
    1868: { router: "0x7E40dB01736f88464e5f4E42394F3d5bbb6705B9", quoter: "0x3E6C707d0125226ff60F291b6Bd1404634F00AbA", kind: "univ3-quoter-v2-router02" },
  },
  // Sushiswap's V3 fork (SwapRouter + QuoterV2), per-chain deployment.
  // Source: https://github.com/sushiswap/v3-periphery/tree/master/deployments/arbitrum
  "sushiswap-v3": {
    42161: { router: "0x8A21F6768C1f8075791D08546Dadf6daA0bE820c", quoter: "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1" },
  },
  // Sushiswap's classic UniswapV2Router02 fork, same address across many
  // chains. Source: sushiswap/sushiswap-sdk `ROUTER_ADDRESS` constant.
  "sushiswap-v2": {
    1: { router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" },
    42161: { router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  },
  // Camelot's AMMv2 (UniswapV2Router02-style fork), Arbitrum-native.
  // Source: https://docs.camelot.exchange/contracts/arbitrum/one-mainnet
  "camelot-v2": {
    42161: { router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d" },
  },
  // PancakeSwap V2 Router and V3 Smart Router / QuoterV2 addresses from the
  // official @pancakeswap/smart-router deployment constants.
  "pancakeswap-v2": {
    1: { router: "0xEfF92A263d31888d860bD50809A8D171709b7b1c" },
    56: { router: "0x10ED43C718714eb63d5aA57B78B54704E256024E" },
    324: { router: "0x5aEaF2883FBf30f3D62471154eDa3C0c1b05942d" },
    8453: { router: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb" },
    42161: { router: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb" },
    59144: { router: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb" },
  },
  "pancakeswap-v3": {
    1: { router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
    56: { router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
    324: { router: "0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C", quoter: "0x3d146FcE6c1006857750cBe8aF44f76a28041CCc" },
    8453: { router: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
    42161: { router: "0x32226588378236Fd0c7c4053999F88aC0e5cAc77", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
    59144: { router: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
  },
  // Velodrome/Aerodrome V2 are Solidly-style pools: execution requires a
  // Route(from,to,stable,factory), not a Uniswap address[] path.
  "velodrome-v2": {
    10: { router: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858" },
  },
  "aerodrome-v2": {
    8453: { router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" },
  },
  "aerodrome-auto": {
    8453: { router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" },
  },
  "velodrome-auto": {
    10: { router: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858" },
  },
  // LFJ/Trader Joe Liquidity Book v2.2 router. The router supports versioned
  // paths; the route builder identifies the pair factory before encoding the
  // correct enum rather than inferring it from an indexer label.
  "lfj-liquidity-book": {
    42161: { router: "0x18556DA13313f3532c54711497A8FedAC273220E" },
    43114: { router: "0x18556DA13313f3532c54711497A8FedAC273220E" },
  },
  // SyncSwap V1 router and Pool Master deployments. The V1 adapter probes
  // every candidate pool's `master()` before quoting or building calldata;
  // V2/V3 pools deliberately fail closed because their route structs differ.
  "syncswap-v1": {
    324: {
      router: "0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295",
      verifier: "0xbB05918E9B4bA9Fe2c8384d223f0844867909Ffb",
    },
    59144: {
      router: "0x80e38291e06339d10AAB483C65695D004dBD5C69",
      verifier: "0x608Cb7C3168427091F5994A45Baf12083964B4A3",
    },
    534352: {
      router: "0x80e38291e06339d10AAB483C65695D004dBD5C69",
      verifier: "0x608Cb7C3168427091F5994A45Baf12083964B4A3",
    },
  },
  // Lynex concentrated-liquidity pools are Algebra v1.9, not Uniswap V3.
  // Official Algebra partner deployment for Linea.
  "lynex-algebra": {
    59144: {
      router: "0x3921e8cb45B17fC029A0a6dE958330ca4e583390",
      quoter: "0x851d97Fd7823E44193d227682e32234ef8CaC83e",
      factory: "0x622b2c98123D303ae067DB4925CD6282B3A08D0F",
    },
  },
  // Agni is a fee-tiered V3 implementation on Mantle. Addresses come from
  // agni-protocol/contracts deployments/mantleMainnet.json.
  "agni-v3": {
    5000: {
      router: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421",
      quoter: "0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb",
      factory: "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035",
    },
  },
  // Curve pools execute directly on the pair address, so no global router is
  // registered here. buildHop discovers coin indices and the int128/uint256
  // ABI variant from the pool itself.
  "curve-pool": {},
  "balancer-v2": Object.fromEntries(
    [1, 10, 56, 137, 42161, 43114].map((chainId) => [
      chainId,
      { router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as const },
    ]),
  ),
};

/// Camelot's V3 ("AMMv3") is Algebra Integral, not a Uniswap V3 fork — it
/// has dynamic per-pool fees (no `fee()` getter, no fixed-tier calldata) and
/// a different SwapRouter ABI. Deliberately unsupported here, same as
/// Uniswap V4 — see README.md's "Current coverage" section before adding it.

/// Resolves a scanner `DEXVenue` (raw DexScreener `dexId` + `labels`) to a
/// supported DEX kind, or `null` if this bot doesn't know how to route it
/// yet.
export function resolveDex(dexId: string, labels: string[] | undefined): SupportedDex | null {
  const normalized = dexId.toLowerCase();
  const labelSet = new Set((labels ?? []).map((label) => label.toLowerCase()));

  if (normalized === "uniswap") {
    if (labelSet.has("v2")) return "uniswap-v2";
    if (!labelSet.has("v4")) return "uniswap-v3";
  }
  if (normalized === "sushiswap") {
    return labelSet.has("v3") ? "sushiswap-v3" : "sushiswap-v2";
  }
  if (normalized === "camelot" && !labelSet.has("v3") && !labelSet.has("v4")) {
    return "camelot-v2";
  }
  if (normalized === "pancakeswap") {
    if (labelSet.has("v1") || labelSet.has("infinity") || labelSet.has("v4")) return null;
    return labelSet.has("v2") ? "pancakeswap-v2" : "pancakeswap-v3";
  }
  if (normalized === "velodrome") return labelSet.has("v2") ? "velodrome-v2" : "velodrome-auto";
  if (normalized === "aerodrome") return "aerodrome-auto";
  if ((normalized === "traderjoe" || normalized === "lfj") && !labelSet.has("v1")) {
    return "lfj-liquidity-book";
  }
  if (normalized === "syncswap" && !labelSet.has("v3")) return "syncswap-v1";
  if (normalized === "lynex") return "lynex-algebra";
  if (normalized === "agni") return "agni-v3";
  if (normalized === "curve") return "curve-pool";
  if (normalized === "balancer" && !labelSet.has("v3")) return "balancer-v2";

  return null;
}

export function routerFor(dex: SupportedDex, chainId: number): `0x${string}` | null {
  return DEX_CONTRACTS[dex]?.[chainId]?.router ?? null;
}

export function quoterFor(dex: SupportedDex, chainId: number): `0x${string}` | null {
  return DEX_CONTRACTS[dex]?.[chainId]?.quoter ?? null;
}

export function factoryFor(dex: SupportedDex, chainId: number): `0x${string}` | null {
  return DEX_CONTRACTS[dex]?.[chainId]?.factory ?? null;
}

export function verifierFor(dex: SupportedDex, chainId: number): `0x${string}` | null {
  return DEX_CONTRACTS[dex]?.[chainId]?.verifier ?? null;
}

export function dexKindFor(dex: SupportedDex, chainId: number): DexKind {
  return DEX_CONTRACTS[dex]?.[chainId]?.kind ?? DEX_KIND[dex];
}
