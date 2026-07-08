// Tests for max_tokens forwarding as protobuf field 4 in buildGetChatMessageRequest.
// Without this, Windsurf defaults to 1024 output tokens, truncating tool call JSON.
// The fix forwards body.max_tokens via encodeVarintField(4, maxTokens).
import test from "node:test";
import assert from "node:assert/strict";

const { buildGetChatMessageRequest, encodeVarint, encodeVarintField } =
  await import("../../open-sse/executors/windsurf.ts");

// ─── encodeVarint basics ─────────────────────────────────────────────────────

test("encodeVarint: small value (1) → single byte", () => {
  const bytes = encodeVarint(1);
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0x01);
});

test("encodeVarint: 128 → two bytes (continuation bit)", () => {
  const bytes = encodeVarint(128);
  assert.equal(bytes.length, 2);
  assert.equal(bytes[0], 0x80);
  assert.equal(bytes[1], 0x01);
});

test("encodeVarint: 4096 → two bytes", () => {
  const bytes = encodeVarint(4096);
  assert.equal(bytes.length, 2);
  // 4096 = 0x1000 → varint: 0x80 0x20
  assert.equal(bytes[0], 0x80);
  assert.equal(bytes[1], 0x20);
});

test("encodeVarint: 1000000 → three bytes", () => {
  const bytes = encodeVarint(1000000);
  assert.equal(bytes.length, 3);
  // Verify round-trip: decode back
  let val = 0;
  let shift = 0;
  for (const b of bytes) {
    val |= (b & 0x7f) << shift;
    shift += 7;
  }
  assert.equal(val, 1000000);
});

// ─── encodeVarintField ───────────────────────────────────────────────────────

test("encodeVarintField: field 4, value 4096 → correct tag + varint", () => {
  const bytes = encodeVarintField(4, 4096);
  // Tag = (fieldNum << 3) | wireType = (4 << 3) | 0 = 32
  assert.equal(bytes[0], 32);
  // Rest is the varint encoding of 4096
  assert.equal(bytes[1], 0x80);
  assert.equal(bytes[2], 0x20);
});

// ─── buildGetChatMessageRequest: max_tokens field 4 presence ─────────────────

// Helper: scan protobuf bytes for a specific varint field and return its value
function findVarintField(payload: Uint8Array, fieldNum: number): number | null {
  let i = 0;
  while (i < payload.length) {
    // Read tag (varint)
    let tag = 0;
    let shift = 0;
    while (i < payload.length) {
      const b = payload[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const fieldNumDecoded = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNumDecoded === fieldNum && wireType === 0) {
      // Read varint value
      let val = 0;
      let vShift = 0;
      while (i < payload.length) {
        const b = payload[i++];
        val |= (b & 0x7f) << vShift;
        vShift += 7;
        if (!(b & 0x80)) break;
      }
      return val >>> 0;
    }

    // Skip this field based on wire type
    if (wireType === 0) {
      // varint — skip
      while (i < payload.length) {
        const b = payload[i++];
        if (!(b & 0x80)) break;
      }
    } else if (wireType === 2) {
      // length-delimited — read length and skip
      let len = 0;
      let lShift = 0;
      while (i < payload.length) {
        const b = payload[i++];
        len |= (b & 0x7f) << lShift;
        lShift += 7;
        if (!(b & 0x80)) break;
      }
      i += len;
    } else {
      break; // Unknown wire type — stop
    }
  }
  return null;
}

test("max_tokens=4096 → field 4 present with value 4096", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    4096
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, 4096);
});

test("max_tokens=0 → field 4 absent (falsy check)", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    0
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, null, "field 4 should be absent when maxTokens=0");
});

test("max_tokens=undefined → field 4 absent", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    undefined
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, null, "field 4 should be absent when maxTokens=undefined");
});

test("max_tokens=1 → field 4 present with value 1", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    1
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, 1);
});

test("max_tokens=1000000 → field 4 present with value 1000000 (large varint)", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    1000000
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, 1000000);
});

test("max_tokens=32768 → field 4 present (typical Claude Code budget)", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    32768
  );
  const val = findVarintField(payload, 4);
  assert.equal(val, 32768);
});

// ─── Regression: other fields still present when max_tokens is set ───────────

test("max_tokens set does not break field 7 (request_type=CASCADE=5)", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    4096
  );
  const val = findVarintField(payload, 7);
  assert.equal(val, 5, "field 7 (request_type) should still be CASCADE=5");
});

test("max_tokens set does not break field 18 (provider_source=CHAT=2)", () => {
  const payload = buildGetChatMessageRequest(
    "test-key",
    "gpt-5",
    [{ role: "user", content: "hi" }],
    undefined,
    undefined,
    4096
  );
  const val = findVarintField(payload, 18);
  assert.equal(val, 2, "field 18 (provider_source) should still be CHAT=2");
});
