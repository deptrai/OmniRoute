import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, encodeVarintField } from "../../open-sse/executors/windsurf.ts";

const {
  readVarint,
  decodeGetChatMessageResponse,
  decodeChatToolCall,
  encodeString,
  encodeMessage,
  encodeBoolField,
} = __test;

// ─── Helpers: build protobuf payloads for testing ───────────────────────────

function buildToolCallPayload(id: string, name: string, args: string): Uint8Array {
  const parts: Uint8Array[] = [];
  if (id) parts.push(encodeString(1, id));
  if (name) parts.push(encodeString(2, name));
  if (args) parts.push(encodeString(3, args));
  return concat(parts);
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ─── T2: readVarint ─────────────────────────────────────────────────────────

test("readVarint: single byte value 0", () => {
  const buf = new Uint8Array([0]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 0);
  assert.equal(off, 1);
});

test("readVarint: single byte value 127", () => {
  const buf = new Uint8Array([127]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 127);
  assert.equal(off, 1);
});

test("readVarint: two bytes (128)", () => {
  // 128 = 0x80 0x01
  const buf = new Uint8Array([0x80, 0x01]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 128);
  assert.equal(off, 2);
});

test("readVarint: three bytes (16384)", () => {
  // 16384 = 0x80 0x80 0x01
  const buf = new Uint8Array([0x80, 0x80, 0x01]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 16384);
  assert.equal(off, 3);
});

test("readVarint: max uint32 (4294967295)", () => {
  // 0xFFFFFFFF = 5 bytes: 0xFF 0xFF 0xFF 0xFF 0x0F
  const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 4294967295);
  assert.equal(off, 5);
});

test("readVarint: offset past end returns [0, offset]", () => {
  const buf = new Uint8Array([]);
  const [val, off] = readVarint(buf, 0);
  assert.equal(val, 0);
  assert.equal(off, 0);
});

// ─── T2: decodeChatToolCall ─────────────────────────────────────────────────

test("decodeChatToolCall: full tool call (id + name + args)", () => {
  const payload = buildToolCallPayload("call_123", "Bash", '{"command":"ls"}');
  const tc = decodeChatToolCall(payload);
  assert.ok(tc);
  assert.equal(tc!.id, "call_123");
  assert.equal(tc!.name, "Bash");
  assert.equal(tc!.argumentsJson, '{"command":"ls"}');
});

test("decodeChatToolCall: only id (streaming first frame)", () => {
  const payload = encodeString(1, "call_abc");
  const tc = decodeChatToolCall(payload);
  assert.ok(tc);
  assert.equal(tc!.id, "call_abc");
  assert.equal(tc!.name, "");
  assert.equal(tc!.argumentsJson, "");
});

test("decodeChatToolCall: only name (no id)", () => {
  const payload = encodeString(2, "Agent");
  const tc = decodeChatToolCall(payload);
  assert.ok(tc);
  assert.equal(tc!.id, "");
  assert.equal(tc!.name, "Agent");
  assert.equal(tc!.argumentsJson, "");
});

test("decodeChatToolCall: only arguments (continuation frame)", () => {
  const payload = encodeString(3, '{"prompt":"hello"}');
  const tc = decodeChatToolCall(payload);
  assert.ok(tc);
  assert.equal(tc!.id, "");
  assert.equal(tc!.name, "");
  assert.equal(tc!.argumentsJson, '{"prompt":"hello"}');
});

test("decodeChatToolCall: empty payload returns null", () => {
  const tc = decodeChatToolCall(new Uint8Array(0));
  assert.equal(tc, null);
});

test("decodeChatToolCall: unknown fields skipped", () => {
  // field 99, string — should be skipped without error
  const unknown = encodeString(99, "unknown_value");
  const name = encodeString(2, "Read");
  const tc = decodeChatToolCall(concat([unknown, name]));
  assert.ok(tc);
  assert.equal(tc!.name, "Read");
});

// ─── T2: decodeGetChatMessageResponse ───────────────────────────────────────

test("decodeGetChatMessageResponse: empty payload → all defaults", () => {
  const resp = decodeGetChatMessageResponse(new Uint8Array(0));
  assert.equal(resp.deltaText, "");
  assert.equal(resp.deltaThinking, "");
  assert.equal(resp.deltaToolCalls.length, 0);
  assert.equal(resp.stopReason, 0);
  assert.equal(resp.inputTokens, 0);
  assert.equal(resp.outputTokens, 0);
});

test("decodeGetChatMessageResponse: field 3 (delta_text)", () => {
  const payload = encodeString(3, "Hello world");
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.deltaText, "Hello world");
});

test("decodeGetChatMessageResponse: field 9 (delta_thinking)", () => {
  const payload = encodeString(9, "Thinking about it...");
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.deltaThinking, "Thinking about it...");
  assert.equal(resp.deltaText, "");
});

test("decodeGetChatMessageResponse: field 5 (stop_reason) varint", () => {
  // stop_reason = 13 (STOP_REASON_ERROR)
  const payload = encodeVarintField(5, 13);
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.stopReason, 13);
});

test("decodeGetChatMessageResponse: field 6 (delta_tool_calls) single", () => {
  const tcPayload = buildToolCallPayload("call_1", "Bash", '{"command":"pwd"}');
  const payload = encodeMessage(6, tcPayload);
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.deltaToolCalls.length, 1);
  assert.equal(resp.deltaToolCalls[0].id, "call_1");
  assert.equal(resp.deltaToolCalls[0].name, "Bash");
  assert.equal(resp.deltaToolCalls[0].argumentsJson, '{"command":"pwd"}');
});

test("decodeGetChatMessageResponse: field 6 (delta_tool_calls) multiple", () => {
  const tc1 = buildToolCallPayload("call_1", "Bash", '{"command":"ls"}');
  const tc2 = buildToolCallPayload("call_2", "Read", '{"file_path":"/tmp/a"}');
  const payload = concat([encodeMessage(6, tc1), encodeMessage(6, tc2)]);
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.deltaToolCalls.length, 2);
  assert.equal(resp.deltaToolCalls[0].id, "call_1");
  assert.equal(resp.deltaToolCalls[1].id, "call_2");
});

test("decodeGetChatMessageResponse: field 7 (usage) input + output tokens", () => {
  // usage message: field 2 = input_tokens (varint), field 3 = output_tokens (varint)
  const usagePayload = concat([
    encodeVarintField(2, 1500),
    encodeVarintField(3, 800),
  ]);
  const payload = encodeMessage(7, usagePayload);
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.inputTokens, 1500);
  assert.equal(resp.outputTokens, 800);
});

test("decodeGetChatMessageResponse: combined text + thinking + tool call + usage + stop", () => {
  const parts = [
    encodeString(3, "Response text"),
    encodeString(9, "Reasoning here"),
    encodeMessage(6, buildToolCallPayload("tc_1", "Agent", '{"prompt":"do work"}')),
    encodeMessage(7, concat([encodeVarintField(2, 100), encodeVarintField(3, 50)])),
    encodeVarintField(5, 1), // stop_reason = 1 (STOP)
  ];
  const resp = decodeGetChatMessageResponse(concat(parts));
  assert.equal(resp.deltaText, "Response text");
  assert.equal(resp.deltaThinking, "Reasoning here");
  assert.equal(resp.deltaToolCalls.length, 1);
  assert.equal(resp.deltaToolCalls[0].name, "Agent");
  assert.equal(resp.inputTokens, 100);
  assert.equal(resp.outputTokens, 50);
  assert.equal(resp.stopReason, 1);
});

test("decodeGetChatMessageResponse: unknown length-delimited field skipped", () => {
  // field 99 string — should be skipped
  const payload = concat([
    encodeString(99, "unknown"),
    encodeString(3, "real text"),
  ]);
  const resp = decodeGetChatMessageResponse(payload);
  assert.equal(resp.deltaText, "real text");
});

test("decodeGetChatMessageResponse: 64-bit wire type (wireType=1) skipped", () => {
  // field 10, wire type 1 (64-bit) — 8 bytes of data
  const tag = new Uint8Array([(10 << 3) | 1]); // field 10, wireType 1
  const data = new Uint8Array(8).fill(0x42);
  const text = encodeString(3, "after 64-bit");
  const resp = decodeGetChatMessageResponse(concat([tag, data, text]));
  assert.equal(resp.deltaText, "after 64-bit");
});

test("decodeGetChatMessageResponse: 32-bit wire type (wireType=5) skipped", () => {
  // field 11, wire type 5 (32-bit) — 4 bytes of data
  const tag = new Uint8Array([(11 << 3) | 5]); // field 11, wireType 5
  const data = new Uint8Array(4).fill(0x55);
  const text = encodeString(3, "after 32-bit");
  const resp = decodeGetChatMessageResponse(concat([tag, data, text]));
  assert.equal(resp.deltaText, "after 32-bit");
});

test("decodeGetChatMessageResponse: unknown wire type (3) stops parsing", () => {
  // wire type 3 (start group, deprecated) — should break
  const tag = new Uint8Array([(3 << 3) | 3]); // field 3, wireType 3
  const resp = decodeGetChatMessageResponse(tag);
  assert.equal(resp.deltaText, "");
});

test("decodeGetChatMessageResponse: tool call with empty args frame (arguments-only)", () => {
  // Simulate streaming: first frame has id+name, second has only args
  const frame1 = encodeMessage(6, buildToolCallPayload("call_x", "Agent", ""));
  const frame2 = encodeMessage(6, buildToolCallPayload("", "", '{"prompt":"hi"}'));
  const resp = decodeGetChatMessageResponse(concat([frame1, frame2]));
  assert.equal(resp.deltaToolCalls.length, 2);
  assert.equal(resp.deltaToolCalls[0].id, "call_x");
  assert.equal(resp.deltaToolCalls[0].name, "Agent");
  assert.equal(resp.deltaToolCalls[0].argumentsJson, "");
  assert.equal(resp.deltaToolCalls[1].id, "");
  assert.equal(resp.deltaToolCalls[1].argumentsJson, '{"prompt":"hi"}');
});
