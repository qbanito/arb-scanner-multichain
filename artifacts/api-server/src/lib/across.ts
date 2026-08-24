import { logger } from "./logger";
import { formatUnits, parseUnits } from "viem";
import { normalizeTrackedPair } from "./arbitrageEligibility";
import {
  CHAIN_IDS,
  pairsFor,
  RPCS,
  TOKEN_DEFINITIONS,
  tokenDecimals,
  type ChainId,
  type LiveMarket,
} from "../routes/scanner";

const DEFAULT_ACROSS_API_BASE_URL = "https://app.across.to/api";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;
const DEFAULT_ACROSS_SCAN_TOKENS = ["WETH", "USDC", "USDT", "DAI", "WBTC"];

export type AcrossTradeType = "exactInput" | "minOutput";

export type AcrossQuoteRequest = {
  originChainId: number;
  destinationChainId: number;
  inputToken: `0x${string}`;
  outputToken: `0x${string}`;
  amount: string;
  depositor: `0x${string}`;
  recipient: `0x${string}`;
  tradeType: AcrossTradeType;
};

export type AcrossTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  gas?: string;
};

export type AcrossQuote = {
  id?: string;
  expectedOutputAmount: string;
  minOutputAmount?: string;
  expectedFillTimeSeconds?: number;
  quoteExpiryTimestamp?: number;
  fees: {
    totalUsd?: number;
    totalRaw?: string;
    details?: Record<string, unknown>;
  };
  simulationSuccess?: boolean;
  checks?: unknown;
  approvalTxns: AcrossTransaction[];
  swapTx: AcrossTransaction;
  raw: Record<string, unknown>;
};

export type AcrossConfig = {
  enabled: boolean;
  apiBaseUrl: string;
  apiKeyConfigured: boolean;
  integratorIdConfigured: boolean;
  allowedChainIds: number[];
};

export type CrossChainProfitInputs = {
  originSaleUsd: number;
  destinationBuyUsd: number;
  acrossFeeUsd: number;
  originGasUsd: number;
  destinationGasUsd: number;
  slippageUsd: number;
  inventoryCarryUsd?: number;
};

export type CrossChainProfit = {
  grossSpreadUsd: number;
  totalCostsUsd: number;
  netProfitUsd: number;
  executable: false;
  blocker: "cross-chain-inventory-required";
};

export type AcrossOpportunity = {
  id: string;
  token: string;
  originChain: string;
  originChainId: number;
  destinationChain: string;
  destinationChainId: number;
  originPriceUsd: number;
  destinationPriceUsd: number;
  spreadBps: number;
  inputAmount: string;
  inputAmountUsd: number;
  expectedOutputAmount?: string;
  expectedOutputUsd?: number;
  acrossFeeUsd?: number;
  expectedFillTimeSeconds?: number;
  netProfitUsd?: number;
  quoteStatus: "quoted" | "unavailable";
  profitable: boolean;
  executable: false;
  blocker: "cross-chain-inventory-required" | "across-quote-unavailable";
  detectedAt: string;
};

export type AcrossOpportunitySnapshot = {
  generatedAt: string;
  nextScanAt: string;
  enabled: boolean;
  continuous: boolean;
  chainsScanned: string[];
  tokensEvaluated: number;
  quoteFailures: number;
  configurationMissing: string[];
  opportunities: AcrossOpportunity[];
};

function positiveFinite(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function transaction(value: unknown): AcrossTransaction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const to = stringValue(candidate.to);
  const data = stringValue(candidate.data);
  if (!to || !ADDRESS_RE.test(to) || !data || !HEX_RE.test(data)) return undefined;
  const result: AcrossTransaction = { to: to as `0x${string}`, data: data as `0x${string}` };
  for (const key of ["value", "gas"] as const) {
    const field = stringValue(candidate[key]);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

function transactions(value: unknown): AcrossTransaction[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = transaction(item);
        return parsed ? [parsed] : [];
      })
    : [];
}

function feeUsd(body: Record<string, unknown>): number | undefined {
  const fees = body.fees;
  if (!fees || typeof fees !== "object") return undefined;
  const total = (fees as Record<string, unknown>).total;
  if (total && typeof total === "object") {
    const breakdown = total as Record<string, unknown>;
    const usd = positiveFinite(breakdown.usd) ?? positiveFinite(breakdown.amountUsd);
    if (usd !== undefined) return usd;
  }
  return positiveFinite(total);
}

function rawFee(body: Record<string, unknown>): string | undefined {
  const fees = body.fees;
  if (!fees || typeof fees !== "object") return undefined;
  const total = (fees as Record<string, unknown>).total;
  if (total && typeof total === "object") {
    return stringValue((total as Record<string, unknown>).amount);
  }
  return stringValue(total);
}

function envChainIds(): number[] {
  const configured = process.env["ACROSS_ALLOWED_CHAIN_IDS"];
  if (!configured) return [];
  return configured
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function acrossConfig(): AcrossConfig {
  return {
    enabled: process.env["ACROSS_ENABLED"] === "true",
    apiBaseUrl: process.env["ACROSS_API_BASE_URL"] ?? DEFAULT_ACROSS_API_BASE_URL,
    apiKeyConfigured: Boolean(process.env["ACROSS_API_KEY"]),
    integratorIdConfigured: Boolean(process.env["ACROSS_INTEGRATOR_ID"]),
    allowedChainIds: envChainIds(),
  };
}

export function validateAcrossRequest(request: AcrossQuoteRequest): string | null {
  if (!Number.isInteger(request.originChainId) || request.originChainId <= 0) return "Invalid origin chain id";
  if (!Number.isInteger(request.destinationChainId) || request.destinationChainId <= 0) return "Invalid destination chain id";
  if (request.originChainId === request.destinationChainId) return "Across requires different origin and destination chains";
  if (!ADDRESS_RE.test(request.inputToken) || !ADDRESS_RE.test(request.outputToken)) return "Invalid token address";
  if (!ADDRESS_RE.test(request.depositor) || !ADDRESS_RE.test(request.recipient)) return "Invalid wallet address";
  if (!/^\d+$/.test(request.amount) || request.amount === "0") return "Amount must be a positive integer in token base units";
  return null;
}

export async function fetchAcrossQuote(
  request: AcrossQuoteRequest,
  signal?: AbortSignal,
): Promise<AcrossQuote> {
  const config = acrossConfig();
  if (!config.enabled) throw new Error("Across integration is disabled (set ACROSS_ENABLED=true)");
  const validationError = validateAcrossRequest(request);
  if (validationError) throw new Error(validationError);
  if (config.allowedChainIds.length > 0 &&
      (!config.allowedChainIds.includes(request.originChainId) || !config.allowedChainIds.includes(request.destinationChainId))) {
    throw new Error("Chain pair is not enabled for Across in this deployment");
  }
  if (!config.integratorIdConfigured) throw new Error("ACROSS_INTEGRATOR_ID is not configured");
  if (config.apiBaseUrl.includes("app.across.to") && !config.apiKeyConfigured) {
    throw new Error("ACROSS_API_KEY is required for production Across quotes");
  }

  const params = new URLSearchParams({
    originChainId: String(request.originChainId),
    destinationChainId: String(request.destinationChainId),
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    amount: request.amount,
    depositor: request.depositor,
    recipient: request.recipient,
    tradeType: request.tradeType,
    integratorId: process.env["ACROSS_INTEGRATOR_ID"]!,
  });
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env["ACROSS_API_KEY"]) headers.authorization = `Bearer ${process.env["ACROSS_API_KEY"]}`;

  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/swap/approval?${params}`, {
    headers,
    signal: signal ?? AbortSignal.timeout(12_000),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const detail = body && typeof body === "object" ? stringValue((body as Record<string, unknown>).message) : undefined;
    throw new Error(`Across quote failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!body || typeof body !== "object") throw new Error("Across returned an invalid quote payload");
  const record = body as Record<string, unknown>;
  const expectedOutputAmount = stringValue(record.expectedOutputAmount);
  const swapTx = transaction(record.swapTx);
  if (!expectedOutputAmount || !swapTx) throw new Error("Across quote did not include executable swap data");

  const quote: AcrossQuote = {
    id: stringValue(record.id),
    expectedOutputAmount,
    minOutputAmount: stringValue(record.minOutputAmount),
    expectedFillTimeSeconds: positiveFinite(record.expectedFillTime),
    quoteExpiryTimestamp: positiveFinite(record.quoteExpiryTimestamp),
    fees: {
      totalUsd: feeUsd(record),
      totalRaw: rawFee(record),
      details: record.fees && typeof record.fees === "object" ? (record.fees as Record<string, unknown>) : undefined,
    },
    simulationSuccess: typeof record.simulationSuccess === "boolean" ? record.simulationSuccess : undefined,
    checks: record.checks,
    approvalTxns: transactions(record.approvalTxns),
    swapTx,
    raw: record,
  };
  logger.debug({ originChainId: request.originChainId, destinationChainId: request.destinationChainId, expectedFillTime: quote.expectedFillTimeSeconds }, "Across quote received");
  return quote;
}

export function calculateCrossChainProfit(inputs: CrossChainProfitInputs): CrossChainProfit {
  const grossSpreadUsd = inputs.destinationBuyUsd - inputs.originSaleUsd;
  const totalCostsUsd = inputs.acrossFeeUsd + inputs.originGasUsd + inputs.destinationGasUsd + inputs.slippageUsd + (inputs.inventoryCarryUsd ?? 0);
  return {
    grossSpreadUsd,
    totalCostsUsd,
    netProfitUsd: grossSpreadUsd - totalCostsUsd,
    executable: false,
    blocker: "cross-chain-inventory-required",
  };
}

function envNumber(name: string, fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function addressConfigured(value: string | undefined): value is `0x${string}` {
  return Boolean(value && ADDRESS_RE.test(value));
}

type MarketPrice = {
  token: string;
  address: string;
  decimals: number;
  priceUsd: number;
  liquidityUsd: number;
};

function bestMarketPrices(chain: ChainId, markets: LiveMarket[]): Map<string, MarketPrice> {
  const result = new Map<string, MarketPrice>();
  for (const { token, pairs } of markets) {
    const address = token.addresses[chain];
    if (!address) continue;
    for (const pair of pairs) {
      const normalized = normalizeTrackedPair(pair, address);
      const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
      if (!normalized || normalized.priceUsd <= 0 || liquidityUsd < envNumber("ACROSS_MIN_POOL_LIQUIDITY_USD", 25_000)) continue;
      const key = token.symbol.toUpperCase();
      const current = result.get(key);
      if (!current || liquidityUsd > current.liquidityUsd) {
        result.set(key, {
          token: token.symbol,
          address,
          decimals: tokenDecimals(token, chain),
          priceUsd: normalized.priceUsd,
          liquidityUsd,
        });
      }
    }
  }
  return result;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

// A malformed or thin pool can report a wildly wrong USD conversion. Require
// cross-chain corroboration before letting a price dislocation become an
// Across candidate; bridge fees cannot make a 200,000x spot error executable.
function sanitizeCrossChainPrices(
  raw: Map<ChainId, Map<string, MarketPrice>>,
): Map<ChainId, Map<string, MarketPrice>> {
  const byToken = new Map<string, number[]>();
  for (const markets of raw.values()) {
    for (const [token, market] of markets) {
      const values = byToken.get(token) ?? [];
      values.push(market.priceUsd);
      byToken.set(token, values);
    }
  }
  const maxDeviation = envNumber("ACROSS_MAX_REFERENCE_DEVIATION_BPS", 1_000, 100, 5_000) / 10_000;
  const reference = new Map<string, { price: number; corroborated: boolean }>();
  for (const [token, values] of byToken) {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const price = median(values);
    const corroborated = values.length >= 3 || maximum / minimum <= 1 + maxDeviation;
    reference.set(token, { price, corroborated });
  }
  return new Map(
    [...raw.entries()].map(([chain, markets]) => [
      chain,
      new Map(
        [...markets.entries()].filter(([token, market]) => {
          const ref = reference.get(token);
          return Boolean(
            ref &&
              ref.corroborated &&
              Math.abs(market.priceUsd / ref.price - 1) <= maxDeviation,
          );
        }),
      ),
    ]),
  );
}

function scanChains(): ChainId[] {
  const config = acrossConfig();
  const allowed = config.allowedChainIds;
  const chains = CHAIN_IDS.filter((chain) => allowed.length === 0 || allowed.includes(RPCS[chain].chainId));
  return chains.slice(0, Math.floor(envNumber("ACROSS_MAX_CHAINS", 8, 2, CHAIN_IDS.length)));
}

function acrossScanTokens(): Set<string> {
  const configured = process.env["ACROSS_SCAN_TOKENS"]
    ?.split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ACROSS_SCAN_TOKENS);
}

async function lightMarkets(chain: ChainId): Promise<LiveMarket[]> {
  const symbols = acrossScanTokens();
  const definitions = TOKEN_DEFINITIONS.filter((token) =>
    symbols.has(token.symbol.toUpperCase()) && Boolean(token.addresses[chain]),
  );
  const settled = await Promise.allSettled(
    definitions.map(async (token) => ({
      token,
      pairs: await pairsFor(chain, token.addresses[chain]!),
    })),
  );
  const markets = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (markets.length === 0) throw new Error(`No Across seed markets returned for ${chain}`);
  return markets;
}

function amountForPrice(amountUsd: number, priceUsd: number, decimals: number): bigint {
  const units = amountUsd / priceUsd;
  const precision = Math.min(decimals, 8);
  return parseUnits(units.toFixed(precision), decimals);
}

async function withinChainScanBudget<T>(promise: Promise<T>, chain: ChainId): Promise<T> {
  const timeoutMs = Math.floor(envNumber("ACROSS_CHAIN_SCAN_TIMEOUT_MS", 10_000, 3_000, 30_000));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Across market scan exceeded ${timeoutMs}ms for ${chain}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let acrossSnapshot: { expiresAt: number; value: AcrossOpportunitySnapshot } | null = null;
let acrossScanInFlight: Promise<AcrossOpportunitySnapshot> | null = null;
const acrossMarketCache = new Map<ChainId, LiveMarket[]>();
let acrossChainCursor = 0;

export async function scanAcrossOpportunities(force = false): Promise<AcrossOpportunitySnapshot> {
  const config = acrossConfig();
  const intervalMs = Math.floor(envNumber("ACROSS_SCAN_INTERVAL_MS", 15_000, 5_000, 120_000));
  if (!force && acrossSnapshot && acrossSnapshot.expiresAt > Date.now()) return acrossSnapshot.value;
  if (acrossScanInFlight) return acrossScanInFlight;

  const configurationMissing = [
    ...(config.enabled ? [] : ["ACROSS_ENABLED"]),
    ...(config.apiKeyConfigured || !config.apiBaseUrl.includes("app.across.to") ? [] : ["ACROSS_API_KEY"]),
    ...(config.integratorIdConfigured ? [] : ["ACROSS_INTEGRATOR_ID"]),
    ...(addressConfigured(process.env["ACROSS_QUOTE_ADDRESS"]) ? [] : ["ACROSS_QUOTE_ADDRESS"]),
  ];
  const chains = scanChains();
  const startedAt = new Date().toISOString();

  acrossScanInFlight = (async () => {
    const perCycle = Math.floor(envNumber("ACROSS_CHAINS_PER_CYCLE", 1, 1, chains.length));
    const cycleChains = chains.length <= perCycle
      ? chains
      : Array.from({ length: perCycle }, (_, offset) => chains[(acrossChainCursor + offset) % chains.length]!);
    acrossChainCursor = chains.length ? (acrossChainCursor + cycleChains.length) % chains.length : 0;
    const settled = await Promise.allSettled(
      cycleChains.map(async (chain) => ({
        chain,
        markets: await withinChainScanBudget(lightMarkets(chain), chain),
      })),
    );
    settled.forEach((item) => {
      if (item.status === "fulfilled") acrossMarketCache.set(item.value.chain, item.value.markets);
    });
    const successful = chains.flatMap((chain) => {
      const markets = acrossMarketCache.get(chain);
      return markets ? [{ chain, markets }] : [];
    });
    const prices = sanitizeCrossChainPrices(new Map<ChainId, Map<string, MarketPrice>>(
      successful.map(({ chain, markets }) => [chain, bestMarketPrices(chain, markets)]),
    ));
    const candidates: Array<{
      token: string;
      origin: ChainId;
      destination: ChainId;
      originPrice: MarketPrice;
      destinationPrice: MarketPrice;
      spreadBps: number;
    }> = [];
    for (const token of TOKEN_DEFINITIONS) {
      for (const origin of successful.map(({ chain }) => chain)) {
        for (const destination of successful.map(({ chain }) => chain)) {
          if (origin === destination) continue;
          const originPrice = prices.get(origin)?.get(token.symbol.toUpperCase());
          const destinationPrice = prices.get(destination)?.get(token.symbol.toUpperCase());
          if (!originPrice || !destinationPrice || !token.addresses[origin] || !token.addresses[destination]) continue;
          const spreadBps = ((destinationPrice.priceUsd / originPrice.priceUsd) - 1) * 10_000;
          if (spreadBps < envNumber("ACROSS_MIN_SPREAD_BPS", 30, 1, 10_000)) continue;
          candidates.push({ token: token.symbol, origin, destination, originPrice, destinationPrice, spreadBps });
        }
      }
    }
    candidates.sort((a, b) => b.spreadBps - a.spreadBps);
    const inputAmountUsd = envNumber("ACROSS_SCAN_AMOUNT_USD", 250, 1, 1_000_000);
    const maxQuotes = Math.floor(envNumber("ACROSS_MAX_QUOTES", 16, 1, 64));

    // Keep market discovery useful before production Across credentials are
    // present. These rows are deliberately watch-only: without an Across
    // quote we cannot calculate bridge fees, destination gas, slippage, or a
    // realizable net profit.
    if (configurationMissing.length > 0) {
      const opportunities: AcrossOpportunity[] = candidates.slice(0, maxQuotes).map((candidate) => {
        const amount = amountForPrice(inputAmountUsd, candidate.originPrice.priceUsd, candidate.originPrice.decimals);
        return {
          id: `across:${candidate.token}:${candidate.origin}:${candidate.destination}`,
          token: candidate.token,
          originChain: candidate.origin,
          originChainId: RPCS[candidate.origin].chainId,
          destinationChain: candidate.destination,
          destinationChainId: RPCS[candidate.destination].chainId,
          originPriceUsd: candidate.originPrice.priceUsd,
          destinationPriceUsd: candidate.destinationPrice.priceUsd,
          spreadBps: Math.round(candidate.spreadBps),
          inputAmount: amount.toString(),
          inputAmountUsd,
          quoteStatus: "unavailable",
          profitable: false,
          executable: false,
          blocker: "across-quote-unavailable",
          detectedAt: startedAt,
        };
      });
      const value: AcrossOpportunitySnapshot = {
        generatedAt: startedAt,
        nextScanAt: new Date(Date.now() + intervalMs).toISOString(),
        enabled: config.enabled,
        continuous: successful.length > 0,
        chainsScanned: successful.map(({ chain }) => chain),
        tokensEvaluated: TOKEN_DEFINITIONS.filter((token) => successful.filter(({ chain }) => token.addresses[chain]).length >= 2).length,
        quoteFailures: 0,
        configurationMissing,
        opportunities,
      };
      acrossSnapshot = { expiresAt: Date.now() + intervalMs, value };
      return value;
    }

    const quoteAddress = process.env["ACROSS_QUOTE_ADDRESS"] as `0x${string}`;
    let quoteFailures = 0;
    const opportunities: AcrossOpportunity[] = [];
    for (const candidate of candidates.slice(0, maxQuotes)) {
      const amount = amountForPrice(inputAmountUsd, candidate.originPrice.priceUsd, candidate.originPrice.decimals);
      const id = `across:${candidate.token}:${candidate.origin}:${candidate.destination}`;
      try {
        const quote = await fetchAcrossQuote({
          originChainId: RPCS[candidate.origin].chainId,
          destinationChainId: RPCS[candidate.destination].chainId,
          inputToken: candidate.originPrice.address as `0x${string}`,
          outputToken: candidate.destinationPrice.address as `0x${string}`,
          amount: amount.toString(),
          depositor: quoteAddress,
          recipient: quoteAddress,
          tradeType: "exactInput",
        });
        const expectedOutputUsd = Number(formatUnits(BigInt(quote.expectedOutputAmount), candidate.destinationPrice.decimals)) * candidate.destinationPrice.priceUsd;
        const acrossFeeUsd = quote.fees.totalUsd ?? Math.max(0, inputAmountUsd - expectedOutputUsd);
        const profit = calculateCrossChainProfit({
          originSaleUsd: inputAmountUsd,
          destinationBuyUsd: expectedOutputUsd,
          acrossFeeUsd,
          originGasUsd: envNumber("ACROSS_ORIGIN_GAS_USD", 0.25, 0, 100),
          destinationGasUsd: envNumber("ACROSS_DESTINATION_GAS_USD", 0.25, 0, 100),
          slippageUsd: inputAmountUsd * envNumber("ACROSS_SLIPPAGE_BPS", 50, 0, 1_000) / 10_000,
          inventoryCarryUsd: inputAmountUsd * envNumber("ACROSS_INVENTORY_CARRY_BPS", 10, 0, 1_000) / 10_000,
        });
        opportunities.push({
          id,
          token: candidate.token,
          originChain: candidate.origin,
          originChainId: RPCS[candidate.origin].chainId,
          destinationChain: candidate.destination,
          destinationChainId: RPCS[candidate.destination].chainId,
          originPriceUsd: candidate.originPrice.priceUsd,
          destinationPriceUsd: candidate.destinationPrice.priceUsd,
          spreadBps: Math.round(candidate.spreadBps),
          inputAmount: amount.toString(),
          inputAmountUsd,
          expectedOutputAmount: quote.expectedOutputAmount,
          expectedOutputUsd,
          acrossFeeUsd,
          expectedFillTimeSeconds: quote.expectedFillTimeSeconds,
          netProfitUsd: profit.netProfitUsd,
          quoteStatus: "quoted",
          profitable: profit.netProfitUsd > 0,
          executable: false,
          blocker: "cross-chain-inventory-required",
          detectedAt: startedAt,
        });
      } catch (err) {
        quoteFailures++;
        logger.debug({ err, id }, "Across cross-chain quote failed");
      }
    }
    opportunities.sort((a, b) => (b.netProfitUsd ?? -Infinity) - (a.netProfitUsd ?? -Infinity));
    const value: AcrossOpportunitySnapshot = {
      generatedAt: startedAt,
      nextScanAt: new Date(Date.now() + intervalMs).toISOString(),
      enabled: true,
      continuous: true,
      chainsScanned: successful.map(({ chain }) => chain),
      tokensEvaluated: TOKEN_DEFINITIONS.filter((token) => successful.filter(({ chain }) => token.addresses[chain]).length >= 2).length,
      quoteFailures,
      configurationMissing: [],
      opportunities,
    };
    acrossSnapshot = { expiresAt: Date.now() + intervalMs, value };
    return value;
  })().finally(() => {
    acrossScanInFlight = null;
  });
  return acrossScanInFlight;
}
