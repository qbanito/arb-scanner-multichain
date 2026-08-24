import type { Account, Chain, PublicClient, Transport } from "viem";
import { arbExecutorAbi } from "./abis";
import { nativeEthAmountToUsd } from "./priceOracle";
import { logger } from "./logger";
import { resolveUsdValue } from "./sizing";

export type GasCheck =
  | {
      ok: true;
      gasCostUsd: number;
      gasCostWei: bigint;
      expectedProfitUsd: number;
      gasEstimate: bigint;
    }
  | {
      ok: false;
      reason:
        | "gas-estimate-failed"
        | "no-native-price-feed"
        | "no-quote-price-feed"
        | "profit-does-not-clear-gas";
      detail?: unknown;
    };

/// Estimates real gas cost in USD (via `eth_estimateGas` + current gas
/// price, converted through the chain's native-ETH price feed) and refuses
/// to let a route proceed to simulation/sending unless the *estimated*
/// gross profit clears that cost by `minMultiplier`.
///
/// This exists because ArbExecutor's on-chain `minProfit` floor is
/// basis-points-of-principal — it has no notion of gas price, and gas is
/// paid separately by the sender rather than from flash-loan proceeds. On
/// Arbitrum that's a rounding error (~$0.01-0.05/tx); on Ethereum mainnet a
/// single transaction can cost $15-50+, which could otherwise exceed a
/// "profitable" trade's actual profit while still passing the on-chain
/// check and the simulation. This is a pre-flight sanity gate, not the
/// safety backstop — the contract's own checks remain that.
export async function checkGasVsProfit(
  client: PublicClient<Transport, Chain>,
  args: {
    chainId: number;
    executorAddress: `0x${string}`;
    account: Account;
    asset: `0x${string}`;
    amount: bigint;
    legs: { target: `0x${string}`; data: `0x${string}` }[];
    minProfit: bigint;
    assetDecimals: number;
    estimatedGrossProfitAsset: bigint;
    minMultiplier: number;
    /// Skips the Chainlink-based resolveUsdValue lookup below and uses this
    /// figure instead — the liquidation path already computes a USD profit
    /// figure from Aave's own oracle (see liquidationRouteBuilder.ts), which
    /// covers every Aave-known asset rather than only the handful
    /// priceOracle.ts has a hand-maintained Chainlink feed for.
    expectedProfitUsdOverride?: number;
  },
): Promise<GasCheck> {
  let gasEstimate: bigint;
  try {
    gasEstimate = await client.estimateContractGas({
      address: args.executorAddress,
      abi: arbExecutorAbi,
      functionName: "initiateArbitrage",
      args: [args.asset, args.amount, args.legs, args.minProfit, args.asset],
      account: args.account,
    });
  } catch (err) {
    // If it can't even be gas-estimated, it's not sendable regardless —
    // let the caller's existing revert-handling path take it from here.
    return { ok: false, reason: "gas-estimate-failed", detail: err };
  }

  const gasPrice = await client.getGasPrice();
  // Small headroom over the current base/gas price — estimateGas/getGasPrice
  // reflect this instant, and the price this trade actually lands at can be
  // slightly higher.
  const gasCostWei = (gasEstimate * gasPrice * 120n) / 100n;

  const gasCostUsd = await nativeEthAmountToUsd(
    client,
    args.chainId,
    gasCostWei,
  );
  if (gasCostUsd === null) return { ok: false, reason: "no-native-price-feed" };

  const expectedProfitUsd =
    args.expectedProfitUsdOverride ??
    (await resolveUsdValue(
      client,
      args.chainId,
      args.asset,
      args.assetDecimals,
      args.estimatedGrossProfitAsset,
    ));
  if (expectedProfitUsd === null)
    return { ok: false, reason: "no-quote-price-feed" };

  logger.debug(
    { gasCostUsd, expectedProfitUsd, gasEstimate: gasEstimate.toString() },
    "gas-vs-profit check",
  );

  if (expectedProfitUsd < gasCostUsd * args.minMultiplier) {
    return { ok: false, reason: "profit-does-not-clear-gas" };
  }

  return { ok: true, gasCostUsd, gasCostWei, expectedProfitUsd, gasEstimate };
}
