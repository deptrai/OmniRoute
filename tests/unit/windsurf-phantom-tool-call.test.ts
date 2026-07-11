// Tests that phantom tool call headers (id + name, no args) are flushed
// at stream end so finish_reason matches actual emitted content.
//
// Bug: GLM-5.2 sometimes emits a delta_tool_calls frame with id + name
// but empty argumentsJson, then never sends an arguments frame. The
// deferral logic buffered it (never emitting), but sawToolCalls was
// already true → finish_reason="tool_calls" with no tool_use block →
// Claude Code "tool call could not be parsed".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WindsurfExecutor, __test } from "../../open-sse/executors/windsurf.ts";

/** Build a Connect data frame (flags=0, BE length, payload). */
function dataFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x00;
  const view = new DataView(frame.buffer);
  view.setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

/** Build a Connect trailer frame (flags=0x02). */
function trailerFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x02;
  const view = new DataView(frame.buffer);
  view.setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

const { encodeString, encodeVarintField, encodeField } = __test;

/** Simpler: manually build protobuf response bytes. */
function buildProtoResponse(opts: {
  thinking?: string;
  toolCall?: { id: string; name: string; args: string };
  stopReason?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.thinking) {
    parts.push(encodeString(9, opts.thinking));
  }
  if (opts.toolCall) {
    const tc = opts.toolCall;
    const tcParts: Uint8Array[] = [];
    if (tc.id) tcParts.push(encodeString(1, tc.id));
    if (tc.name) tcParts.push(encodeString(2, tc.name));
    if (tc.args) tcParts.push(encodeString(3, tc.args));
    // field 6 = delta_tool_calls (repeated ChatToolCall)
    const tcMsg = concat(tcParts);
    parts.push(encodeField(6, tcMsg));
  }
  if (opts.stopReason !== undefined) {
    parts.push(encodeVarintField(5, opts.stopReason));
  }
  return concat(parts);
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Read SSE events from a Response stream. */
async function readSSE(response: Response): Promise<string[]> {
  const events: string[] = [];
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) events.push(line.slice(6));
    }
  }
  return events;
}

function parseSSE(events: string[]): any[] {
  return events.map((e) => (e === "[DONE]" ? "[DONE]" : JSON.parse(e)));
}

describe("Windsurf phantom tool call header", () => {
  it("flushes buffered tool call with empty args when name present but no args arrive", async () => {
    // Frame 1: thinking content
    // Frame 2: delta_tool_calls with id + name, NO args (phantom header)
    // Frame 3: stop_reason=10 (FUNCTION_CALL), no tool calls
    const frame1 = dataFrame(buildProtoResponse({ thinking: "I'll call read_file." }));
    const frame2 = dataFrame(
      buildProtoResponse({ toolCall: { id: "call-123", name: "read_file", args: "" } })
    );
    const frame3 = dataFrame(buildProtoResponse({ stopReason: 10 }));
    const body = concat([frame1, frame2, frame3, trailerFrame("grpc-status: 0\n")]);

    const upstream = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/connect+proto" },
    });

    const executor = new WindsurfExecutor();
    const sseResponse = (executor as any).transformToSSE(upstream, "glm-5.2", true, true);
    const events = parseSSE(await readSSE(sseResponse));

    // Should have a tool_calls chunk with name="read_file" and arguments="{}"
    const toolCallChunks = events.filter(
      (e) => e !== "[DONE]" && e.choices?.[0]?.delta?.tool_calls
    );
    assert.ok(toolCallChunks.length > 0, "Should emit at least one tool_calls chunk");

    const lastToolChunk = toolCallChunks[toolCallChunks.length - 1];
    const tc = lastToolChunk.choices[0].delta.tool_calls[0];
    assert.equal(tc.function.name, "read_file");
    assert.equal(tc.function.arguments, "{}");

    // finish_reason should be "tool_calls" since we emitted a tool call
    const finishChunk = events.find((e) => e !== "[DONE]" && e.choices?.[0]?.finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, "tool_calls");
  });

  it("uses finish_reason=stop when no tool calls are seen at all", async () => {
    const frame1 = dataFrame(buildProtoResponse({ thinking: "Just thinking." }));
    const frame2 = dataFrame(buildProtoResponse({ stopReason: 2 })); // STOP_PATTERN
    const body = concat([frame1, frame2, trailerFrame("grpc-status: 0\n")]);

    const upstream = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/connect+proto" },
    });

    const executor = new WindsurfExecutor();
    const sseResponse = (executor as any).transformToSSE(upstream, "glm-5.2", true, true);
    const events = parseSSE(await readSSE(sseResponse));

    const finishChunk = events.find((e) => e !== "[DONE]" && e.choices?.[0]?.finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, "stop");
  });

  it("emits tool call immediately when args arrive in first frame", async () => {
    const frame1 = dataFrame(
      buildProtoResponse({
        thinking: "Calling read_file.",
        toolCall: { id: "call-1", name: "read_file", args: '{"file_path": "/tmp/test.txt"}' },
        stopReason: 10,
      })
    );
    const body = concat([frame1, trailerFrame("grpc-status: 0\n")]);

    const upstream = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/connect+proto" },
    });

    const executor = new WindsurfExecutor();
    const sseResponse = (executor as any).transformToSSE(upstream, "glm-5.2", true, true);
    const events = parseSSE(await readSSE(sseResponse));

    const toolCallChunks = events.filter(
      (e) => e !== "[DONE]" && e.choices?.[0]?.delta?.tool_calls
    );
    assert.equal(toolCallChunks.length, 1);
    assert.equal(toolCallChunks[0].choices[0].delta.tool_calls[0].function.name, "read_file");
    assert.equal(
      toolCallChunks[0].choices[0].delta.tool_calls[0].function.arguments,
      '{"file_path": "/tmp/test.txt"}'
    );

    const finishChunk = events.find((e) => e !== "[DONE]" && e.choices?.[0]?.finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, "tool_calls");
  });

  it("does not set tool_calls finish_reason when tool call frame has only id (no name, no args)", async () => {
    // Frame with only id, no name, no args — should be skipped entirely
    const frame1 = dataFrame(
      buildProtoResponse({
        thinking: "Thinking...",
        toolCall: { id: "call-x", name: "", args: "" },
        stopReason: 10,
      })
    );
    const body = concat([frame1, trailerFrame("grpc-status: 0\n")]);

    const upstream = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/connect+proto" },
    });

    const executor = new WindsurfExecutor();
    const sseResponse = (executor as any).transformToSSE(upstream, "glm-5.2", true, true);
    const events = parseSSE(await readSSE(sseResponse));

    // No tool call should be emitted (no name to flush)
    const toolCallChunks = events.filter(
      (e) => e !== "[DONE]" && e.choices?.[0]?.delta?.tool_calls
    );
    assert.equal(toolCallChunks.length, 0, "Should not emit tool call without name");

    // finish_reason should be "stop" since no tool call was emitted
    const finishChunk = events.find((e) => e !== "[DONE]" && e.choices?.[0]?.finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, "stop");
  });
});
