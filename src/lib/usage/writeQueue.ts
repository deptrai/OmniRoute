/**
 * Single-writer batch queue for request-scoped persistence (architecture spine
 * AD-1: no synchronous SQLite on the request path).
 *
 * Callers enqueue ops; the queue flushes them in ONE transaction either every
 * FLUSH_INTERVAL_MS or when the queue reaches BATCH_FLUSH_SIZE, whichever comes
 * first. better-sqlite3 is synchronous — batching collapses hundreds of
 * per-request transactions (each paying its own WAL/fsync and lock acquisition)
 * into one commit, and keeps individual write latency off the request path.
 *
 * Each op runs inside a per-op SAVEPOINT, so one malformed op rolls back alone
 * instead of poisoning the whole batch. Ops enqueued while the queue is idle
 * flush on the next macrotask, so `enqueueWriteAwaited` callers pay ~0ms at low
 * load and only queue delay under bursts.
 *
 * Durability window: rows sit in process memory until the next flush — bounded
 * by FLUSH_INTERVAL_MS under normal flow and by MAX_QUEUE_DEPTH under
 * backpressure — and are lost on SIGKILL/uncaughtException. A `beforeExit` hook
 * performs a last-chance synchronous drain; graceful shutdown drains via
 * `closeWriteQueue` (wired from `closeCallLogSaves` → `gracefulShutdown`).
 *
 * Only ONE module may own a writer queue — new sinks register ops here, they do
 * not create parallel queues (spine AD-1).
 */
import { getDbInstance } from "../db/core";
import { registerDbStateResetter } from "../db/stateReset";

export interface QueuedWriteOp {
  /** Execute one or more statements inside the batch transaction. */
  run: (db: ReturnType<typeof getDbInstance>) => void;
  /** Invoked only if the batch transaction committed (e.g. event emit). */
  afterCommit?: () => void;
  /** Short label for metrics/error logs, e.g. "call_logs.insert". */
  label?: string;
  /** Internal: settle hooks wired by {@link enqueueWriteAwaited}. */
  resolve?: () => void;
  reject?: (err: unknown) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_BATCH_FLUSH_SIZE = 200;
const DEFAULT_MAX_BATCH_OPS = 500;
const DEFAULT_MAX_QUEUE_DEPTH = 5_000;
const MAX_FLUSH_RETRIES = 5;
const BUSY_RETRY_BASE_MS = 50;
const EXIT_FLUSH_PASSES = 3;

type DbHandle = ReturnType<typeof getDbInstance>;

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getFlushIntervalMs() {
  return envInt("OMNIROUTE_WRITE_QUEUE_FLUSH_MS", DEFAULT_FLUSH_INTERVAL_MS);
}
function getBatchFlushSize() {
  return envInt("OMNIROUTE_WRITE_QUEUE_BATCH_SIZE", DEFAULT_BATCH_FLUSH_SIZE);
}
function getMaxBatchOps() {
  return envInt("OMNIROUTE_WRITE_QUEUE_MAX_BATCH", DEFAULT_MAX_BATCH_OPS);
}
function getMaxQueueDepth() {
  return envInt("OMNIROUTE_WRITE_QUEUE_MAX_DEPTH", DEFAULT_MAX_QUEUE_DEPTH);
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_TIMEOUT" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_BUSY_SNAPSHOT"
  ) {
    return true;
  }
  return /locked|busy/i.test(error instanceof Error ? error.message : String(error));
}

/** Prefer BEGIN IMMEDIATE (write txns must not read-lock-then-upgrade). */
function runWriteTransaction(db: DbHandle, fn: () => void): void {
  const adapter = db as unknown as { immediate?: (f: () => void) => void };
  if (typeof adapter.immediate === "function") {
    adapter.immediate(fn);
    return;
  }
  const txn = db.transaction(fn) as unknown as (() => void) & { immediate?: () => void };
  if (typeof txn.immediate === "function") {
    txn.immediate();
    return;
  }
  txn();
}

function labelsOf(ops: QueuedWriteOp[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) {
    const key = op.label ?? "unlabeled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k}×${n}`).join(", ");
}

let queue: QueuedWriteOp[] = [];
let flushing = false;
let timer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let backoffUntil = 0;
let consecutiveFlushFailures = 0;
let closing = false;
let exitHookRegistered = false;

const stats = {
  enqueued: 0,
  flushed: 0,
  dropped: 0,
  errors: 0,
  batches: 0,
};

function isDrained() {
  return !flushing && queue.length === 0;
}

function ensureTimer() {
  if (timer || closing) return;
  timer = setInterval(() => flushWrites(), getFlushIntervalMs());
  timer.unref?.();
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("beforeExit", () => {
    // Last-chance synchronous drain for non-graceful exits (CLI entry points,
    // scripts). Bounded passes — a permanently busy DB must not hang exit.
    backoffUntil = 0;
    let guard = EXIT_FLUSH_PASSES;
    try {
      while (queue.length > 0 && guard-- > 0) flushWrites();
    } catch {
      // process is exiting; nothing useful left to do
    }
  });
}

function flushWrites() {
  if (flushing || queue.length === 0) return;
  if (Date.now() < backoffUntil) return;

  flushing = true;
  const batch = queue.splice(0, getMaxBatchOps());
  const succeeded: QueuedWriteOp[] = [];
  const failed: Array<[QueuedWriteOp, unknown]> = [];
  try {
    const db = getDbInstance();
    runWriteTransaction(db, () => {
      for (const op of batch) {
        try {
          // Nested transaction → per-op SAVEPOINT on every driver, so one bad
          // op rolls back alone instead of dropping the whole batch.
          db.transaction(() => op.run(db))();
          succeeded.push(op);
        } catch (opError) {
          failed.push([op, opError]);
        }
      }
    });
    consecutiveFlushFailures = 0;
    stats.flushed += succeeded.length;
    stats.batches += 1;
    for (const op of succeeded) {
      try {
        op.afterCommit?.();
      } catch (err) {
        console.error("[writeQueue] afterCommit error:", err);
      }
      op.resolve?.();
    }
    if (failed.length > 0) {
      stats.errors += failed.length;
      stats.dropped += failed.length;
      for (const [op, err] of failed) op.reject?.(err);
      console.error(
        `[writeQueue] ${failed.length} op(s) failed and were rolled back individually: ${labelsOf(
          failed.map(([op]) => op)
        )} — first error:`,
        failed[0][1]
      );
    }
  } catch (error) {
    stats.errors += 1;
    consecutiveFlushFailures += 1;
    if (isBusyError(error) && consecutiveFlushFailures <= MAX_FLUSH_RETRIES) {
      // Requeue at the front, preserving order; retry with linear backoff.
      queue = [...batch, ...queue];
      const delayMs = BUSY_RETRY_BASE_MS * consecutiveFlushFailures;
      backoffUntil = Date.now() + delayMs;
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flushWrites();
        }, delayMs);
        retryTimer.unref?.();
      }
    } else {
      // Reset the counter — the next batch is a fresh attempt and must not
      // inherit this batch's spent retry budget.
      consecutiveFlushFailures = 0;
      stats.dropped += batch.length;
      for (const op of batch) op.reject?.(error);
      console.error(
        `[writeQueue] dropping ${batch.length} ops (${labelsOf(batch)}):`,
        error
      );
    }
  } finally {
    flushing = false;
    // Still queued (batch limit or shutdown drain) — keep flushing on the next
    // macrotask unless we're inside a backoff window.
    if (queue.length > 0 && Date.now() >= backoffUntil) setImmediate(flushWrites);
  }
}

/**
 * Enqueue a write op. Returns false only when the queue is closing — a full
 * queue still accepts the op under drop-oldest policy (the oldest queued ops
 * are evicted and their awaited callers rejected).
 */
export function enqueueWrite(op: QueuedWriteOp): boolean {
  if (closing) return false;
  const maxDepth = getMaxQueueDepth();
  if (queue.length >= maxDepth) {
    const evicted = queue.splice(0, queue.length - maxDepth + 1);
    stats.dropped += evicted.length;
    const err = new Error("[writeQueue] dropped by queue-depth overflow");
    for (const evict of evicted) evict.reject?.(err);
    console.error(
      `[writeQueue] queue full — evicted ${evicted.length} oldest ops: ${labelsOf(evicted)}`
    );
  }
  queue.push(op);
  stats.enqueued += 1;
  registerExitHook();
  ensureTimer();
  // Eager flush when idle: first op after an empty queue commits on the next
  // macrotask so awaited callers pay ~0ms at low load. During bursts the
  // interval/batch-size paths keep batching.
  if (queue.length === 1 || queue.length >= getBatchFlushSize()) {
    if (Date.now() >= backoffUntil) setImmediate(flushWrites);
  }
  return true;
}

/**
 * Enqueue a write op and resolve once its batch transaction commits. Rejects
 * when the op is dropped (queue overflow, repeated flush failure, or the queue
 * is already closing). Callers needing durability should await this; callers
 * that fire-and-forget are safe — an internal catch marks a handled branch so
 * non-awaiting callers never produce an unhandled rejection.
 */
export function enqueueWriteAwaited(op: QueuedWriteOp): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    if (!enqueueWrite({ ...op, resolve, reject })) {
      reject(new Error("[writeQueue] closing — op not accepted"));
    }
  });
  promise.catch(() => {});
  return promise;
}

export function isWriteQueueClosing() {
  return closing;
}

export function getWriteQueueStats() {
  return { depth: queue.length, flushing, closing, ...stats };
}

/** Resolve once the queue is empty and no flush is in-flight. */
export function waitForWriteDrain(timeoutMs = 10_000): Promise<boolean> {
  if (isDrained()) return Promise.resolve(true);
  const ms = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 10_000;
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const check = () => {
      if (isDrained()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 50).unref?.();
    };
    check();
  });
}

/** Stop accepting ops and drain what's left. */
export async function closeWriteQueue(timeoutMs = 10_000): Promise<boolean> {
  closing = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  flushWrites(); // synchronous drain pass; loop in finally keeps going if needed
  return waitForWriteDrain(timeoutMs);
}

/**
 * Reset all queue state — pending ops are REJECTED so awaited callers never
 * hang. Registered as a DB-state resetter so backup/restore flows (which call
 * `resetDbInstance`) cannot silently flush stale ops into a restored database.
 */
export function resetWriteQueueForTests() {
  const pending = queue;
  queue = [];
  for (const op of pending) {
    op.reject?.(new Error("[writeQueue] queue reset — op dropped uncommitted"));
  }
  flushing = false;
  closing = false;
  consecutiveFlushFailures = 0;
  backoffUntil = 0;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  stats.enqueued = 0;
  stats.flushed = 0;
  stats.dropped = 0;
  stats.errors = 0;
  stats.batches = 0;
}

registerDbStateResetter(resetWriteQueueForTests);
