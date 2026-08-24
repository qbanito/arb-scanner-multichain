import { Router, type IRouter } from "express";
import {
  acrossConfig,
  calculateCrossChainProfit,
  fetchAcrossQuote,
  type AcrossQuoteRequest,
} from "../lib/across";
import { RateGate } from "../lib/rateGate";

const router: IRouter = Router();
const acrossQuoteGate = new RateGate(250);

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function queryInteger(value: unknown): number | undefined {
  const parsed = Number(queryString(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Across is deliberately exposed as a quote/read surface first. A bridge
 * transfer is not an atomic continuation of an origin-chain flash loan, so
 * this route never signs or submits the returned calldata.
 */
router.get("/scanner/across/status", (_req, res) => {
  const config = acrossConfig();
  res.json({
    enabled: config.enabled,
    apiBaseUrl: config.apiBaseUrl,
    apiKeyConfigured: config.apiKeyConfigured,
    integratorIdConfigured: config.integratorIdConfigured,
    allowedChainIds: config.allowedChainIds,
    executionMode: "quote-only",
    blocker: "cross-chain-inventory-required",
  });
});

router.get("/scanner/across/quote", async (req, res) => {
  const originChainId = queryInteger(req.query.originChainId);
  const destinationChainId = queryInteger(req.query.destinationChainId);
  const inputToken = queryString(req.query.inputToken);
  const outputToken = queryString(req.query.outputToken);
  const amount = queryString(req.query.amount);
  const depositor = queryString(req.query.depositor);
  const recipient = queryString(req.query.recipient) ?? depositor;
  const tradeType = queryString(req.query.tradeType) === "minOutput" ? "minOutput" : "exactInput";

  if (!originChainId || !destinationChainId || !inputToken || !outputToken || !amount || !depositor || !recipient) {
    res.status(400).json({ error: "originChainId, destinationChainId, inputToken, outputToken, amount and depositor are required" });
    return;
  }
  if (!acrossConfig().enabled) {
    res.status(503).json({ error: "Across integration is disabled" });
    return;
  }

  const request: AcrossQuoteRequest = {
    originChainId,
    destinationChainId,
    inputToken: inputToken as `0x${string}`,
    outputToken: outputToken as `0x${string}`,
    amount,
    depositor: depositor as `0x${string}`,
    recipient: recipient as `0x${string}`,
    tradeType,
  };

  try {
    const quote = await acrossQuoteGate.run(() => fetchAcrossQuote(request));
    res.json({
      id: quote.id,
      originChainId,
      destinationChainId,
      inputToken,
      outputToken,
      amount,
      expectedOutputAmount: quote.expectedOutputAmount,
      minOutputAmount: quote.minOutputAmount,
      expectedFillTimeSeconds: quote.expectedFillTimeSeconds,
      quoteExpiryTimestamp: quote.quoteExpiryTimestamp,
      fees: quote.fees,
      simulationSuccess: quote.simulationSuccess,
      checks: quote.checks,
      approvalTxns: quote.approvalTxns,
      swapTx: quote.swapTx,
      executionMode: "quote-only",
      executable: false,
      blocker: "cross-chain-inventory-required",
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Across quote unavailable" });
  }
});

router.get("/scanner/across/profit", (req, res) => {
  const number = (name: string): number | undefined => {
    const value = Number(queryString(req.query[name]));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const originSaleUsd = number("originSaleUsd");
  const destinationBuyUsd = number("destinationBuyUsd");
  const acrossFeeUsd = number("acrossFeeUsd");
  const originGasUsd = number("originGasUsd");
  const destinationGasUsd = number("destinationGasUsd");
  const slippageUsd = number("slippageUsd");
  const inventoryCarryUsd = number("inventoryCarryUsd");
  if ([originSaleUsd, destinationBuyUsd, acrossFeeUsd, originGasUsd, destinationGasUsd, slippageUsd].some((value) => value === undefined)) {
    res.status(400).json({ error: "originSaleUsd, destinationBuyUsd, acrossFeeUsd, originGasUsd, destinationGasUsd and slippageUsd are required" });
    return;
  }
  res.json(calculateCrossChainProfit({
    originSaleUsd: originSaleUsd!,
    destinationBuyUsd: destinationBuyUsd!,
    acrossFeeUsd: acrossFeeUsd!,
    originGasUsd: originGasUsd!,
    destinationGasUsd: destinationGasUsd!,
    slippageUsd: slippageUsd!,
    inventoryCarryUsd,
  }));
});

export default router;
