import assert from "node:assert";
import test from "node:test";
import { WindsurfExecutor } from "../../open-sse/executors/windsurf.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";

const { __test } = await import("../../open-sse/executors/windsurf.ts");
const { grpcWebFrame, buildGetChatMessageRequest } = __test;

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

test("handleChatCore windsurf streaming returns content", async () => {
  const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.test";
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url: string, init: any) => {
      const body = init.body as Uint8Array;
      // Build a mock Connect response with one content frame and a trailer.
      const mockResp = concatBytes([
        grpcWebFrame(buildMockResponse("Hello there!", "", 1, 2001, 159)),
        buildMockTrailer(),
      ]);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(mockResp);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/connect+proto" },
        }
      );
    };

    const result = await handleChatCore({
      body: {
        model: "ws/glm-5.2",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 100,
        stream: true,
      },
      modelInfo: { provider: "ws", model: "glm-5.2", extendedContext: false },
      credentials: { accessToken: token, providerSpecificData: {} },
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: new Headers() },
      userAgent: "unit-test",
      log: console as any,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.response.headers.get("content-type"), "text/event-stream");

    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    console.log("=== chatCore stream output ===");
    console.log(text);
    assert.ok(text.includes('"content":"Hello there!"'), "Expected content in stream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function buildMockResponse(
  text: string,
  thinking: string,
  stopReason: number,
  inputTokens: number,
  outputTokens: number
) {
  const parts: Uint8Array[] = [];
  if (text) parts.push(__test.encodeString(3, text));
  if (thinking) parts.push(__test.encodeString(9, thinking));
  if (stopReason > 0) parts.push(__test.encodeVarintField(5, stopReason));
  if (inputTokens > 0 || outputTokens > 0) {
    const usageParts: Uint8Array[] = [];
    if (inputTokens > 0) usageParts.push(__test.encodeVarintField(2, inputTokens));
    if (outputTokens > 0) usageParts.push(__test.encodeVarintField(3, outputTokens));
    parts.push(__test.encodeMessage(7, concatBytes(usageParts)));
  }
  return concatBytes(parts);
}

function buildMockTrailer() {
  const text = new TextEncoder().encode("grpc-status:0\n");
  const frame = new Uint8Array(5 + text.length);
  frame[0] = 0x02;
  new DataView(frame.buffer).setUint32(1, text.length, false);
  frame.set(text, 5);
  return frame;
}
