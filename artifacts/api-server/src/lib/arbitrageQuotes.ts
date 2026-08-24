import { parseUnits } from "viem";
import { optimizeBorrowSize } from "./borrowOptimizer";

type Venue = { dexId: string; labels?: string[]; pairAddress: string };

export type AtomicQuoteLeg = {
  tokenInAddress: string;
  tokenOutAddress: string;
  venue: Venue;
};

const ROUTERS: Record<number, Record<string, `0x${string}`>> = {
  1: { uniswap: "0xE592427A0AEce92De3Edee1F18E0157C05861564", "uniswap-v2": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", sushiswap: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", pancakeswap: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", "pancakeswap-v2": "0xEfF92A263d31888d860bD50809A8D171709b7b1c" },
  42161: { uniswap: "0xE592427A0AEce92De3Edee1F18E0157C05861564", sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", camelot: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", pancakeswap: "0x32226588378236Fd0c7c4053999F88aC0e5cAc77", "pancakeswap-v2": "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb" },
  10: { uniswap: "0xE592427A0AEce92De3Edee1F18E0157C05861564" },
  137: { uniswap: "0xE592427A0AEce92De3Edee1F18E0157C05861564" },
  8453: { uniswap: "0x2626664c2603336E57B271c5C0b26F421741e481", pancakeswap: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", "pancakeswap-v2": "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb" },
  43114: { uniswap: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE" },
  56: { uniswap: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", pancakeswap: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", "pancakeswap-v2": "0x10ED43C718714eb63d5aA57B78B54704E256024E" },
  42220: { uniswap: "0x5615CDAb10dc425a742d643d949a7F474C01abc4" },
  59144: { uniswap: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", pancakeswap: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", "pancakeswap-v2": "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb", syncswap: "0x80e38291e06339d10AAB483C65695D004dBD5C69", lynex: "0x3921e8cb45B17fC029A0a6dE958330ca4e583390" },
  5000: { uniswap: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2", agni: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421" },
  534352: { uniswap: "0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636", syncswap: "0x80e38291e06339d10AAB483C65695D004dBD5C69" },
  146: { uniswap: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455" },
  324: { uniswap: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3", pancakeswap: "0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C", "pancakeswap-v2": "0x5aEaF2883FBf30f3D62471154eDa3C0c1b05942d", syncswap: "0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295" },
  1868: { uniswap: "0x7E40dB01736f88464e5f4E42394F3d5bbb6705B9" },
};
const QUOTERS: Record<number, Record<string, `0x${string}`>> = {
  1: { uniswap: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
  42161: { uniswap: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", sushiswap: "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1", pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
  10: { uniswap: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
  137: { uniswap: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" },
  8453: { uniswap: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
  43114: { uniswap: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F" },
  56: { uniswap: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
  42220: { uniswap: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8" },
  59144: { uniswap: "0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1", pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", lynex: "0x851d97Fd7823E44193d227682e32234ef8CaC83e" },
  5000: { uniswap: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf", agni: "0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb" },
  534352: { uniswap: "0x2566e082Cb1656d22BCbe5644F5b997D194b5299" },
  146: { uniswap: "0x5911cB3633e764939edc2d92b7e1ad375Bb57649" },
  324: { uniswap: "0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28", pancakeswap: "0x3d146FcE6c1006857750cBe8aF44f76a28041CCc" },
  1868: { uniswap: "0x3E6C707d0125226ff60F291b6Bd1404634F00AbA" },
};
const AAVE_POOLS: Record<number, `0x${string}`> = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
  42220: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
  59144: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac",
  5000: "0x458F293454fE0d67EC0655f3672301301DD51422",
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  146: "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3",
  324: "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c",
  1868: "0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B",
};
const UNISWAP_QUOTER_V2_CHAINS = new Set([56, 146, 324, 1868, 5000, 8453, 43114, 59144, 534352]);
const premiumCache = new Map<number, { expiresAt: number; value: bigint }>();
const curveCoinCache = new Map<string, string[]>();
const curveIndexKindCache = new Map<string, "int128" | "uint256">();
const balancerPoolIdCache = new Map<string, `0x${string}`>();

export type QuoteFailureDiagnostic = {
  adapter: string;
  reason: string;
};

function quoteFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\s+/g, " ")
    .replace(/Request Arguments:[\s\S]*$/i, "")
    .trim()
    .slice(0, 180) || "unknown quote failure";
}

function readAtBlock(
  client: any,
  request: Record<string, unknown>,
  blockNumber?: bigint,
) {
  return client.readContract({
    ...request,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

type FailureCounter = Map<string, { count: number; diagnostic: QuoteFailureDiagnostic }>;

function recordQuoteFailure(
  failures: FailureCounter,
  adapter: string,
  error: unknown,
) {
  const diagnostic = { adapter, reason: quoteFailureReason(error) };
  const key = `${adapter}:${diagnostic.reason}`;
  const current = failures.get(key);
  failures.set(key, {
    count: (current?.count ?? 0) + 1,
    diagnostic,
  });
}

function dominantQuoteFailure(
  failures: FailureCounter,
): QuoteFailureDiagnostic | undefined {
  return [...failures.values()].sort((a, b) => b.count - a.count)[0]
    ?.diagnostic;
}

const SYNCSWAP_V1_POOL_MASTERS: Record<number, `0x${string}`> = {
  324: "0xbB05918E9B4bA9Fe2c8384d223f0844867909Ffb",
  59144: "0x608Cb7C3168427091F5994A45Baf12083964B4A3",
  534352: "0x608Cb7C3168427091F5994A45Baf12083964B4A3",
};
const LYNEX_ALGEBRA_FACTORY = "0x622b2c98123D303ae067DB4925CD6282B3A08D0F" as const;
const AGNI_FACTORY = "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035" as const;

const poolAbi = [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }] as const;
const v3QuoterAbi = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint256" }, { type: "uint160" }], outputs: [{ type: "uint256" }] }] as const;
const v3QuoterV2Abi = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "view", inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }] as const;
const v2RouterAbi = [{ type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] }] as const;
const solidlyPoolAbi = [{ type: "function", name: "getAmountOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const slipstreamPoolAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
] as const;
const slipstreamQuoterV2Abi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "view",
  inputs: [{ type: "tuple", components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "tickSpacing", type: "int24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }],
}] as const;
const SLIPSTREAM_DEPLOYMENTS: Record<number, Record<string, { quoter: `0x${string}`; router: `0x${string}` }>> = {
  8453: {
    "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a": { quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0", router: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5" },
    "0xade65c38cd4849adba595a4323a8c7ddfe89716a": { quoter: "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C", router: "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D" },
    "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef": { quoter: "0x514c8B5f54112481E28028F1166Bd78501089259", router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" },
  },
  10: {
    "0xcc0bddb707055e04e497ab22a59c2af4391cd12f": { quoter: "0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466", router: "0x0792a633F0c19c351081CF4B211F68F79bCc9676" },
    "0xe13dd1fba721aa81a1826d9523ac9bc7d260c879": { quoter: "0xAd432b2ca49965266133F2bd4c17dc1Ec12f5DEB", router: "0xbA3aEe516399388C779463183d00bB579f5041Ca" },
  },
};
const liquidityBookPairAbi = [
  { type: "function", name: "getTokenX", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getTokenY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getSwapOut",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint128" }, { name: "swapForY", type: "bool" }],
    outputs: [{ name: "amountInLeft", type: "uint128" }, { name: "amountOut", type: "uint128" }, { name: "fee", type: "uint128" }],
  },
] as const;
const premiumAbi = [{ type: "function", name: "FLASHLOAN_PREMIUM_TOTAL", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] }] as const;
const curveAbi = [{ type: "function", name: "get_dy", stateMutability: "view", inputs: [{ type: "int128" }, { type: "int128" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }] as const;
const curveUintAbi = [{ type: "function", name: "get_dy", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }] as const;
const curveCoinAbi = [{ type: "function", name: "coins", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const;
const balancerPoolAbi = [{ type: "function", name: "getPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;
const poolFactoryAbi = [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const syncSwapPoolAbi = [
  { type: "function", name: "master", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const algebraQuoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "view",
  inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint160" }],
  outputs: [{ type: "uint256" }, { type: "uint16" }],
}] as const;
const balancerVaultQueryAbi = [{
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
}] as const;
const BALANCER_V2_VAULTS: Record<number, `0x${string}`> = Object.fromEntries(
  [1, 10, 56, 137, 42161, 43114].map((chainId) => [chainId, "0xBA12222222228d8Ba445958a75a0704d566BF2C8"]),
) as Record<number, `0x${string}`>;
const ETHEREUM_3POOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7" as const;
const THREE_POOL_COINS = ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7"] as const;

async function flashLoanPremiumBps(client: any, chainId: number): Promise<bigint> {
  const hit = premiumCache.get(chainId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await client.readContract({ address: AAVE_POOLS[chainId]!, abi: premiumAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" });
  premiumCache.set(chainId, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

async function curveCoins(client: any, chainId: number, pool: `0x${string}`): Promise<string[]> {
  const key = `${chainId}:${pool.toLowerCase()}`;
  const cached = curveCoinCache.get(key);
  if (cached) return cached;
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    client.readContract({ address: pool, abi: curveCoinAbi, functionName: "coins", args: [BigInt(index)] }) as Promise<string>,
  ));
  const coins = results.flatMap((result) => result.status === "fulfilled" ? [result.value.toLowerCase()] : []);
  if (coins.length < 2) throw new Error("Curve pool coin discovery failed");
  curveCoinCache.set(key, coins);
  return coins;
}

async function quoteCurvePool(
  client: any,
  chainId: number,
  pool: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<bigint> {
  const coins = await curveCoins(client, chainId, pool);
  const i = coins.indexOf(tokenIn.toLowerCase());
  const j = coins.indexOf(tokenOut.toLowerCase());
  if (i < 0 || j < 0 || i === j) throw new Error("Curve pool token mismatch");
  const key = `${chainId}:${pool.toLowerCase()}`;
  const cachedKind = curveIndexKindCache.get(key);
  const tryKind = async (kind: "int128" | "uint256") => readAtBlock(client, {
    address: pool,
    abi: kind === "int128" ? curveAbi : curveUintAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), amountIn],
  }, blockNumber) as Promise<bigint>;
  if (cachedKind) return tryKind(cachedKind);
  try {
    const amountOut = await tryKind("int128");
    curveIndexKindCache.set(key, "int128");
    return amountOut;
  } catch {
    const amountOut = await tryKind("uint256");
    curveIndexKindCache.set(key, "uint256");
    return amountOut;
  }
}

async function quoteBalancerPool(
  client: any,
  chainId: number,
  pool: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<bigint> {
  const vault = BALANCER_V2_VAULTS[chainId];
  if (!vault) throw new Error("Balancer V2 is not registered on this chain");
  const key = `${chainId}:${pool.toLowerCase()}`;
  let poolId = balancerPoolIdCache.get(key);
  if (!poolId) {
    const discoveredPoolId = await client.readContract({ address: pool, abi: balancerPoolAbi, functionName: "getPoolId" }) as `0x${string}`;
    balancerPoolIdCache.set(key, discoveredPoolId);
    poolId = discoveredPoolId;
  }
  const zero = "0x0000000000000000000000000000000000000000" as const;
  const deltas = await readAtBlock(client, {
    address: vault,
    abi: balancerVaultQueryAbi,
    functionName: "queryBatchSwap",
    args: [
      0,
      [{ poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: amountIn, userData: "0x" }],
      [tokenIn, tokenOut],
      { sender: zero, fromInternalBalance: false, recipient: zero, toInternalBalance: false },
    ],
  }, blockNumber) as readonly bigint[];
  const outputDelta = deltas[1];
  if (outputDelta === undefined || outputDelta >= 0n) throw new Error("invalid Balancer output delta");
  return -outputDelta;
}

async function quoteVenue(client: any, chainId: number, venue: Venue, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, blockNumber?: bigint): Promise<bigint> {
  // Indexers occasionally return mixed-case addresses whose checksum casing
  // is not canonical. Lowercase is an unambiguous EVM address and prevents
  // viem from rejecting an otherwise valid pool/token before eth_call.
  tokenIn = tokenIn.toLowerCase() as `0x${string}`;
  tokenOut = tokenOut.toLowerCase() as `0x${string}`;
  const pairAddress = venue.pairAddress.toLowerCase() as `0x${string}`;
  const dex = venue.dexId.toLowerCase();
  const labels = new Set((venue.labels ?? []).map((label) => label.toLowerCase()));
  if (dex === "syncswap") {
    const expectedMaster = SYNCSWAP_V1_POOL_MASTERS[chainId];
    if (!expectedMaster || labels.has("v3")) throw new Error("unsupported SyncSwap generation");
    const pair = pairAddress;
    const master = await client.readContract({ address: pair, abi: syncSwapPoolAbi, functionName: "master" }) as string;
    if (master.toLowerCase() !== expectedMaster.toLowerCase()) throw new Error("unverified SyncSwap Pool Master");
    return readAtBlock(client, {
      address: pair,
      abi: syncSwapPoolAbi,
      functionName: "getAmountOut",
      args: [tokenIn, amountIn, "0x0000000000000000000000000000000000000000"],
    }, blockNumber);
  }
  if (dex === "lynex") {
    if (chainId !== 59144) throw new Error("unsupported Lynex deployment");
    const factory = await client.readContract({ address: pairAddress, abi: poolFactoryAbi, functionName: "factory" }) as string;
    if (factory.toLowerCase() !== LYNEX_ALGEBRA_FACTORY.toLowerCase()) throw new Error("unverified Lynex Algebra factory");
    const quoter = QUOTERS[chainId]?.lynex;
    if (!quoter) throw new Error("missing Lynex quoter");
    return (await readAtBlock(client, { address: quoter, abi: algebraQuoterAbi, functionName: "quoteExactInputSingle", args: [tokenIn, tokenOut, amountIn, 0n] }, blockNumber))[0];
  }
  if (dex === "agni") {
    if (chainId !== 5000) throw new Error("unsupported Agni deployment");
    const factory = await client.readContract({ address: pairAddress, abi: poolFactoryAbi, functionName: "factory" }) as string;
    if (factory.toLowerCase() !== AGNI_FACTORY.toLowerCase()) throw new Error("unverified Agni factory");
  }
  if (dex === "curve") {
    return quoteCurvePool(client, chainId, pairAddress, tokenIn, tokenOut, amountIn, blockNumber);
  }
  if (dex === "balancer") {
    return quoteBalancerPool(client, chainId, pairAddress, tokenIn, tokenOut, amountIn, blockNumber);
  }
  if (dex === "traderjoe" || dex === "lfj") {
    const pair = pairAddress;
    const [tokenX, tokenY] = await Promise.all([
      client.readContract({ address: pair, abi: liquidityBookPairAbi, functionName: "getTokenX" }),
      client.readContract({ address: pair, abi: liquidityBookPairAbi, functionName: "getTokenY" }),
    ]);
    const input = tokenIn.toLowerCase();
    const output = tokenOut.toLowerCase();
    const swapForY = input === tokenX.toLowerCase() && output === tokenY.toLowerCase();
    const swapForX = input === tokenY.toLowerCase() && output === tokenX.toLowerCase();
    if (!swapForY && !swapForX) throw new Error("Liquidity Book pair token mismatch");
    if (amountIn > (1n << 128n) - 1n) throw new Error("Liquidity Book amount exceeds uint128");
    const [amountInLeft, amountOut] = await readAtBlock(client, {
      address: pair,
      abi: liquidityBookPairAbi,
      functionName: "getSwapOut",
      args: [amountIn, swapForY],
    }, blockNumber);
    if (amountInLeft !== 0n || amountOut === 0n) throw new Error("insufficient Liquidity Book depth");
    return amountOut;
  }
  if (dex === "velodrome" || dex === "aerodrome") {
    const pool = pairAddress;
    try {
      return await readAtBlock(client, { address: pool, abi: solidlyPoolAbi, functionName: "getAmountOut", args: [amountIn, tokenIn] }, blockNumber);
    } catch {
      const [factory, tickSpacing] = await Promise.all([
        client.readContract({ address: pool, abi: slipstreamPoolAbi, functionName: "factory" }) as Promise<string>,
        client.readContract({ address: pool, abi: slipstreamPoolAbi, functionName: "tickSpacing" }) as Promise<number>,
      ]);
      const deployment = SLIPSTREAM_DEPLOYMENTS[chainId]?.[factory.toLowerCase()];
      if (!deployment) throw new Error("unknown Slipstream factory");
      return (await readAtBlock(client, {
        address: deployment.quoter,
        abi: slipstreamQuoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
      }, blockNumber))[0];
    }
  }
  const routerKey = (dex === "uniswap" || dex === "pancakeswap") && labels.has("v2") ? `${dex}-v2` : dex;
  const router = ROUTERS[chainId]?.[routerKey];
  if (!router) throw new Error("unsupported venue");
  if ((dex === "uniswap" || dex === "pancakeswap") && labels.has("v2") || dex === "sushiswap" && !labels.has("v3") || dex === "camelot") {
    const amounts = await readAtBlock(client, { address: router, abi: v2RouterAbi, functionName: "getAmountsOut", args: [amountIn, [tokenIn, tokenOut]] }, blockNumber);
    if (!amounts[1]) throw new Error("empty quote");
    return amounts[1];
  }
  const fee = await client.readContract({ address: pairAddress, abi: poolAbi, functionName: "fee" });
  const quoter = QUOTERS[chainId]?.[dex];
  if (!quoter) throw new Error("missing quoter");
  if (dex === "pancakeswap" || dex === "sushiswap" || dex === "agni" || dex === "uniswap" && UNISWAP_QUOTER_V2_CHAINS.has(chainId)) {
    return (await readAtBlock(client, { address: quoter, abi: v3QuoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] }, blockNumber))[0];
  }
  return readAtBlock(client, { address: quoter, abi: v3QuoterAbi, functionName: "quoteExactInputSingle", args: [tokenIn, tokenOut, fee, amountIn, 0n] }, blockNumber);
}

export type ClosedRouteQuote = { borrowUsd: number; grossProfitUsd: number; flashLoanFeeUsd: number; slippageUsd: number; netBeforeGasUsd: number };

function sizingRefinementIterations(): number {
  const parsed = Number.parseInt(process.env["SCANNER_SIZE_REFINEMENT_ITERATIONS"] ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(10, Math.max(0, parsed)) : 4;
}

export async function quoteClosedRoute(client: any, args: { chainId: number; tokenAddress: string; tokenDecimals: number; buyQuoteAddress: string; buyQuoteDecimals: number; sellQuoteAddress: string; sellQuoteDecimals: number; buy: Venue; sell: Venue; maxBorrowUsd: number; minBorrowUsd?: number; preferredBorrowUsd?: readonly number[]; slippageBps: number; borrowTokenPriceUsd?: number; blockNumber?: bigint; onFailure?: (diagnostic: QuoteFailureDiagnostic) => void }): Promise<ClosedRouteQuote | null> {
  const borrowTokenPriceUsd = args.borrowTokenPriceUsd ?? 1;
  if (!Number.isFinite(borrowTokenPriceUsd) || borrowTokenPriceUsd <= 0) return null;
  const premiumBps = await flashLoanPremiumBps(client, args.chainId);
  const failures: FailureCounter = new Map();
  const optimized = await optimizeBorrowSize({
    maxBorrowUsd: args.maxBorrowUsd,
    minBorrowUsd: args.minBorrowUsd,
    preferredBorrowUsd: args.preferredBorrowUsd,
    stopAfterFirstIfValueAtMost: 0,
    refinementIterations: sizingRefinementIterations(),
    evaluate: async (borrowUsd) => {
      let activeAdapter = args.buy.dexId;
      try {
        const borrowTokenAmount = borrowUsd / borrowTokenPriceUsd;
        const amountIn = parseUnits(
          borrowTokenAmount.toFixed(args.buyQuoteDecimals),
          args.buyQuoteDecimals,
        );
        const bought = await quoteVenue(client, args.chainId, args.buy, args.buyQuoteAddress as `0x${string}`, args.tokenAddress as `0x${string}`, amountIn, args.blockNumber);
        activeAdapter = args.sell.dexId;
        const sold = await quoteVenue(client, args.chainId, args.sell, args.tokenAddress as `0x${string}`, args.sellQuoteAddress as `0x${string}`, bought, args.blockNumber);
        let finalOut = sold;
        if (args.sellQuoteAddress.toLowerCase() !== args.buyQuoteAddress.toLowerCase()) {
          const i = THREE_POOL_COINS.findIndex((coin) => coin.toLowerCase() === args.sellQuoteAddress.toLowerCase());
          const j = THREE_POOL_COINS.findIndex((coin) => coin.toLowerCase() === args.buyQuoteAddress.toLowerCase());
          if (args.chainId !== 1 || i < 0 || j < 0) return null;
          activeAdapter = "curve-3pool";
          finalOut = await readAtBlock(client, { address: ETHEREUM_3POOL, abi: curveAbi, functionName: "get_dy", args: [BigInt(i), BigInt(j), sold] }, args.blockNumber);
        }
        const premium = amountIn * premiumBps / 10_000n;
        const gross =
          (Number(finalOut - amountIn) / 10 ** args.buyQuoteDecimals) *
          borrowTokenPriceUsd;
        const premiumUsd =
          (Number(premium) / 10 ** args.buyQuoteDecimals) *
          borrowTokenPriceUsd;
        const netBeforeGasUsd =
          (Number(finalOut - amountIn - premium) /
            10 ** args.buyQuoteDecimals) *
          borrowTokenPriceUsd;
        // A router's slippage tolerance is a revert boundary, not a fee and
        // not an expected loss. Exact quotes already include pool fees and
        // price impact. ArbExecutor independently requires repayment plus a
        // positive minProfit, so stale/worse execution reverts atomically.
        const quote = { borrowUsd, grossProfitUsd: gross, flashLoanFeeUsd: premiumUsd, slippageUsd: 0, netBeforeGasUsd };
        return { value: quote.netBeforeGasUsd, result: quote };
      } catch (error) {
        recordQuoteFailure(failures, activeAdapter, error);
        return null;
      }
    },
  });
  // Return the best fully quoted cycle even when it is negative. The UI
  // should show why a visible spread is not executable instead of replacing
  // a completed calculation with zeroes. `executable` is decided separately.
  if (!optimized) {
    const failure = dominantQuoteFailure(failures);
    if (failure) args.onFailure?.(failure);
  }
  return optimized?.result ?? null;
}

/** Exact-quote an arbitrary same-chain cycle which begins and ends in the flash-borrowed asset. */
export async function quoteAtomicCycle(client: any, args: {
  chainId: number;
  borrowDecimals: number;
  /** USD value of one whole borrowed token; stablecoins use 1. */
  borrowTokenPriceUsd?: number;
  legs: AtomicQuoteLeg[];
  maxBorrowUsd: number;
  minBorrowUsd?: number;
  preferredBorrowUsd?: readonly number[];
  slippageBps: number;
  blockNumber?: bigint;
  onFailure?: (diagnostic: QuoteFailureDiagnostic) => void;
}): Promise<ClosedRouteQuote | null> {
  if (args.legs.length < 2 || args.legs.length > 6) return null;
  const firstAsset = args.legs[0]?.tokenInAddress.toLowerCase();
  const finalAsset = args.legs.at(-1)?.tokenOutAddress.toLowerCase();
  if (!firstAsset || finalAsset !== firstAsset) return null;
  const borrowTokenPriceUsd = args.borrowTokenPriceUsd ?? 1;
  if (!Number.isFinite(borrowTokenPriceUsd) || borrowTokenPriceUsd <= 0) return null;

  const premiumBps = await flashLoanPremiumBps(client, args.chainId);
  const failures: FailureCounter = new Map();
  const optimized = await optimizeBorrowSize({
    maxBorrowUsd: args.maxBorrowUsd,
    minBorrowUsd: args.minBorrowUsd,
    preferredBorrowUsd: args.preferredBorrowUsd,
    stopAfterFirstIfValueAtMost: 0,
    refinementIterations: sizingRefinementIterations(),
    evaluate: async (borrowUsd) => {
      let activeAdapter = "route";
      try {
        const borrowTokenAmount = borrowUsd / borrowTokenPriceUsd;
        const amountIn = parseUnits(
          borrowTokenAmount.toFixed(args.borrowDecimals),
          args.borrowDecimals,
        );
        let amount = amountIn;
        for (const [index, leg] of args.legs.entries()) {
          activeAdapter = `${leg.venue.dexId}:leg-${index + 1}`;
          const quoted = await quoteVenue(
            client,
            args.chainId,
            leg.venue,
            leg.tokenInAddress as `0x${string}`,
            leg.tokenOutAddress as `0x${string}`,
            amount,
            args.blockNumber,
          );
          amount = quoted;
        }
        const premium = amountIn * premiumBps / 10_000n;
        const unit = 10 ** args.borrowDecimals;
        const quote: ClosedRouteQuote = {
          borrowUsd,
          grossProfitUsd:
            (Number(amount - amountIn) / unit) * borrowTokenPriceUsd,
          flashLoanFeeUsd: (Number(premium) / unit) * borrowTokenPriceUsd,
          // Slippage tolerance remains encoded as the final swap's minOut in
          // the executor. It must not be charged as a certain loss per hop.
          slippageUsd: 0,
          netBeforeGasUsd:
            (Number(amount - amountIn - premium) / unit) * borrowTokenPriceUsd,
        };
        return { value: quote.netBeforeGasUsd, result: quote };
      } catch (error) {
        recordQuoteFailure(failures, activeAdapter, error);
        return null;
      }
    },
  });
  if (!optimized) {
    const failure = dominantQuoteFailure(failures);
    if (failure) args.onFailure?.(failure);
  }
  return optimized?.result ?? null;
}
