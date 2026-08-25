import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  webSocket,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import type { Config } from "./config";
import { logger } from "./logger";

const CHAIN_DEFS: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  56: bsc,
  137: polygon,
  146: sonic,
  324: zkSync,
  1868: soneium,
  5000: mantle,
  8453: base,
  42161: arbitrum,
  42220: celo,
  43114: avalanche,
  59144: linea,
  534352: scroll,
};

export type ChainEntry = {
  chain: Chain;
  /// `null` means watch-only — no ArbExecutor deployed on this chain yet.
  /// Real-time monitoring (e.g. the liquidation watcher) still works; this
  /// bot just can never build/send a transaction here.
  executorAddress: `0x${string}` | null;
  /// Transport is `fallback([primary, backup])`, not plain `http` — see
  /// buildChainClients. Typed as the general `Transport` rather than a
  /// specific transport's return type since read/write can each end up on
  /// either `fallback` or (for Ethereum sends via Flashbots Protect) `http`.
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  /// Separate client on a WebSocket transport, used only to subscribe to
  /// new blocks (executor.ts's block-driven tick). `null` unless a verified
  /// *_WS_URL is configured; HTTPS endpoints are never rewritten into an
  /// assumed WebSocket endpoint. The timer remains the fallback.
  wsClient: PublicClient<ReturnType<typeof webSocket>, Chain> | null;
};

export function buildChainClients(config: Config) {
  const account = privateKeyToAccount(config.privateKey);

  const clients = new Map<number, ChainEntry>();

  for (const [chainIdStr, chainConfig] of Object.entries(config.chains)) {
    const chainId = Number(chainIdStr);
    const chain = CHAIN_DEFS[chainId];
    if (!chain) continue;

    // The configured Alchemy project has exhausted its monthly capacity.
    // Some of those responses surface as contract-call errors that viem
    // correctly treats as non-retriable, so putting that transport first can
    // prevent fallback altogether. Use the independently verified public RPC
    // first and keep the configured endpoint as the secondary transport. Do
    // not rank/ping the exhausted endpoint on every cycle.
    const readUrls = (
      chainId === 8453
        ? [
            chainConfig.rpcUrl,
            chainConfig.fallbackRpcUrl,
            ...chain.rpcUrls.default.http,
          ]
        : [
            chainConfig.fallbackRpcUrl,
            ...chain.rpcUrls.default.http,
            chainConfig.rpcUrl,
          ]
    ).filter((url, index, urls) => urls.indexOf(url) === index);
    const readTransport = fallback(readUrls.map((url) => http(url)));

    // Block/mempool subscriptions stay on the primary's own WebSocket only —
    // fallback() is a per-request retry model, not a fit for a long-lived
    // subscription, and alchemy_pendingTransactions (highValueWatcher.ts's
    // mempool early warning) is Alchemy-specific regardless.
    const wsUrl = chainConfig.wsUrl;
    let wsClient: ChainEntry["wsClient"] = null;
    if (wsUrl) {
      try {
        wsClient = createPublicClient({ chain, transport: webSocket(wsUrl) });
      } catch (err) {
        logger.warn(
          { err, chainId },
          "failed to create WebSocket client, falling back to timer-only polling",
        );
      }
    }

    // Route only the final signed transaction through Flashbots Protect —
    // reads (multicall, simulateContract, block watching) stay on the fast
    // configured RPC. Only meaningful on Ethereum mainnet (chainId 1):
    // Arbitrum has no public mempool for a private relay to protect against,
    // and Flashbots Protect doesn't support it. viem's walletClient signs
    // locally and submits via eth_sendRawTransaction for a local account —
    // exactly the call Flashbots Protect's RPC intercepts and forwards
    // privately, so no other code path needs to change. When Flashbots
    // isn't configured (or on Arbitrum), sends still get the same two-
    // provider fallback as reads — no reason a send should have less
    // reliability than a read.
    const writeTransport =
      chainId === 8453
        ? http(chainConfig.rpcUrl)
        : chainId === 1 && config.flashbotsProtectRpcUrl
        ? http(config.flashbotsProtectRpcUrl)
        : readTransport;
    if (chainId === 1 && config.flashbotsProtectRpcUrl) {
      logger.info(
        { chainId },
        "routing Ethereum transactions through Flashbots Protect (private, not the public mempool)",
      );
    }
    if (chainId === 8453) {
      logger.info(
        { chainId, rpcUrl: chainConfig.rpcUrl },
        "routing Base reads, pending simulation and sends through Flashblocks",
      );
    }

    clients.set(chainId, {
      chain,
      executorAddress: chainConfig.executorAddress,
      publicClient: createPublicClient({ chain, transport: readTransport }),
      walletClient: createWalletClient({
        chain,
        transport: writeTransport,
        account,
      }),
      wsClient,
    });
  }

  return { account, clients };
}

export type ChainClients = ReturnType<typeof buildChainClients>;
