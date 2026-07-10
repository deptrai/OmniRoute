import test from "node:test";
import assert from "node:assert/strict";

const { openaiToOpenAIResponsesResponse, openaiResponsesToOpenAIResponse, normalizeUpstreamFailure } =
  await import("../../open-sse/translator/response/openai-responses.ts");

function makeResponsesState() {
  return {
    seq: 0, created: 1700000000, responseId: "resp_test123", started: false,
    msgItemAdded: {}, msgContentAdded: {}, msgTextBuf: {}, msgItemDone: {},
    funcCallIds: {}, funcNames: {}, funcArgsBuf: {}, funcArgsDone: {}, funcItemDone: {},
    completedSent: false, completedOutputItems: [],
    reasoningId: null, reasoningIndex: null, reasoningDone: false, reasoningBuf: "",
    reasoningPartAdded: false, usage: null, parseTextualReasoningTags: false,
  };
}

function makeChatState() {
  return {
    started: false, chatId: null, created: null, model: null,
    toolCallIndex: 0, currentToolCallId: null, currentToolCallArgsBuffer: "",
    currentToolCallDeferred: false, finishReasonSent: false, usage: null,
    roleEmitted: false, finishReason: null,
  };
}

const types = (events: any[]) => events.map((e) => e.event);

// ===== Chat -> Responses (openaiToOpenAIResponsesResponse) =====

test("Chat -> Responses emits response.created + in_progress on first chunk", () => {
  const state = makeResponsesState();
  const events = openaiToOpenAIResponsesResponse(
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: "Hello" } }] }, state
  ) as any[];

  assert.ok(types(events).includes("response.created"));
  assert.ok(types(events).includes("response.in_progress"));
  const created = events.find((e) => e.event === "response.created");
  assert.equal(created.data.response.id, "resp_chatcmpl_1");
  assert.equal(created.data.response.status, "in_progress");
});

test("Chat -> Responses streams text as output_text.delta with output_item/content_part added", () => {
  const state = makeResponsesState();
  const events = openaiToOpenAIResponsesResponse(
    { id: "c1", choices: [{ index: 0, delta: { content: "text" } }] }, state
  ) as any[];

  assert.ok(events.find((e) => e.event === "response.output_item.added")?.data.item.type === "message");
  assert.ok(events.find((e) => e.event === "response.content_part.added"));
  assert.ok(events.find((e) => e.event === "response.output_text.delta")?.data.delta === "text");
});

test("Chat -> Responses streams tool call arguments as function_call_arguments.delta", () => {
  const state = makeResponsesState();
  openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }],
  } }] }, state);

  const events = openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }],
  } }] }, state) as any[];

  const argDelta = events.find((e) => e.event === "response.function_call_arguments.delta");
  assert.ok(argDelta);
  assert.equal(argDelta.data.delta, '{"city":"SF"}');
  assert.equal(argDelta.data.item_id, "fc_call_1");
});

test("Chat -> Responses accumulates tool call arguments across multiple deltas", () => {
  const state = makeResponsesState();
  openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "search", arguments: "" } }],
  } }] }, state);

  for (const frag of ['{"q":', '"hello', '"}']) {
    openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: {
      tool_calls: [{ index: 0, function: { arguments: frag } }],
    } }] }, state);
  }

  const finalEvents = openaiToOpenAIResponsesResponse(
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, state
  ) as any[];

  const argsDone = finalEvents.find((e) => e.event === "response.function_call_arguments.done");
  assert.ok(argsDone);
  assert.equal(argsDone.data.arguments, '{"q":"hello"}');
});

test("Chat -> Responses emits response.completed with dense output on finish_reason", () => {
  const state = makeResponsesState();
  openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: { content: "Done" } }] }, state);
  const events = openaiToOpenAIResponsesResponse(
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, state
  ) as any[];

  const completed = events.find((e) => e.event === "response.completed");
  assert.ok(completed);
  assert.equal(completed.data.response.status, "completed");
  assert.equal(completed.data.response.output.length, 1);
  assert.equal(completed.data.response.output[0].content[0].text, "Done");
});

test("Chat -> Responses handles reasoning_content as reasoning output_item + summary delta", () => {
  const state = makeResponsesState();
  const events = openaiToOpenAIResponsesResponse(
    { id: "c1", choices: [{ index: 0, delta: { reasoning_content: "Thinking..." } }] }, state
  ) as any[];

  assert.equal(events.find((e) => e.event === "response.output_item.added")?.data.item.type, "reasoning");
  assert.equal(events.find((e) => e.event === "response.reasoning_summary_text.delta")?.data.delta, "Thinking...");
});

test("Chat -> Responses normalizes usage from Chat format to Responses format", () => {
  const state = makeResponsesState();
  openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: { content: "hi" } }] }, state);
  const events = openaiToOpenAIResponsesResponse({
    id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
  }, state) as any[];

  const usage = events.find((e) => e.event === "response.completed").data.response.usage;
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.input_tokens_details.cached_tokens, 3);
  assert.equal(usage.output_tokens_details.reasoning_tokens, 2);
});

test("Chat -> Responses returns [] for chunk with no choices and flushes on null", () => {
  const state = makeResponsesState();
  assert.deepEqual(openaiToOpenAIResponsesResponse({ id: "c1", choices: [] }, state), []);

  // Flush test
  const s2 = makeResponsesState();
  openaiToOpenAIResponsesResponse({ id: "c1", choices: [{ index: 0, delta: { content: "partial" } }] }, s2);
  const flushEvents = openaiToOpenAIResponsesResponse(null, s2) as any[];
  assert.ok(types(flushEvents).includes("response.completed"));
});

test("Chat -> Responses assigns strictly increasing sequence_numbers", () => {
  const state = makeResponsesState();
  const events = openaiToOpenAIResponsesResponse(
    { id: "c1", choices: [{ index: 0, delta: { content: "Hi" } }] }, state
  ) as any[];
  const seqs = events.map((e) => e.data.sequence_number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
});

// ===== Responses -> Chat (openaiResponsesToOpenAIResponse) =====

test("Responses -> Chat maps output_text.delta to content and injects assistant role on first chunk", () => {
  const state = makeChatState();
  const c1 = openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "Hi" }, state) as any;
  assert.equal(c1.choices[0].delta.content, "Hi");
  assert.equal(c1.choices[0].delta.role, "assistant");

  const c2 = openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: " there" }, state) as any;
  assert.equal(c2.choices[0].delta.role, undefined, "role must not be re-injected");
});

test("Responses -> Chat maps function_call output_item.added + arguments.delta to tool_calls", () => {
  const state = makeChatState();
  const c1 = openaiResponsesToOpenAIResponse({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "fc_1", name: "get_weather", arguments: "" },
  }, state) as any;
  assert.equal(c1.choices[0].delta.tool_calls[0].id, "fc_1");
  assert.equal(c1.choices[0].delta.tool_calls[0].function.name, "get_weather");

  const c2 = openaiResponsesToOpenAIResponse({
    type: "response.function_call_arguments.delta", delta: '{"city":"SF"}',
  }, state) as any;
  const tc = c2.choices[0].delta.tool_calls[0];
  assert.equal(tc.function.arguments, '{"city":"SF"}');
  assert.equal(tc.id, undefined, "delta chunks must not include id/type");
  assert.equal(tc.type, undefined);
});

test("Responses -> Chat accumulates tool call arguments across multiple deltas", () => {
  const state = makeChatState();
  openaiResponsesToOpenAIResponse({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "fc_1", name: "search", arguments: "" },
  }, state);

  for (const frag of ['{"q":', '"test', '"}']) {
    openaiResponsesToOpenAIResponse({ type: "response.function_call_arguments.delta", delta: frag }, state);
  }
  assert.equal(state.currentToolCallArgsBuffer, '{"q":"test"}');
});

test("Responses -> Chat maps response.completed to finish_reason stop/tool_calls with usage", () => {
  const baseState = () => {
    const s = makeChatState();
    s.started = true; s.chatId = "chatcmpl_1"; s.created = 1700000000; s.model = "gpt-4o";
    return s;
  };

  const s1 = baseState();
  const c1 = openaiResponsesToOpenAIResponse({
    type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } },
  }, s1) as any;
  assert.equal(c1.choices[0].finish_reason, "stop");
  assert.equal(c1.usage.prompt_tokens, 10);

  const s2 = baseState();
  s2.toolCallIndex = 1;
  const c2 = openaiResponsesToOpenAIResponse({ type: "response.completed", response: {} }, s2) as any;
  assert.equal(c2.choices[0].finish_reason, "tool_calls");
});

test("Responses -> Chat maps reasoning_summary_text.delta to reasoning_content", () => {
  const state = makeChatState();
  state.started = true; state.chatId = "c1"; state.created = 1700000000; state.model = "gpt-4o";
  const chunk = openaiResponsesToOpenAIResponse({
    type: "response.reasoning_summary_text.delta", delta: "Thinking hard",
  }, state) as any;
  assert.equal(chunk.choices[0].delta.reasoning_content, "Thinking hard");
});

test("Responses -> Chat flush (null) emits final chunk with finish_reason, empty delta returns null", () => {
  const state = makeChatState();
  state.started = true; state.chatId = "c1"; state.created = 1700000000; state.model = "gpt-4o";
  const flushChunk = openaiResponsesToOpenAIResponse(null, state) as any;
  assert.ok(flushChunk);
  assert.equal(flushChunk.choices[0].finish_reason, "stop");

  const emptyChunk = openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "" }, makeChatState());
  assert.equal(emptyChunk, null);
});

// ===== normalizeUpstreamFailure =====

test("normalizeUpstreamFailure maps rate_limit/context_length/unknown errors correctly", () => {
  const rateLimit = normalizeUpstreamFailure({ error: { code: "rate_limit_exceeded", message: "Slow" } });
  assert.equal(rateLimit.status, 429);
  assert.equal(rateLimit.type, "rate_limit_error");

  const ctxOverflow = normalizeUpstreamFailure({ error: { code: "context_length_exceeded", message: "Too long" } });
  assert.equal(ctxOverflow.status, 400);
  assert.equal(ctxOverflow.type, "invalid_request_error");

  const unknown = normalizeUpstreamFailure({ error: { code: "internal_error", message: "Broke" } });
  assert.equal(unknown.status, 502);
  assert.equal(unknown.type, "server_error");
  assert.equal(unknown.code, "internal_error");
});

test("normalizeUpstreamFailure uses fallback message and extracts nested response.error", () => {
  const fallback = normalizeUpstreamFailure({ foo: "bar" });
  assert.equal(fallback.status, 502);
  assert.equal(fallback.message, "Upstream failure");

  const nested = normalizeUpstreamFailure({
    response: { error: { code: "rate_limited", message: "Slow down" } },
  });
  assert.equal(nested.status, 429);
  assert.equal(nested.message, "Slow down");
});
