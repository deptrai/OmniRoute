import test from "node:test";
import assert from "node:assert/strict";

const { convertKiroToOpenAI } =
  await import("../../open-sse/translator/response/kiro-to-openai.ts");

// ── Edge cases ────────────────────────────────────────────────────────────────

test("returns null for null/undefined chunk", () => {
  assert.equal(convertKiroToOpenAI(null, {}), null);
  assert.equal(convertKiroToOpenAI(undefined, {}), null);
});

test("already-OpenAI chunk passes through unchanged", () => {
  const chunk = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
  };
  assert.equal(convertKiroToOpenAI(chunk, {}), chunk);
});

test("string chunk with no data returns null", () => {
  assert.equal(convertKiroToOpenAI("event:foo\n\n", {}), null);
  assert.equal(convertKiroToOpenAI("", {}), null);
});

test("non-JSON string data is stored in data.text but content lookup returns null (no content field)", () => {
  // 'plain text' is not valid JSON → {text: "plain text", _eventType: "assistantResponseEvent"}
  // content = data.assistantResponseEvent?.content || data.content || "" → "" → returns null
  assert.equal(convertKiroToOpenAI("event:assistantResponseEvent\ndata:plain text\n\n", {}), null);
});

// ── :event-type header parsing ────────────────────────────────────────────────

test(":event-type header is parsed as event type", () => {
  const out = convertKiroToOpenAI(":event-type: assistantResponseEvent\ndata:{\"content\":\"hi\"}\n\n", {});
  assert.equal(out.choices[0].delta.content, "hi");
});

// ── assistantResponseEvent ────────────────────────────────────────────────────

test("first chunk includes role:assistant, subsequent omits it", () => {
  const state = {};
  const first = convertKiroToOpenAI(
    'event:assistantResponseEvent\ndata:{"content":"A"}\n\n',
    state
  );
  const second = convertKiroToOpenAI(
    'event:assistantResponseEvent\ndata:{"content":"B"}\n\n',
    state
  );
  assert.equal(first.choices[0].delta.role, "assistant");
  assert.equal(first.choices[0].delta.content, "A");
  assert.equal(second.choices[0].delta.role, undefined);
  assert.equal(second.choices[0].delta.content, "B");
  assert.equal(first.id, second.id);
  assert.equal(first.object, "chat.completion.chunk");
});

test("assistantResponseEvent with empty content returns null", () => {
  assert.equal(
    convertKiroToOpenAI('event:assistantResponseEvent\ndata:{"content":""}\n\n', {}),
    null
  );
});

test("object chunk with assistantResponseEvent field works", () => {
  const out = convertKiroToOpenAI({ assistantResponseEvent: { content: "obj" } }, {});
  assert.equal(out.choices[0].delta.content, "obj");
});

// ── reasoningContentEvent ─────────────────────────────────────────────────────

test("reasoningContentEvent emits reasoning_content delta", () => {
  const out = convertKiroToOpenAI(
    'event:reasoningContentEvent\ndata:{"content":"think"}\n\n',
    {}
  );
  assert.equal(out.choices[0].delta.reasoning_content, "think");
  assert.equal(out.choices[0].delta.content, undefined);
});

test("reasoningContentEvent with empty content returns null", () => {
  assert.equal(
    convertKiroToOpenAI('event:reasoningContentEvent\ndata:{"content":""}\n\n', {}),
    null
  );
});

// ── toolUseEvent ──────────────────────────────────────────────────────────────

test("toolUseEvent emits tool_calls with id, name, and stringified args", () => {
  const out = convertKiroToOpenAI(
    { _eventType: "toolUseEvent", toolUseId: "tu_1", name: "read", input: { path: "/x" } },
    {}
  );
  const tc = out.choices[0].delta.tool_calls[0];
  assert.equal(tc.id, "tu_1");
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "read");
  assert.equal(tc.function.arguments, JSON.stringify({ path: "/x" }));
});

test("toolUseEvent without id uses fallbackToolCallId", () => {
  const out = convertKiroToOpenAI(
    { _eventType: "toolUseEvent", name: "write", input: {} },
    {}
  );
  assert.match(out.choices[0].delta.tool_calls[0].id, /^call_\d+$/);
});

test("toolUseEvent without input defaults to empty object args", () => {
  const out = convertKiroToOpenAI(
    { _eventType: "toolUseEvent", toolUseId: "tu_2", name: "f" },
    {}
  );
  assert.equal(out.choices[0].delta.tool_calls[0].function.arguments, "{}");
});

test("toolUseEvent restores original name via state.toolNameMap", () => {
  const state = { toolNameMap: new Map([["trunc_a", "original_long_name"]]) };
  const out = convertKiroToOpenAI(
    { _eventType: "toolUseEvent", toolUseId: "tu_3", name: "trunc_a", input: {} },
    state
  );
  assert.equal(out.choices[0].delta.tool_calls[0].function.name, "original_long_name");
});

test("toolUseEvent sets state.sawToolUse = true", () => {
  const state = {};
  convertKiroToOpenAI(
    { _eventType: "toolUseEvent", toolUseId: "tu_4", name: "f", input: {} },
    state
  );
  assert.equal(state.sawToolUse, true);
});

// ── messageStopEvent / done ───────────────────────────────────────────────────

test("done event with no prior tool use → finish_reason stop", () => {
  const out = convertKiroToOpenAI("event:done\ndata:{}\n\n", {});
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.deepEqual(out.choices[0].delta, {});
});

test("messageStopEvent after tool use → finish_reason tool_calls", () => {
  const state = {};
  convertKiroToOpenAI(
    { _eventType: "toolUseEvent", toolUseId: "tu", name: "f", input: {} },
    state
  );
  const out = convertKiroToOpenAI(
    'event:messageStopEvent\ndata:{}\n\n',
    state
  );
  assert.equal(out.choices[0].finish_reason, "tool_calls");
});

test("done event includes usage from state when available", () => {
  const state = { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
  const out = convertKiroToOpenAI("event:done\ndata:{}\n\n", state);
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test("done event without usage has no usage field", () => {
  const out = convertKiroToOpenAI("event:done\ndata:{}\n\n", {});
  assert.equal(out.usage, undefined);
});

// ── usageEvent ────────────────────────────────────────────────────────────────

test("usageEvent stores usage in state and returns null", () => {
  const state = {};
  const out = convertKiroToOpenAI(
    'event:usageEvent\ndata:{"inputTokens":10,"outputTokens":20}\n\n',
    state
  );
  assert.equal(out, null);
  assert.equal(state.usage.prompt_tokens, 10);
  assert.equal(state.usage.completion_tokens, 20);
  assert.equal(state.usage.total_tokens, 30);
});

test("usageEvent with zero tokens", () => {
  const state = {};
  convertKiroToOpenAI('event:usageEvent\ndata:{"inputTokens":0,"outputTokens":0}\n\n', state);
  assert.equal(state.usage.total_tokens, 0);
});

// ── unknown events ────────────────────────────────────────────────────────────

test("unknown event type returns null", () => {
  assert.equal(convertKiroToOpenAI('event:unknown\ndata:{}\n\n', {}), null);
});

test("object chunk with no recognized event returns null", () => {
  assert.equal(convertKiroToOpenAI({ foo: "bar" }, {}), null);
});

// ── state initialization ──────────────────────────────────────────────────────

test("state.responseId and created are set on first event", () => {
  const state = {};
  convertKiroToOpenAI('event:assistantResponseEvent\ndata:{"content":"x"}\n\n', state);
  assert.match(state.responseId, /^chatcmpl-\d+$/);
  assert.equal(typeof state.created, "number");
  assert.equal(state.chunkIndex, 1);
});

test("state.model is used in output when set", () => {
  const state = { model: "kiro-claude" };
  const out = convertKiroToOpenAI('event:assistantResponseEvent\ndata:{"content":"x"}\n\n', state);
  assert.equal(out.model, "kiro-claude");
});
