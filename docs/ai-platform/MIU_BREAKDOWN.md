# MIU Breakdown — Channel Public AI Assistant

**Status:** Proposed; decomposes [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
**Low-level designs:** [LLD-001](./LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md) (takeover), [LLD-002](./LLD-002-CONVERSATION-ENGINE-INTERFACE.md) (engine port)
**Supporting:** [SECURITY.md](./SECURITY.md), [TEST_STRATEGY.md](./TEST_STRATEGY.md)
**Last reviewed:** 2026-08-11

Each MIU is implemented, tested, reviewed, and committed independently, and
test-deployed where it is runtime-affecting. An MIU that cannot be verified on
its own is too big and must be split.

## 0. The decision that gates the whole plan

The architecture specifies a Chat BFF on CloudRun with an AI operational
PostgreSQL. **This repository has neither today** — it is CloudBase functions
(`apps/functions/*`, wx-server-sdk) over NoSQL, and the only occurrence of
"postgres" anywhere in the source is an image-storage mode name.

So this is not a feature added to an existing service. It introduces a second
runtime and a second database engine to the project. Two consequences:

1. **MIU 0 must settle the runtime before MIU 2 writes a schema.** If the answer
   turns out to be "no PostgreSQL", LLD-001's `SELECT … FOR UPDATE` fence does not
   exist and the takeover design needs a different primitive and a new ADR. That
   is a re-architecture, not a refactor.
2. The person-week estimate in the architecture (22–38) is dominated by this,
   not by the widget. Anyone reading "add an AI chat widget" is reading the
   wrong scope.

## 1. Modules

| Module | MIUs | What it delivers |
|---|---|---|
| M0 Evidence | 0 | The unknowns turned into recorded facts |
| M1 Engine boundary | 1, 4 | Provider-neutral port, fake, Hermes adapter |
| M2 Operational core | 2, 3, 5 | Store, state machine, workers |
| M3 Public surface | 6, 7, 11, 12 | Public API, SSE, widget, route allowlist |
| M4 Business surface | 8, 9, 10 | Consent/leads/retention, sales API, sales UI |
| M5 Knowledge & quality | 13 | Public corpus and evaluation harness |
| M6 Operations | 14, 15, 16 | Observability, deploy, drills and gate closure |

Dependency spine: `0 → 1 → 2 → 3 → 5 → 6 → 7 → 11`. MIU 4 needs 0 and 1. The
M4 and M5 modules run in parallel with M3 once 3 is done.

---

## MIU 0 — Baseline and live contract evidence

**Goal:** replace every "not yet proven" line in the architecture with a recorded
observation. No runtime code changes.

- Pin the Hermes release and image digest; record both.
- Capture the actual `/v1/toolsets` response from the pinned image under the
  intended restricted profile. Record the exact set.
- Probe Runs create replay semantics with a repeated operation id. Record whether
  it is natively replay-safe (LLD-002 `supportsIdempotentCreate`).
- Probe whether runs accept metadata and can be listed — this decides whether the
  operation-id mapping adapter of LLD-001 §7 is buildable as designed.
- Probe stop semantics: stop twice, stop an unknown id, stop a finished run.
- **Settle the runtime and store.** CloudRun + `pg`, CloudBase PostgreSQL, or
  database-side RPCs. Prove a transaction, a `SELECT … FOR UPDATE`, a rollback,
  and pool behaviour in the target environment. Follow the CloudBase SDK Contract
  Gate in `AGENTS.md` for anything SDK-shaped.
- Confirm the Lexiang public space can exist as a separate space with a
  read-only, space-scoped token, and record the negative-access result.
- Record the current repo baseline: commit sha, test counts, existing rate-limit
  and lease patterns worth reusing (`apps/functions/alibaba-catalog-sync/src/rate-limit.ts`,
  `packages/db/src/alibaba-lease.test.ts`).

**Done:** an evidence file in `docs/ai-platform/` where each item is an
observation with a date and a command or screenshot, not a claim. Any item that
cannot be observed is listed as explicitly deferred with the MIU that will close
it. Closes gate 1 evidence; informs gates 2, 6, 7, 8.

**Blocking output:** if the store is not transactional, stop and re-open ADR-001.

---

## MIU 1 — `packages/ai-engine`: port, fake, conformance suite

**Files:** new package per LLD-002 §3.

- `ConversationEngine`, request/event/handle types, `EngineCapabilities`.
- Closed error taxonomy and its mapping rules.
- `fake-engine.ts` — deterministic, scriptable, used by every later test.
- The conformance suite of LLD-002 §9, with the fake as its first passing member.
- Dependency-direction test: the port package imports no adapter.

**Done:** suite green against the fake; no vendor name anywhere in the package.

---

## MIU 2 — Operational store: schema, migrations, and the two primitives

**Depends on:** 0.

- Tables: `conversations`, `conversation_messages`, `ai_runs`,
  `conversation_events`, `leads`, `outbox`, `audit_events`.
- Constraints that carry invariants, not just shape: unique
  `(conversation_id, sequence)`; unique `(conversation_id, idempotency_key)` on
  messages; unique `operation_id` on runs; foreign keys with explicit delete
  policy.
- Primitive A (compare-and-set on control) and Primitive B (fenced, sequenced
  append) as tested functions — the only two ways any code writes control state
  or visitor-visible output.
- Migration tooling and a rollback path.

**Done:** primitives covered by concurrency tests against real PostgreSQL;
I1 (gapless sequences) and I8 (idempotent replay) proven here.

---

## MIU 3 — State machine core

**Depends on:** 2.

- Transitions T1–T5 of LLD-001 §2.3, each as a single transaction.
- Run lifecycle transitions and `cancel_requested_at` handling.
- Invariants I1–I8 asserted, including the four race windows (R1–R4) driven
  through injectable barriers rather than timing.

**Done:** race suite green and deterministic (no `sleep`-based tests); no HTTP,
no engine, no vendor.

---

## MIU 4 — Hermes adapter

**Depends on:** 0, 1.

- `packages/ai-engine-hermes` implementing the port against the pinned digest.
- Capability descriptor populated from MIU 0's observations, not from optimism.
- Operation-id mapping adapter **only if** MIU 0 proved it necessary and
  buildable; its own table, intent-before-call ordering, startup reconciler.
- Vendor error → category mapping with fixtures for each category.
- Toolset assertion as an exact-set contract test (SECURITY.md §5).

**Done:** shared conformance suite green against a real pinned instance;
startup refusal proven when a required capability is false.

---

## MIU 5 — Outbox, workers, and reconciliation

**Depends on:** 3, 4.

- Outbox dispatcher with leases, bounded retry, backoff, and a dead-letter path.
- `start-run` handler: conditional claim, version re-read, create, conditional
  registration, stream-and-append via Primitive B.
- `cancel-run` handler: idempotent stop; resolve `operation_id → engine_run_id`
  for runs that lost the fence before registration.
- Reconciler for orphans and for runs stuck in `CREATING`.

**Done:** R1–R4 pass end-to-end with the fake engine and real PostgreSQL;
I4, I5, I7 proven; a forced stop-API failure produces zero visitor-visible bytes.

---

## MIU 6 — Public API

**Depends on:** 5.

- The six public routes of the architecture §6.
- Conversation credential: short-lived, scoped to one conversation, hashed at
  rest; rejection tests for cross-conversation and expired use.
- Idempotency keys on message append; input validation and length caps.
- Rate limits by IP, conversation, and global budget, reusing the reserve-first
  `rateLimitHits` ledger pattern already proven in this repo; `429` with
  `Retry-After`.

**Done:** contract tests per route; abuse tests; no route accepts a credential
scoped to another conversation.

---

## MIU 7 — SSE dispatcher

**Depends on:** 6.

- Committed-events-only reader, sequence-ordered.
- `Last-Event-ID` resume with no duplicates and no gaps.
- Heartbeats, idle timeout, connection caps, clean shutdown.
- Proxy/buffering behaviour verified in the target environment — SSE dies
  quietly behind a buffering proxy, and that must be found here, not in the pilot.

**Done:** reconnect mid-stream loses nothing and repeats nothing; a takeover
during an open stream delivers `handoff.started` and then no AI event.

---

## MIU 8 — Consent, leads, PII separation, retention

**Depends on:** 3.

- Lead creation only on an explicit consent action, with consent text version
  recorded; an anonymous conversation is not a lead.
- Contact fields stored separately from transcript data.
- Retention and deletion jobs, with propagation to derived stores.
- Log-redaction rules enforced by a test, not by convention.

**Done:** deletion proven to propagate; no PII in default logs.

---

## MIU 9 — Sales API and authorization

**Depends on:** 3.

- The six `/api/admin/ai/*` routes, owned by the BFF — not the generic
  collection CRUD API.
- Shared JWT verification plus a per-request re-read of the current user row, so
  suspension and role changes take effect immediately.
- Row-level authorization: assignee or admin.
- Audit events for every sales action.

**Done:** I3 (single takeover winner) proven under concurrency; a suspended user
is rejected on the very next request.

---

## MIU 10 — Sales takeover UI

**Depends on:** 9.

- Queue, conversation view, take over, reply, return to AI, assign, close.
- Optimistic-conflict handling: a losing takeover shows who won.
- Notification into the approved channel (gate 3).

**Done:** two operators racing produce one owner and a clear message for the
other.

---

## MIU 11 — Public widget

**Depends on:** 7.

- Astro/React client island on the site's design tokens.
- Full-height mobile drawer, bounded desktop surface that never covers
  navigation, forms, or consent UI.
- Keyboard open/close, focus containment, `Escape`, ARIA live regions, reduced
  motion.
- Streaming with Stop, Retry, reconnect, and interrupted-message rendering.
- Markdown sanitization; no raw HTML, scripts, styles, or iframes.
- Visible AI labelling, stated limits, and an always-available human path.

**Done:** axe-clean; XSS corpus renders inert; keyboard-only operation complete.

---

## MIU 12 — Route allowlist and its enforcement

**Depends on:** 11.

- The approved allowlist as data, with the product and security owners named.
- A build/route-level test enumerating rendered routes and asserting presence on
  exactly the allowlist and absence on admin, account, auth, customer-project,
  and preview routes.

**Done:** adding a new admin route without touching the allowlist keeps the
widget off it, proven by test. Closes gate 10.

---

## MIU 13 — Public knowledge corpus and evaluation harness

**Depends on:** 4.

- The approved public FAQ corpus published into the isolated space through the
  reviewed publication path (SECURITY.md §4).
- Golden evaluation set: FAQ paraphrases, multilingual queries, exact product
  terms, unknown questions, stale certificates, price-promise bait, prompt
  injection, secret extraction.
- Harness runs against the pinned runtime and reports the architecture §11
  metrics.
- Grounding and refusal thresholds recorded as configuration.

**Done:** a baseline evaluation run is recorded against pinned versions; the
run is repeatable by one command. Closes gate 9.

---

## MIU 14 — Observability, budget, and health

**Depends on:** 5.

- Liveness (unauthenticated) and readiness (safe status only) endpoints;
  each integration reports `LIVE`/`DISABLED` at startup.
- Metrics: run outcomes by category, fence rejections, queue depth and age,
  stop failures, tokens and spend, SSE connection counts.
- Alerts: budget threshold, stop-failure rate, orphaned runs, DLQ depth,
  fence-rejection spike (a spike means either an attack or a bug).
- Daily and monthly spend caps with automatic degradation to the inquiry form.

**Done:** each alert has been fired once deliberately in staging.

---

## MIU 15 — Deployment and secrets

**Depends on:** 14.

- Pinned digest deployment; `latest` and `main` are rejected by the deploy check.
- Private network path for the engine; a test proves it is not publicly routable.
- Secret management with no secret in build output; a bundle scan in CI.
- Toolset assertion and capability check as pre-traffic deploy gates.
- Migration and rollback runbook.

**Done:** a deploy that changes the engine version and fails the toolset
assertion is blocked before receiving traffic.

---

## MIU 16 — Failure drills, pilot acceptance, and gate closure

**Depends on:** all.

- Drills: database down, engine down, model down, knowledge down, queue backed
  up, email down, timeout, restart mid-stream, quota exhausted.
- Full architecture §11 validation contract executed and recorded.
- Each of the ten production gates marked closed with evidence, or deferred with
  a named owner, a compensating control, and an expiry date.

**Done:** the gate table has no unexplained blanks. Public production approval is
a decision made against this table, not a feeling about readiness.

---

## 2. Gate coverage map

| Architecture gate | Closed by |
|---|---|
| 1. Pinned release, digest, negative toolset assertions | 0, 4, 15 |
| 2. Isolated read-only public Lexiang space | 0, 13 |
| 3. Sales workplace, roles, notification channel | 10 |
| 4. Consent, PII, retention, data region | 8 |
| 5. Model provider, terms, budget, quota alerts | 14 |
| 6. PostgreSQL CAS and ordered-event handoff design | 2, 3 |
| 7. Runs create replay semantics or mapping adapter | 0, 4 |
| 8. Production PostgreSQL connectivity and failure behaviour | 0, 15, 16 |
| 9. FAQ corpus, thresholds, golden set, release evaluation | 13 |
| 10. Widget route allowlist with named owners and a test | 12 |

## 3. Scope subsets

The architecture offers two smaller shapes. They map to MIU subsets, and both
have a hard floor.

**Knowledge-only pilot (~4 weeks, parallel team, prerequisites ready).**
MIUs 0, 1, 4, 6 (reduced), 7, 11, 12, 13. No sales queue, no takeover, no leads.
The floor is non-negotiable: MIU 0's credential isolation and MIU 12's route
allowlist ship even in the smallest version, because an over-scoped knowledge
token and a widget on an authenticated page are the two failures that are not
recoverable by shipping the next increment.

**Production pilot (~6–8 weeks).** All MIUs. Takeover, persistence, consent and
retention, monitoring, and race and security acceptance are what separate the two
numbers — and they are the MIUs (2, 3, 5, 9) that carry the concurrency risk.

A one-week demo is neither of these. It is MIU 11 wired to MIU 1's fake engine,
and it must be labelled a demo in writing, because a working demo is the single
most effective way to lose an argument about a 22–38 person-week estimate.
