import { logger } from "./logger";

const DEFAULT_ACROSS_API_BASE_URL = "https://app.across.to/api";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;

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
    const usd = positiveFinite((total as Record<string, unknown>).usd);
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
