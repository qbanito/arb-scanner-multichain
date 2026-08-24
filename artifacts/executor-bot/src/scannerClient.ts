import { GetScannerOpportunitiesResponse } from "@workspace/api-zod";
import type { ArbitrageOpportunity } from "@workspace/api-zod";
import { logger } from "./logger";

/// Fetches opportunities for a single `chain` filter (e.g. "arbitrum").
/// The scanner's `/opportunities?chain=all` concatenates each chain's list
/// before slicing to `limit` — querying one chain at a time avoids a
/// higher-opportunity-count chain silently starving another out of the page.
export async function fetchOpportunities(
  apiBaseUrl: string,
  chain: string,
  minProfitBps: number,
  timeoutMs = 60_000,
): Promise<ArbitrageOpportunity[]> {
  const url = new URL("/api/scanner/opportunities", apiBaseUrl);
  url.searchParams.set("chain", chain);
  url.searchParams.set("minProfitBps", String(minProfitBps));
  url.searchParams.set("limit", "100");

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, chain }, "scanner API returned a non-OK status");
      return [];
    }

    const parsed = GetScannerOpportunitiesResponse.safeParse(await response.json());
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues, chain }, "scanner API response failed validation");
      return [];
    }

    return parsed.data;
  } catch (err) {
    // One throttled network must not discard the opportunities already
    // returned by every other configured chain in this poll cycle.
    logger.warn({ err, chain }, "scanner API request unavailable for chain");
    return [];
  }
}

export async function fetchExecutionRequests(apiBaseUrl: string): Promise<Set<string>> {
  try {
    const response = await fetch(new URL("/api/scanner/execution-requests", apiBaseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return new Set();
    const body = await response.json() as { opportunityIds?: unknown };
    return new Set(Array.isArray(body.opportunityIds) ? body.opportunityIds.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export async function completeExecutionRequest(apiBaseUrl: string, opportunityId: string): Promise<void> {
  try {
    await fetch(new URL(`/api/scanner/execution-requests/${encodeURIComponent(opportunityId)}`, apiBaseUrl), {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // TTL cleanup in the API is the fallback; never fail a trading cycle for this acknowledgement.
  }
}
