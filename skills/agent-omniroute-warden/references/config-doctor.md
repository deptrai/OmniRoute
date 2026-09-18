---
name: config-doctor
description: Pick the smallest config lever that fixes a diagnosed OmniRoute symptom — snapshot before mutating, verify after, always reversible
code: cd
---

# Config Doctor

The outcome is the smallest configuration change that resolves a diagnosed symptom — the right lever at the right layer — proposed with its blast radius, applied only with the owner's approval, and always reversible: snapshot before you mutate, verify the effect after, and record the before/after in MEMORY.md so future-you can roll it back or learn from it. The owner consumes your recommendation to decide; future-you consumes the record to not re-litigate a change. A change that can't be undone, or one whose blast radius you didn't name, is unfinished — and reaching for a source edit while a config lever still reaches the problem is the specific failure this capability exists to prevent.

Hold this bar:

- **Smallest lever first.** Narrowest scope that reaches the problem: a `providerErrorRules` entry before a global threshold, a model-scoped cooldown before a connection-scoped one, one connection's flag before the provider's profile.
- **Name the blast radius.** Every lever you touch — say which providers/models/connections it actually affects. `providerBreaker.oauth` thresholds move for every OAuth-profile provider at once, not just the one you're fixing; per-connection flags and error rules are the surgical tools.
- **Config before code, always.** If you conclude no config surface reaches the problem, you must name the surfaces you checked — settings key, env var, error rule, combo target, connection flag — and why each falls short. That claim needs evidence, not vibes.
- **Verify, don't assume.** After a change, confirm the effect in logs or a probe — not just that the write landed. A config that should stop 503s gets checked against actual 503s.

Non-inferables — the lever map you cannot guess:

- **Where config lives.** Live settings sit in the SQLite `key_value` settings namespace (`resilienceSettings`, `providerErrorRules`, combo definitions, etc.) and hot-reload within seconds of a write — a direct DB write or the API both take effect without a restart. `PATCH /api/resilience` covers the resilience block (request queue, cooldowns, breaker thresholds, quota preflight); `PUT /api/settings` covers `providerErrorRules`. Env vars (`OMNIROUTE_*`) set at process start.
- **The surgical levers.** `providerErrorRules` (max 50) match a provider+status+substring to a scope (`model`/`connection`/`provider`) and `cooldownMs` — this is how you narrow a misclassified error (e.g. a wrapped upstream `internal error` surfaced as `502`) down to a short model-scoped cool instead of a 60s connection blackout. Per-connection flags like `disableCooling` opt one connection out of transient cooldown — but check the code before flipping: some flags interact with the model-lockout path and can lock longer, not shorter. Combo targets and strategies live in the combo definitions.
- **The breaker-reset levers.** Breakers are per-replica in-memory. `DELETE /api/monitoring/health` calls `resetAllCircuitBreakers()` directly on that replica — the clean path. If it is unavailable, `PATCH /api/resilience` toggling `useUpstream429BreakerHints` fires the same reset as a side-effect (it needs a real state transition — flip back if the flag is already at the target value). Either way: hit every replica that needs it, and only after a bypass probe shows the upstream is actually healthy.
- **Quota handling.** `quotaPreflight` (already enabled in this deployment) drops nearly-drained accounts before dispatch so quota exhausts gracefully; account-level locks isolate a drained account from the pool without touching the breaker.
- **The repo is the reference.** `src/lib/resilience/settings.ts` defines every resilience knob and its default; `open-sse/config/providerErrorRules.ts` and `errorConfig.ts` define error classification; `src/sse/handlers/chat.ts` owns combo-path retry/fallback policy. Read them to know what a lever really does before turning it.

Escalate honestly: when triage shows a real code-path gap (e.g. upstream recognizes an error but the combo path deliberately skips that handler), say so plainly with the evidence — then let the owner decide whether to accept the workaround or commission a fix. Your job is the truth about the layers, not winning an argument for config.
