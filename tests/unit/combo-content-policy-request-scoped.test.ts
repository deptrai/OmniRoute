/**
 * Devin Desktop rejects a prompt with `permission_denied: ... content policy ...`,
 * which the executor classifies as a 400 `content_policy_violation`. That is a
 * deterministic, per-payload rejection — the connection and provider are healthy.
 *
 * Regression: before the request-scoped classification, this failure was
 * normalized to a 502 server_error, cooled the connection via
 * markAccountUnavailable, fed the provider circuit breaker, and — with
 * devin-desktop as a protected first target — collapsed the whole combo into
 * repeated 503 "Pipeline gate rejected" responses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-policy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-policy-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { clearAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../src/shared/utils/circuitBreaker.ts");

test.afterEach(() => {
  clearAllModelLockouts();
  resetAllCircuitBreakers();
});

test.after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function contentPolicyResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "content_policy_violation",
        type: "invalid_request_error",
        message:
          "Devin Desktop stream error: permission_denied: Your request was blocked by our content policy. Please remove sensitive or unsafe content from your prompt, memories, and other settings and try again.",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function okResponse(modelStr: string) {
  return new Response(JSON.stringify({ model: modelStr }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCombo(models: Array<{ model: string; fallbackOnlyOnQuotaExhaustion?: boolean }>) {
  return {
    name: `combo-policy-${Math.random()}`,
    strategy: "priority",
    models,
    config: { maxRetries: 0, retryDelayMs: 0 },
  };
}

test("content-policy 400 falls through to the next target and never trips the provider breaker", async () => {
  const modelsCalled: string[] = [];
  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo([{ model: "devin-desktop/swe-2-max" }, { model: "anthropic/backup" }]),
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return modelStr === "devin-desktop/swe-2-max"
        ? contentPolicyResponse()
        : okResponse(modelStr);
    },
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(result.status, 200, "combo must fall through to the backup target");
  assert.deepEqual(modelsCalled, ["devin-desktop/swe-2-max", "anthropic/backup"]);
  assert.equal(
    getCircuitBreaker("devin-desktop").getStatus().failureCount,
    0,
    "a per-prompt policy rejection must not count against provider health"
  );
});

test("streaming pre-content error frame records the classified 400, not a 502 quality failure", async () => {
  // The Devin failure mode in production: HTTP 200 SSE stream carrying an
  // error frame BEFORE any content. The quality peek rejects it — and must
  // propagate the classified status/code so the combo records 400 (scoped)
  // instead of a generic 502 quality_failure that feeds model lockout.
  const encoder = new TextEncoder();
  const policyStream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: error",
              `data: ${JSON.stringify({
                error: {
                  code: "content_policy_violation",
                  type: "invalid_request_error",
                  message: "permission_denied: blocked by content policy",
                },
              })}`,
              "",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  const healthyStream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "backup ok" }, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`
          )
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );

  const modelsCalled: string[] = [];
  const result = await handleComboChat({
    body: { stream: true, model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo([{ model: "devin-desktop/swe-2-max" }, { model: "anthropic/backup" }]),
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return modelStr === "devin-desktop/swe-2-max" ? policyStream : healthyStream;
    },
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(result.status, 200, "combo must fall through to the backup target");
  assert.deepEqual(modelsCalled, ["devin-desktop/swe-2-max", "anthropic/backup"]);
  assert.equal(
    getCircuitBreaker("devin-desktop").getStatus().failureCount,
    0,
    "a classified per-prompt policy rejection must not feed provider health"
  );
});

test("protected first target surfaces the real 400 instead of a masked breaker 503", async () => {
  const modelsCalled: string[] = [];
  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo([
      { model: "devin-desktop/swe-2-max", fallbackOnlyOnQuotaExhaustion: true },
      { model: "anthropic/backup" },
    ]),
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return modelStr === "devin-desktop/swe-2-max"
        ? contentPolicyResponse()
        : okResponse(modelStr);
    },
    log,
    settings: {},
    allCombos: [],
  });

  // fallbackOnlyOnQuotaExhaustion semantics are preserved: a non-quota failure
  // on the protected target ends the combo — but with the honest 400, and
  // without having marked the provider unhealthy.
  assert.equal(result.status, 400);
  assert.deepEqual(modelsCalled, ["devin-desktop/swe-2-max"]);
  assert.equal(getCircuitBreaker("devin-desktop").getStatus().failureCount, 0);
});
