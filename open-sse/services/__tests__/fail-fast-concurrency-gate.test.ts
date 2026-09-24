import { describe, it, expect, beforeEach } from "vitest";
import {
  acquire,
  acquireMany,
  isAccountSemaphoreFull,
  markBlocked,
  unblock,
  resetAll,
} from "../accountSemaphore.ts";

describe("isAccountSemaphoreFull fail-fast concurrency gate", () => {
  beforeEach(() => {
    resetAll();
  });

  it("returns false when no semaphore gate exists", () => {
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", 1)).toBe(false);
  });

  it("returns false when maxConcurrency is null, <= 0, or bypassed", () => {
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", null)).toBe(false);
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", 0)).toBe(false);
  });

  it("returns false when running < maxConcurrency", async () => {
    const release = await acquire("featherless-ai:conn-1", { maxConcurrency: 2 });
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", 2)).toBe(false);
    release();
  });

  it("returns true immediately when running >= maxConcurrency", async () => {
    const release = await acquire("featherless-ai:conn-1", { maxConcurrency: 1 });
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", 1)).toBe(true);
    release();
    expect(isAccountSemaphoreFull("featherless-ai", "conn-1", 1)).toBe(false);
  });

  it("rejects immediately with SEMAPHORE_BLOCKED when the gate is in cooldown", async () => {
    markBlocked("antigravity:conn-9", 60_000);
    const startedAt = Date.now();
    await expect(
      acquire("antigravity:conn-9", { maxConcurrency: 6, timeoutMs: 45_000 })
    ).rejects.toMatchObject({ code: "SEMAPHORE_BLOCKED" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    unblock("antigravity:conn-9");
    const release = await acquire("antigravity:conn-9", { maxConcurrency: 6 });
    release();
  });

  it("rejects acquireMany immediately when any required gate is blocked", async () => {
    markBlocked("antigravity:conn-10", 60_000);
    await expect(
      acquireMany(
        [
          { key: "global", maxConcurrency: 30 },
          { key: "antigravity:conn-10", maxConcurrency: 3 },
        ],
        { timeoutMs: 45_000 }
      )
    ).rejects.toMatchObject({ code: "SEMAPHORE_BLOCKED" });
  });

  it("still queues (not blocked-rejects) when the gate is merely saturated", async () => {
    const release = await acquire("antigravity:conn-11", { maxConcurrency: 1 });
    const waiter = acquire("antigravity:conn-11", { maxConcurrency: 1, timeoutMs: 50 });
    await expect(waiter).rejects.toMatchObject({ code: "SEMAPHORE_TIMEOUT" });
    release();
  });
});
