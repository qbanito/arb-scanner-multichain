import WebSocket from "ws";
import type { Hex } from "viem";
import { logger } from "./logger";

export type BloxrouteBackrunSignal = {
  targetHash: Hex;
  addresses: Set<string>;
  nextBlockNumber: bigint;
  maxBlockNumber: bigint;
};

function parseBlockNumber(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^(?:0x[a-fA-F0-9]+|\d+)$/.test(value))
    return BigInt(value);
  return null;
}

export function decodeBloxrouteBackrunSignal(
  raw: string,
): BloxrouteBackrunSignal | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = (
    message as {
      params?: { result?: Record<string, unknown> };
    }
  )?.params?.result;
  if (!result) return null;
  const transactions = Array.isArray(result.transactions)
    ? result.transactions
    : [];
  const first = transactions[0] as
    | { txHash?: unknown; txContents?: { to?: unknown; logs?: unknown } }
    | undefined;
  if (
    typeof first?.txHash !== "string" ||
    !/^0x[a-fA-F0-9]{64}$/.test(first.txHash)
  )
    return null;
  const nextBlockNumber = parseBlockNumber(result.nextBlockNumber);
  const maxBlockNumber = parseBlockNumber(result.maxBlockNumber);
  if (nextBlockNumber === null || maxBlockNumber === null) return null;

  const addresses = new Set<string>();
  for (const transaction of transactions) {
    const contents = (transaction as { txContents?: Record<string, unknown> })
      .txContents;
    const to = contents?.to;
    if (typeof to === "string" && /^0x[a-fA-F0-9]{40}$/.test(to))
      addresses.add(to.toLowerCase());
    const logs = Array.isArray(contents?.logs) ? contents.logs : [];
    for (const log of logs) {
      const address = (log as { address?: unknown })?.address;
      if (
        typeof address === "string" &&
        /^0x[a-fA-F0-9]{40}$/.test(address)
      )
        addresses.add(address.toLowerCase());
    }
  }
  if (result.state && typeof result.state === "object") {
    for (const address of Object.keys(result.state))
      if (/^0x[a-fA-F0-9]{40}$/.test(address))
        addresses.add(address.toLowerCase());
  }
  return {
    targetHash: first.txHash as Hex,
    addresses,
    nextBlockNumber,
    maxBlockNumber,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function watchBloxrouteBackrunme(args: {
  wsUrl: string;
  authorization: string;
  onSignal: (signal: BloxrouteBackrunSignal) => void;
  signal?: AbortSignal;
}): Promise<void> {
  while (!args.signal?.aborted) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(args.wsUrl, {
          headers: { Authorization: args.authorization },
        });
        const abort = () => socket.close();
        args.signal?.addEventListener("abort", abort, { once: true });
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              id: 1,
              method: "subscribe",
              params: [
                "arbOnlyMEV",
                {
                  blockchain_network: "BSC-Mainnet",
                  options: { include: ["all", "backrun_config"] },
                },
              ],
            }),
          );
          logger.info("bloXroute BSC arbOnlyMEV private stream connected");
        });
        socket.on("message", (data) => {
          const signal = decodeBloxrouteBackrunSignal(data.toString());
          if (signal) args.onSignal(signal);
        });
        socket.once("error", reject);
        socket.once("close", () => resolve());
      });
    } catch (err) {
      if (args.signal?.aborted) return;
      logger.warn({ err }, "bloXroute BackRunMe stream disconnected; retrying");
    }
    if (!args.signal?.aborted) await wait(2_000);
  }
}

async function bloxrouteRpc<T>(args: {
  rpcUrl: string;
  authorization: string;
  method: string;
  params: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const response = await (args.fetchImpl ?? fetch)(args.rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: args.authorization,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: args.method,
      params: args.params,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`bloXroute returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string; code?: number };
  };
  if (body.error)
    throw new Error(
      `bloXroute ${args.method} failed: ${body.error.message ?? body.error.code ?? "unknown error"}`,
    );
  if (body.result === undefined)
    throw new Error(`bloXroute ${args.method} returned no result`);
  return body.result;
}

function simulationFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (object.success === false || object.status === "0x0") return true;
  if (typeof object.error === "string" && object.error.length > 0) return true;
  if (object.firstRevert !== undefined && object.firstRevert !== null)
    return true;
  return Object.values(object).some((entry) =>
    Array.isArray(entry)
      ? entry.some(simulationFailed)
      : simulationFailed(entry),
  );
}

export async function simulateAndSubmitBloxrouteBackrun(args: {
  rpcUrl: string;
  authorization: string;
  signal: BloxrouteBackrunSignal;
  signedTransaction: Hex;
  fetchImpl?: typeof fetch;
}): Promise<{ bundleHash: string | null }> {
  const blockNumber = `0x${args.signal.nextBlockNumber.toString(16)}`;
  const params = {
    transaction_hash: args.signal.targetHash,
    transaction: [args.signedTransaction.slice(2)],
    block_number: blockNumber,
    state_block_number: "latest",
    blockchain_network: "BSC-Mainnet",
  };
  const simulation = await bloxrouteRpc<unknown>({
    rpcUrl: args.rpcUrl,
    authorization: args.authorization,
    method: "simulate_arb_only_bundle",
    params,
    fetchImpl: args.fetchImpl,
  });
  if (simulationFailed(simulation))
    throw new Error("bloXroute matched BackRunMe simulation reported a revert");

  const submitted = await bloxrouteRpc<unknown>({
    rpcUrl: args.rpcUrl,
    authorization: args.authorization,
    method: "submit_arb_only_bundle",
    params: {
      ...params,
      max_block_number: `0x${args.signal.maxBlockNumber.toString(16)}`,
    },
    fetchImpl: args.fetchImpl,
  });
  const result = submitted as Record<string, unknown> | string | null;
  const bundleHash =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? String(result.bundleHash ?? result.bundle_hash ?? "") || null
        : null;
  return { bundleHash };
}
