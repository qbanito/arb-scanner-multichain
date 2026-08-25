import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toBytes } from "viem";
import {
  decodeSseChunk,
  isPotentialSwapHint,
  mevShareHintAddresses,
} from "./mevShareHints";

test("decodes fragmented MEV-Share SSE events without dropping the remainder", () => {
  const first = decodeSseChunk("", 'event: transaction\ndata: {"hash":"0x');
  assert.deepEqual(first.events, []);
  const second = decodeSseChunk(first.remainder, `${"11".repeat(32)}","logs":[]}\n\n: keepalive\n\n`);
  assert.equal(second.events.length, 1);
  assert.deepEqual(second.events[0], { hash: `0x${"11".repeat(32)}`, logs: [] });
  assert.equal(second.remainder, "");
});

test("distinguishes swap order flow from ordinary token transfers", () => {
  const hash = `0x${"11".repeat(32)}` as const;
  assert.equal(
    isPotentialSwapHint({
      hash,
      logs: [{
        topics: [
          keccak256(
            toBytes("Transfer(address,address,uint256)"),
          ),
        ],
      }],
    }),
    false,
  );
  assert.equal(
    isPotentialSwapHint({
      hash,
      logs: [{
        topics: [
          keccak256(
            toBytes("Swap(address,address,int256,int256,uint160,uint128,int24)"),
          ),
        ],
      }],
    }),
    true,
  );
});

test("extracts only valid disclosed route addresses", () => {
  const addresses = mevShareHintAddresses({
    hash: `0x${"11".repeat(32)}`,
    logs: [
      { address: `0x${"AA".repeat(20)}` },
      { address: "not-an-address" },
    ],
    txs: [{ to: `0x${"bb".repeat(20)}` }],
  });
  assert.deepEqual([...addresses].sort(), [
    `0x${"aa".repeat(20)}`,
    `0x${"bb".repeat(20)}`,
  ]);
});

test("ignores malformed frames and joins multi-line data", () => {
  const decoded = decodeSseChunk("", 'data: nope\n\ndata: {"hash":\ndata: "value"}\n\n');
  assert.deepEqual(decoded.events, [{ hash: "value" }]);
});
