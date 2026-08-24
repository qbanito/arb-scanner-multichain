import type { Chain, PublicClient, Transport } from "viem";
import { logger } from "./logger";
import { nativeEthAmountToUsd, usdToNativeEthAmount } from "./priceOracle";

export type DynamicFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; extraTipUsd: number };

// Willing to spend up to this share of expected profit as an *extra* tip on
// top of the market-rate priority fee, to win inclusion when another
// searcher is racing the same position. Never the whole thing — the point
// is to win the race profitably, not to donate the win to a block builder.
const MAX_PRIORITY_FEE_PROFIT_SHARE = 0.15;
// Always keep at least this much USD of profit after gas AND the extra tip,
// regardless of how generous MAX_PRIORITY_FEE_PROFIT_SHARE would otherwise
// allow — a large enough opportunity could still technically clear
// checkGasVsProfit's multiplier while paying away nearly all of it in tip.
const MIN_PROFIT_FLOOR_USD = 5;
// Absolute ceiling on the *extra* portion regardless of profit size — a
// backstop against a bad price read or a math error computing something
// absurd, not meant to bind in normal operation. Sized against real
// historical Ethereum priority-fee spikes (peak congestion has seen
// sustained fees in the hundreds of gwei), not an arbitrary round number —
// 50 gwei was tried first and turned out to bind by ~$2,000 of profit
// (verified live against real fee data), which defeated the entire point
// for anything bigger, including positions actually seen this session in
// the millions. 500 gwei leaves MAX_PRIORITY_FEE_PROFIT_SHARE as the
// operative constraint up to several-thousand-dollar trades, only kicking
// in as a genuine backstop for outsized profit figures.
const MAX_EXTRA_PRIORITY_FEE_WEI = 500n * 10n ** 9n; // 500 gwei

/// Computes a competitive EIP-1559 fee for the final liquidation send,
/// scaled to how much this specific opportunity is worth — instead of
/// leaving fee selection to viem/the RPC's generic default, which has no
/// notion of "this one's worth fighting harder for than that one."
///
/// Ethereum mainnet only: this only matters where inclusion is a public
/// priority-fee auction among block builders, which is what Flashbots
/// Protect's transactions still compete on even though they're submitted
/// privately (the builder receiving the bundle decides by the same
/// effective-tip math it would for anything else). Arbitrum's sequencer
/// ordering isn't a per-tx priority-fee market the same way — a bigger tip
/// there wouldn't buy what it buys here — so this returns null for chains
/// other than mainnet and the caller falls back to normal fee estimation.
export async function computeCompetitivePriorityFee(
  client: PublicClient<Transport, Chain>,
  chainId: number,
  gasEstimate: bigint,
  expectedProfitUsd: number,
  baselineGasCostUsd: number,
): Promise<DynamicFees | null> {
  if (chainId !== 1 || gasEstimate === 0n) return null;

  let baseFee: bigint | null;
  let marketPriorityFee: bigint;
  try {
    const [block, priorityFee] = await Promise.all([client.getBlock({ blockTag: "latest" }), client.estimateMaxPriorityFeePerGas()]);
    baseFee = block.baseFeePerGas ?? null;
    marketPriorityFee = priorityFee;
  } catch (err) {
    logger.debug({ err }, "failed to read fee market data — falling back to default fee estimation");
    return null;
  }
  if (baseFee === null) return null; // pre-EIP-1559 chain state, shouldn't happen on mainnet but don't guess

  const spendableUsd = Math.min(expectedProfitUsd * MAX_PRIORITY_FEE_PROFIT_SHARE, expectedProfitUsd - baselineGasCostUsd - MIN_PROFIT_FLOOR_USD);
  if (spendableUsd <= 0) return null; // nothing to spare over the floor — send at market rate, no boost

  const spendableWei = await usdToNativeEthAmount(client, chainId, spendableUsd);
  if (spendableWei === null) return null;

  let extraPerGas = spendableWei / gasEstimate;
  if (extraPerGas > MAX_EXTRA_PRIORITY_FEE_WEI) extraPerGas = MAX_EXTRA_PRIORITY_FEE_WEI;
  if (extraPerGas <= 0n) return null;

  const maxPriorityFeePerGas = marketPriorityFee + extraPerGas;
  // Same headroom pattern as viem's own default fee estimation: cover a
  // couple of blocks' worth of base fee growth (max +12.5%/block) on top of
  // the priority fee, so the tx doesn't stall if base fee ticks up before
  // it lands.
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  // Re-price the *actual* extra wei being spent (after the absolute-ceiling
  // cap above may have reduced it below spendableUsd) back to USD, purely
  // for logging — never used in a financial decision past this point.
  const extraTipUsd = (await nativeEthAmountToUsd(client, chainId, extraPerGas * gasEstimate)) ?? 0;

  return { maxFeePerGas, maxPriorityFeePerGas, extraTipUsd };
}
