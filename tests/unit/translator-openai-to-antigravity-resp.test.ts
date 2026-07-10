import test from "node:test";
import assert from "node:assert/strict";

const { openaiToAntigravityResponse } =
  await import("../../open-sse/translator/response/openai-to-antigravity.ts");

// ── Edge cases ────────────────────────────────────────────────────────────────

test("returns null for null/undefined chunk", () => {
  assert.equal(openaiToAntigravityResponse(null, {}), null);
  assert.equal(openaiToAntigravityResponse(undefined, {}), null);
});

test("returns null when no choices and no usage", () => {
  assert.equal(openaiToAntigravityResponse({ id: "x", model: "m" }, {}), null);
});

test("usage-only chunk (no choices) is stored in state and returns null", () => {
  const state = {};
  const out = openaiToAntigravityResponse(
    { id: "x", model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    state
  );
  assert.equal(out, null);
  assert.deepEqual(state._usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
});

// ── text content ──────────────────────────────────────────────────────────────

test("delta.content becomes a text part", () => {
  const out = openaiToAntigravityResponse(
    { id: "c1", model: "m", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
    {}
  );
  assert.deepEqual(out.response.candidates[0].content.parts, [{ text: "hello" }]);
  assert.equal(out.response.candidates[0].content.role, "model");
});

test("delta.reasoning_content becomes a thought part", () => {
  const out = openaiToAntigravityResponse(
    { id: "c1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "plan" }, finish_reason: null }] },
    {}
  );
  assert.deepEqual(out.response.candidates[0].content.parts, [{ thought: true, text: "plan" }]);
});

test("reasoning + text both become parts in order", () => {
  const out = openaiToAntigravityResponse(
    {
      id: "c1",
      model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "p", content: "a" }, finish_reason: null }],
    },
    {}
  );
  assert.deepEqual(out.response.candidates[0].content.parts, [
    { thought: true, text: "p" },
    { text: "a" },
  ]);
});

// ── state init ────────────────────────────────────────────────────────────────

test("state._responseId and _modelVersion initialized from chunk", () => {
  const state = {};
  openaiToAntigravityResponse(
    { id: "abc", model: "gpt-x", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
    state
  );
  assert.equal(state._responseId, "abc");
  assert.equal(state._modelVersion, "gpt-x");
});

test("state._responseId falls back to resp_<timestamp> when id missing", () => {
  const state = {};
  openaiToAntigravityResponse(
    { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
    state
  );
  assert.match(state._responseId, /^resp_\d+$/);
});

// ── tool call accumulation ────────────────────────────────────────────────────

test("tool call chunks accumulate silently (no emit until finish)", () => {
  const state = {};
  const first = openaiToAntigravityResponse(
    {
      id: "c2",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"a":' } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  assert.equal(first, null);
  assert.equal(state._toolCallAccum[0].id, "call_1");
  assert.equal(state._toolCallAccum[0].name, "read");
  assert.equal(state._toolCallAccum[0].arguments, '{"a":');
});

test("tool call name concatenates across chunks", () => {
  const state = {};
  openaiToAntigravityResponse(
    {
      id: "c3",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: "read_", arguments: "" } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  openaiToAntigravityResponse(
    {
      id: "c3",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "{}" } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  assert.equal(state._toolCallAccum[0].name, "read_file");
});

test("on finish, accumulated tool call emits as functionCall with parsed args", () => {
  const state = {};
  openaiToAntigravityResponse(
    {
      id: "c4",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  const out = openaiToAntigravityResponse(
    { id: "c4", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    state
  );
  assert.deepEqual(out.response.candidates[0].content.parts, [
    { functionCall: { name: "f", args: { x: 1 } } },
  ]);
});

test("invalid JSON args on finish → empty object args", () => {
  const state = {};
  openaiToAntigravityResponse(
    {
      id: "c5",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "not json" } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  const out = openaiToAntigravityResponse(
    { id: "c5", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    state
  );
  assert.deepEqual(out.response.candidates[0].content.parts[0].functionCall.args, {});
});

test("multiple tool calls (different indices) all emit on finish", () => {
  const state = {};
  openaiToAntigravityResponse(
    {
      id: "c6",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "a", function: { name: "f1", arguments: "{}" } },
              { index: 1, id: "b", function: { name: "f2", arguments: "{}" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    state
  );
  const out = openaiToAntigravityResponse(
    { id: "c6", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    state
  );
  const fcs = out.response.candidates[0].content.parts.filter((p) => p.functionCall);
  assert.equal(fcs.length, 2);
  assert.equal(fcs[0].functionCall.name, "f1");
  assert.equal(fcs[1].functionCall.name, "f2");
});

test("tool call without index defaults to 0", () => {
  const state = {};
  openaiToAntigravityResponse(
    {
      id: "c7",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }] },
          finish_reason: null,
        },
      ],
    },
    state
  );
  assert.ok(state._toolCallAccum[0]);
});

// ── finish reason mapping ─────────────────────────────────────────────────────

test("stop → STOP", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {}
  );
  assert.equal(out.response.candidates[0].finishReason, "STOP");
});

test("length → MAX_TOKENS", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    {}
  );
  assert.equal(out.response.candidates[0].finishReason, "MAX_TOKENS");
});

test("tool_calls → STOP", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    {}
  );
  assert.equal(out.response.candidates[0].finishReason, "STOP");
});

test("content_filter → SAFETY", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] },
    {}
  );
  assert.equal(out.response.candidates[0].finishReason, "SAFETY");
});

test("unknown finish reason → STOP (default)", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "weird" }] },
    {}
  );
  assert.equal(out.response.candidates[0].finishReason, "STOP");
});

test("finish with no content and no tool calls → empty text part", () => {
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {}
  );
  assert.deepEqual(out.response.candidates[0].content.parts, [{ text: "" }]);
});

// ── usage metadata ────────────────────────────────────────────────────────────

test("chunk.usage maps to usageMetadata with token counts", () => {
  const out = openaiToAntigravityResponse(
    {
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
    {}
  );
  assert.deepEqual(out.response.usageMetadata, {
    promptTokenCount: 5,
    candidatesTokenCount: 3,
    totalTokenCount: 8,
  });
});

test("reasoning_tokens → thoughtsTokenCount", () => {
  const out = openaiToAntigravityResponse(
    {
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        completion_tokens_details: { reasoning_tokens: 9 },
      },
    },
    {}
  );
  assert.equal(out.response.usageMetadata.thoughtsTokenCount, 9);
});

test("cached_tokens → cachedContentTokenCount", () => {
  const out = openaiToAntigravityResponse(
    {
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    },
    {}
  );
  assert.equal(out.response.usageMetadata.cachedContentTokenCount, 4);
});

test("stored state._usage is used on finish when chunk has no usage", () => {
  const state = {};
  openaiToAntigravityResponse(
    { id: "c", model: "m", usage: { prompt_tokens: 7, completion_tokens: 6, total_tokens: 13 } },
    state
  );
  const out = openaiToAntigravityResponse(
    { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    state
  );
  assert.equal(out.response.usageMetadata.promptTokenCount, 7);
  assert.equal(out.response.usageMetadata.totalTokenCount, 13);
});

// ── empty non-finish chunk ────────────────────────────────────────────────────

test("delta with no content/reasoning/tool_calls and no finish → null", () => {
  assert.equal(
    openaiToAntigravityResponse(
      { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: null }] },
      {}
    ),
    null
  );
});
