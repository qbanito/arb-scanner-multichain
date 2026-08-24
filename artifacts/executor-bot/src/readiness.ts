import { getAddress } from "viem";
import { arbExecutorAbi } from "./abis";
import type { ChainClients } from "./chains";

const MIN_GAS_BALANCE_WEI: Record<number, bigint> = {
  1: 1_000_000_000_000_000n, // 0.001 ETH
  42161: 50_000_000_000_000n, // 0.00005 ETH
  10: 50_000_000_000_000n, // 0.00005 ETH
  137: 100_000_000_000_000_000n, // 0.1 POL
  8453: 50_000_000_000_000n, // 0.00005 ETH
  43114: 10_000_000_000_000_000n, // 0.01 AVAX
  56: 2_000_000_000_000_000n, // 0.002 BNB
  42220: 100_000_000_000_000_000n, // 0.1 CELO
  59144: 50_000_000_000_000n, // 0.00005 ETH
  5000: 50_000_000_000_000_000n, // 0.05 MNT
  534352: 50_000_000_000_000n, // 0.00005 ETH
  146: 1_000_000_000_000_000_000n, // 1 S
  324: 50_000_000_000_000n, // 0.00005 ETH
  1868: 50_000_000_000_000n, // 0.00005 ETH
};

export type ChainExecutionReadiness = {
  ready: boolean;
  blockers: Array<
    | "watch-only"
    | "rpc-unavailable"
    | "no-bytecode"
    | "wrong-owner"
    | "paused"
    | "insufficient-gas"
  >;
  gasBalance: bigint | null;
  minimumGasBalance: bigint;
};

export function minimumGasBalance(chainId: number): bigint {
  return MIN_GAS_BALANCE_WEI[chainId] ?? 0n;
}

export function hasSufficientGasBalance(
  balance: bigint,
  chainMinimum: bigint,
  estimatedTransactionCost = 0n,
): boolean {
  return balance >= chainMinimum + estimatedTransactionCost;
}

/**
 * Readiness is evaluated independently per chain. A low balance is a safe
 * standby state, not a process-level failure: once the operator is funded,
 * the next tick can begin trading without a restart or user interaction.
 */
export async function getExecutionReadiness(
  chainClients: ChainClients,
  chainIds?: ReadonlySet<number>,
): Promise<Map<number, ChainExecutionReadiness>> {
  const readiness = new Map<number, ChainExecutionReadiness>();

  await Promise.all(
    [...chainClients.clients]
      .filter(([chainId]) => !chainIds || chainIds.has(chainId))
      .map(async ([chainId, chain]) => {
        const minimum = minimumGasBalance(chainId);
        if (!chain.executorAddress) {
          readiness.set(chainId, {
            ready: false,
            blockers: ["watch-only"],
            gasBalance: null,
            minimumGasBalance: minimum,
          });
          return;
        }

        try {
          const [bytecode, owner, paused, gasBalance] = await Promise.all([
            chain.publicClient.getBytecode({ address: chain.executorAddress }),
            chain.publicClient.readContract({
              address: chain.executorAddress,
              abi: arbExecutorAbi,
              functionName: "owner",
            }),
            chain.publicClient.readContract({
              address: chain.executorAddress,
              abi: arbExecutorAbi,
              functionName: "paused",
            }),
            chain.publicClient.getBalance({
              address: chainClients.account.address,
            }),
          ]);
          const blockers: ChainExecutionReadiness["blockers"] = [];
          if (!bytecode || bytecode === "0x") blockers.push("no-bytecode");
          if (getAddress(owner) !== getAddress(chainClients.account.address))
            blockers.push("wrong-owner");
          if (paused) blockers.push("paused");
          if (!hasSufficientGasBalance(gasBalance, minimum))
            blockers.push("insufficient-gas");
          readiness.set(chainId, {
            ready: blockers.length === 0,
            blockers,
            gasBalance,
            minimumGasBalance: minimum,
          });
        } catch {
          readiness.set(chainId, {
            ready: false,
            blockers: ["rpc-unavailable"],
            gasBalance: null,
            minimumGasBalance: minimum,
          });
        }
      }),
  );

  return readiness;
}

export async function routeTargetsAllowed(
  chainClients: ChainClients,
  chainId: number,
  targets: readonly `0x${string}`[],
): Promise<{ ok: true } | { ok: false; blocked: `0x${string}`[] }> {
  const chain = chainClients.clients.get(chainId);
  if (!chain?.executorAddress)
    return { ok: false, blocked: [...new Set(targets)] };
  const unique = [
    ...new Set(targets.map((target) => getAddress(target))),
  ] as `0x${string}`[];
  const checks = await Promise.all(
    unique.map((target) =>
      chain.publicClient.readContract({
        address: chain.executorAddress!,
        abi: arbExecutorAbi,
        functionName: "allowedTargets",
        args: [target],
      }),
    ),
  );
  const blocked = unique.filter((_, index) => !checks[index]);
  return blocked.length ? { ok: false, blocked } : { ok: true };
}
