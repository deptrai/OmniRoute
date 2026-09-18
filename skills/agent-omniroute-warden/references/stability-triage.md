---
name: stability-triage
description: Read OmniRoute's logs and state, classify every recent failure to its correct layer, and name the lever or escalation that addresses it
code: st
---

# Stability Triage

The outcome is a classification of OmniRoute's recent failures that your owner can act on mid-incident: each failure pinned to its layer — **request-scoped**, **connection/account**, **quota-drain**, or **provider-outage** — with the log evidence behind the call and the lever that addresses it. The owner consumes this to decide: change a setting, accept a fallback, wait out a cooldown, or escalate to a code fix. A wrong classification is the expensive failure here — a request-scoped error treated as provider trouble opens a circuit breaker and blacks out a healthy provider; a stale breaker treated as an outage sends the owner chasing a provider that was never down.

Hold this bar:

- **Evidence, always.** Every classification cites the log line, status code, or DB row. No "provider is down" from a single 503 — one error is a data point, not a verdict.
- **Breaker state is not upstream health.** An open circuit breaker only means the counter tripped; the provider behind it may be perfectly fine. If a breaker is suspect, probe the upstream directly with a bypass (`x-internal-test: combo-health-check` header skips the breaker and accounting) before calling anything dead.
- **Replicas are independent.** Circuit breakers are per-process in-memory. With N replicas, each holds its own state — check all of them; one open breaker is not the fleet.
- **Quota-drain is expected, not an outage.** Accounts exhausting quota is the system working — connection-level lock, next account serves. It becomes a problem only when it feeds the provider breaker or the pool runs dry.
- **Correlate before concluding.** Group failures by provider, model, account, combo, and time. A burst of the same upstream fault across sessions is one sick provider; scattered distinct errors are something else.

Non-inferables — the wiring you cannot guess:

- **Logs:** the deployment's docker service logs (SSH host + service name are in BOND.md's deployment map) and the SQLite `call_logs` table under the data path. Connection/account state (cooldowns, last errors, quota) lives in `provider_connections`; resilience config in the `key_value` settings namespace.
- **The layer taxonomy** (learned from real incidents): `4xx`/`content_policy`/`prompt too long`/deterministic payload faults are request-scoped — they must not cool an account or feed the breaker. `permission_denied: an internal error occurred` and similar wrapped upstream faults are the historical trap — surfaced as generic `502`/`503`, they cool the sole account and feed the breaker unless an error rule narrows them. `5xx`/timeouts with a quota signal are quota-drain — lock the account, never the breaker. Genuine `5xx`/timeouts with no quota signal are the only thing that should feed the provider breaker (trip codes are `408, 500, 502, 503, 504`).
- **Breaker escalation is sticky:** repeated open→probe-fail cycles back off the reset timeout multiplicatively (up to ~8×), so a tripped breaker can linger minutes past the upstream's recovery. That is why bypass-probing beats waiting.

Report per failure group: the layer, the evidence, the blast radius (which provider/model/combo/replica), and the recommended lever — or "needs `config-doctor`" / "needs a code fix" when triage shows the config surface can't reach it. Check MEMORY.md for this deployment's known quirks and past incidents before concluding — a pattern you've seen before should be named, not rediscovered.
