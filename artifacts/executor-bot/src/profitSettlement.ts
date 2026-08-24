import type { Account } from "viem";
import { getAddress } from "viem";
import {
  arbExecutorAbi,
  erc20Abi,
  uniswapV2RouterAbi,
  wrappedNativeAbi,
} from "./abis";
import type { ChainEntry } from "./chains";

export const BSC_CHAIN_ID = 56;
export const BSC_WBNB = getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
);
export const PANCAKE_V2_ROUTER_BSC = getAddress(
  "0x10ED43C718714eb63d5aA57B78B54704E256024E",
);

const WITHDRAW_GAS_UNITS = 80_000n;
const WBNB_UNWRAP_GAS_UNITS = 80_000n;
const ERC20_REFILL_GAS_UNITS = 320_000n;

export type GasReserveSettings = {
  enabled: boolean;
  triggerWei: bigint;
  targetWei: bigint;
  slippageBps: number;
};

export type GasRefillPlan =
  | { kind: "none"; reason: "disabled" | "unsupported-chain" | "reserve-healthy" | "no-profit" }
  | {
      kind: "refill";
      shortfallWei: bigint;
      maxProfitAmount: bigint;
      unwrapWbnb: boolean;
    };

export function planGasRefill(args: {
  chainId: number;
  settings: GasReserveSettings;
  nativeBalance: bigint;
  profitToken: `0x${string}`;
  confirmedProfit: bigint;
}): GasRefillPlan {
  if (!args.settings.enabled) return { kind: "none", reason: "disabled" };
  if (args.chainId !== BSC_CHAIN_ID)
    return { kind: "none", reason: "unsupported-chain" };
  if (args.nativeBalance >= args.settings.triggerWei)
    return { kind: "none", reason: "reserve-healthy" };
  if (args.confirmedProfit <= 0n)
    return { kind: "none", reason: "no-profit" };
  return {
    kind: "refill",
    shortfallWei: args.settings.targetWei - args.nativeBalance,
    maxProfitAmount: args.confirmedProfit,
    unwrapWbnb: getAddress(args.profitToken) === BSC_WBNB,
  };
}

/**
 * Conservative gas held back before an arbitrage is sent. The withdrawal is
 * mandatory on every chain; BSC additionally budgets the worst-case
 * approve+swap refill whenever the projected native reserve is low.
 */
export function estimateSettlementGasBudgetWei(args: {
  chainId: number;
  gasPriceWei: bigint;
  projectedNativeBalance: bigint;
  profitToken: `0x${string}`;
  settings: GasReserveSettings;
}): bigint {
  let gasUnits = WITHDRAW_GAS_UNITS;
  if (
    args.settings.enabled &&
    args.chainId === BSC_CHAIN_ID &&
    args.projectedNativeBalance < args.settings.triggerWei
  ) {
    gasUnits +=
      getAddress(args.profitToken) === BSC_WBNB
        ? WBNB_UNWRAP_GAS_UNITS
        : ERC20_REFILL_GAS_UNITS;
  }
  return (gasUnits * args.gasPriceWei * 120n) / 100n;
}

export async function readExecutorTokenBalance(
  chain: ChainEntry,
  token: `0x${string}`,
): Promise<bigint> {
  if (!chain.executorAddress) return 0n;
  return chain.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [chain.executorAddress],
  });
}

export async function sweepExecutorToken(args: {
  chain: ChainEntry;
  account: Account;
  token: `0x${string}`;
  amount: bigint;
}): Promise<`0x${string}`> {
  const executorAddress = args.chain.executorAddress;
  if (!executorAddress) throw new Error("cannot sweep a watch-only executor");
  const { request } = await args.chain.publicClient.simulateContract({
    address: executorAddress,
    abi: arbExecutorAbi,
    functionName: "withdrawToken",
    args: [args.token, args.account.address, args.amount],
    account: args.account,
  });
  const hash = await args.chain.walletClient.writeContract(request);
  const receipt = await args.chain.publicClient.waitForTransactionReceipt({
    hash,
  });
  if (receipt.status !== "success")
    throw new Error(`profit withdrawal reverted: ${hash}`);
  return hash;
}

async function approveExact(args: {
  chain: ChainEntry;
  account: Account;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
}): Promise<void> {
  const currentAllowance = await args.chain.publicClient.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.account.address, args.spender],
  });
  const approvals = currentAllowance === 0n ? [args.amount] : [0n, args.amount];
  for (const amount of approvals) {
    const { request } = await args.chain.publicClient.simulateContract({
      address: args.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [args.spender, amount],
      account: args.account,
    });
    const hash = await args.chain.walletClient.writeContract(request);
    const receipt = await args.chain.publicClient.waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success")
      throw new Error(`gas-reserve approval reverted: ${hash}`);
  }
}

async function revokeAllowance(args: {
  chain: ChainEntry;
  account: Account;
  token: `0x${string}`;
}): Promise<void> {
  try {
    const { request } = await args.chain.publicClient.simulateContract({
      address: args.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PANCAKE_V2_ROUTER_BSC, 0n],
      account: args.account,
    });
    const hash = await args.chain.walletClient.writeContract(request);
    await args.chain.publicClient.waitForTransactionReceipt({ hash });
  } catch {
    // The profit remains in the operator wallet. The next refill resets any
    // surviving allowance before approving another bounded amount.
  }
}

export type SettlementResult = {
  withdrawn: bigint;
  withdrawalHash: `0x${string}`;
  refill:
    | {
        status: "not-needed";
        reason: Extract<GasRefillPlan, { kind: "none" }>["reason"];
      }
    | {
        status: "completed";
        profitSpent: bigint;
        nativeReceivedMinimum: bigint;
        transactionHash: `0x${string}`;
      }
    | { status: "skipped"; reason: string };
};

/**
 * Withdraws only the just-confirmed executor balance, then uses at most that
 * amount to refill BNB. Pre-existing wallet token balances are never read as
 * refill capital and therefore can never be spent by this routine.
 */
export async function settleConfirmedProfit(args: {
  chainId: number;
  chain: ChainEntry;
  account: Account;
  profitToken: `0x${string}`;
  confirmedProfit: bigint;
  settings: GasReserveSettings;
}): Promise<SettlementResult> {
  const withdrawalHash = await sweepExecutorToken({
    chain: args.chain,
    account: args.account,
    token: args.profitToken,
    amount: args.confirmedProfit,
  });

  const nativeBalance = await args.chain.publicClient.getBalance({
    address: args.account.address,
  });
  const plan = planGasRefill({
    chainId: args.chainId,
    settings: args.settings,
    nativeBalance,
    profitToken: args.profitToken,
    confirmedProfit: args.confirmedProfit,
  });
  if (plan.kind === "none") {
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: { status: "not-needed", reason: plan.reason },
    };
  }

  if (plan.unwrapWbnb) {
    const amount =
      plan.maxProfitAmount < plan.shortfallWei
        ? plan.maxProfitAmount
        : plan.shortfallWei;
    const { request } = await args.chain.publicClient.simulateContract({
      address: BSC_WBNB,
      abi: wrappedNativeAbi,
      functionName: "withdraw",
      args: [amount],
      account: args.account,
    });
    const hash = await args.chain.walletClient.writeContract(request);
    const receipt = await args.chain.publicClient.waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success")
      throw new Error(`WBNB gas-reserve unwrap reverted: ${hash}`);
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: {
        status: "completed",
        profitSpent: amount,
        nativeReceivedMinimum: amount,
        transactionHash: hash,
      },
    };
  }

  const path = [getAddress(args.profitToken), BSC_WBNB] as const;
  let requiredInput: bigint;
  try {
    const amountsIn = await args.chain.publicClient.readContract({
      address: PANCAKE_V2_ROUTER_BSC,
      abi: uniswapV2RouterAbi,
      functionName: "getAmountsIn",
      args: [plan.shortfallWei, path],
    });
    requiredInput = amountsIn[0];
  } catch {
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: { status: "skipped", reason: "no-direct-pancake-v2-route" },
    };
  }

  const bufferedInput =
    (requiredInput * BigInt(10_000 + args.settings.slippageBps) + 9_999n) /
    10_000n;
  const amountIn =
    bufferedInput < plan.maxProfitAmount ? bufferedInput : plan.maxProfitAmount;
  if (amountIn <= 0n) {
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: { status: "skipped", reason: "profit-too-small" },
    };
  }
  const amountsOut = await args.chain.publicClient.readContract({
    address: PANCAKE_V2_ROUTER_BSC,
    abi: uniswapV2RouterAbi,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const quotedOut = amountsOut.at(-1) ?? 0n;
  const minimumOut =
    (quotedOut * BigInt(10_000 - args.settings.slippageBps)) / 10_000n;
  if (minimumOut <= 0n) {
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: { status: "skipped", reason: "zero-output-quote" },
    };
  }

  await approveExact({
    chain: args.chain,
    account: args.account,
    token: args.profitToken,
    spender: PANCAKE_V2_ROUTER_BSC,
    amount: amountIn,
  });
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
    const { request } = await args.chain.publicClient.simulateContract({
      address: PANCAKE_V2_ROUTER_BSC,
      abi: uniswapV2RouterAbi,
      functionName: "swapExactTokensForETH",
      args: [amountIn, minimumOut, path, args.account.address, deadline],
      account: args.account,
    });
    const hash = await args.chain.walletClient.writeContract(request);
    const receipt = await args.chain.publicClient.waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success")
      throw new Error(`gas-reserve swap reverted: ${hash}`);
    return {
      withdrawn: args.confirmedProfit,
      withdrawalHash,
      refill: {
        status: "completed",
        profitSpent: amountIn,
        nativeReceivedMinimum: minimumOut,
        transactionHash: hash,
      },
    };
  } catch (error) {
    await revokeAllowance({
      chain: args.chain,
      account: args.account,
      token: args.profitToken,
    });
    throw error;
  }
}
