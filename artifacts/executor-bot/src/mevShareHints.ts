import { logger } from "./logger";

export type MevShareHint = {
  hash: `0x${string}`;
  logs?: unknown[];
  txs?: Array<{ to?: string; functionSelector?: string; callData?: string }>;
};

/** Incrementally decodes standards-compliant SSE data frames. */
export function decodeSseChunk(buffer: string, chunk: string): { events: unknown[]; remainder: string } {
  const normalized = (buffer + chunk).replaceAll("\r\n", "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: unknown[] = [];
  for (const frame of frames) {
    const payload = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // A malformed hint must not tear down the long-lived stream.
    }
  }
  return { events, remainder };
}

function isHint(value: unknown): value is MevShareHint {
  if (!value || typeof value !== "object") return false;
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(hash);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watches the official MEV-Share hint stream and wakes the normal scanner.
 * This is deliberately only an early-warning trigger: target-aware bundle
 * submission must not happen until the post-target state and our signed
 * backrun transaction have been simulated together.
 */
export async function watchMevShareHints(
  streamUrl: string,
  onHint: (hint: MevShareHint) => void,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    try {
      const response = await fetch(streamUrl, {
        headers: { Accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`MEV-Share stream returned HTTP ${response.status}`);
      logger.info({ streamUrl }, "MEV-Share hint stream connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        const decoded = decodeSseChunk(buffer, decoder.decode(value, { stream: true }));
        buffer = decoded.remainder;
        for (const event of decoded.events) if (isHint(event)) onHint(event);
      }
    } catch (err) {
      if (signal?.aborted) return;
      logger.warn({ err }, "MEV-Share hint stream disconnected; retrying");
    }
    await wait(2_000);
  }
}
