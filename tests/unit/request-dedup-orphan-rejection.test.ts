import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicate, clearInflight } from "../../open-sse/services/requestDedup.ts";

// Regression: a dedup leader whose fn() throws used to leave the stored
// `sharedPromise` rejected with no handlers whenever no joiner attached —
// an unhandledRejection that the process crash guard treats as fatal,
// taking the whole replica down (production crash signature: uncaught
// SEMAPHORE_TIMEOUT on a dedup-eligible non-streaming request → exit 7).
// The stored promise must be marked handled; joiners must still observe
// the rejection through their own `await existing` branch.

test("leader failure with NO joiner does not surface an unhandledRejection", async () => {
  clearInflight();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      deduplicate("orphan-no-joiner", async () => {
        const err = new Error("Semaphore timeout after 4000ms for devin-desktop:acct,global") as Error & {
          code?: string;
        };
        err.code = "SEMAPHORE_TIMEOUT";
        throw err;
      }),
      /Semaphore timeout/
    );
    // unhandledRejection fires on a later turn — give the runtime room.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection(s): ${unhandled}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    clearInflight();
  }
});

test("joiner still observes the leader's failure (rejection is broadcast, not swallowed)", async () => {
  clearInflight();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let failLeader: (err: Error) => void = () => {};
    const leaderPromise = deduplicate("joiner-sees-failure", () => {
      return new Promise<never>((_res, rej) => {
        failLeader = rej;
      });
    });
    const leaderAssert = assert.rejects(leaderPromise, /upstream blew up/);
    const joinerAssert = assert.rejects(deduplicate("joiner-sees-failure", async () => "never-runs"), /upstream blew up/);

    failLeader(new Error("upstream blew up"));
    await Promise.all([leaderAssert, joinerAssert]);
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    clearInflight();
  }
});

test("leader success still deduplicates (no behavior change on the happy path)", async () => {
  clearInflight();
  let calls = 0;
  const slowFn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return "SHARED_OK";
  };
  const [a, b] = await Promise.all([
    deduplicate("happy-path", slowFn),
    deduplicate("happy-path", slowFn),
  ]);
  assert.equal(a.result, "SHARED_OK");
  assert.equal(b.result, "SHARED_OK");
  assert.equal(calls, 1);
  clearInflight();
});
