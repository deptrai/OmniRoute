// Test: Windsurf returns 502 with "quota has been exhausted" body.
// Before fix: classifyProviderError returned SERVER_ERROR (502 >= 500),
//   connection was never marked credits_exhausted, account rotation never fired.
// After fix: classifyProviderError returns QUOTA_EXHAUSTED,
//   checkFallbackError returns shouldFallback=true with creditsExhausted=true,
//   connection gets marked credits_exhausted → next request picks the other account.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderError,
  PROVIDER_ERROR_TYPES,
} from "../../open-sse/services/errorClassifier.ts";
import {
  isCreditsExhausted,
  isDailyQuotaExhausted,
  checkFallbackError,
  CREDITS_EXHAUSTED_SIGNALS,
} from "../../open-sse/services/accountFallback.ts";

const WINDSURF_502_BODY =
  "Your daily usage quota has been exhausted. Visit https://app.devin.ai/plans to manage your plan.";

test("windsurf 502 quota body: isCreditsExhausted matches", () => {
  assert.ok(isCreditsExhausted(WINDSURF_502_BODY), "should match credits exhausted signals");
});

test("windsurf 502 quota body: isDailyQuotaExhausted matches 'daily usage quota'", () => {
  assert.ok(isDailyQuotaExhausted(WINDSURF_502_BODY), "should match daily quota signals");
});

test("windsurf 502 quota body: classifyProviderError returns QUOTA_EXHAUSTED (not SERVER_ERROR)", () => {
  const result = classifyProviderError(502, WINDSURF_502_BODY, "windsurf");
  assert.equal(result, PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED);
});

test("windsurf 502 quota body: checkFallbackError returns shouldFallback + creditsExhausted", () => {
  const result = checkFallbackError(502, WINDSURF_502_BODY, 0, null, "windsurf");
  assert.ok(result.shouldFallback, "should fallback to next account");
  assert.ok(result.creditsExhausted, "should mark as credits exhausted");
  assert.equal(result.reason, "quota_exhausted");
});

test("windsurf 502 without quota body: classifyProviderError still returns SERVER_ERROR", () => {
  const result = classifyProviderError(502, "Internal server error", "windsurf");
  assert.equal(result, PROVIDER_ERROR_TYPES.SERVER_ERROR);
});

test("CREDITS_EXHAUSTED_SIGNALS contains 'quota has been exhausted'", () => {
  assert.ok(CREDITS_EXHAUSTED_SIGNALS.includes("quota has been exhausted"));
});
