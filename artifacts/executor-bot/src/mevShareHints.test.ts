import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSseChunk } from "./mevShareHints";

test("decodes fragmented MEV-Share SSE events without dropping the remainder", () => {
  const first = decodeSseChunk("", 'event: transaction\ndata: {"hash":"0x');
  assert.deepEqual(first.events, []);
  const second = decodeSseChunk(first.remainder, `${"11".repeat(32)}","logs":[]}\n\n: keepalive\n\n`);
  assert.equal(second.events.length, 1);
  assert.deepEqual(second.events[0], { hash: `0x${"11".repeat(32)}`, logs: [] });
  assert.equal(second.remainder, "");
});

test("ignores malformed frames and joins multi-line data", () => {
  const decoded = decodeSseChunk("", 'data: nope\n\ndata: {"hash":\ndata: "value"}\n\n');
  assert.deepEqual(decoded.events, [{ hash: "value" }]);
});
