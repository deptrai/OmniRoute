# Pattern: Clearing stale provider cooldowns

Applies whenever code resets a `provider_connections` row that has a future
`rate_limited_until`, a non-active `test_status`, or an error field set.

## When this happens

- `setQuotaCache` detects that an account's quota has recovered and wants to
  clear the DB cooldown.
- Startup / crash recovery proactively clears elapsed cooldowns.
- Dashboard / operator actions reset a connection.

## Rules

### 1. Never clear terminal statuses

Terminal statuses (`banned`, `expired`, `credits_exhausted`) must persist until
an operator or credential change resolves them. The canonical set is defined in
`src/lib/quota/connectionRecovery.ts`:

<ref_snippet file="/Users/luisphan/Documents/GitHub/OmniRoute/src/lib/quota/connectionRecovery.ts" lines="39-43" />

Why this matters: some 402 paths in `chatCore.ts` set
`testStatus = "credits_exhausted"` while `lastErrorType` is still
`quota_exhausted` from `classifyProviderError`:

<ref_snippet file="/Users/luisphan/Documents/GitHub/OmniRoute/open-sse/handlers/chatCore.ts" lines="3325-3330" />

Clearing only by `lastErrorType` would incorrectly re-activate a
`credits_exhausted` connection.

### 2. Reset `backoffLevel` when clearing transient errors

`clearAccountError` and `clearStaleCrashCooldowns` both reset `backoff_level`:

<ref_snippet file="/Users/luisphan/Documents/GitHub/OmniRoute/src/sse/services/auth.ts" lines="2283-2292" />

Any cooldown-clear path must also set `backoff_level = 0`. Otherwise the
connection can be marked active while still carrying a high backoff multiplier
from previous failures.

### 3. Use `PROVIDER_ERROR_TYPES` constants

Do not use the raw string `"quota_exhausted"`. The canonical constant lives in
`open-sse/services/errorClassifier.ts`:

<ref_snippet file="/Users/luisphan/Documents/GitHub/OmniRoute/open-sse/services/errorClassifier.ts" lines="68-80" />

### 4. Log errors, do not swallow them

`catch` blocks should use `console.error` / `console.warn` so failures are
observable. Empty `catch` blocks make silent partial writes impossible to debug.

### 5. Avoid TOCTOU when clearing from a snapshot

If the code reads a connection, decides to clear it, and then writes, a fresh
429 may arrive in between and update the row. Use a conditional single-row SQL
update that only succeeds when the snapshot values still match. See
`src/lib/db/providers/rateLimit.ts::clearQuotaCooldownIfUnchanged`.

### 6. No `setTimeout` in tests for async DB writes

Tests that wait for async DB effects must poll or await the promise. Hard-coded
sleeps are non-deterministic and hide flakiness.

## See also

- `src/lib/db/providers/rateLimit.ts`
- `src/domain/quotaCache.ts`
- `open-sse/executors/antigravity.ts`
- `src/lib/quota/connectionRecovery.ts`
