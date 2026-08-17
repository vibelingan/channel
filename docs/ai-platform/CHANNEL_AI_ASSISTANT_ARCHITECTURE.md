# Channel Public AI Assistant Architecture

**Product:** Diversity Technology Limited website  
**Status:** Proposed; production approval blocked by the gates in this document  
**Last reviewed:** 2026-08-17
**Scope:** Public floating customer-service assistant and sales handoff

## 1. Decision

Use the locally proven Hermes plus Tencent Lexiang path behind a project-owned Chat BFF:

```text
Anonymous browser
    |
    | HTTPS and SSE; no vendor credentials
    v
Chat BFF on CloudRun
    |-- conversation ownership, consent, PII, leads, rate limits
    |-- human-handoff state and ordered public events
    |-- authenticated sales routes
    |
    | private authenticated call
    v
Pinned Hermes Agent customer-service profile
    |-- approved model endpoint
    |-- read-only public-knowledge tools only
    v
Dedicated Tencent Lexiang public customer-service space
```

The BFF exposes a provider-neutral `ConversationEngine` boundary. The selected production implementation is CloudRun BFF/workers calling a pinned Hermes profile, with Hermes retrieving from Lexiang through its configured MCP server. This is a closed implementation decision for the current product. Replacing the runtime, engine, or knowledge transport requires a later ADR and equivalent security, cancellation, evaluation, and operations evidence; it is not an open implementation choice.

## 2. Evidence and Current State

### Observed

- A local prototype proved browser -> Hermes `/v1/chat/completions` -> DeepSeek -> Lexiang MCP connectivity. That records the *prototype*; the company's running Hermes bot uses **zenmux** (an OpenAI-compatible provider) per `HERMES_OPS_SOP.md`, and the production provider is still an open decision (gate 5).
- Hermes Agent is the public Nous Research project and supports an API server, streaming, Runs, stop, sessions, MCP, health endpoints, and Docker deployment.
- The default Hermes API-server tool surface is much broader than public customer service requires.
- The repository currently has no production AI widget, Chat BFF, assistant conversation store, lead queue, or human-takeover implementation.

### Not yet proven

- The exact pinned Hermes release and container digest.
- Idempotent Runs creation semantics for the pinned release.
- The production CloudRun network path and PostgreSQL transaction boundary.
- A public-only Lexiang space and a production Lexiang MCP credential whose
    actual tool surfaces cannot access internal knowledge or write public content.
- Production model, region, retention policy, budget, and sales takeover channel.

The local prototype proves feasibility, not production readiness.

## 3. Product Contract

The first production pilot must:

- Appear only on an explicit public-route allowlist approved by the product owner and security owner, never on admin, account, authentication, customer-project, or preview routes.
- Answer approved public questions about MOQ, price factors, typical lead-time ranges, certificates, and OEM availability.
- Cite approved public knowledge where the channel supports citations.
- Refuse and offer inquiry or human help when evidence is absent, stale, contradictory, or outside policy.
- Create a lead only after the visitor requests follow-up or an estimate, submits contact information, and consents.
- Synchronize eligible conversations and leads into a sales queue.
- Stop all old AI output after a human takes control: once takeover commits, no further assistant text is written to the conversation. Text committed before the takeover remains part of the transcript and may still be delivered — see `LLD-001` §1 for what this does and does not promise about the visitor's screen.
- Fall back to a contact or inquiry form when the model, Hermes, knowledge source, or operational store is unavailable.

An anonymous conversation is not automatically a lead.

## 4. Answer Policy

| Topic | Allowed | Forbidden |
|---|---|---|
| MOQ | Published product or category MOQ and approved conditions | Unapproved exceptions or negotiated commitments |
| Price | Published ranges, price factors, and estimator/inquiry guidance | Invented unit prices, internal cost, margin, or a binding quotation |
| Lead time | Approved typical ranges and prerequisites | Guaranteed delivery dates |
| Certificates | Reviewed certificate and capability summaries | Claims about missing, expired, or unverified certification |
| OEM availability | Approved processes, categories, and engagement steps | Unverified capacity or process commitments |
| Customer projects | Not supported in the public pilot | Any project status, customer file, or private account information |

Commercially binding price, supplier, purchasing, shipment, or delivery actions require deterministic services and explicit human approval. They are not assistant tools in this release.

## 5. Ownership Boundaries

| Component | Owns | Must not own |
|---|---|---|
| Browser widget | Presentation, input, accessible streaming UI, consent collection | Long-lived keys, vendor routing, authorization, durable history |
| Chat BFF | Public API, session ownership, state machine, rate limits, PII, leads, sales authorization, event filtering | Vendor business rules, price calculation, arbitrary tool execution |
| Hermes profile | Restricted conversation orchestration and approved read-only knowledge calls | Identity, sales state, takeover truth, internal data, terminal/file/browser/code tools |
| Lexiang public space | Reviewed public knowledge and source references | Leads, transcripts, internal cost, supplier contracts, customer data |
| AI operational PostgreSQL | Conversations, messages, runs, ordered events, leads, takeover, audit, outbox | Existing CMS/auth/OEM/media ownership |
| Existing NoSQL and Admin | Existing users, CMS, OEM, media, and shared JWT source | Generic CRUD over AI operational tables or long-lived SSE |

The standalone Hermes messaging gateway documented in `HERMES_OPS_SOP.md` is operationally separate and is not part of this browser request path.

## 6. Public and Sales APIs

### Public

**Host:** these paths are served on the **BFF's own CloudRun origin**
(`<service>-<id>.sh.run.tcloudbase.com` or a custom domain mapped to it), *not*
on the website's API domain. MIU 0 measured that `/api/ai/*` on the website
domain resolves to the `public-api` function by longest-prefix match and always
will; the assistant does not contend for that prefix. The widget therefore makes
cross-origin calls, which makes CORS and cross-origin credential handling
load-bearing rather than incidental (§14, `evidence/P3-runtime-and-routing.md`).

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/ai/conversations` | Create an anonymous conversation and short-lived conversation credential |
| `POST` | `/api/ai/conversations/:id/messages` | Append a visitor message using an idempotency key, and reserve an AI run when the conversation is bot-controlled and none is live (see §8) |
| `GET` | `/api/ai/conversations/:id/events` | Stream committed ordered events over SSE |
| `POST` | `/api/ai/conversations/:id/handoff` | Request a human and optionally submit consented lead fields |
| `POST` | `/api/ai/runs/:id/cancel` | Cancel the caller's current run |
| `POST` | `/api/ai/conversations/:id/close` | Close the conversation and begin its retention policy |

### Authenticated sales

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/admin/ai/conversations` | Query the permitted sales queue |
| `POST` | `/api/admin/ai/conversations/:id/takeover` | Atomically claim control and stop old AI runs |
| `POST` | `/api/admin/ai/conversations/:id/messages` | Send a human message |
| `POST` | `/api/admin/ai/conversations/:id/return-to-ai` | Explicitly create a new AI-control version |
| `PATCH` | `/api/admin/ai/conversations/:id/assignment` | Assign or reassign under role policy |
| `POST` | `/api/admin/ai/conversations/:id/close` | Close and record the outcome |

The Chat BFF owns all `/api/admin/ai/*` routes. It validates the shared JWT, re-reads the current NoSQL user row on every request so suspension and role changes take effect immediately, and then applies PostgreSQL row-level business authorization. These routes do not use the generic collection CRUD API.

## 7. Operational Data Model

Minimum logical entities:

- `conversations`: owner credential hash, status, `modeVersion`, assignment, retention state, next event sequence.
- `conversationMessages`: visitor, assistant, and human messages with visibility and provenance. Message **content** is immutable once written; a small set of assignment fields (which run was reserved to answer a visitor message, and the epoch it arrived in) is set by the owning transaction. Content is edited only by a retention tombstone.
- `aiRuns`: internal operation ID, engine run ID, expected mode version, status, timestamps, error category.
- `conversationEvents`: monotonically sequenced committed events used by SSE.
- `leads`: consented contact fields, source, assignment, status, and audit linkage.
- `outbox`: start-run, cancel-run, notification, and CRM work with idempotency metadata.
- `auditEvents`: actor, action, target, result, and safe metadata without secrets or raw prompt logging.

Existing CMS, users, OEM inquiries, and media remain in the existing NoSQL store.

## 8. Human Handoff Invariant

`conversation.status` and `modeVersion` are the source of truth:

```text
BOT_ACTIVE -> HANDOFF_REQUESTED -> HUMAN_ACTIVE -> CLOSED
     |                                |
     +---------- direct takeover -----+
HUMAN_ACTIVE -> BOT_ACTIVE only through an authorized explicit return
```

Every change of AI/human control increments `modeVersion` atomically.

### Required sequence

1. A visitor-message transaction writes the message and, **only when the conversation is bot-controlled and no run is already live**, reserves `aiRun(CREATING, operationId, expectedModeVersion)` and writes a start-run outbox item. A message arriving while an answer is in flight is stored, and is answered when that run terminalizes **provided the conversation is still bot-controlled in the epoch the message arrived in**; if a human takes over first, the message is left for that person and is never assigned to an AI run, including after control returns. At most one run per conversation is live at a time. The public request does not create an external run directly.
2. A worker locks or conditionally claims the run, rechecks `BOT_ACTIVE` and the expected version, then creates the Hermes run with a stable operation ID.
3. The pinned Hermes version must prove replay-safe creation. If it does not, interpose a persistent operation-ID mapping layer. It belongs to the BFF and wraps the engine boundary; it is not an engine adapter, because `LLD-002` forbids database access inside one and this layer owns a table.
4. The external run ID is recorded **write-once** as soon as it is known — no mode or status fence, `NULL` becomes the handle, a replay of the same handle succeeds, and a *different* handle never overwrites the first (retain both, cancel both, alert). Only the run's authorization to stream is conditional on the same mode version. A lost fence immediately requests cancellation, using the ID just recorded. Recording and authorizing were a single conditional step in an earlier revision of this document; splitting them keeps the pointer needed to stop an already-created run, instead of discarding it at the one moment it is required and depending on vendor run-listing to recover. `LLD-001` §5 specifies the two writes. Note that `ADR-001` still describes the earlier single-step form; this document is canonical.
5. Every AI token, citation, error, and final message is first appended as a committed `conversationEvents.sequence` under the conversation lock. Hermes events never write directly to the HTTP response.
6. Human takeover uses the same lock or compare-and-set transaction to change status, increment the version, mark old runs for cancellation, append `handoff.started`, and write cancellation outbox items.
7. The SSE dispatcher emits only committed events in sequence. Once `handoff.started(sequence=N)` commits, no old-version AI event may be appended with a sequence greater than `N`.
8. The cancellation worker stops known engine runs idempotently. Runs still between external creation and registration are reconciled by operation ID and then stopped.

Client-side filtering is defense in depth. A prompt instruction to stop is not a concurrency control.

## 9. Security Requirements

- No Hermes, Lexiang, model, database, or CRM credential reaches browser JavaScript.
- Hermes listens only on a private network path and accepts only authenticated BFF calls.
- Pin the Hermes release and image digest; do not deploy `main` or `latest`.
- Use a dedicated profile and data directory for public customer service.
- The actual `/v1/toolsets` response is the deployment contract. Assert the required read-only tools and deny terminal, process, files, patching, browser, code execution, delegation, cron, memory management, skill management, and messaging.
- Use a dedicated read-only Lexiang credential restricted to a physically or permission-isolated public space.
- Sanitize rendered Markdown, apply CSP and `nosniff`, validate all input, and cap length, turns, tokens, concurrency, and rate.
- Apply edge and BFF rate limits by IP, session, and global budget; return `429` with `Retry-After`.
- Treat retrieved documents as untrusted input. Prompt injection cannot grant a tool or data capability.
- Separate contact PII from public transcript data and default logs to IDs, state, latency, token counts, and error categories.
- Fail closed when knowledge or model evidence is unavailable.

## 10. Widget Requirements

- Implement as an Astro/React client island using the site's design tokens.
- Use a full-height mobile drawer and a bounded desktop surface that does not cover navigation, forms, or consent UI.
- Support keyboard open/close, focus containment, `Escape`, ARIA live regions, and reduced motion.
- Stream over SSE and provide Stop, Retry, and reconnect/reconciliation behavior.
- Sanitize Markdown and secure external links; reject arbitrary HTML, scripts, styles, and iframes.
- Label the experience as an AI assistant, state its limits, and keep a visible human/inquiry path.

## 11. Validation Contract

The production gate must include:

- Unit tests for state transitions, authorization, retention decisions, and event ordering.
- Adapter contracts for the pinned Hermes Runs API, stop behavior, toolsets, Lexiang tools, model endpoint, email, and CRM.
- Integration tests with fake dependencies and real PostgreSQL transactions.
- Race tests with takeover before run creation, between creation and registration, before and after token append, and before final commit.
- Evaluation cases for FAQ paraphrases, multilingual queries, exact product terms, unknown questions, stale certificates, price promises, prompt injection, and secret extraction.
- Browser E2E for responsive layout, keyboard access, XSS, reconnect, cancel, lead consent, and human takeover.
- Failure drills for database, Hermes, model, Lexiang, queue, email, timeout, restart, and quota exhaustion.

Suggested pilot targets, subject to product approval:

| Metric | Target |
|---|---:|
| Grounded-answer rate on approved FAQ set | at least 90% |
| Citation coverage when knowledge is required | at least 95% |
| Secret, internal-cost, or cross-conversation leakage | 0 |
| Old AI events **committed** after a committed takeover | 0 |
| Correct refusal or escalation on unsupported questions | at least 95% |
| Pilot availability | 99.5% |

## 12. Production Approval Gates

The isolated staging pilot may continue, but public production remains blocked until all are closed:

1. Pin and verify a Hermes release and image digest, including negative toolset assertions.
2. Provision and test the isolated read-only public Lexiang space.
3. Choose the sales takeover workplace, role model, and notification channel.
4. Approve consent, PII, transcript retention/deletion, and production data region.
5. Approve the model provider, data-processing terms, monthly budget, and quota alerts.
6. Approve and test the PostgreSQL compare-and-set and ordered-event handoff design.
7. Prove Runs create replay semantics or implement the persistent operation-ID adapter.
8. Prove production PostgreSQL connectivity, transactions, rollback, pooling, and failure behavior.
9. Approve the public FAQ corpus, supported languages, grounding/refusal thresholds, golden evaluation set, and pilot acceptance metrics; execute the release evaluation against the pinned runtime.
10. Approve and record the widget public-route allowlist, with the product owner and security owner named; add a route-level test proving excluded surfaces do not load the assistant.

## 13. Delivery Boundary and Estimate

With the existing prototype, the production increment remains approximately **22-38 person-weeks**:

- 4 weeks can produce a controlled knowledge-only pilot with a small parallel team if knowledge, credentials, domain, and cloud environment are ready.
- 6-8 weeks can produce a production pilot with sales queue, hard takeover, persistence, consent/retention, monitoring, and race/security acceptance.
- A one-week demo is not a production customer-service system.

The estimator, trend, supplier, and logistics modules are separate workstreams. Their details remain historical roadmap material until each receives its own English owning design.

## 14. Environment and Purchase Strategy

The existing CloudBase NoSQL environment remains the source for CMS, users,
OEM, media and current Cloud Functions. The assistant adds a separate
PostgreSQL operational store; it does not migrate or replace those workloads.

Keep one PostgreSQL implementation from development to production:

| Stage | Runtime and store | Purchase posture |
|---|---|---|
| Local development | Docker Compose: BFF, workers, PostgreSQL 16 | No cloud purchase |
| CI | PostgreSQL service, same migrations and race tests | No persistent cloud purchase |
| Cloud integration | CloudRun plus short-lived pay-as-you-go TencentDB PostgreSQL in ap-shanghai | Bounded test-window spend; release after evidence if no shared environment is needed |
| Customer pilot/production | CloudRun plus sized TencentDB PostgreSQL on a private VPC path | Approve from measured traffic, connections, retention, RPO and RTO; pay-as-you-go or monthly |

A second CloudBase PG-mode environment is optional sandbox capacity, not the
primary target. PG mode requires a newly created environment; the existing
traditional NoSQL environment cannot be upgraded in place. One free-experience
environment with 3,000 monthly resource points may be available at the account
level, but eligibility, renewal and workload sufficiency must be confirmed. If
the PG environment exposes a normal server-side PostgreSQL connection and passes
the store probes, the same implementation may be reused. An HTTP/RPC-only path
moves transaction logic into database functions and requires a reviewed store
implementation.

Local Docker is production-shaped, not production-equivalent. It proves the
container process, SSE server, health checks, graceful shutdown, migrations,
transactions and race suite. It does not prove CloudRun gateway behavior, CORS,
scale-to-zero cold starts, VPC attachment, TLS, managed pooling, quotas or
billing. Those are repeated against the deployed path before public traffic.

CloudRun is usage-based, not inherently a several-hundred-yuan monthly server.
At the currently published rates, one continuously warm `0.25 core + 0.5 GiB`
instance is about 21.72 yuan/month compute-only, and `1 core + 2 GiB` is about
86.87 yuan/month. `minNum=0` may reduce low-traffic compute by scaling to zero,
with a cold-start trade-off. Multiple services/replicas, logs, egress and other
resources add cost, and the existing Standard-plan resource-point deduction
must be confirmed on the actual bill.

CloudRun is the production runtime for this product. Local Docker Compose is the
development substitute for its BFF and worker containers. Future agents must not
reopen the runtime choice during implementation; a proposed replacement requires
a new ADR rather than an MIU-level trade-off.

The knowledge path is also fixed for this release:

```text
BFF -> ConversationEngine -> pinned Hermes profile -> Lexiang MCP server
```

The BFF does not call Lexiang REST directly, and the browser never calls
Lexiang. The local working artifact used an MCP URL and an `lxmcp_...` bearer
credential. A REST AppKey's interface and knowledge authorization range is
useful administrative evidence, but it does not prove that the serving MCP
credential has the same scope. Gate 2 closes only against the exact MCP
credential and tool surfaces deployed in the Hermes profile.

The local-development design does not require Lexiang infrastructure on a
developer machine. Current and planned layers are explicit:

- The existing deterministic `FakeEngine` already supports successful token
  streams, citations, transport failures, timeout and overlong-output cases.
- MIU 5a and integration MIUs add answer-policy fixtures, including
  `knowledge_empty` and `unavailable`; those cases are not yet implemented.
- MIU 4 creates a local stub Hermes HTTP server that emits recorded, sanitized
  Hermes event fixtures for adapter transport tests; that stub is not yet built
  and will not call Lexiang.
- A developer may run the pinned Hermes container locally with a test-only MCP
  credential for manual integration, but it is optional and must contain no
  internal or customer data.
- Shared staging, contract probes, golden-set evaluation and production use the
  real dedicated public Lexiang space and the exact scoped MCP credential.

MIU 2a also creates the Docker Compose BFF/worker/PostgreSQL development stack;
it does not exist in the current repository yet.

Lexiang itself remains a managed external service. There is no Lexiang database,
index, or MCP server to install locally. The company administrator creates the
public space, obtains or mints the MCP credential, stores it in Secret Manager,
and gives the deployment only a secret reference. Hermes is configured with the
MCP URL, bearer credential, timeout and a read-only tool allowlist. Startup
readiness fails if the MCP server or credential is absent.

Before traffic, the deployed credential must pass, per exposed MCP surface: a
known public positive read/search, a known internal denial, a public write
denial, and a deliberately over-scoped sensitivity run that turns the probe red.
If Lexiang cannot provide a credential that passes this contract, gate 2 remains
blocked; implementation does not silently switch transport or relax isolation.

No long-term infrastructure purchase is required to start local implementation.
The first bounded cloud spend is the pay-as-you-go database integration window.
Before customer traffic, the architect approves the complete operating envelope:
CloudRun, PostgreSQL, Hermes hosting, model usage, Lexiang licensing if any,
logs/monitoring, WAF, network and notification services.
