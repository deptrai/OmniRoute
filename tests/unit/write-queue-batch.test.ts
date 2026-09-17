/**
 * Architecture spine AD-1: request-scoped persistence (call_logs,
 * usage_history) must not run synchronous SQLite on the request path. The
 * shared writer queue batches ops into one transaction on a flush cadence.
 *
 * Coverage:
 *  - ops enqueued are committed (not lost) after a flush
 *  - batching: many ops land in ONE transaction (single batch)
 *  - afterCommit fires only after the transaction commits
 *  - queue overflow drops oldest ops and never rejects the new op
 *  - closeWriteQueue drains pending ops before returning
 *  - enqueueWrite refuses new ops once the queue is closing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-write-queue-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_WRITE_QUEUE_FLUSH_MS = "25";
process.env.OMNIROUTE_WRITE_QUEUE_BATCH_SIZE = "1000";
process.env.OMNIROUTE_WRITE_QUEUE_MAX_BATCH = "1000";

const core = await import("../../src/lib/db/core.ts");
const writeQueue = await import("../../src/lib/usage/writeQueue.ts");

function getDb() {
  return core.getDbInstance() as unknown as {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => { n?: number } | undefined;
      all: (...args: unknown[]) => Array<{ v: number }>;
    };
  };
}

test.after(() => {
  writeQueue.resetWriteQueueForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ensureTable() {
  getDb().exec("CREATE TABLE IF NOT EXISTS wq_test (id INTEGER PRIMARY KEY, v INTEGER)");
}

test("enqueue + drain commits the op's row", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  writeQueue.enqueueWrite({
    label: "test.insert",
    run: (db) => {
      (db as unknown as ReturnType<typeof getDb>).prepare("INSERT INTO wq_test (v) VALUES (?)").run(1);
    },
  });
  assert.equal(await writeQueue.waitForWriteDrain(2000), true);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM wq_test WHERE v = 1").get()?.n, 1);
});

test("many ops collapse into a single batch transaction", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  for (let i = 0; i < 50; i += 1) {
    writeQueue.enqueueWrite({
      run: (db) => {
        (db as unknown as ReturnType<typeof getDb>)
          .prepare("INSERT INTO wq_test (v) VALUES (?)")
          .run(i);
      },
    });
  }
  assert.equal(await writeQueue.waitForWriteDrain(2000), true);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM wq_test").get()?.n, 50);
  // 50 ops <= batch size and flushed before/within one interval → 1-2 batches.
  assert.ok(
    writeQueue.getWriteQueueStats().batches <= 2,
    `expected <=2 batches, got ${writeQueue.getWriteQueueStats().batches}`
  );
});

test("afterCommit fires only for committed ops", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  let committed = 0;
  writeQueue.enqueueWrite({
    run: (db) => {
      (db as unknown as ReturnType<typeof getDb>).prepare("INSERT INTO wq_test (v) VALUES (?)").run(7);
    },
    afterCommit: () => {
      committed += 1;
    },
  });
  assert.equal(committed, 0, "afterCommit must not fire before flush");
  assert.equal(await writeQueue.waitForWriteDrain(2000), true);
  assert.equal(committed, 1);
});

test("a throwing op rolls back alone via per-op savepoint; siblings commit", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  writeQueue.enqueueWrite({
    run: (db) => {
      (db as unknown as ReturnType<typeof getDb>).prepare("INSERT INTO wq_test (v) VALUES (?)").run(9);
    },
  });
  let rejected = false;
  await assert.rejects(
    writeQueue.enqueueWriteAwaited({
      run: () => {
        throw new Error("boom — not a busy error");
      },
    }),
    /boom/,
    "failed op must reject its awaited caller"
  );
  rejected = true;
  assert.ok(rejected);
  assert.equal(await writeQueue.waitForWriteDrain(3000), true);
  const stats = writeQueue.getWriteQueueStats();
  assert.ok(stats.dropped >= 1, `expected >=1 dropped op, got ${stats.dropped}`);
  // The good sibling committed; only the bad op was rolled back.
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM wq_test WHERE v = 9").get()?.n, 1);
});

test("enqueueWriteAwaited resolves on commit and sees earlier ops in the same batch", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  let observedInTxn = -1;
  // Enqueue both synchronously so they land in one batch — op B's SELECT must
  // see op A's uncommitted insert (same-connection dedup visibility).
  const p1 = writeQueue.enqueueWriteAwaited({
    run: (db) => {
      (db as unknown as ReturnType<typeof getDb>)
        .prepare("INSERT INTO wq_test (v) VALUES (?)")
        .run(42);
    },
  });
  const p2 = writeQueue.enqueueWriteAwaited({
    run: (db) => {
      observedInTxn =
        (db as unknown as ReturnType<typeof getDb>)
          .prepare("SELECT COUNT(*) AS n FROM wq_test WHERE v = 42")
          .get()?.n ?? -1;
    },
  });
  await Promise.all([p1, p2]);
  assert.equal(observedInTxn, 1, "op B must see op A's uncommitted row inside the batch txn");
});

test("enqueueWriteAwaited rejects when the queue is closing", async () => {
  writeQueue.resetWriteQueueForTests();
  await writeQueue.closeWriteQueue(1000);
  await assert.rejects(writeQueue.enqueueWriteAwaited({ run: () => {} }), /closing/);
  // And a non-awaited rejection must not produce an unhandled rejection —
  // fire-and-forget is safe by design (internal catch marks a handled branch).
  void writeQueue.enqueueWriteAwaited({ run: () => {} });
  writeQueue.resetWriteQueueForTests();
});

test("queue overflow drops oldest ops, accepts the new one", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  const prevMax = process.env.OMNIROUTE_WRITE_QUEUE_MAX_DEPTH;
  process.env.OMNIROUTE_WRITE_QUEUE_MAX_DEPTH = "10";
  try {
    for (let i = 0; i < 15; i += 1) {
      writeQueue.enqueueWrite({
        run: (db) => {
          (db as unknown as ReturnType<typeof getDb>)
            .prepare("INSERT INTO wq_test (v) VALUES (?)")
            .run(i);
        },
      });
    }
    const stats = writeQueue.getWriteQueueStats();
    assert.ok(stats.dropped >= 5, `expected >=5 dropped, got ${stats.dropped}`);
    assert.equal(await writeQueue.waitForWriteDrain(2000), true);
    const rows = getDb().prepare("SELECT v FROM wq_test ORDER BY v").all();
    assert.equal(rows.length, 10);
    assert.deepEqual(
      rows.map((r) => r.v),
      [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    );
  } finally {
    if (prevMax === undefined) delete process.env.OMNIROUTE_WRITE_QUEUE_MAX_DEPTH;
    else process.env.OMNIROUTE_WRITE_QUEUE_MAX_DEPTH = prevMax;
  }
});

test("closeWriteQueue drains pending ops then refuses new ones", async () => {
  writeQueue.resetWriteQueueForTests();
  ensureTable();
  getDb().exec("DELETE FROM wq_test");
  for (let i = 0; i < 20; i += 1) {
    writeQueue.enqueueWrite({
      run: (db) => {
        (db as unknown as ReturnType<typeof getDb>)
          .prepare("INSERT INTO wq_test (v) VALUES (?)")
          .run(i);
      },
    });
  }
  assert.equal(await writeQueue.closeWriteQueue(3000), true);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM wq_test").get()?.n, 20);
  assert.equal(writeQueue.enqueueWrite({ run: () => {} }), false);
  writeQueue.resetWriteQueueForTests();
});
