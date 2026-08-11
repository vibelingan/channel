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
(`apps/functions/*`, wx-server-sdk) over NoSQL. There is no PostgreSQL client, no
Dockerfile, no container tooling, no `services:` block in CI, and no way to run a
database locally; `apps/local-server` is a JSON-file adapter. The nearest thing
to "postgres" in the source is the string `'pg-storage'`, one value of an
image-storage mode enum.

So this is not a feature added to an existing service. It introduces a second
runtime and a second database engine to the project. Two consequences:

1. **MIU 0 must settle the runtime before MIU 2c writes a schema.** If the answer
   turns out to be "no PostgreSQL", LLD-001's conditional-`UPDATE` fence does not
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
| M2 Operational core | 2a–2d, 3, 5a–5e | Runtime, store, state machine, policy, workers |
| M3 Public surface | 6, 7, 11, 12 | Public API, SSE, widget, route allowlist |
| M4 Business surface | 8, 9, 9r, 10 | Consent/leads/retention, sales role, sales API, sales UI |
| M5 Knowledge & quality | 13a, 13b | Public corpus, evaluation harness |
| M6 Operations | 14, 14b, 15, 16 | Observability, budget enforcement, deploy, drills |

Dependency edges, which are the per-MIU `Depends on:` lines restated — if the two
ever disagree, the per-MIU lines win:

| MIU | Depends on |
|---|---|
| 0 | — (starts immediately) |
| 1 | — (starts immediately) |
| 2a | 0 |
| 2b | 2a |
| 2c | 2b |
| 2d | 2c |
| 3 | 2d |
| 4 | 0, 1 |
| 5a | 1 |
| 5b | 2d, 3 |
| 5c | 5a, 5b |
| 5d | 5c |
| 5e | 5b |
| 6 | 5c, 14b, 8 |
| 7 | 6 |
| 8 | 3 |
| 9r | 0 |
| 9 | 3, 9r |
| 10 | 9 |
| 11 | 7, 12a |
| 12a | — (allowlist data; must precede 11) |
| 12b | 11 |
| 13a | 0 |
| 13b | 1, 4, 5a |
| 14 | 5b |
| 14b | 2c |
| 15 | 14 |
| 16 | all |

Longest path: `0 → 2a → 2b → 2c → 2d → 3 → 5b → 5c → 6 → 7 → 11 → 12b`.

**MIU 1 depends on nothing** and starts on day zero, in parallel with MIU 0 —
the whole argument of LLD-002 is that the port is written before any vendor
knowledge exists. MIU 4 needs 0 and 1. The start-run handler (5c) needs **1, 3,
5a and 5b**, not the Hermes adapter: its acceptance runs against the fake engine,
and serializing the critical path behind a live-vendor MIU that is itself blocked
on external provisioning costs weeks of idle time. It is re-run against the real
adapter in MIU 16.

MIU 6 additionally needs 14b (budget enforcement must exist before the public API
it protects) and 8 (for the handoff and close routes). MIU 11 needs 12a, because
the allowlist data has to exist before anything mounts against it.

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
  operation-id mapping layer of LLD-001 §7 is buildable as designed.
- Probe stop semantics: stop twice, stop an unknown id, stop a finished run.
- **Settle the runtime and store.** CloudRun + `pg`, CloudBase PostgreSQL, or
  database-side RPCs. Prove a transaction, a conditional `UPDATE … RETURNING`, a rollback,
  and pool behaviour in the target environment. Follow the CloudBase SDK Contract
  Gate in `AGENTS.md` for anything SDK-shaped.
- Confirm the Lexiang public space can exist as a separate space with a
  read-only, space-scoped token, and record the negative-access result.
- **Decide the worker runtime and its trigger.** LLD-001's start-run handler
  streams engine events and appends per event, which is a long-lived process. The
  repo's only scheduling primitive is CloudBase timer triggers, and prior work
  established the test environment has none. This is a decision, not a detail —
  MIU 5b and 5c cannot be built without it.
- **Decide the context-assembly and redaction rule**: how many prior turns go
  into a run, whether a returned-to-AI conversation replays the salesperson's
  messages, and what is redacted. LLD-001 open question 3 and LLD-002 open
  question 4. Human turns routinely contain contact details the visitor gave a
  person, so this is a privacy decision, and leaving it to whoever writes MIU 5
  means it gets made silently.
- **Decide the language set.** Gate 9 requires approved supported languages and
  MIU 13b's golden set includes multilingual queries, but the site is English-only
  today. Either scope a locale MIU or record "English-only pilot" here and strip
  multilingual from the golden set.
- Record the model provider, data-processing terms, and region decisions
  (gates 4 and 5) — the architecture lists them unproven and no later MIU
  produces them.
- Record the current repo baseline: commit sha, test counts, existing rate-limit
  and lease patterns worth reusing (`apps/functions/alibaba-catalog-sync/src/rate-limit.ts`,
  `packages/db/src/alibaba-lease.test.ts`).

**Done:** an evidence file in `docs/ai-platform/` where each item is an
observation with a date and a command or screenshot, not a claim. Any item that
cannot be observed is listed as explicitly deferred with the MIU that will close
it. Closes gate 1 evidence; informs gates 2, 4, 5, 6, 7, 8.

**Run the store probe first, before anything else in this MIU.** If the store is
not transactional, stop and re-open ADR-001. That branch is not a setback to
absorb quietly: LLD-001's entire design is conditional `UPDATE … RETURNING`, and
ADR-001 already concedes the CloudBase PostgreSQL SDK exposes no full transaction
API, so the BFF must use the `pg` protocol or database-side RPCs. On that branch
MIU 1 and the widget survive; the operational core, the public API, and the sales
surface all need re-design. Name the decision owner and the re-plan budget here
rather than discovering both mid-implementation.

---

## MIU 1 — `packages/ai-engine`: port, fake, conformance suite

**Depends on:** nothing. Starts day zero, in parallel with MIU 0 — the argument
of LLD-002 is precisely that the port is written before any vendor knowledge
exists, so blocking it on evidence would defeat its purpose.

**Files:** new package per LLD-002 §3.

- `ConversationEngine`, request/event/handle types, `EngineCapabilities`.
- Closed error taxonomy and its mapping rules.
- `fake-engine.ts` — deterministic, scriptable, used by every later test.
- The conformance suite of LLD-002 §9, with the fake as its first passing member.
- Dependency-direction test: the port package imports no adapter.

**Done:** suite green against the fake; no vendor name anywhere in the package.

---

## MIU 2a — BFF service skeleton, runtime, and deploy path

**Depends on:** 0. **Nothing else in M2 can be verified until this exists.**

This MIU was missing from the first draft of this plan, and its absence is the
kind that stops work in week one: MIUs 2c and 2d require "concurrency tests
against real PostgreSQL", and nothing made a PostgreSQL exist for a test to talk
to.

- The BFF service itself: container image, service definition, health route,
  gateway route, CORS origin, secret and environment plumbing.
- PostgreSQL in CI (`services:` in the workflow) and locally (compose file), plus
  the connection, pool, and transaction harness — with the isolation level
  asserted at connection setup per LLD-001 §4.4.
- Local development parity: how a developer runs site + local-server + BFF +
  database together. The prior Alibaba work treated route mirroring in
  `apps/local-server` as mandatory; here the BFF is a separate runtime, so the
  answer is a compose file and a documented proxy, not a route copy.
- Deploy wiring and its drift tests, mirroring the existing function manifest
  discipline (`scripts/cloudbase-function-manifest.mjs` and its lockstep
  consumers) so a new deployable does not silently fall out of the manifest.

**Done:** a trivial route is reachable in CI, locally, and in the test
environment; a transaction and a rollback are proven against real PostgreSQL in
all three.

---

## MIU 2b — Migration tooling and rollback

**Depends on:** 2a.

Forward and backward migrations, applied in CI, with a documented rollback
runbook. Separate from the schema so that the tooling is proven before the first
real table depends on it.

**Done:** a migration applies and rolls back cleanly in CI and in the test
environment.

---

## MIU 2c — Schema and constraints

**Depends on:** 2b.

- Tables: `conversations`, `conversation_messages`, `ai_runs`,
  `conversation_events`, `leads`, `outbox`, `audit_events`, plus the AI rate-limit
  ledger (see below).
- Constraints that carry invariants, not just shape: unique
  `(conversation_id, sequence)`; unique `(conversation_id, idempotency_key)` on
  messages; unique `operation_id` on runs; the partial unique index enforcing one
  live run per conversation (I9); `run_id` on events; foreign keys with an
  explicit delete policy.
- **Decide where AI rate limits live.** MIU 6 reuses the reserve-first
  `rateLimitHits` pattern, but that ledger is CloudBase NoSQL. A CloudRun BFF
  either reimplements it in SQL — a new concurrency-sensitive component needing
  its own tests, not "reuse" — or talks to two databases per request. Pick one
  here and put the table in this MIU if it is SQL.

**Done:** one constraint-violation test per invariant the schema is supposed to
carry.

---

## MIU 2d — Primitive A and Primitive B

**Depends on:** 2c.

Compare-and-set on control, and the fenced sequenced append, as the only two ways
any code writes control state or visitor-visible output. Both are single
conditional statements per LLD-001 §4; a fence-then-write shape is a review
rejection.

**Done:** concurrency tests against real PostgreSQL prove I1 (gapless sequences).
**I8 is not proven here** — idempotent replay also needs TX1's message/run/outbox
transaction and the POST route, so it belongs to MIU 5's acceptance.

---

## MIU 3 — State machine core

**Depends on:** 2d.

- Transitions T1–T6 of LLD-001 §2.3, each as a single transaction.
- Run lifecycle transitions and `cancel_requested_at` handling.
- Invariants I1–I10 asserted, including the four takeover windows (R1–R4) and
  the intra-append window, driven
  through injectable barriers rather than timing.

**Done:** race suite green and deterministic (no `sleep`-based tests); no HTTP,
no engine, no vendor.

---

## MIU 4 — Hermes adapter

**Depends on:** 0, 1.

- `packages/ai-engine-hermes` implementing the port against the pinned digest.
- Capability descriptor populated from MIU 0's observations, not from optimism.
- The operation-id mapping layer is **MIU 5c's**, not this MIU's — LLD-002
  forbids database access inside an adapter, so it lives in the BFF and wraps the
  port rather than implementing it. This MIU only reports the capability
  truthfully so the BFF knows whether the layer is required.
- Vendor error → category mapping with fixtures for each category.
- Toolset assertion as an exact-set contract test (SECURITY.md §5).

**Done:** shared conformance suite green against a real pinned instance;
startup refusal proven when a required capability is false.

---

## MIU 5a — Answer policy and the versioned engine profile

**Depends on:** 1.

The architecture's answer policy — what may be said about MOQ, price, lead time,
certificates, OEM availability, and customer projects, and what must be refused —
is a whole table that no MIU built. LLD-002 explicitly forbids the port from
deciding refusals, so this is BFF work, and without it MIU 5b has no `profileId`
to send and MIU 13b measures refusal quality against a policy nobody wrote.

- The policy as versioned data, not scattered conditionals.
- The grounding and refusal decision function, including the `knowledge_empty`
  and `content_filtered` paths.
- The server-side engine profile that pins model, prompt, and tool configuration,
  versioned and referenced by id.
- The context-assembly and redaction rule decided in MIU 0.

**Done:** the policy table has a test per row; a refusal is produced for each
forbidden case. This is the control that keeps an invented price off the public
site.

---

## MIU 5b — Outbox dispatcher

**Depends on:** 2d, 3.

Leases with a fencing token, bounded retry and attempt cap, backoff, dead-letter
path, and the rule that a dead-lettered item transitions its run to a terminal
state rather than leaving it `CREATING` forever.

**Done:** a dead-lettered item leaves no run in a non-terminal state.

---

## MIU 5c — Start-run handler

**Depends on:** 5a, 5b.

Conditional claim with `claim_epoch`, epoch re-read, create, unconditional
recording of `engine_run_id`, fenced authorization, and stream-and-append via
Primitive B. The operation-id mapping layer of LLD-001 §7 lives here — in the
BFF, not in the adapter — if MIU 0 proved it necessary.

**Done:** R1–R4 and the intra-append window pass with the fake engine and real
PostgreSQL; I4, I5, I8, I9, I10 proven.

---

## MIU 5d — Cancel-run handler and reconciliation

**Depends on:** 5c.

Idempotent stop; resolution for runs cancelled before authorization; reconciler
for orphans, for runs stuck in `CREATING` past the age limit, for `RUNNING` runs
whose `last_append_at` is past the stall limit, and for operations stranded in
`CALL_IN_FLIGHT`. Also the terminalization path's **drain**: when a run reaches a
terminal status, a visitor message queued behind it gets a run.

**Done:** a forced stop-API failure produces zero visitor-visible bytes (I7); a
crash between the vendor call and recording produces no second vendor run.

---

## MIU 5e — Notification, email, and CRM handlers

**Depends on:** 5b.

The outbox carries four work types and the first draft of this plan built two.
This MIU builds the rest: the sales-notification handler into the approved
channel (gate 3), the email handler reusing `packages/email`, and the CRM adapter
with its contract test and the deletion-propagation hook MIU 8 depends on.

**Done:** adapter contracts green for email and CRM; a notification reaches the
approved channel; deletion propagates.

---

## MIU 6 — Public API

**Depends on:** 5c, 14b (budget), and — for the handoff and close routes — 8.

Six routes plus a credential subsystem is too much for one unit; implement and
commit in this order, each independently verifiable:

| Sub-unit | Contents |
|---|---|
| 6a | Conversation credential: mint, hash at rest, TTL, single-conversation scope, verify. Rejection tests for cross-conversation and expired use |
| 6b | Create conversation; append message (TX1) with idempotency key, validation, and length caps |
| 6c | Cancel route (the visitor's Stop, LLD-001 T6) |
| 6d | Handoff route — needs MIU 8's consent model for the optional lead fields |
| 6e | Close route — needs MIU 8's retention policy |
| 6f | Rate-limit and abuse layer by IP, conversation, and global budget, per the store decision in MIU 2c; `429` with `Retry-After` |

6d and 6e depend on MIU 8 because both carry business rules that live there.
Building them first means building against a consent and retention model that
does not exist, then reworking them.

**Done:** contract tests per route; abuse tests; no route accepts a credential
scoped to another conversation; every route refuses when the budget is exhausted
rather than serving unmetered.

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

Two sub-units with different shapes: **8a** consent and leads, **8b** retention
and deletion.

- Lead creation only on an explicit consent action, with consent text version
  recorded; an anonymous conversation is not a lead.
- Contact fields stored separately from transcript data, plus the write-path
  redaction that keeps contact details out of the turns sent to the engine.
- Retention and deletion jobs implemented as **tombstoning** — payload replaced
  in place, sequence retained — because removing event rows would break the
  gapless-sequence invariant (LLD-001 I1).
- Propagation enumerated as a checklist with one assertion per target store: the
  existing NoSQL leads and OEM inquiries, media storage, the CRM (via MIU 5e),
  queues, and backups within their stated window.
- The job's execution model comes from MIU 0's worker-runtime decision.
- Log-redaction rules enforced by a test, not by convention.

**Done:** deletion proven to propagate to each enumerated store; I1 still holds
after a deletion; no PII in default logs.

---

## MIU 9r — Sales role in the existing admin

**Depends on:** 0.

The plan assumed a sales role that does not exist. This repo's roles are
`viewer | member | contributor | admin`, documented as an **ascending privilege
ladder**; "sales" is orthogonal to that ladder, so it cannot simply be inserted.
This MIU covers the role itself, its grant path in user management,
`canAccessAdmin`/`canReadCollection`/`canEditCollection`, and regression tests
pinning existing role behaviour.

**Done:** existing role behaviour is provably unchanged; a sales user reaches the
AI queue and nothing else new.

---

## MIU 9 — Sales API and authorization

**Depends on:** 3, 9r.

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
- Optimistic-conflict handling: a losing takeover shows who won; a reassigned
  salesperson whose in-flight reply is rejected gets an explicit conflict rather
  than a vanished message.
- Lives in `apps/site/src/pages/admin.astro` and `islands/admin/*`, as a custom
  page rather than a generic collection view, using the existing session.

Notification delivery is **not** here — it is MIU 5e. A frontend MIU should not
own a backend integration.

**Done:** two operators racing produce one owner and a clear message for the
other.

---

## MIU 11 — Public widget

**Depends on:** 7, 12a (the allowlist data must exist before anything mounts).

Five sub-units — the sanitizer is a security control and must not be reviewed in
the same diff as drawer CSS:

| Sub-unit | Contents |
|---|---|
| 11a | Island shell, full-height mobile drawer, bounded desktop surface that never covers navigation, forms, or consent UI. Mounted **per page** per SECURITY.md §9, never in a shared layout. Includes the no-JS fallback: a server-rendered inquiry link inside the island, so a visitor without JavaScript still reaches a human |
| 11b | Accessibility contract: keyboard open/close, focus containment, `Escape`, ARIA live regions, reduced motion |
| 11c | SSE client: streaming, Stop, Retry, reconnect, interrupted-message rendering |
| 11d | Sanitizing Markdown renderer plus the XSS corpus; no raw HTML, scripts, styles, or iframes; citation URLs scheme-allowlisted |
| 11e | Consent and lead form, AI labelling and stated limits, and the fallback-to-inquiry path wired to the existing surfaces (`islands/shop/InquiryForm.tsx`, `components/ProjectForm.astro`) and driven by the degradation signal from MIU 14b |

**Done:** axe-clean; XSS corpus renders inert; keyboard-only operation complete;
the assistant degrades to the inquiry form when the degradation signal is set,
and with JavaScript disabled.

---

## MIU 12 — Route allowlist and its enforcement

**12a — the allowlist as data**, with the product and security owners named,
comes **before** MIU 11. The MIU that carries a contract precedes its consumer;
otherwise the widget gets mounted somewhere provisional and the allowlist is
retrofitted around wherever it landed.

**12b — enforcement**, after MIU 11: a build/route-level test enumerating routes
from the built output and asserting presence on exactly the allowlist and absence
on admin, account, auth, customer-project, and preview routes. Fails on an empty
enumeration.

**Done:** adding a new admin route without touching the allowlist keeps the
widget off it, proven by test. Closes gate 10 **for widget placement only** —
SECURITY.md §9 records that this gate does not close session theft, because the
session token is origin-scoped and reachable from allowlisted public pages.

---

## MIU 13a / 13b — Public knowledge corpus, and the evaluation harness

Two deliverables with different blockers, so they are two units: **13a** is
largely non-code and gated on a named owner's approval and the Lexiang space
(depends on 0); **13b** is code, gated on the pinned runtime and the answer
policy (depends on 1, 4, 5a).

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

## MIU 14 — Observability and health

**Depends on:** 5b.

- Liveness (unauthenticated) and readiness (safe status only) endpoints;
  each integration reports `LIVE`/`DISABLED` at startup and feeds readiness.
- Metrics: run outcomes by category, fence rejections, queue depth and age,
  stop failures, tokens and spend, SSE connection counts, connection-pool
  saturation.
- Alerts: budget threshold, stop-failure rate, orphaned runs, DLQ depth,
  fence-rejection spike (a spike means either an attack or a bug).

**Done:** each alert has been fired once deliberately in staging.

---

## MIU 14b — Budget and quota enforcement

**Depends on:** 2c. **Sequenced before MIU 6**, not after.

Enforcement is request-path work, not observability, and the public API cannot
ship without it — an anonymous stranger with no cap is an unbounded model bill.

- Daily and monthly spend caps, evaluated on the request path.
- The degradation signal that MIU 11e consumes to show the inquiry form.
- A cap on turns per conversation, and on concurrent conversations per visitor
  and per IP. Concurrency *within* a conversation needs no cap — the MIU 2c index
  admits exactly one live run and MIU 6b queues the next message — but nothing
  stops one visitor opening many conversations, which is the unbounded-bill case.

**Done:** with the cap exhausted, every public route degrades rather than
serving; the widget shows the inquiry path.

---

## MIU 15 — Engine deployment, secrets, and the standing security probes

**Depends on:** 14.

MIU 2a deployed the BFF; this MIU deploys the engine and installs the gates that
keep the security boundary closed over time.

- Pinned digest deployment; `latest` and `main` are rejected by the deploy check.
- Private network path for the engine, with empty or BFF-origin-only CORS; a test
  proves it is not publicly routable **and** that the BFF's own path works.
- Secret management with no secret in build output. The existing CI scan is a
  hand-maintained list of names — extend it so new AI secrets are covered by
  construction, not by remembering to add them.
- Toolset + MCP exact-set assertion and the capability check as pre-traffic
  deploy gates, keyed to the config hash of SECURITY.md §5.
- **The standing knowledge-credential scope probe** of SECURITY.md §4: the
  three-assertion form, run pre-deploy against the deployed credential, with its
  fingerprint asserted at BFF startup, plus the sensitivity run that must go red.
  This is the control that keeps gate 2 closed after the day it is opened.
- Production data region recorded (part of gate 4).
- Migration and rollback runbook.

**Done:** a deploy that changes the engine version, its profile, or its MCP
server list and fails the assertions is blocked before receiving traffic; the
credential probe's sensitivity run has been observed failing.

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

Split by sub-claim, because a gate row with one owner and three claims reads as
covered while part of it has none.

| Architecture gate | Sub-claim | Closed by |
|---|---|---|
| 1 | Pinned release and digest | 0, 15 |
| 1 | Negative toolset assertions (incl. MCP surface) | 4, 15 |
| 2 | Isolated public space exists, read-only credential | 0, 13a |
| 2 | **Standing** proof it cannot reach internal knowledge | 15 |
| 3 | Sales workplace | 10 |
| 3 | Role model | 9r |
| 3 | Notification channel | 5e |
| 4 | Consent and PII | 8a |
| 4 | Retention and deletion | 8b |
| 4 | Production data region | 0 (decision), 15 (deployment) |
| 5 | Model provider and data-processing terms | 0 |
| 5 | Budget and quota alerts | 14, 14b |
| 6 | CAS and ordered-event design | 2c, 2d, 3 |
| 7 | Replay semantics, or the mapping layer | 0, 5c |
| 8 | Connectivity, transactions, pooling | 0, 2a |
| 8 | Failure behaviour under load | 14, 16 |
| 9 | Corpus, languages, thresholds | 0 (languages), 13a |
| 9 | Golden set and release evaluation | 13b |
| 10 | Allowlist data with named owners | 12a |
| 10 | Enforcement test | 12b |

Gate 10 closes widget *placement* only. SECURITY.md §9 records why it does not
close session theft in this codebase, and what would.

## 3. Scope subsets

The architecture offers two smaller shapes. Note that its 22–38 figure is
**person-weeks** while the 4 and 6–8 figures below are **calendar weeks for a
parallel team** — mixing the two units is how a plan gets agreed at a quarter of
its real cost.

**Knowledge-only pilot (~4 calendar weeks, parallel team, prerequisites ready).**
MIUs 0, 1, **2a, 2b, 2c (reduced), 2d**, 4, **5a, 5b, 5c (reduced)**, 6a, 6b, 6f,
7, 11, 12a, 12b, 13a, 13b, 14b, 15. No sales queue, no takeover, no leads.

The store and the start-run path are **not** optional in this subset, even though
the first draft of this plan listed them as excluded. MIU 7 is defined as a
reader of the committed event log; without MIU 2c there is no log, and the only
way to build the pilot without it is a synchronous route that streams the engine
straight into the HTTP response — which is LLD-001's explicitly forbidden shape,
throws away the operation-id work, and would be rewritten entirely for the
production pilot. The reduced form of 2c is four tables (`conversations`,
`conversation_messages`, `conversation_events`, `ai_runs`); the reduced 6 is
create, append, and cancel.

The floor is non-negotiable: MIU 15's standing credential probe and MIU 12's
route allowlist ship even in the smallest version. An over-scoped knowledge token
and a widget on an authenticated page are the two failures that are not
recoverable by shipping the next increment.

**Production pilot (~6–8 calendar weeks).** All MIUs. Takeover, persistence,
consent and retention, monitoring, and race and security acceptance are what
separate the two numbers — and MIUs 2d, 3, 5b–5d, and 9 carry the concurrency
risk.

A one-week demo is neither of these. It is MIU 11 wired to MIU 1's fake engine,
and it must be labelled a demo in writing, because a working demo is the single
most effective way to lose an argument about a 22–38 person-week estimate.

## 4. Estimate reconciliation

Sizing the units above sums to roughly **44–50 person-weeks**, against the
architecture's 22–38 ceiling. The gap is not new work invented here — it is work
the architecture implies and the first draft of this breakdown left unowned: the
BFF's own runtime and deploy path, PostgreSQL in CI and locally, the answer
policy and engine profile, the notification/email/CRM handlers, the sales role,
budget enforcement, and the no-JS and degradation paths.

Two honest options, and the choice belongs to the product owner:

1. **Move the ceiling** to ~45 person-weeks and keep the scope.
2. **Cut scope** — the knowledge-only pilot above is the natural cut, and it
   lands inside the original range because it drops takeover, leads, the sales
   surface, and retention.

What is not available is the original ceiling with the original scope. Recording
that here, rather than discovering it in week nine, is the point of decomposing
before implementing.
