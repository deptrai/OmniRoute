/**
 * Regression tests for the Antigravity family-lock duration bug.
 *
 * Upstream quota/429 responses report the *quota window* boundary (e.g. the
 * weekly reset) rather than the effective rate-limit recovery. Those reset
 * claims flowed verbatim into `family:gemini`/`family:claude` model lockouts
 * (bypassing maxCooldownMs for header/RetryInfo provenance) and into the
 * persisted `antigravityFamilyRateLimitedUntil` PSD — observed production
 * locks of ~4.6 days on accounts whose per-model windows had already rolled.
 * Every writer must now clamp family-scope locks to
 * OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS (default 1h): the account re-enters
 * eligibility sooner and simply re-locks on the next real refusal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-cap-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const {
  clearAllModelLockouts,
  getModelLockoutInfo,
  isModelLocked,
  lockModel,
  recordModelLockoutFailure,
} = await import("../../open-sse/services/accountFallback.ts");
const {
  capAntigravityFamilyLockMs,
  DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
  getAntigravityFamilyLockMaxMs,
} = await import("../../open-sse/services/antigravityQuotaFamily.ts");
const {
  persistAntigravityFamilyCooldown,
  persistAntigravityPreflightFamilyLock,
  rehydrateAntigravityFamilyLocks,
} = await import("../../open-sse/services/antigravityFamilyCooldown.ts");

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

test.after(() => {
  clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── cap helper ───────────────────────────────────────────────────────────────

test("capAntigravityFamilyLockMs: long cooldowns clamp to the 1h default", () => {
  assert.equal(capAntigravityFamilyLockMs(FOUR_DAYS_MS), DEFAULT_AGY_FAMILY_LOCK_MAX_MS);
  assert.equal(capAntigravityFamilyLockMs(DEFAULT_AGY_FAMILY_LOCK_MAX_MS + 1), DEFAULT_AGY_FAMILY_LOCK_MAX_MS);
});

test("capAntigravityFamilyLockMs: short cooldowns pass through", () => {
  const short = 30 * 60 * 1000;
  assert.equal(capAntigravityFamilyLockMs(short), short);
  assert.equal(capAntigravityFamilyLockMs(0), 0);
  assert.equal(capAntigravityFamilyLockMs(-5), -5);
});

test("getAntigravityFamilyLockMaxMs: env override wins", () => {
  const prev = process.env.OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS;
  try {
    process.env.OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS = "900000";
    assert.equal(getAntigravityFamilyLockMaxMs(), 900_000);
    assert.equal(capAntigravityFamilyLockMs(FOUR_DAYS_MS), 900_000);
    process.env.OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS = "not-a-number";
    assert.equal(getAntigravityFamilyLockMaxMs(), DEFAULT_AGY_FAMILY_LOCK_MAX_MS);
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS;
    else process.env.OMNIROUTE_AGY_FAMILY_LOCK_MAX_MS = prev;
  }
});

// ── in-memory lockModel path (request/combo + preflight/executor/rehydrate) ──

test("lockModel: agy gemini model locks at family scope and clamps to the cap", () => {
  clearAllModelLockouts();
  lockModel("agy", "conn-1", "gemini-3.8-flash-high", "quota_exhausted", FOUR_DAYS_MS);
  const info = getModelLockoutInfo("agy", "conn-1", "gemini-3.8-flash-high");
  assert.ok(info, "family lock must exist");
  assert.ok(
    info.remainingMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
    `expected family lock <= ${DEFAULT_AGY_FAMILY_LOCK_MAX_MS}ms, got ${info.remainingMs}ms`
  );
  assert.ok(info.remainingMs > DEFAULT_AGY_FAMILY_LOCK_MAX_MS - 60_000);
  // sibling gemini models share the same family lock
  assert.equal(isModelLocked("agy", "conn-1", "gemini-3.8-flash-low"), true);
});

test("lockModel: agy claude family is capped too", () => {
  clearAllModelLockouts();
  lockModel("antigravity", "conn-2", "claude-sonnet-4-6", "quota_exhausted", FOUR_DAYS_MS);
  const info = getModelLockoutInfo("antigravity", "conn-2", "claude-sonnet-4-6");
  assert.ok(info);
  assert.ok(info.remainingMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS);
});

test("lockModel: non-antigravity provider keeps the full upstream reset", () => {
  clearAllModelLockouts();
  lockModel("gemini", "conn-3", "gemini-2.5-pro", "quota_exhausted", FOUR_DAYS_MS);
  const info = getModelLockoutInfo("gemini", "conn-3", "gemini-2.5-pro");
  assert.ok(info);
  assert.ok(
    info.remainingMs > DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
    "non-agy providers must keep verbatim upstream resets"
  );
});

test("lockModel: short agy cooldown passes through unchanged", () => {
  clearAllModelLockouts();
  const thirtyMin = 30 * 60 * 1000;
  lockModel("agy", "conn-4", "gemini-3.8-flash-low", "quota_exhausted", thirtyMin);
  const info = getModelLockoutInfo("agy", "conn-4", "gemini-3.8-flash-low");
  assert.ok(info);
  assert.ok(info.remainingMs <= thirtyMin && info.remainingMs > thirtyMin - 60_000);
});

test("recordModelLockoutFailure: upstream-reset bypass still clamps at family scope", () => {
  clearAllModelLockouts();
  // The production path: exactCooldownIsUpstreamReset lets a parsed upstream
  // reset bypass maxCooldownMs entirely — family scope must still be capped.
  recordModelLockoutFailure(
    "agy",
    "conn-5",
    "gemini-3.8-flash-high",
    "quota_exhausted",
    429,
    120_000,
    null,
    {
      exactCooldownMs: FOUR_DAYS_MS,
      maxCooldownMs: 1_800_000,
      exactCooldownIsUpstreamReset: true,
    }
  );
  const info = getModelLockoutInfo("agy", "conn-5", "gemini-3.8-flash-high");
  assert.ok(info);
  assert.ok(
    info.remainingMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
    `family lock must be capped, got ${info.remainingMs}ms`
  );
});

// ── persisted PSD path ───────────────────────────────────────────────────────

test("persistAntigravityFamilyCooldown: far-future rateLimitedUntil is clamped in PSD", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "AG PSD Cap Test",
  });
  const connId = (conn as { id: string }).id;
  const farFuture = new Date(Date.now() + FOUR_DAYS_MS).toISOString();

  await persistAntigravityFamilyCooldown({
    connectionId: connId,
    model: "gemini-3.8-flash-high",
    rateLimitedUntil: farFuture,
  });

  const row = (await providersDb.getProviderConnectionById(connId)) as {
    providerSpecificData?: { antigravityFamilyRateLimitedUntil?: { gemini?: string } };
  };
  const persisted = row.providerSpecificData?.antigravityFamilyRateLimitedUntil?.gemini;
  assert.ok(persisted, "family lock must be persisted");
  const persistedMs = Date.parse(persisted) - Date.now();
  assert.ok(
    persistedMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
    `persisted family lock must be capped, got ${persistedMs}ms`
  );
});

// ── preflight + rehydrate paths ──────────────────────────────────────────────

test("persistAntigravityPreflightFamilyLock: in-memory lock is capped", async () => {
  clearAllModelLockouts();
  const conn = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "AG Preflight Cap Test",
  });
  const connId = (conn as { id: string }).id;
  const farFuture = new Date(Date.now() + FOUR_DAYS_MS).toISOString();

  await persistAntigravityPreflightFamilyLock({
    provider: "agy",
    connectionId: connId,
    model: "gemini-3.8-flash-high",
    unavailableUntil: farFuture,
  });

  const info = getModelLockoutInfo("agy", connId, "gemini-3.8-flash-high");
  assert.ok(info, "preflight family lock must exist");
  assert.ok(info.remainingMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS);
});

test("rehydrateAntigravityFamilyLocks: a long persisted lock rehydrates capped", () => {
  clearAllModelLockouts();
  const farFuture = new Date(Date.now() + FOUR_DAYS_MS).toISOString();
  rehydrateAntigravityFamilyLocks("agy", "conn-6", {
    antigravityFamilyRateLimitedUntil: { gemini: farFuture },
  });
  const info = getModelLockoutInfo("agy", "conn-6", "gemini-3.8-flash-high");
  assert.ok(info, "rehydrated family lock must exist");
  assert.ok(
    info.remainingMs <= DEFAULT_AGY_FAMILY_LOCK_MAX_MS,
    `rehydrated lock must be capped, got ${info.remainingMs}ms`
  );
});
