import { Router, type IRouter } from "express";
import { GetLiquidationOpportunitiesResponse, GetLiquidationStrategyDetailResponse } from "@workspace/api-zod";
import { chainIdForKey, findLiquidationOpportunities, getLiquidationStrategyDetail, supportedLiquidationChainIds } from "../lib/aave";
import { logger } from "../lib/logger";

const cache = new Map<string, { expiresAt: number; value: unknown }>();
const TTL_MS = 120_000; // scanning up to ~3,000 candidates per chain is not cheap; also reused for /liquidations/strategy — DEX quotes/gas/competitors don't shift faster than that either

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await loader();
  cache.set(key, { expiresAt: Date.now() + TTL_MS, value });
  return value;
}

const router: IRouter = Router();

router.get("/liquidations/opportunities", async (req, res) => {
  const graphApiKey = process.env["GRAPH_API_KEY"];
  if (!graphApiKey) {
    res.status(503).json({ error: "GRAPH_API_KEY is not configured. No liquidation data was fabricated." });
    return;
  }

  const chainParam = String(req.query["chain"] ?? "all");
  const chainIds =
    chainParam === "all"
      ? supportedLiquidationChainIds()
      : [chainIdForKey(chainParam)].filter((id): id is number => id !== null);

  const maxHealthFactor = Number(req.query["maxHealthFactor"] ?? 1.05);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 20)));

  try {
    const perChain = await Promise.all(
      chainIds.map((chainId) =>
        cached(`liquidations:${chainId}:${maxHealthFactor}:${limit}`, () =>
          findLiquidationOpportunities(chainId, graphApiKey, maxHealthFactor, limit),
        ),
      ),
    );
    const opportunities = perChain.flat().sort((a, b) => b.estimatedBonusUsd - a.estimatedBonusUsd).slice(0, limit);
    res.json(GetLiquidationOpportunitiesResponse.parse(opportunities));
  } catch (err) {
    logger.warn({ err }, "live liquidation scan unavailable");
    res.status(503).json({ error: "Live liquidation data is unavailable. No opportunities were fabricated." });
  }
});

router.get("/liquidations/strategy", async (req, res) => {
  const chainId = Number(req.query["chainId"]);
  const poolAddress = String(req.query["poolAddress"] ?? "");
  const debtAssetAddress = String(req.query["debtAssetAddress"] ?? "");
  const collateralAssetAddress = String(req.query["collateralAssetAddress"] ?? "");
  const debtAmount = String(req.query["debtAmount"] ?? "");
  const collateralAmount = String(req.query["collateralAmount"] ?? "");
  const estimatedBonusUsd = Number(req.query["estimatedBonusUsd"]);

  if (!Number.isFinite(chainId) || !poolAddress || !debtAssetAddress || !collateralAssetAddress || !debtAmount || !collateralAmount || !Number.isFinite(estimatedBonusUsd)) {
    res.status(503).json({ error: "Missing or invalid query parameters." });
    return;
  }

  try {
    const cacheKey = `strategy:${chainId}:${poolAddress}:${debtAssetAddress}:${collateralAssetAddress}:${debtAmount}:${collateralAmount}`;
    const detail = await cached(cacheKey, () =>
      getLiquidationStrategyDetail({ chainId, poolAddress, debtAssetAddress, collateralAssetAddress, debtAmount, collateralAmount, estimatedBonusUsd }),
    );
    res.json(GetLiquidationStrategyDetailResponse.parse(detail));
  } catch (err) {
    logger.warn({ err }, "liquidation strategy detail unavailable");
    res.status(503).json({ error: "Live strategy detail is unavailable. Nothing was fabricated." });
  }
});

export default router;
