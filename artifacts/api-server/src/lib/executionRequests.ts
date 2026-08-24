const REQUEST_TTL_MS = 60_000;
const requests = new Map<string, number>();

export function requestImmediateExecution(opportunityId: string): void {
  requests.set(opportunityId, Date.now() + REQUEST_TTL_MS);
}

export function activeExecutionRequests(): string[] {
  const now = Date.now();
  for (const [id, expiresAt] of requests) {
    if (expiresAt <= now) requests.delete(id);
  }
  return [...requests.keys()];
}

export function completeExecutionRequest(opportunityId: string): void {
  requests.delete(opportunityId);
}
