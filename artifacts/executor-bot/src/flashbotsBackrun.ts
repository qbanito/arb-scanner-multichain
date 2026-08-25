import { keccak256, toBytes, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
};

type MevShareBundle = {
  version: "v0.1";
  inclusion: { block: Hex; maxBlock: Hex };
  body: [{ hash: Hex }, { tx: Hex; canRevert: false }];
  validity: { refund: []; refundConfig: [] };
  privacy: { hints: ["hash"] };
};

async function signedRpc<T>(args: {
  relayUrl: string;
  account: PrivateKeyAccount;
  method: "mev_simBundle" | "mev_sendBundle";
  params: unknown[];
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: args.method,
    params: args.params,
  });
  // Flashbots authenticates the relay request with an EIP-191 signature over
  // the keccak256 hash encoded as a UTF-8 hex string.
  const signature = await args.account.signMessage({
    message: keccak256(toBytes(body)),
  });
  const response = await (args.fetchImpl ?? fetch)(args.relayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-flashbots-signature": `${args.account.address}:${signature}`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Flashbots relay returned HTTP ${response.status}`);
  const decoded = (await response.json()) as JsonRpcResponse<T>;
  if (decoded.error)
    throw new Error(
      `Flashbots ${args.method} failed: ${decoded.error.message ?? decoded.error.code ?? "unknown error"}`,
    );
  if (decoded.result === undefined)
    throw new Error(`Flashbots ${args.method} returned no result`);
  return decoded.result;
}

export async function simulateAndSendMevShareBackrun(args: {
  relayUrl: string;
  account: PrivateKeyAccount;
  targetHash: Hex;
  signedTransaction: Hex;
  nextBlockNumber: bigint;
  maxBlockWindow?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ bundleHash: Hex; simulationGasUsed: bigint }> {
  const maxBlockWindow = Math.max(1, Math.min(5, args.maxBlockWindow ?? 3));
  const bundle: MevShareBundle = {
    version: "v0.1",
    inclusion: {
      block: toHex(args.nextBlockNumber),
      maxBlock: toHex(args.nextBlockNumber + BigInt(maxBlockWindow - 1)),
    },
    body: [
      { hash: args.targetHash },
      { tx: args.signedTransaction, canRevert: false },
    ],
    validity: { refund: [], refundConfig: [] },
    privacy: { hints: ["hash"] },
  };

  const simulation = await signedRpc<{
    success?: boolean;
    gasUsed?: Hex;
    error?: string;
  }>({
    relayUrl: args.relayUrl,
    account: args.account,
    method: "mev_simBundle",
    params: [bundle, { parentBlock: "latest" }],
    fetchImpl: args.fetchImpl,
  });
  if (!simulation.success)
    throw new Error(
      `Flashbots matched-bundle simulation failed: ${simulation.error ?? "relay reported success=false"}`,
    );

  const submitted = await signedRpc<{ bundleHash: Hex }>({
    relayUrl: args.relayUrl,
    account: args.account,
    method: "mev_sendBundle",
    params: [bundle],
    fetchImpl: args.fetchImpl,
  });
  if (!submitted.bundleHash)
    throw new Error("Flashbots mev_sendBundle returned no bundle hash");
  return {
    bundleHash: submitted.bundleHash,
    simulationGasUsed: simulation.gasUsed ? BigInt(simulation.gasUsed) : 0n,
  };
}
