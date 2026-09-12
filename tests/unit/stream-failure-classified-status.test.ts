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
    // Devin Desktop's account-level message rate limit — classified 429 at the
    // readiness layer (#ea27311a6); a bare code-only mid-stream frame must map
    // the same way instead of falling through to 502.
    [{ code: "resource_exhausted", type: "rate_limit_error" }, 429],
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

test("numeric HTTP-range error.code is honored as an explicit status", () => {
  // Bare numeric-code frames (no classified string code, no rate-limit text)
  // previously collapsed to 502 — the number itself is the upstream's verdict.
  assert.equal(
    normalizeStreamFailurePayload({ error: { code: 429, message: "slow down" } })?.status,
    429
  );
  assert.equal(
    normalizeStreamFailurePayload({ error: { code: 503, message: "upstream gone" } })?.status,
    503
  );
  // Out-of-range / non-integer codes are not statuses.
  assert.equal(
    normalizeStreamFailurePayload({ error: { code: 42, message: "weird" } })?.status,
    502
  );
});

test("prototype-chain keys can never masquerade as classified codes", () => {
  // Without Object.hasOwn, a hostile/buggy upstream sending
  // {code:"constructor"} would resolve to the Object constructor function —
  // a non-number "status" that corrupts downstream recording.
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(
      normalizeStreamFailurePayload({ error: { code: key, message: "x" } })?.status,
      502,
      `${key} must fall through to 502, not resolve to a prototype member`
    );
  }
});

test("generic type umbrella does not shadow the rate-limit text heuristic", () => {
  // A throttling frame carrying only the umbrella type "invalid_request_error"
  // must stay 429 via the message heuristic — the type map is consulted AFTER
  // it, or real throttles would degrade to 400 and skip cooldown handling.
  const throttled = normalizeStreamFailurePayload({
    error: {
      code: "upstream_error",
      type: "invalid_request_error",
      message: "Reached overall message rate limit — your limit will reset in 12 minutes",
    },
  });
  assert.equal(throttled?.status, 429);
  // A classified type (not just the umbrella) still maps on its own.
  const policy = normalizeStreamFailurePayload({
    error: { code: "upstream_error", type: "content_policy_violation", message: "denied" },
  });
  assert.equal(policy?.status, 400);
});

test("request-scoped classification consults type as well as code", () => {
  // Some providers carry the classified identifier in `type` — the scoped
  // verdict must match the status-map verdict for the same frame.
  assert.equal(
    isRequestScopedUpstreamFailure({ code: "upstream_error", type: "content_policy_violation" }),
    true
  );
  assert.equal(
    isRequestScopedUpstreamFailure({ code: "content_filter" }),
    true
  );
  assert.equal(
    isRequestScopedUpstreamFailure({ code: "context_window_exceeded" }),
    true
  );
  // Auth/permission codes stay connection-scoped — a dead key SHOULD cool.
  assert.equal(isRequestScopedUpstreamFailure({ code: "permission_denied" }), false);
  assert.equal(isRequestScopedUpstreamFailure({ code: "invalid_api_key" }), false);
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
  assert.equal(isRequestScopedUpstreamFailure({ type: "server_error" }), false);
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
