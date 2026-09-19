// Devin Desktop free-model vs account-wide rate-limit scope.
// Upstream sends two distinct resource_exhausted wordings:
//   "Reached free model rate limit. Upgrade to Max ... reset in 1 minute"
//     → per-model free-tier bucket — only that model may lock; sibling models
//       on the same connection (swe-2-max, glm-5-3-*) must stay eligible.
//   "Reached overall message rate limit ... reset in N minutes"
//     → account-wide cap — the connection must cool until reset.
// Production regression being pinned: the same free-model text arriving under
// an outer 502 envelope (Connect/proto decode error re-thrown by the stream
// wrapper) used to cool the whole connection and exhaust same-connection
// combo targets — one throttled free model blacked out every Devin model.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-devin-scope-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const { classifyDevinDesktopError } =
  await import("../../open-sse/executors/devin-desktop.ts");
const { getProviderErrorRuleMatch, honorsRuleLockScope } =
  await import("../../open-sse/config/providerErrorRules.ts");

const FREE_MODEL_429 =
  '{"error":{"message":"resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 1 minute.","code":"rate_limit_exceeded","type":"rate_limit_error"}}';
const OVERALL_429 =
  '{"error":{"message":"resource_exhausted: Reached overall message rate limit. Please try again later. Your limit will reset in 1 minute.","code":"rate_limit_exceeded","type":"rate_limit_error"}}';
const FREE_MODEL_NO_RESET =
  '{"error":{"message":"resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model.","code":"rate_limit_exceeded","type":"rate_limit_error"}}';

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(overrides: Record<string, unknown> = {}): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: "devin-desktop",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    ...overrides,
  });
  return (conn as Record<string, unknown>).id as string;
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("devin-desktop honors rule lock scope and has per-model quota", () => {
  assert.equal(honorsRuleLockScope("devin-desktop"), true);
  assert.equal(accountFallback.hasPerModelQuota("devin-desktop", "swe-2-high"), true);
});

test("devin 429 free-model -> model scope + upstream reset cooldown", () => {
  const result = accountFallback.checkFallbackError(
    429,
    FREE_MODEL_429,
    0,
    "swe-2-high",
    "devin-desktop"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "rate_limit_exceeded");
  assert.equal(result.ruleScope, "model");
  assert.ok(result.cooldownMs >= 55_000 && result.cooldownMs <= 65_000,
    `expected ~60s upstream reset cooldown, got ${result.cooldownMs}`);
});

test("devin 429 overall message limit -> connection scope + quota_exhausted", () => {
  const result = accountFallback.checkFallbackError(
    429,
    OVERALL_429,
    0,
    "swe-2-medium",
    "devin-desktop"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "quota_exhausted");
  assert.equal(result.ruleScope, "connection");
  assert.ok(result.cooldownMs >= 55_000 && result.cooldownMs <= 65_000,
    `expected ~60s upstream reset cooldown, got ${result.cooldownMs}`);
});

test("devin 502 envelope carrying free-model text -> still model scope", () => {
  const result = accountFallback.checkFallbackError(
    502,
    FREE_MODEL_429,
    0,
    "swe-2-high",
    "devin-desktop"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "rate_limit_exceeded");
  assert.equal(result.ruleScope, "model");
  assert.ok(result.cooldownMs >= 55_000 && result.cooldownMs <= 65_000);
});

test("devin free-model without reset phrase -> model scope + fallback cooldown", () => {
  const result = accountFallback.checkFallbackError(
    429,
    FREE_MODEL_NO_RESET,
    0,
    "swe-2-high",
    "devin-desktop"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "rate_limit_exceeded");
  assert.equal(result.ruleScope, "model");
  assert.ok(result.cooldownMs > 0);
});

test("devin provider rule rejects unrelated 429/502 bodies", () => {
  const other429 = getProviderErrorRuleMatch("devin-desktop", 429, null, {
    error: { message: "rate_limit_exceeded: too many requests" },
  });
  assert.equal(other429, null);
  const other502 = getProviderErrorRuleMatch("devin-desktop", 502, null, {
    error: { message: "bad gateway" },
  });
  assert.equal(other502, null);
  const other500 = getProviderErrorRuleMatch("devin-desktop", 500, null, {
    error: { message: "resource_exhausted: Reached free model rate limit" },
  });
  assert.equal(other500, null, "rule must not fire on a plain 500 envelope");
});

test("markAccountUnavailable: free-model 429 locks only the model, connection stays active", async () => {
  await resetStorage();
  const connId = await seedConnection();

  const result = await auth.markAccountUnavailable(
    connId,
    429,
    FREE_MODEL_429,
    "devin-desktop",
    "swe-2-high"
  );

  assert.equal(result.shouldFallback, true);
  const after = await providersDb.getProviderConnectionById(connId);
  assert.notEqual(after.testStatus, "unavailable");
  assert.notEqual(after.testStatus, "banned");
  assert.ok(!after.rateLimitedUntil, "model-scoped cap must not rate-limit the connection");

  assert.equal(accountFallback.isModelLocked("devin-desktop", connId, "swe-2-high"), true);
  assert.equal(
    accountFallback.isModelLocked("devin-desktop", connId, "swe-2-max"),
    false,
    "sibling model must remain eligible"
  );
  assert.equal(
    accountFallback.isModelLocked("devin-desktop", connId, "glm-5-3-flash-high"),
    false,
    "glm sibling must remain eligible"
  );
});

test("markAccountUnavailable: 502 envelope with free-model text locks only the model", async () => {
  await resetStorage();
  const connId = await seedConnection();

  const result = await auth.markAccountUnavailable(
    connId,
    502,
    FREE_MODEL_429,
    "devin-desktop",
    "swe-2-medium"
  );

  assert.equal(result.shouldFallback, true);
  const after = await providersDb.getProviderConnectionById(connId);
  assert.notEqual(after.testStatus, "unavailable");
  assert.ok(!after.rateLimitedUntil);
  assert.equal(accountFallback.isModelLocked("devin-desktop", connId, "swe-2-medium"), true);
  assert.equal(accountFallback.isModelLocked("devin-desktop", connId, "swe-2-max"), false);
});

test("markAccountUnavailable: overall 429 cools the connection, never terminal, no model lock", async () => {
  await resetStorage();
  const connId = await seedConnection();

  const result = await auth.markAccountUnavailable(
    connId,
    429,
    OVERALL_429,
    "devin-desktop",
    "swe-2-high"
  );

  assert.equal(result.shouldFallback, true);
  const after = await providersDb.getProviderConnectionById(connId);
  assert.equal(after.testStatus, "unavailable");
  assert.notEqual(after.testStatus, "banned");
  assert.notEqual(after.testStatus, "credits_exhausted");
  assert.ok(after.rateLimitedUntil, "connection cooldown must carry rateLimitedUntil");
  assert.ok(
    new Date(String(after.rateLimitedUntil)).getTime() > Date.now() + 30_000,
    "cooldown should approximate the upstream reset window"
  );

  assert.equal(
    accountFallback.isModelLocked("devin-desktop", connId, "swe-2-high"),
    false,
    "connection-scoped cap must not also record a model lockout"
  );
});

test("markAccountUnavailable: overall 429 cools the connection even for combo callers", async () => {
  await resetStorage();
  const connId = await seedConnection();

  const result = await auth.markAccountUnavailable(
    connId,
    429,
    OVERALL_429,
    "devin-desktop",
    "swe-2-high",
    null,
    { isCombo: true, persistUnavailableState: false }
  );

  assert.equal(result.shouldFallback, true);
  const after = await providersDb.getProviderConnectionById(connId);
  assert.equal(after.testStatus, "unavailable");
  assert.ok(after.rateLimitedUntil);
});

test("executor classifier maps thrown resource_exhausted decode error to 429", () => {
  const classified = classifyDevinDesktopError(
    "resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 1 minute."
  );
  assert.equal(classified.status, 429);
  assert.equal(classified.code, "rate_limit_exceeded");
  assert.equal(classified.type, "rate_limit_error");
});
