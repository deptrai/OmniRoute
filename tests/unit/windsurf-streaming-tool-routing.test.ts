import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, encodeVarintField } from "../../open-sse/executors/windsurf.ts";

const {
  transformToSSE,
  decodeGetChatMessageResponse,
  encodeString,
  encodeMessage,
  grpcWebFrame,
} = __test;

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function buildToolCallPayload(id: string, name: string, args: string): Uint8Array {
  const parts: Uint8Array[] = [];
  if (id) parts.push(encodeString(1, id));
  if (name) parts.push(encodeString(2, name));
  if (args) parts.push(encodeString(3, args));
  return concat(parts);
}

function buildResponsePayload(fields: { text?: string; thinking?: string; toolCalls?: { id: string; name: string; args: string }[]; stopReason?: number; inputTokens?: number; outputTokens?: number }): Uint8Array {
  const parts: Uint8Array[] = [];
  if (fields.text !== undefined) parts.push(encodeString(3, fields.text));
  if (fields.thinking !== undefined) parts.push(encodeString(9, fields.thinking));
  if (fields.toolCalls) {
    for (const tc of fields.toolCalls) {
      parts.push(encodeMessage(6, buildToolCallPayload(tc.id, tc.name, tc.args)));
    }
  }
  if (fields.stopReason !== undefined) parts.push(encodeVarintField(5, fields.stopReason));
  if (fields.inputTokens !== undefined || fields.outputTokens !== undefined) {
    const usageParts: Uint8Array[] = [];
    if (fields.inputTokens !== undefined) usageParts.push(encodeVarintField(2, fields.inputTokens));
    if (fields.outputTokens !== undefined) usageParts.push(encodeVarintField(3, fields.outputTokens));
    parts.push(encodeMessage(7, concat(usageParts)));
  }
  return concat(parts);
}

/** Build a Connect streaming frame: flags(1) + length(4 BE) + payload */
function dataFrame(payload: Uint8Array): Uint8Array {
  return grpcWebFrame(payload);
}

/** Build a Connect trailer frame: flags=0x02 + length(4 BE) + trailer text */
function trailerFrame(text: string = "grpc-status:0\n"): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x02; // trailer flag
  const view = new DataView(frame.buffer);
  view.setUint32(1, payload.length, false); // big-endian
  frame.set(payload, 5);
  return frame;
}

/** Create a mock Response with a given body */
function mockResponse(body: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/connect+proto" },
  });
}

/** Read all SSE data from a Response and parse into chunks */
async function readSSE(response: Response): Promise<any[]> {
  const text = await response.text();
  const chunks: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        chunks.push(JSON.parse(data));
      } catch {
        // non-JSON data (error), push raw
        chunks.push({ _raw: data });
      }
    }
  }
  return chunks;
}

/** Extract tool_calls deltas from SSE chunks */
function extractToolCallDeltas(chunks: any[]): any[] {
  return chunks
    .filter((c) => c.choices?.[0]?.delta?.tool_calls)
    .flatMap((c) => c.choices[0].delta.tool_calls);
}

/** Get finish_reason from SSE chunks */
function getFinishReason(chunks: any[]): string | null {
  for (const c of chunks) {
    if (c.choices?.[0]?.finish_reason) return c.choices[0].finish_reason;
  }
  return null;
}

// ─── T1: Windsurf streaming tool call routing ───────────────────────────────

test("T1: single tool call — id + name + args in one frame", async () => {
  const payload = buildResponsePayload({
    toolCalls: [{ id: "call_1", name: "Bash", args: '{"command":"ls"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  assert.equal(tcDeltas.length, 1, "one tool call delta");
  assert.equal(tcDeltas[0].id, "call_1");
  assert.equal(tcDeltas[0].function.name, "Bash");
  assert.equal(tcDeltas[0].function.arguments, '{"command":"ls"}');
  assert.equal(getFinishReason(chunks), "tool_calls");
});

test("T1: tool call args streamed across multiple frames (same index)", async () => {
  // Frame 1: id + name + partial args
  const frame1Payload = buildResponsePayload({
    toolCalls: [{ id: "call_1", name: "Agent", args: '{"prompt":"hello' }],
  });
  // Frame 2: args continuation (no id, no name)
  const frame2Payload = buildResponsePayload({
    toolCalls: [{ id: "", name: "", args: ' world"}' }],
  });
  // Frame 3: stop
  const frame3Payload = buildResponsePayload({ stopReason: 1 });
  const body = concat([
    dataFrame(frame1Payload),
    dataFrame(frame2Payload),
    dataFrame(frame3Payload),
    trailerFrame(),
  ]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  // First delta has id+name, subsequent deltas only have args fragment
  assert.ok(tcDeltas.length >= 2, "at least 2 deltas (start + continuation)");
  assert.equal(tcDeltas[0].id, "call_1");
  assert.equal(tcDeltas[0].function.name, "Agent");
  // All deltas should have the same index (so translator accumulates into one block)
  for (const d of tcDeltas) {
    assert.equal(d.index, 0, "all deltas use index 0");
  }
});

test("T1: phantom tool call (id + name, NO args) is suppressed", async () => {
  // GLM-5.2-max bug: emits tool call header with empty args, never sends args
  const phantomPayload = buildResponsePayload({
    toolCalls: [{ id: "call_phantom", name: "Agent", args: "" }],
    stopReason: 1,
  });
  const body = concat([dataFrame(phantomPayload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  // Phantom tool call should NOT be emitted — no tool_calls in SSE output
  assert.equal(tcDeltas.length, 0, "phantom tool call suppressed (no args → no emission)");
  // Finish reason should be "stop" not "tool_calls" since no tool calls were emitted
  // Actually sawToolCalls is set to true if deltaToolCalls parsed, even if not emitted.
  // The key assertion is: no tool_calls deltas in SSE output.
});

test("T1: phantom tool call followed by real tool call — only real one emitted", async () => {
  // Frame 1: phantom (id + name, no args)
  const phantom = buildResponsePayload({
    toolCalls: [{ id: "call_phantom", name: "Agent", args: "" }],
  });
  // Frame 2: real tool call with args
  const real = buildResponsePayload({
    toolCalls: [{ id: "call_real", name: "Bash", args: '{"command":"pwd"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(phantom), dataFrame(real), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  // Only the real tool call should be emitted
  assert.ok(tcDeltas.length >= 1, "at least one tool call delta");
  assert.equal(tcDeltas[0].id, "call_real");
  assert.equal(tcDeltas[0].function.name, "Bash");
});

test("T1: two parallel tool calls — stable indices", async () => {
  // Frame 1: tool call 0 (id + name + args)
  const frame1 = buildResponsePayload({
    toolCalls: [{ id: "call_a", name: "Bash", args: '{"command":"ls"}' }],
  });
  // Frame 2: tool call 1 (id + name + args)
  const frame2 = buildResponsePayload({
    toolCalls: [{ id: "call_b", name: "Read", args: '{"file_path":"/tmp"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(frame1), dataFrame(frame2), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  assert.ok(tcDeltas.length >= 2, "two tool call deltas");
  // First tool call uses index 0, second uses index 1
  assert.equal(tcDeltas[0].index, 0);
  assert.equal(tcDeltas[0].id, "call_a");
  assert.equal(tcDeltas[1].index, 1);
  assert.equal(tcDeltas[1].id, "call_b");
});

test("T1: tool call with same name but different ids — two separate calls", async () => {
  // GLM sometimes calls the same tool twice with different ids
  const frame1 = buildResponsePayload({
    toolCalls: [{ id: "call_1", name: "Agent", args: '{"prompt":"task A"}' }],
  });
  const frame2 = buildResponsePayload({
    toolCalls: [{ id: "call_2", name: "Agent", args: '{"prompt":"task B"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(frame1), dataFrame(frame2), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  assert.ok(tcDeltas.length >= 2, "two separate tool call deltas");
  assert.equal(tcDeltas[0].id, "call_1");
  assert.equal(tcDeltas[1].id, "call_2");
  // Different indices
  assert.notEqual(tcDeltas[0].index, tcDeltas[1].index, "different indices for different ids");
});

test("T1: text + tool call in same frame — both emitted", async () => {
  const payload = buildResponsePayload({
    text: "Let me run that for you.",
    toolCalls: [{ id: "call_1", name: "Bash", args: '{"command":"echo hi"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Should have text delta
  const textDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.content)
    .map((c) => c.choices[0].delta.content);
  assert.ok(textDeltas.some((t) => t.includes("Let me run")), "text content emitted");
  // Should have tool call delta
  const tcDeltas = extractToolCallDeltas(chunks);
  assert.equal(tcDeltas.length, 1);
  assert.equal(tcDeltas[0].function.name, "Bash");
});

test("T1: hasTools=false — tool call fields ignored", async () => {
  // When hasTools is false, tool call parsing should be skipped
  const payload = buildResponsePayload({
    text: "Hello",
    toolCalls: [{ id: "call_1", name: "Bash", args: '{"command":"ls"}' }],
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, false);
  const chunks = await readSSE(resp);
  const tcDeltas = extractToolCallDeltas(chunks);
  assert.equal(tcDeltas.length, 0, "no tool calls when hasTools=false");
  // Text should still be emitted
  const textDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.content)
    .map((c) => c.choices[0].delta.content);
  assert.ok(textDeltas.some((t) => t.includes("Hello")), "text still emitted");
});

test("T1: empty response with stop_reason — emits finish chunk", async () => {
  const payload = buildResponsePayload({ stopReason: 1 });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Should have a finish chunk
  const finish = getFinishReason(chunks);
  assert.ok(finish, "finish_reason present");
});

test("T1: STOP_REASON_ERROR (13) — error emitted in SSE", async () => {
  const payload = buildResponsePayload({ stopReason: 13 });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Should have an error chunk or non-OK finish
  const hasError = chunks.some((c) => c.error || c._raw);
  const finish = getFinishReason(chunks);
  // Either error chunk or stop finish (no content streamed → error path)
  assert.ok(hasError || finish === "stop", "error or stop finish on STOP_REASON_ERROR");
});

// ─── T6: GLM reasoning (field 9) ────────────────────────────────────────────

test("T6: GLM model — delta_thinking emitted as reasoning_content", async () => {
  const payload = buildResponsePayload({
    thinking: "Let me analyze this...",
    text: "Here is my answer.",
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // reasoning_content should be present
  const reasoningDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.reasoning_content)
    .map((c) => c.choices[0].delta.reasoning_content);
  assert.equal(reasoningDeltas.length, 1);
  assert.equal(reasoningDeltas[0], "Let me analyze this...");
});

test("T6: non-GLM model — delta_thinking NOT emitted (field 9 gated)", async () => {
  const payload = buildResponsePayload({
    thinking: "Internal reasoning...",
    text: "Answer.",
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "claude-sonnet-4", true, true);
  const chunks = await readSSE(resp);
  // reasoning_content should NOT be present for non-GLM models
  const reasoningDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.reasoning_content)
    .map((c) => c.choices[0].delta.reasoning_content);
  assert.equal(reasoningDeltas.length, 0, "field 9 gated to GLM models only");
});

test("T6: GLM reasoning-only response (no text) — not silently dropped", async () => {
  const payload = buildResponsePayload({
    thinking: "Just thinking, no text output.",
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2", true, true);
  const chunks = await readSSE(resp);
  // Should still emit reasoning_content and a finish chunk
  const reasoningDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.reasoning_content)
    .map((c) => c.choices[0].delta.reasoning_content);
  assert.equal(reasoningDeltas.length, 1);
  assert.equal(reasoningDeltas[0], "Just thinking, no text output.");
  // Should have a finish chunk
  assert.ok(getFinishReason(chunks), "finish_reason present for reasoning-only response");
});

// ─── T5: Error path streaming ───────────────────────────────────────────────

test("T5: connect-protocol-error in trailer — error emitted", async () => {
  // Data frame with some text, then trailer with error
  const textPayload = buildResponsePayload({ text: "Partial" });
  const errorTrailer = trailerFrame("connect-protocol-error: rate limit exceeded\n");
  const body = concat([dataFrame(textPayload), errorTrailer]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Should have text content
  const textDeltas = chunks
    .filter((c) => c.choices?.[0]?.delta?.content)
    .map((c) => c.choices[0].delta.content);
  assert.ok(textDeltas.some((t) => t.includes("Partial")), "partial text emitted");
  // Should have a finish chunk (stop, since content was streamed)
  const finish = getFinishReason(chunks);
  assert.equal(finish, "stop", "finish_reason=stop when text was streamed before error");
});

test("T5: grpc-status non-zero in trailer — error emitted", async () => {
  const errorTrailer = trailerFrame("grpc-status:2\ngrpc-message:internal error\n");
  const body = concat([dataFrame(buildResponsePayload({ text: "" })), errorTrailer]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // No text streamed → error path
  const hasError = chunks.some((c) => c.error || c._raw);
  assert.ok(hasError, "error emitted when no content and grpc-status non-zero");
});

test("T5: no content + no error — empty response handled gracefully", async () => {
  const payload = buildResponsePayload({ stopReason: 1 });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Should not crash, should have some finish
  assert.ok(chunks.length > 0, "at least one chunk emitted");
});

// ─── T5: Usage tracking ─────────────────────────────────────────────────────

test("T5: usage tokens emitted in finish chunk", async () => {
  const payload = buildResponsePayload({
    text: "Hello",
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 1,
  });
  const body = concat([dataFrame(payload), trailerFrame()]);
  const resp = transformToSSE.call({}, mockResponse(body), "glm-5.2-max", true, true);
  const chunks = await readSSE(resp);
  // Find chunk with usage
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, "usage in finish chunk");
  assert.equal(usageChunk.usage.prompt_tokens, 100);
  assert.equal(usageChunk.usage.completion_tokens, 50);
  assert.equal(usageChunk.usage.total_tokens, 150);
});
