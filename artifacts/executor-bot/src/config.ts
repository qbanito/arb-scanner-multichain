import { parseEther } from "viem";
import { z } from "zod";

const hexAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "expected a 0x-prefixed 20-byte address")
  .transform((value) => value as `0x${string}`);

const nativeAmount = z
  .string()
  .regex(/^\d+(?:\.\d{1,18})?$/, "expected a non-negative native-token amount");

const envSchema = z.object({
  API_BASE_URL: z.string().url().default("http://localhost:8080"),
  // Optional process-level partition. Running one BSC-only worker prevents
  // slow RPCs on other networks from delaying BNB's five-second loop, while a
  // second worker can keep Ethereum/Arbitrum active without nonce overlap.
  EXECUTION_CHAIN_IDS: z.string().optional(),
  PRIVATE_KEY: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{64}$/,
      "PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
    )
    .transform((value) => value as `0x${string}`),

  ETHEREUM_RPC_URL: z.string().url().optional(),
  ARBITRUM_RPC_URL: z.string().url().optional(),
  OPTIMISM_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL: z.string().url().optional(),
  AVALANCHE_RPC_URL: z.string().url().optional(),
  BSC_RPC_URL: z.string().url().optional(),
  CELO_RPC_URL: z.string().url().optional(),
  LINEA_RPC_URL: z.string().url().optional(),
  MANTLE_RPC_URL: z.string().url().optional(),
  SCROLL_RPC_URL: z.string().url().optional(),
  SONIC_RPC_URL: z.string().url().optional(),
  ZKSYNC_RPC_URL: z.string().url().optional(),
  SONEIUM_RPC_URL: z.string().url().optional(),
  ETHEREUM_WS_URL: z.string().url().optional(),
  ARBITRUM_WS_URL: z.string().url().optional(),
  OPTIMISM_WS_URL: z.string().url().optional(),
  POLYGON_WS_URL: z.string().url().optional(),
  BASE_WS_URL: z.string().url().optional(),
  AVALANCHE_WS_URL: z.string().url().optional(),
  BSC_WS_URL: z.string().url().optional(),
  CELO_WS_URL: z.string().url().optional(),
  LINEA_WS_URL: z.string().url().optional(),
  MANTLE_WS_URL: z.string().url().optional(),
  SCROLL_WS_URL: z.string().url().optional(),
  SONIC_WS_URL: z.string().url().optional(),
  ZKSYNC_WS_URL: z.string().url().optional(),
  SONEIUM_WS_URL: z.string().url().optional(),
  // Second RPC source per chain, raced via viem's `fallback` transport (see
  // chains.ts) — real, repeated 429s from the shared Alchemy key this
  // session (rate-limited scanner, a liquidation that briefly vanished from
  // results) are exactly what this exists to stop happening. Falls through
  // automatically on any error that isn't "retrying elsewhere wouldn't
  // help" (revert, user rejection) — a 429 always falls through. Left unset,
  // each chain defaults to a well-known public node (verified reachable
  // before shipping this) rather than silently running with no fallback at
  // all; override with your own second provider once you have one.
  ETHEREUM_RPC_URL_FALLBACK: z.string().url().optional(),
  ARBITRUM_RPC_URL_FALLBACK: z.string().url().optional(),
  OPTIMISM_RPC_URL_FALLBACK: z.string().url().optional(),
  POLYGON_RPC_URL_FALLBACK: z.string().url().optional(),
  BASE_RPC_URL_FALLBACK: z.string().url().optional(),
  AVALANCHE_RPC_URL_FALLBACK: z.string().url().optional(),
  BSC_RPC_URL_FALLBACK: z.string().url().optional(),
  CELO_RPC_URL_FALLBACK: z.string().url().optional(),
  LINEA_RPC_URL_FALLBACK: z.string().url().optional(),
  MANTLE_RPC_URL_FALLBACK: z.string().url().optional(),
  SCROLL_RPC_URL_FALLBACK: z.string().url().optional(),
  SONIC_RPC_URL_FALLBACK: z.string().url().optional(),
  ZKSYNC_RPC_URL_FALLBACK: z.string().url().optional(),
  SONEIUM_RPC_URL_FALLBACK: z.string().url().optional(),

  ARB_EXECUTOR_ETHEREUM: hexAddress.optional(),
  ARB_EXECUTOR_ARBITRUM: hexAddress.optional(),
  ARB_EXECUTOR_OPTIMISM: hexAddress.optional(),
  ARB_EXECUTOR_POLYGON: hexAddress.optional(),
  ARB_EXECUTOR_BASE: hexAddress.optional(),
  ARB_EXECUTOR_AVALANCHE: hexAddress.optional(),
  ARB_EXECUTOR_BSC: hexAddress.optional(),
  ARB_EXECUTOR_CELO: hexAddress.optional(),
  ARB_EXECUTOR_LINEA: hexAddress.optional(),
  ARB_EXECUTOR_MANTLE: hexAddress.optional(),
  ARB_EXECUTOR_SCROLL: hexAddress.optional(),
  ARB_EXECUTOR_SONIC: hexAddress.optional(),
  ARB_EXECUTOR_ZKSYNC: hexAddress.optional(),
  ARB_EXECUTOR_SONEIUM: hexAddress.optional(),

  // Optional: route the final signed transaction on Ethereum mainnet through
  // Flashbots Protect instead of the public mempool — see chains.ts. Reads
  // (multicall, simulate, block watching) are unaffected; only matters for
  // chainId 1, since Arbitrum has no public mempool for this to protect
  // against in the first place. Left unset by default (no behavior change).
  FLASHBOTS_PROTECT_RPC_URL: z.string().url().optional(),
  ENABLE_MEV_SHARE_HINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MEV_SHARE_STREAM_URL: z
    .string()
    .url()
    .default("https://mev-share.flashbots.net"),

  // Safety-first defaults: no live transactions, small size, generous profit
  // floor, and a hard cap on trade frequency. See README.md before changing.
  ENABLE_LIVE_EXECUTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REQUIRE_MANUAL_EXECUTION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MAX_BORROW_USD: z.coerce.number().positive().default(250),
  MIN_PROFIT_USD: z.coerce.number().positive().default(20),
  // Low-fee BNB routes can be worthwhile below the global floor. This only
  // admits them to the expensive exact quote/simulation pipeline; the gas
  // multiplier and ArbExecutor's on-chain minProfit remain mandatory.
  MIN_PROFIT_USD_BSC: z.coerce.number().positive().optional(),
  // On-chain profit floor, expressed in basis points of the borrowed amount
  // rather than an absolute USD figure — ArbExecutor's `minProfit` param is
  // denominated in the flash-borrowed asset, and converting an off-chain USD
  // target into that asset's units would need a price oracle we don't have.
  // MIN_PROFIT_USD above is only an off-chain pre-filter to skip clearly
  // unattractive opportunities before spending RPC calls/gas on them.
  MIN_PROFIT_BPS_ON_CHAIN: z.coerce.number().int().nonnegative().default(15),
  // Pre-flight gate (gasGuard.ts): estimated gross profit must be at least
  // this many times the estimated real gas cost, or the route is skipped
  // before ever simulating/sending. Gas is paid separately from flash-loan
  // proceeds and isn't reflected in MIN_PROFIT_BPS_ON_CHAIN at all, so on
  // expensive chains (Ethereum mainnet) this is the check that actually
  // protects against a "profitable" trade being a net loss after gas.
  MIN_PROFIT_OVER_GAS_MULTIPLIER: z.coerce.number().positive().default(2),
  MAX_TRADES_PER_HOUR: z.coerce.number().int().positive().default(3),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Exact multi-pool scans can exceed 15 seconds on public RPCs. Aborting
  // sooner makes the executor permanently miss otherwise valid snapshots.
  SCANNER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(60_000),
  MIN_TICK_GAP_MS: z.coerce.number().int().min(250).default(1_000),
  SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(50),
  // Profit is swept after every confirmed trade so an old balance can never
  // subsidize a later losing route. On BNB Chain, a bounded part of that
  // just-confirmed profit can then replenish the operator's native gas.
  AUTO_GAS_RESERVE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BSC_GAS_RESERVE_TRIGGER_BNB: nativeAmount.default("0.0025"),
  BSC_GAS_RESERVE_TARGET_BNB: nativeAmount.default("0.004"),
  GAS_RESERVE_SLIPPAGE_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000)
    .default(100),

  // Liquidations (optional feature — see src/liquidation/).
  GRAPH_API_KEY: z.string().optional(),
  ENABLE_LIQUIDATIONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LIQUIDATION_SCAN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid executor-bot configuration:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const env = parsed.data;

  // Verified reachable (real eth_blockNumber response) before shipping this
  // — a legitimate public fallback, not a guess. Only ever used as the
  // *second* transport in chains.ts's fallback() — reads still prefer the
  // configured primary (or its own fallback override) whenever it's up.
  const DEFAULT_FALLBACK_RPC_URL: Record<number, string> = {
    1: "https://ethereum-rpc.publicnode.com",
    42161: "https://arbitrum-one-rpc.publicnode.com",
    10: "https://optimism-rpc.publicnode.com",
    137: "https://polygon-bor-rpc.publicnode.com",
    8453: "https://base-rpc.publicnode.com",
    43114: "https://avalanche-c-chain-rpc.publicnode.com",
    56: "https://bsc-rpc.publicnode.com",
    42220: "https://celo-rpc.publicnode.com",
    59144: "https://linea-rpc.publicnode.com",
    5000: "https://mantle-rpc.publicnode.com",
    534352: "https://scroll-rpc.publicnode.com",
    146: "https://sonic-rpc.publicnode.com",
    324: "https://mainnet.era.zksync.io",
    1868: "https://soneium-rpc.publicnode.com",
  };

  // `executorAddress: null` means watch-only — an RPC URL was given but no
  // ArbExecutor deployment, so this bot can monitor live on-chain state
  // (e.g. Health Factor for the liquidation watcher) on that chain but can
  // never actually build/send a transaction there.
  const chains: Record<
    number,
    {
      rpcUrl: string;
      fallbackRpcUrl: string;
      wsUrl: string | null;
      executorAddress: `0x${string}` | null;
    }
  > = {};
  if (env.ETHEREUM_RPC_URL) {
    chains[1] = {
      rpcUrl: env.ETHEREUM_RPC_URL,
      fallbackRpcUrl:
        env.ETHEREUM_RPC_URL_FALLBACK ?? DEFAULT_FALLBACK_RPC_URL[1]!,
      wsUrl: env.ETHEREUM_WS_URL ?? null,
      executorAddress: env.ARB_EXECUTOR_ETHEREUM ?? null,
    };
  }
  if (env.ARBITRUM_RPC_URL) {
    chains[42161] = {
      rpcUrl: env.ARBITRUM_RPC_URL,
      fallbackRpcUrl:
        env.ARBITRUM_RPC_URL_FALLBACK ?? DEFAULT_FALLBACK_RPC_URL[42161]!,
      wsUrl: env.ARBITRUM_WS_URL ?? null,
      executorAddress: env.ARB_EXECUTOR_ARBITRUM ?? null,
    };
  }
  if (env.OPTIMISM_RPC_URL) {
    chains[10] = {
      rpcUrl: env.OPTIMISM_RPC_URL,
      fallbackRpcUrl:
        env.OPTIMISM_RPC_URL_FALLBACK ?? DEFAULT_FALLBACK_RPC_URL[10]!,
      wsUrl: env.OPTIMISM_WS_URL ?? null,
      executorAddress: env.ARB_EXECUTOR_OPTIMISM ?? null,
    };
  }
  if (env.POLYGON_RPC_URL) {
    chains[137] = {
      rpcUrl: env.POLYGON_RPC_URL,
      fallbackRpcUrl:
        env.POLYGON_RPC_URL_FALLBACK ?? DEFAULT_FALLBACK_RPC_URL[137]!,
      wsUrl: env.POLYGON_WS_URL ?? null,
      executorAddress: env.ARB_EXECUTOR_POLYGON ?? null,
    };
  }

  const optionalChains = [
    [
      8453,
      env.BASE_RPC_URL,
      env.BASE_RPC_URL_FALLBACK,
      env.BASE_WS_URL,
      env.ARB_EXECUTOR_BASE,
    ],
    [
      43114,
      env.AVALANCHE_RPC_URL,
      env.AVALANCHE_RPC_URL_FALLBACK,
      env.AVALANCHE_WS_URL,
      env.ARB_EXECUTOR_AVALANCHE,
    ],
    [
      56,
      env.BSC_RPC_URL,
      env.BSC_RPC_URL_FALLBACK,
      env.BSC_WS_URL,
      env.ARB_EXECUTOR_BSC,
    ],
    [
      42220,
      env.CELO_RPC_URL,
      env.CELO_RPC_URL_FALLBACK,
      env.CELO_WS_URL,
      env.ARB_EXECUTOR_CELO,
    ],
    [
      59144,
      env.LINEA_RPC_URL,
      env.LINEA_RPC_URL_FALLBACK,
      env.LINEA_WS_URL,
      env.ARB_EXECUTOR_LINEA,
    ],
    [
      5000,
      env.MANTLE_RPC_URL,
      env.MANTLE_RPC_URL_FALLBACK,
      env.MANTLE_WS_URL,
      env.ARB_EXECUTOR_MANTLE,
    ],
    [
      534352,
      env.SCROLL_RPC_URL,
      env.SCROLL_RPC_URL_FALLBACK,
      env.SCROLL_WS_URL,
      env.ARB_EXECUTOR_SCROLL,
    ],
    [
      146,
      env.SONIC_RPC_URL,
      env.SONIC_RPC_URL_FALLBACK,
      env.SONIC_WS_URL,
      env.ARB_EXECUTOR_SONIC,
    ],
    [
      324,
      env.ZKSYNC_RPC_URL,
      env.ZKSYNC_RPC_URL_FALLBACK,
      env.ZKSYNC_WS_URL,
      env.ARB_EXECUTOR_ZKSYNC,
    ],
    [
      1868,
      env.SONEIUM_RPC_URL,
      env.SONEIUM_RPC_URL_FALLBACK,
      env.SONEIUM_WS_URL,
      env.ARB_EXECUTOR_SONEIUM,
    ],
  ] as const;
  for (const [
    chainId,
    rpcUrl,
    fallbackRpcUrl,
    wsUrl,
    executorAddress,
  ] of optionalChains) {
    if (!rpcUrl) continue;
    chains[chainId] = {
      rpcUrl,
      fallbackRpcUrl: fallbackRpcUrl ?? DEFAULT_FALLBACK_RPC_URL[chainId]!,
      wsUrl: wsUrl ?? null,
      executorAddress: executorAddress ?? null,
    };
  }

  if (env.EXECUTION_CHAIN_IDS) {
    const requested = new Set(
      env.EXECUTION_CHAIN_IDS.split(",").map((value) => Number(value.trim())),
    );
    if ([...requested].some((chainId) => !Number.isInteger(chainId) || chainId <= 0)) {
      throw new Error(
        "Invalid EXECUTION_CHAIN_IDS: expected comma-separated positive chain IDs.",
      );
    }
    for (const chainId of Object.keys(chains).map(Number)) {
      if (!requested.has(chainId)) delete chains[chainId];
    }
  }

  if (Object.keys(chains).length === 0) {
    throw new Error(
      "No usable chain configured: set at least one supported *_RPC_URL value.",
    );
  }

  const minProfitUsdByChain: Partial<Record<number, number>> = {};
  if (env.MIN_PROFIT_USD_BSC)
    minProfitUsdByChain[56] = env.MIN_PROFIT_USD_BSC;

  const bscGasReserveTriggerWei = parseEther(
    env.BSC_GAS_RESERVE_TRIGGER_BNB,
  );
  const bscGasReserveTargetWei = parseEther(env.BSC_GAS_RESERVE_TARGET_BNB);
  if (bscGasReserveTargetWei <= bscGasReserveTriggerWei) {
    throw new Error(
      "Invalid gas-reserve configuration: BSC_GAS_RESERVE_TARGET_BNB must be greater than BSC_GAS_RESERVE_TRIGGER_BNB.",
    );
  }
  if (bscGasReserveTriggerWei < 2_000_000_000_000_000n) {
    throw new Error(
      "Invalid gas-reserve configuration: BSC_GAS_RESERVE_TRIGGER_BNB must be at least the 0.002 BNB execution floor.",
    );
  }

  return {
    apiBaseUrl: env.API_BASE_URL,
    privateKey: env.PRIVATE_KEY,
    chains,
    enableLiveExecution: env.ENABLE_LIVE_EXECUTION,
    requireManualExecution: env.REQUIRE_MANUAL_EXECUTION,
    maxBorrowUsd: env.MAX_BORROW_USD,
    minProfitUsd: env.MIN_PROFIT_USD,
    minProfitUsdByChain,
    minProfitBpsOnChain: env.MIN_PROFIT_BPS_ON_CHAIN,
    minProfitOverGasMultiplier: env.MIN_PROFIT_OVER_GAS_MULTIPLIER,
    maxTradesPerHour: env.MAX_TRADES_PER_HOUR,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    scannerRequestTimeoutMs: env.SCANNER_REQUEST_TIMEOUT_MS,
    minTickGapMs: env.MIN_TICK_GAP_MS,
    slippageBps: env.SLIPPAGE_BPS,
    autoGasReserve: env.AUTO_GAS_RESERVE,
    bscGasReserveTriggerWei,
    bscGasReserveTargetWei,
    gasReserveSlippageBps: env.GAS_RESERVE_SLIPPAGE_BPS,
    graphApiKey: env.GRAPH_API_KEY,
    enableLiquidations: env.ENABLE_LIQUIDATIONS,
    liquidationScanIntervalMs: env.LIQUIDATION_SCAN_INTERVAL_MS,
    flashbotsProtectRpcUrl: env.FLASHBOTS_PROTECT_RPC_URL,
    enableMevShareHints: env.ENABLE_MEV_SHARE_HINTS,
    mevShareStreamUrl: env.MEV_SHARE_STREAM_URL,
  };
}
