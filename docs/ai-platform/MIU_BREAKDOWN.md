# MIU Breakdown — Channel Public AI Assistant

**Status:** Proposed; decomposes [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
**Low-level designs:** [LLD-001](./LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md) (takeover), [LLD-002](./LLD-002-CONVERSATION-ENGINE-INTERFACE.md) (engine port)
**Supporting:** [SECURITY.md](./SECURITY.md), [TEST_STRATEGY.md](./TEST_STRATEGY.md)
**Last reviewed:** 2026-08-11

Each MIU is implemented, tested, reviewed, and committed independently, and
test-deployed where it is runtime-affecting. An MIU that cannot be verified on
its own is too big and must be split.

## 0. The evidence gate for the selected runtime and store

The architecture specifies a Chat BFF on CloudRun with an AI operational
PostgreSQL. **This repository has neither today** — it is CloudBase functions
(`apps/functions/*`, wx-server-sdk) over NoSQL. There is no PostgreSQL client, no
Dockerfile, no container tooling, no `services:` block in CI, and no way to run a
database locally; `apps/local-server` is a JSON-file adapter. The nearest thing
to "postgres" in the source is the string `'pg-storage'`, one value of an
image-storage mode enum.

So this is not a feature added to an existing service. It introduces the
selected CloudRun runtime and a second database engine to the project. Two
consequences:

1. **MIU 0 verifies CloudRun and the selected PostgreSQL contract before MIU 2c
  writes a schema.** Runtime selection is closed. If a target PostgreSQL fails
  the store probe, use another conforming PostgreSQL target or open a new ADR;
  do not reopen CloudRun selection inside an MIU.
2. The person-week estimate in the architecture (22–38) is dominated by this,
   not by the widget. Anyone reading "add an AI chat widget" is reading the
   wrong scope.

## 1. Modules

| Module | MIUs | What it delivers |
|---|---|---|
| M0 Evidence | 0 | The unknowns turned into recorded facts |
| M1 Engine boundary | 1, 4 | Provider-neutral port, fake, Hermes adapter |
| M2 Operational core | 2a–2d, 3, 5a–5f | Runtime, store, state machine, policy, workers, wire contracts |
| M3 Public surface | 6, 7, 11, 12 | Public API, SSE, widget, route allowlist |
| M4 Business surface | 8, 9, 9r, 10 | Consent/leads/retention, sales role, sales API, sales UI |
| M5 Knowledge & quality | 13a, 13b | Public corpus, evaluation harness |
| M6 Operations | 14, 14b, 15, 16 | Observability, budget enforcement, deploy, drills |

Dependency edges. This table is a **restatement** of the per-MIU `Depends on:`
lines, and those lines win if the two ever disagree — so a change made here and
not there is not a change at all. Round 2 of the external review found exactly
that: accepted edges added to this table while six declarations still said the
old thing.

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
| 5a | 0, 1 |
| 5b | 2d, 3 |
| 5c | 5a, 5b |
| 5d | 5c |
| 5e | 5b |
| 5f | 1, 3 |
| 6 | 5c, 5d, 5f, 14b, 8 |
| 7 | 6, 5f |
| 8 | 3; 8b also 5e |
| 9r | 0 |
| 9 | 3, 9r, 5f |
| 10 | 9, 5f |
| 11 | 7, 12a, 5f |
| 12a | — (allowlist data; must precede 11) |
| 12b | 11 |
| 13a | 0 |
| 13b | 1, 4, 5a, 13a |
| 14 | 5b |
| 14b | 2c |
| 15 | 14, 4, 5a, 13a |
| 16 | all |

Longest path to a shippable surface: `0 → 2a → 2b → 2c → 2d → 3 → 5b → 5c → 5d → 6 → 7 → 11 → 12b`. MIU 16 depends on everything and closes the plan.

**MIU 1 depends on nothing** and starts on day zero, in parallel with MIU 0 —
the whole argument of LLD-002 is that the port is written before any vendor
knowledge exists. MIU 4 needs 0 and 1. The start-run handler (5c) needs **1, 3,
5a and 5b**, not the Hermes adapter: its acceptance runs against the fake engine,
and serializing the critical path behind a live-vendor MIU that is itself blocked
on external provisioning costs weeks of idle time. It is re-run against the real
adapter in MIU 16.

MIU 6 additionally needs 5d (the drain and reaper behind its message queue), 14b
(budget enforcement must exist before the public API it protects), and 8 (for the
handoff and close routes). MIU 11 needs 12a, because the allowlist data has to
exist before anything mounts against it.

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
- **Verify the selected runtime and store.** CloudRun hosts the BFF and workers;
  PostgreSQL is accessed through the `pg` protocol. Prove a transaction, a
  conditional `UPDATE … RETURNING`, a rollback, pool behaviour, VPC/subnet and
  TLS from the target environment. Follow the CloudBase SDK Contract Gate in
  `AGENTS.md` for anything SDK-shaped.
- Confirm the dedicated Lexiang public space and exact MCP serving credential
  can satisfy K1-K5. Record the MCP URL/preset, non-secret credential identity,
  space id, tool schema and negative-access result. REST AppKey scope is
  supporting administration evidence, not serving-credential proof.
- **Verify the CloudRun worker topology and choose only its trigger mechanism.**
  LLD-001's start-run handler streams engine events and appends per event, which
  is a long-lived process. Decide whether the selected CloudRun worker is woken
  by an internal signed request, queue adapter, or bounded polling; do not choose
  a different runtime in this MIU.
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
- The worker deployment skeleton: separate workspace package, process entry,
  container, health/readiness and trigger plumbing. MIU 2a does not implement
  outbox or start-run business logic; MIUs 5b/5c fill that skeleton.
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
- **The artifacts, named.** Telling a future implementer to "name a package" is
  the same non-executable instruction one level down, so here they are:

  | Artifact | Value |
  |---|---|
  | Workspace package | `apps/ai-bff`, package name `@vibelingan-channel/ai-bff` |
  | Entry point | `apps/ai-bff/src/server.ts` |
  | Container | `apps/ai-bff/Dockerfile` |
  | Build | `pnpm --filter @vibelingan-channel/ai-bff build` |
  | Start | `pnpm --filter @vibelingan-channel/ai-bff start` |
  | Worker package | `apps/ai-worker`, package name `@vibelingan-channel/ai-worker` |
  | Worker entry point | `apps/ai-worker/src/worker.ts` |
  | Worker container | `apps/ai-worker/Dockerfile` |
  | Worker build | `pnpm --filter @vibelingan-channel/ai-worker build` |
  | Worker start | `pnpm --filter @vibelingan-channel/ai-worker start` |
  | Local dev | `docker compose -f docker-compose.ai.yml up` (BFF + worker + PostgreSQL) |
  | Store package | `packages/ai-store`, package name `@vibelingan-channel/ai-store` — pool, transaction helper, readiness proof |
  | Root scripts | `dev:ai`, `build:ai`, `test:ai:store`, `test:ai`, `smoke:ai` in the root `package.json`; `build:ai` builds both packages |
  | Deploy manifest | `scripts/cloudrun-service-manifest.mjs`, pinned by `scripts/cloudrun-manifest.test.mjs` |
  | BFF smoke | `node scripts/smoke-ai-bff.mjs <deployed-url>` asserting readiness and one round-trip |
  | Worker smoke | `node scripts/smoke-ai-worker.mjs <deployed-url>` asserting readiness and, after MIU 5c, one fake-engine outbox drain |

  **Readiness proves a transaction, not a connection.** `select 1` also succeeds
  against a read-only replica and against a role that cannot open a transaction,
  so `/readyz` runs a real transaction, rolls it back, checks the rollback
  discarded the write, and reports the isolation level it observed. The
  isolation level is deliberately on the wire: it is a property of the *managed
  database*, not of our code, and LLD-001 §4.4 breaks silently if a provider
  ships something other than READ COMMITTED. Reading it back from a running
  deployment is the only way to know.

- **Implement the measured separate-origin routing decision.**
  The architecture puts the assistant at `/api/ai/*` and `/api/admin/ai/*`. The
  existing CloudBase gateway already maps `/api` to the `public-api` function and
  `/api/admin` to `admin` as wildcard prefixes
  (`scripts/cloudbase-function-manifest.mjs`), so both proposed prefixes sit
  *underneath* routes that are already claimed. Left alone, assistant traffic is
  answered by the storefront catalog function.

  MIU 0 measured that CloudRun uses its own hostname and is not mounted under the
  environment service domain. Therefore the BFF uses that separate origin. Add
  the exact site-origin CORS policy, short-lived cross-origin conversation
  credential handling, frontend API origin and deployed smoke URL. Do not add a
  competing gateway-prefix route.

**Done:**

- Every artifact above exists at the named path.
- A trivial route is reachable locally (compose), in CI, and on the deployed
  CloudRun origin; a transaction and a rollback are proven against real
  PostgreSQL in all three.
- **On the BFF's own CloudRun hostname**, `GET /api/ai/healthz` returns the
  BFF's response — not `public-api`'s.
- On the *website* API domain, `/api/ai/…` still resolves to `public-api`, and
  that is the expected, correct outcome. It is not a defect and must not be
  "fixed" by adding a gateway prefix route.

An earlier draft of this MIU asked for a deployed request to `/api/ai/…` to
reach the BFF "rather than `public-api`" without saying on which host. Under the
separate-origin decision recorded ten lines above, that is unsatisfiable by
construction: on the website domain the longest-prefix match sends `/api/ai/*`
to `public-api` and always will.

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
- **The constraints LLD-001 specifies are this MIU's output, not prose it cites.**
  A composite foreign key `(conversation_id, run_id)` on `conversation_events`
  referencing `ai_runs (conversation_id, id)`, so a terminalizer physically cannot
  attach run A to conversation B; a `CHECK` per system event type enforcing its
  closed payload schema (LLD-001 §4.3), so arbitrary JSON cannot carry vendor
  text; and the append-only `engine_run_handles` table of LLD-001 §3.4. Each ships
  with a **direct-writer negative test** that bypasses the application and asserts
  the database itself refuses — an A/B conversation mismatch, and a payload with a
  recognizable text field.
- `conversation_messages` carries `answered_by_run` (nullable), `accepted_in_epoch`
  (**NOT NULL**), and `event_sequence`, with an index supporting the drain's
  "oldest unanswered in this epoch" scan. These three are what make I11
  enforceable; a nullable `accepted_in_epoch` turns the drain into a silent no-op.
- **Conditional on MIU 0:** if native create is not replay-safe, this MIU also
  creates the `engine_operations` table that MIU 5c's mapping layer needs. It is
  a conditional output of the schema MIU, not an afterthought inside 5c.
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
- The **storage half** of I1–I10, plus the exact T1–T6 guard / effect / rollback
  matrix, driven through injectable barriers rather than timing.
- **Not** the full race windows R1–R4: those exercise worker paths, vendor calls
  and cancellation that MIUs 5c and 5d introduce. Claiming them here would assign
  evidence to a unit that has no engine, no worker and no HTTP surface. See
  TEST_STRATEGY §2 for the layer-by-layer split.

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
- Build a local stub Hermes HTTP server with sanitized recorded frames and run
  adapter transport tests against it. This artifact does not exist before MIU 4
  and does not require or fake a Lexiang deployment.
- Shared staging and release conformance run against the pinned Hermes instance
  configured with the exact scoped Lexiang MCP credential. The serving path is
  MCP only for this release; adapters do not choose REST versus MCP at runtime.

**Done:** shared conformance suite green against a real pinned instance;
startup refusal proven when a required capability is false. The **composed**
replay case that LLD-002 §9 makes mandatory when native idempotency is absent
runs in MIU 5c, not here — it needs the mapping layer, which does not exist yet
at this point in the plan.

Development completion and release completion are distinct: local stub
conformance permits dependent local MIUs to proceed; MIU 15 and gate 2 still
require the real deployed MCP credential, tool-surface probe and attestation.

---

## MIU 5a — Answer policy and the versioned engine profile

**Depends on:** 0 (the context-assembly and redaction decision), 1.

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

**Done:** a forced stop-API failure commits no further AI event (I7); a
crash between the vendor call and recording produces no second vendor run; **I11**
holds — a queued message is answered exactly once, a message from a human-handled
epoch is never drained, and a wedged run is reaped within the stall limit.

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

## MIU 5f — Wire contracts for every seam

**Depends on:** 1 (the error taxonomy — it is the port's, defined in
`packages/ai-engine/src/errors.ts`, not the answer policy's), 3 (the event types).

**Files:** `packages/ai-contracts/src/public.ts`, `admin.ts`, `events.ts`,
`errors.ts`, `credential.ts` — one package both the BFF and the widget import.

The canonical route table gives each endpoint a *purpose* and no contract. MIUs 6
and 7 then add routes and an SSE stream, and MIU 11 consumes them — three units
agreeing on a shape that is written down nowhere. The seam gets an owner before
its consumers exist, not after:

- Request and response DTOs for all six public and six sales routes.
- The error envelope and its codes, mapped from LLD-002's taxonomy.
- The conversation-credential wire format: where it travels, its TTL, and its
  renewal or expiry behaviour.
- The **SSE event union** — every `type` the dispatcher can emit and its payload,
  matching LLD-001 §4.3's closed schemas exactly, so the widget and the server
  cannot drift.
- Generated or shared types, so a change breaks the build rather than a browser.

**Done:** the widget and the BFF import the same contract; a field renamed on one
side fails to compile on the other.

---

## MIU 6 — Public API

**Depends on:** 5c, 5d, 5f (wire contracts), 14b (budget), and — for the handoff and close routes — 8.
5d is required, not optional: 6b queues a message behind a live run, and 5d owns
both the drain that answers it and the reaper that stops one wedged run blocking
the conversation forever.

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

**Depends on:** 6, 5f (the SSE event union).

- Committed-events-only reader, sequence-ordered.
- `Last-Event-ID` resume with no duplicates and no gaps.
- Heartbeats, idle timeout, connection caps, clean shutdown.
- Proxy/buffering behaviour verified in the target environment — SSE dies
  quietly behind a buffering proxy, and that must be found here, not in the pilot.

**Done:** reconnect mid-stream loses nothing and repeats nothing; a takeover
during an open stream delivers `handoff.started` and then no AI event.

---

## MIU 8 — Consent, leads, PII separation, retention

**Depends on:** 3; **8b additionally on 5e** — CRM deletion propagation has no
target until the CRM adapter exists.

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
  the PostgreSQL `conversation_messages`, `conversation_events`, `leads` and
  `audit_events` tables; the NoSQL `oemProjects` collection (this repo has **no**
  NoSQL `leads` collection); media storage; the CRM (via MIU 5e); queues; and
  backups within their stated window.
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

**Depends on:** 3, 9r, 5f (the sales DTOs and error envelope).

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

**Depends on:** 9, 5f (it renders against the same admin DTOs).

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

**Depends on:** 7, 12a (the allowlist data must exist before anything mounts),
5f (it consumes the public DTOs and the SSE event union).

Five sub-units — the sanitizer is a security control and must not be reviewed in
the same diff as drawer CSS:

| Sub-unit | Contents |
|---|---|
| 11a | Island shell, full-height mobile drawer, bounded desktop surface that never covers navigation, forms, or consent UI. Mounted **per page** per SECURITY.md §9, never in a shared layout. Includes the no-JS fallback: a server-rendered inquiry link inside the island, so a visitor without JavaScript still reaches a human |
| 11b | Accessibility contract: keyboard open/close, focus containment, `Escape`, ARIA live regions, reduced motion |
| 11c | SSE client: streaming, Stop, Retry, reconnect, interrupted-message rendering |
| 11d | Sanitizing Markdown renderer plus the XSS corpus; no raw HTML, scripts, styles, or iframes; citation URLs scheme-allowlisted |
| 11f | **Page security headers and the egress proof.** Deployed CSP and `X-Content-Type-Options` on the allowlisted routes, made compatible with the two inline scripts `BaseLayout.astro` already ships; the approved egress set as data — `(origin, route, method, credential-carrier)` tuples; and the token-egress E2E of TEST_STRATEGY §3.3, including the intentional exfiltration control that proves the detector fires. SECURITY.md §9 makes CSP the control standing between a sanitizer escape and the session, so it needs an owner, and until this unit existed it had none |
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
policy (depends on 1, 4, 5a, **and 13a** — an evaluation run against a corpus
that has not been published yet measures nothing).

- The approved public FAQ corpus published into the isolated space through the
  reviewed publication path (SECURITY.md §4).
- Golden evaluation set: FAQ paraphrases, multilingual queries, exact product
  terms, unknown questions, stale certificates, price-promise bait, prompt
  injection, secret extraction.
- Harness runs against the pinned runtime and reports the architecture §11
  metrics.
- Grounding and refusal thresholds recorded as configuration.
- MIU 13a records the dedicated Lexiang space id, public owner, MCP URL/preset,
  non-secret serving credential id and Secret Manager reference. REST AppKey
  scope is not accepted as proof of the MCP credential's scope.

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

**Depends on:** 14, and **4, 5a, 13a** — it deploys the adapter, the serving
profile, and the published corpus.

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
- **Assemble and enforce the credential-proof manifest** of SECURITY.md §3:
  every credential row filled in with its allowed operation, nearest forbidden
  operation, owning MIU, CI stage, and evidence artifact. A row that cannot be
  completed blocks traffic rather than shipping as an intention.
- **The standing knowledge-credential scope probe** of SECURITY.md §4: the
  three-assertion form, run pre-deploy against the deployed credential, with its
  attested identity asserted at BFF startup via
  `attestKnowledgeCredential()` (LLD-002 §4) — `credentialId`, `spaceId` and
  `rotationCounter` all matching what the probe cleared — plus the per-surface
  controls and the sensitivity run that must go red.
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
- Each of the ten production gates marked closed with **decision + implementation
  + fresh evidence** for every sub-claim.

**On deferral, reconciling two rules that appear to conflict.** The architecture
§12 says public production is blocked until all ten gates close. README rule 6
says a gate may be deferred through explicit, time-bounded risk acceptance with
named owners and compensating controls. Both are pre-existing and both stand,
because they answer different questions: **a deferral authorises continued
isolated staging; it never authorises public production.** A deferred gate
remains a production blocker with an expiry date attached. Reading rule 6 as a
route to launch would make §12 unenforceable.

**Done:** the gate table has no unexplained blanks, and every row distinguishes
the *approved decision* from the *implementation* from the *evidence* — several
gates (workplace, consent and retention, budget thresholds, corpus thresholds,
golden set, pilot metrics) require a human decision that no amount of code
closes. Public production approval is a decision made against this table, not a
feeling about readiness.

---

## 2. Gate coverage map

Split by sub-claim, because a gate row with one owner and three claims reads as
covered while part of it has none.

Three columns, because MIU 16 requires all three and a two-column map cannot show
that a gate's *decision* is missing while its code is done. Several of these gates
close on a human decision that no amount of implementation reaches.

| Gate | Sub-claim | Approved decision by | Implementation | Evidence artifact |
|---|---|---|---|---|
| 1 | Pinned release and digest | product + security owner sign-off on the version | 15 | Digest recorded in the deploy manifest and in MIU 0's evidence file |
| 1 | Negative toolset assertions incl. MCP surface | — (mechanical) | 4, 15 | Pre-traffic gate output showing the exact set and the config hash |
| 2 | Isolated public space exists, read-only credential | knowledge owner approves the space and its scope | 0, 13a | Space id and credential attestation recorded |
| 2 | Standing proof it cannot reach internal knowledge | — (mechanical) | 15 | Per-surface probe run, including the sensitivity run observed red |
| 3 | Sales workplace | **sales lead chooses where takeover happens** | 10 | Written decision naming the surface |
| 3 | Role model | **security owner approves the sales role** | 9r | Role definition diff + regression run |
| 3 | Notification channel | **sales lead approves the channel** | 5e | Delivered test notification in that channel |
| 4 | Consent and PII | **product + legal approve consent text and retention** | 8a | Approved consent copy, versioned |
| 4 | Retention and deletion | — (mechanical, once approved) | 8b | Deletion run showing every enumerated store |
| 4 | Production data region | **product + legal approve the region** | 15 | Deployed region recorded |
| 5 | Model provider and data-processing terms | **legal approves the terms** | 0 | Signed terms reference |
| 5 | Budget thresholds and quota alerts | **product owner sets the monthly cap** | 14, 14b | Cap in config + each alert observed firing once |
| 6 | CAS and ordered-event design | — (mechanical) | 2c, 2d, 3 | Race suite green against real PostgreSQL |
| 7 | Replay semantics, or the mapping layer | — (mechanical) | 0, 5c | MIU 0 probe result + composed replay test |
| 8 | Connectivity, transactions, pooling | — (mechanical) | 0, 2a | Probe output from the target environment |
| 8 | Failure behaviour under load | — (mechanical) | 14, 16 | Drill log, one entry per dependency |
| 9 | Corpus, languages, thresholds | **product owner approves corpus, languages, and the grounding/refusal thresholds** | 0 (languages), 13a | Approved corpus manifest + threshold config |
| 9 | Golden set and release evaluation | **product owner approves the golden set and pilot metrics** | 13b | Recorded evaluation run against the pinned runtime |
| 10 | Allowlist data with named owners | **product + security owner approve the route list** | 12a | Allowlist file with both names recorded |
| 10 | Enforcement test | — (mechanical) | 12b | Route enumeration output |

Eleven of these twenty rows need a named human to decide something. No amount of
implementation closes those, which is the practical reason the three columns are
separate: a gate whose code is finished and whose decision is missing is not
closed, and a two-column map cannot show the difference.

Gate 10 closes widget *placement* only. SECURITY.md §9 records why it does not
close session theft in this codebase, and what would.

## 3. Scope subsets

The architecture offers two smaller shapes. Note that its 22–38 figure is
**person-weeks** while the 4 and 6–8 figures below are **calendar weeks for a
parallel team** — mixing the two units is how a plan gets agreed at a quarter of
its real cost.

**Knowledge-only pilot (~4 calendar weeks, parallel team, prerequisites ready).**
MIUs 0, 1, **2a, 2b, 2c (reduced), 2d, 3 (reduced)**, 4, **5a, 5b, 5c (reduced),
5d, 5f**, 6a, 6b, **6c**, 6f, 7, 11 (reduced), 12a, 12b, 13a, 13b, **14**, 14b,
15. No sales queue, no takeover, no leads.

This subset has been wrong three times, so its closure rules are written out
rather than left to inspection:

- **14 is in**, because 15 declares it as a dependency. A pilot that deploys
  without observability deploys blind.
- **5f is in.** MIUs 6, 7 and 11 are all in this subset and all consume the wire
  contracts; omitting their source while including three consumers is the same
  class of error as omitting the outbox.
- **The reduced 2c schema, defined once so it cannot be counted differently in
  two places:** five base tables — `conversations`, `conversation_messages`,
  `conversation_events`, `ai_runs`, `outbox` — **plus** `engine_operations` if
  and only if MIU 0 found native create is not replay-safe, **plus** the rate
  ledger if 2c's decision put it in SQL. 5b *is* the outbox dispatcher, so
  omitting its table while including it was incoherent; and 6f enforces against
  the ledger, so that decision is made here, not deferred.
- **MIU 11 is reduced to 11a–11d.** Full 11 includes 11e, which builds the
  consent and lead form — and this pilot says "no leads". The reduced widget
  keeps the shell, accessibility, streaming and sanitizing renderer, and swaps
  11e's consent form for a plain link to the existing inquiry page.
- **The reduced 5c** is the start-run handler without the operation-id mapping
  layer, if and only if MIU 0 proved native replay safety. If it did not, the
  mapping layer is in, because the alternative is duplicate vendor runs.

The store and the start-run path are **not** optional in this subset, even though
the first draft of this plan listed them as excluded. MIU 7 is defined as a
reader of the committed event log; without MIU 2c there is no log, and the only
way to build the pilot without it is a synchronous route that streams the engine
straight into the HTTP response — which is LLD-001's explicitly forbidden shape,
throws away the operation-id work, and would be rewritten entirely for the
production pilot. The reduced form of 2c is four tables (`conversations`,
`conversation_messages`, `conversation_events`, `ai_runs`); the reduced 6 is
6a, 6b, 6c and 6f — create, append, cancel, and the abuse layer. 6c is in
because MIU 11c ships a Stop button, and a Stop button with no route behind it
is worse than none. That in turn puts **3 (reduced)** in: T6 and the run
lifecycle live there, so a cancel route without it has no state machine to call.
5d is in for the reason its dependency row gives.

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

**This section deliberately offers no number to plan against yet, and no scope
option, because neither is computable from what is written above.**

What is established: the decomposition contains work the architecture implies and
the first draft of this breakdown left unowned — the BFF's own runtime and deploy
path, PostgreSQL in CI and locally, the answer policy and engine profile, the
notification/email/CRM handlers, the sales role, budget enforcement, the wire
contracts, the security headers, and the no-JS and degradation paths. That is a
directional signal that the plan exceeds the architecture's 22–38 person-week
ceiling.

What is **not** established is by how much. Earlier drafts of this section
asserted 44–50, then labelled that figure unauditable, and then went on to offer
a "~45 ceiling" and a claim that the reduced pilot fits inside 22–38 — numbers
with no inputs behind them. A range nobody can reproduce is worse than no range,
because it gets quoted.

The architecture's own 22–38 is auditable: its component ranges sum to exactly 22
low and 38 high. This breakdown meets the same bar before it proposes anything:

1. Add a **low/high estimate and its stated assumptions** to every MIU heading.
2. Recompute the total from those inputs.
3. *Then* put the options to the product owner — move the ceiling to the computed
   upper bound, or cut scope by an amount the same arithmetic shows.

Until step 2 is done, the only honest statement is the one this section opens
with. Recording that here, rather than discovering it in week nine, is the point
of decomposing before implementing.
