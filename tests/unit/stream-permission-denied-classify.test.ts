/**
 * Devin Desktop streams an error-only SSE frame
 *   data: {"error":{"message":"Devin Desktop stream error: permission_denied: ..."}}
 * and then closes the connection without any non-ping content event.
 *
 * `classifyTerminalStreamDiagnostic` did not recognize `permission_denied`, so
 * the failure collapsed into a generic STREAM_EARLY_EOF → HTTP 502. In combo
 * routing, a 502 is a CONNECTION-LEVEL status (#1731v2): the failing
 * devin-desktop connection was marked exhausted for the rest of the request,
 * sibling targets on the same connection were skipped, and the combo returned
 * "All models failed" 502 — even though sibling models (swe-2-max) on the same
 * connection were healthy.
 *
 * The fix classifies the trailer:
 *   - "... MCP configuration issue" → 400 invalid_request_error (request-scoped:
 *     deterministic for the payload, not a connection-health signal)
 *   - "an internal error occurred"  → 502 upstream_internal_error (transient
 *     upstream fault; NOT 403 — a 403 here flows through the error classifier
 *     to providerErrorType=FORBIDDEN → testStatus="banned", terminally killing
 *     the connection on a transient fault)
 *   - bare "permission_denied"      → 403 permission_denied (executor parity)
 * Content-policy trailers still classify as 400 content_policy_violation via
 * the earlier content-policy branch (order matters — covered below).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { ensureStreamReadiness } = await import("../../open-sse/utils/streamReadiness.ts");

function sseResponse(frames: string[]): Response {
  const bytes = frames.map((f) => new TextEncoder().encode(f));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(b);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function errorFrame(message: string): string {
  return `data: ${JSON.stringify({ error: { message } })}\n\n`;
}

test("permission_denied MCP-configuration trailer → 400 invalid_request_error", async () => {
  const res = await ensureStreamReadiness(
    sseResponse([
      errorFrame(
        "Devin Desktop stream error: permission_denied: Unable to process request due to an MCP configuration issue. (trace ID: 8b6a84907f4c36e9b20e3b16878bfe6a)"
      ),
    ]),
    { timeoutMs: 5000, provider: "devin-desktop", model: "swe-2-high" }
  );

  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_request_error");
  assert.equal(res.type, "invalid_request_error");
  assert.ok(res.response, "expected an error Response");
  assert.equal(res.response!.status, 400);
  const body = (await res.response!.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "invalid_request_error");
});

test("permission_denied internal-error trailer → 502 upstream_internal_error (must NOT ban connection)", async () => {
  // Production incident: "Devin Desktop stream error: permission_denied: an
  // internal error occurred" classified as 403 → FORBIDDEN → testStatus="banned"
  // → every subsequent request failed "401 All 1 connection(s) banned by
  // upstream" while the account was actually healthy.
  const res = await ensureStreamReadiness(
    sseResponse([
      errorFrame("Devin Desktop stream error: permission_denied: an internal error occurred"),
    ]),
    { timeoutMs: 5000, provider: "devin-desktop", model: "swe-2-max" }
  );

  assert.equal(res.ok, false);
  assert.equal(res.code, "upstream_internal_error");
  assert.equal(res.type, "api_error");
  assert.equal(res.response!.status, 502);
});

test("bare permission_denied trailer → 403 permission_denied", async () => {
  const res = await ensureStreamReadiness(
    sseResponse([
      errorFrame("Devin Desktop stream error: permission_denied: access to this resource is denied"),
    ]),
    { timeoutMs: 5000, provider: "devin-desktop", model: "swe-2-max" }
  );

  assert.equal(res.ok, false);
  assert.equal(res.code, "permission_denied");
  assert.equal(res.type, "permission_error");
  assert.equal(res.response!.status, 403);
});

test("permission_denied content-policy trailer still → 400 content_policy_violation", async () => {
  const res = await ensureStreamReadiness(
    sseResponse([
      errorFrame(
        "Devin Desktop stream error: permission_denied: Your request was blocked by our content policy. Please remove sensitive or unsafe content from your prompt and try again."
      ),
    ]),
    { timeoutMs: 5000, provider: "devin-desktop", model: "swe-2-max" }
  );

  assert.equal(res.ok, false);
  assert.equal(res.code, "content_policy_violation");
  assert.equal(res.response!.status, 400);
});

test("unclassified trailer still → 502 STREAM_EARLY_EOF (no regression)", async () => {
  const res = await ensureStreamReadiness(
    sseResponse([errorFrame("some totally novel upstream failure mode")]),
    { timeoutMs: 5000, provider: "devin-desktop", model: "swe-2-max" }
  );

  assert.equal(res.ok, false);
  assert.equal(res.code, "STREAM_EARLY_EOF");
  assert.equal(res.response!.status, 502);
});
