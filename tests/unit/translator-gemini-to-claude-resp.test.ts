import test from "node:test";
import assert from "node:assert/strict";

const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");

function run(chunks, state = {}) {
  const all = [];
  for (const c of chunks) {
    const r = geminiToClaudeResponse(c, state);
    if (r) all.push(...r);
  }
  return all;
}

function baseChunk(parts, extra = {}) {
  return {
    responseId: "r1",
    modelVersion: "gemini-2.5-pro",
    candidates: [{ content: { parts }, ...extra }],
  };
}

// ── Edge cases: null / empty / no candidates ──────────────────────────────────

test("returns null for null/undefined chunk", () => {
  assert.equal(geminiToClaudeResponse(null, {}), null);
  assert.equal(geminiToClaudeResponse(undefined, {}), null);
});

test("returns null when no candidates present", () => {
  assert.equal(geminiToClaudeResponse({ responseId: "r", modelVersion: "m" }, {}), null);
  assert.equal(geminiToClaudeResponse({ candidates: [] }, {}), null);
});

test("chunk with no parts and no finishReason emits only message_start", () => {
  const out = geminiToClaudeResponse(baseChunk([]), {});
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "message_start");
});

// ── message_start initialization ──────────────────────────────────────────────

test("emits message_start with modelVersion and generated messageId", () => {
  const out = run([baseChunk([{ text: "hi" }])]);
  assert.equal(out[0].type, "message_start");
  assert.equal(out[0].message.id, "r1");
  assert.equal(out[0].message.model, "gemini-2.5-pro");
  assert.equal(out[0].message.role, "assistant");
  assert.deepEqual(out[0].message.usage, { input_tokens: 0, output_tokens: 0 });
});

test("falls back to msg_<timestamp> when responseId missing", () => {
  const out = run([{ modelVersion: "m", candidates: [{ content: { parts: [{ text: "x" }] } }] }]);
  assert.match(out[0].message.id, /^msg_\d+$/);
});

test("falls back to 'gemini' model when modelVersion missing", () => {
  const out = run([{ responseId: "r", candidates: [{ content: { parts: [{ text: "x" }] } }] }]);
  assert.equal(out[0].message.model, "gemini");
});

// ── Text streaming: block stays open ──────────────────────────────────────────

test("text block opens once and stays open across multiple chunks", () => {
  const state = {};
  const out = run(
    [baseChunk([{ text: "a" }]), baseChunk([{ text: "b" }]), baseChunk([{ text: "c" }])],
    state
  );
  const starts = out.filter((e) => e.type === "content_block_start" && e.content_block.type === "text");
  const deltas = out.filter((e) => e.type === "content_block_delta");
  assert.equal(starts.length, 1, "only one text block_start");
  assert.equal(deltas.length, 3);
  assert.equal(deltas[0].delta.text, "a");
  assert.equal(deltas[2].delta.text, "c");
  assert.equal(state.openTextBlockIdx, 0);
});

test("empty text part does not open a block", () => {
  const out = run([baseChunk([{ text: "" }])]);
  assert.equal(out.length, 1); // only message_start
});

// ── Thinking ──────────────────────────────────────────────────────────────────

test("thinking part opens+closes its own block and closes prior text block", () => {
  const state = {};
  run([baseChunk([{ text: "txt" }])], state);
  const out = run([baseChunk([{ thought: true, text: "plan" }])], state);
  assert.equal(out[0].type, "content_block_stop");
  assert.equal(out[0].index, 0);
  assert.equal(out[1].content_block.type, "thinking");
  assert.equal(out[2].delta.thinking, "plan");
  assert.equal(out[3].type, "content_block_stop");
});

// ── thoughtSignature: text after thinking ─────────────────────────────────────

test("text part with thoughtSignature (not thought) still emits as text", () => {
  const out = run([baseChunk([{ thoughtSignature: "sig", text: "conclusion" }])]);
  const deltas = out.filter((e) => e.type === "content_block_delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.text, "conclusion");
});

// ── functionCall → tool_use ───────────────────────────────────────────────────

test("functionCall emits tool_use block with input_json_delta", () => {
  const out = run([
    baseChunk([{ functionCall: { name: "getWeather", args: { city: "NYC" } } }]),
  ]);
  const start = out.find((e) => e.type === "content_block_start");
  assert.equal(start.content_block.type, "tool_use");
  assert.equal(start.content_block.name, "getWeather");
  assert.match(start.content_block.id, /^toolu_/);
  const delta = out.find((e) => e.type === "content_block_delta");
  assert.equal(delta.delta.partial_json, JSON.stringify({ city: "NYC" }));
});

test("functionCall uses toolNameMap to restore original name", () => {
  const state = { toolNameMap: new Map([["short_abc", "mcp__original__long_name"]]) };
  const out = run([baseChunk([{ functionCall: { name: "short_abc", args: {} } }])], state);
  const start = out.find((e) => e.type === "content_block_start");
  assert.equal(start.content_block.name, "mcp__original__long_name");
});

test("functionCall uses provided id when present", () => {
  const out = run([baseChunk([{ functionCall: { id: "fc_99", name: "f", args: {} } }])]);
  const start = out.find((e) => e.type === "content_block_start");
  assert.equal(start.content_block.id, "fc_99");
});

test("functionCall with no args defaults to empty object", () => {
  const out = run([baseChunk([{ functionCall: { name: "f" } }])]);
  const delta = out.find((e) => e.type === "content_block_delta");
  assert.equal(delta.delta.partial_json, "{}");
});

// ── finishReason mapping ──────────────────────────────────────────────────────

test("STOP finish reason maps to end_turn", () => {
  const out = run([baseChunk([], { finishReason: "STOP" })]);
  const delta = out.find((e) => e.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "end_turn");
  assert.equal(out.at(-1).type, "message_stop");
});

test("MAX_TOKENS finish reason maps to max_tokens", () => {
  const out = run([baseChunk([], { finishReason: "MAX_TOKENS" })]);
  assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "max_tokens");
});

test("length finish reason maps to max_tokens", () => {
  const out = run([baseChunk([], { finishReason: "length" })]);
  assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "max_tokens");
});

test("safety/recitation/blocklist map to end_turn", () => {
  for (const reason of ["safety", "recitation", "blocklist"]) {
    const out = run([baseChunk([], { finishReason: reason })]);
    assert.equal(
      out.find((e) => e.type === "message_delta").delta.stop_reason,
      "end_turn",
      `${reason} → end_turn`
    );
  }
});

test("tool_calls finish reason maps to tool_use", () => {
  const out = run([baseChunk([], { finishReason: "tool_calls" })]);
  assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
});

test("prior tool use makes STOP map to tool_use", () => {
  const state = {};
  run([baseChunk([{ functionCall: { name: "f", args: {} } }])], state);
  const out = run([baseChunk([], { finishReason: "STOP" })], state);
  assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
});

test("finish closes open text block before message_delta", () => {
  const state = {};
  run([baseChunk([{ text: "hi" }])], state);
  const out = run([baseChunk([], { finishReason: "STOP" })], state);
  assert.equal(out[0].type, "content_block_stop");
  assert.equal(out[0].index, 0);
});

// ── usage metadata ────────────────────────────────────────────────────────────

test("usageMetadata populates state.usage with input + output (candidates+thoughts)", () => {
  const state = {};
  run([
    {
      responseId: "r",
      modelVersion: "m",
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
    },
  ], state);
  assert.equal(state.usage.input_tokens, 10);
  assert.equal(state.usage.output_tokens, 6);
});

test("cachedContentTokenCount adds cache_read_input_tokens when > 0", () => {
  const state = {};
  run([
    {
      responseId: "r",
      modelVersion: "m",
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, cachedContentTokenCount: 3 },
    },
  ], state);
  assert.equal(state.usage.cache_read_input_tokens, 3);
});

test("usageMetadata at chunk level (not response level) is read", () => {
  const state = {};
  run([
    {
      responseId: "r",
      modelVersion: "m",
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    },
  ], state);
  assert.equal(state.usage.input_tokens, 7);
  assert.equal(state.usage.output_tokens, 2);
});

// ── Antigravity wrapper ───────────────────────────────────────────────────────

test("Antigravity {response:{...}} wrapper is unwrapped", () => {
  const out = run([
    { response: { responseId: "rw", modelVersion: "mw", candidates: [{ content: { parts: [{ text: "w" }] } }] } },
  ]);
  assert.equal(out[0].type, "message_start");
  assert.equal(out[0].message.id, "rw");
});
