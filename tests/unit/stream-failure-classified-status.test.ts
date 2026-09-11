/**
 * Mid-stream upstream error frames carry error.code/error.type but usually no
 * HTTP status field (e.g. Devin Desktop emits
 * {code:"content_policy_violation", type:"invalid_request_error"} for a
 * permission_denied trailer). normalizeStreamFailurePayload() used to collapse
 * every such frame to 502 — which then recorded a fake "server_error",
 * cooled the account, and fed the provider circuit breaker.
 *
 * Fix: recover the classified status from error.code/error.type before falling
 * back to message-text heuristics, and keep the classified identifiers
 * (content_policy_violation, permission_denied) safe-listed so buildErrorBody()
 * does not re-project them to generic bad_request/insufficient_quota.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stream-classified-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { normalizeStreamFailurePayload, prepareTranslatedStreamFailure } =
  await import("../../open-sse/utils/streamErrorFormat.ts");
const { buildErrorBody } = await import("../../open-sse/utils/error.ts");
const { isRequestScopedUpstreamFailure } =
  await import("../../open-sse/services/combo/comboPredicates.ts");

const DEVIN_CONTENT_POLICY_FRAME = {
  error: {
    message:
      "Devin Desktop stream error: permission_denied: Your request was blocked by our content policy. Please remove sensitive or unsafe content from your prompt, memories, and other settings and try again.",
    type: "invalid_request_error",
    code: "content_policy_violation",
  },
};

test("mid-stream content_policy_violation frame keeps its classified 400", () => {
  const failure = normalizeStreamFailurePayload(DEVIN_CONTENT_POLICY_FRAME);
  assert.ok(failure, "frame must normalize");
  assert.equal(failure.status, 400, "classified content-policy error must stay 400, not 502");
  assert.equal(failure.code, "content_policy_violation");
  assert.equal(failure.type, "invalid_request_error");
});

test("mid-stream rate-limit/auth/permission codes map to their real statuses", () => {
  const cases = [
    [{ code: "rate_limit_exceeded", type: "rate_limit_error" }, 429],
    [{ code: "usage_limit_reached", type: "rate_limit_error" }, 429],
    [{ code: "invalid_api_key", type: "authentication_error" }, 401],
    [{ code: "permission_denied", type: "permission_error" }, 403],
    [{ code: "model_not_found", type: "invalid_request_error" }, 404],
  ] as const;
  for (const [error, expected] of cases) {
    const failure = normalizeStreamFailurePayload({
      error: { ...error, message: "upstream said no" },
    });
    assert.ok(failure, `${error.code} must normalize`);
    assert.equal(failure.status, expected, `${error.code} must map to ${expected}`);
  }
});

test("explicit status fields still win over the classified map", () => {
  const failure = normalizeStreamFailurePayload({
    error: {
      status: 503,
      message: "explicit status",
      code: "content_policy_violation",
      type: "invalid_request_error",
    },
  });
  assert.ok(failure);
  assert.equal(failure.status, 503);
});

test("unclassified frames still fall back to 502 (or text-heuristic 429)", () => {
  assert.equal(normalizeStreamFailurePayload({ error: { message: "boom" } })?.status, 502);
  // OpenRouter-style numeric-code capacity frame: code is not a string so the
  // map misses, and the "limit reached" text heuristic still yields 429.
  const openrouter = normalizeStreamFailurePayload({
    error: {
      code: 502,
      message:
        "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (33/32)",
    },
  });
  assert.equal(openrouter?.status, 429);
});

test("buildErrorBody keeps classified identifiers instead of projecting them away", () => {
  const body = buildErrorBody(400, "policy blocked", undefined, {
    code: "content_policy_violation",
    type: "invalid_request_error",
  });
  assert.equal(body.error.code, "content_policy_violation");
  assert.equal(body.error.type, "invalid_request_error");

  const forbidden = buildErrorBody(403, "no permission", undefined, {
    code: "permission_denied",
    type: "permission_error",
  });
  assert.equal(forbidden.error.code, "permission_denied");
});

test("content_policy_violation is a request-scoped failure (no breaker/cooldown)", () => {
  assert.equal(
    isRequestScopedUpstreamFailure({
      code: "content_policy_violation",
      type: "invalid_request_error",
    }),
    true
  );
  assert.equal(isRequestScopedUpstreamFailure({ code: "upstream_error" }), false);
  assert.equal(isRequestScopedUpstreamFailure({ type: "invalid_request_error" }), false);
});

test("prepareTranslatedStreamFailure carries the classified 400 through the pipeline", () => {
  const projected = prepareTranslatedStreamFailure(DEVIN_CONTENT_POLICY_FRAME);
  assert.ok(projected, "Devin error frame must project");
  assert.equal(projected.internalFailure.status, 400);
  assert.equal(projected.internalFailure.code, "content_policy_violation");
  const providerError = (projected.providerPayload as { error: { code: string; type: string } })
    .error;
  assert.equal(providerError.code, "content_policy_violation");
  assert.equal(providerError.type, "invalid_request_error");
});
