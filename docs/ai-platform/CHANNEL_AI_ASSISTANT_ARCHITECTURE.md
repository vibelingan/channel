# Channel Public AI Assistant Architecture

**Product:** Diversity Technology Limited website  
**Status:** Proposed; production approval blocked by the gates in this document  
**Last reviewed:** 2026-08-11  
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

The BFF exposes a provider-neutral `ConversationEngine` boundary. Hermes is the first adapter. Direct Lexiang Q&A, Tencent ADP, or a CloudBase Agent can replace it only through a later ADR and equivalent security, cancellation, evaluation, and operations evidence.

## 2. Evidence and Current State

### Observed

- A local prototype proved browser -> Hermes `/v1/chat/completions` -> DeepSeek -> Lexiang MCP connectivity.
- Hermes Agent is the public Nous Research project and supports an API server, streaming, Runs, stop, sessions, MCP, health endpoints, and Docker deployment.
- The default Hermes API-server tool surface is much broader than public customer service requires.
- The repository currently has no production AI widget, Chat BFF, assistant conversation store, lead queue, or human-takeover implementation.

### Not yet proven

- The exact pinned Hermes release and container digest.
- Idempotent Runs creation semantics for the pinned release.
- The production CloudRun network path and PostgreSQL transaction boundary.
- A public-only Lexiang space whose credential cannot access internal knowledge.
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
- Stop all old AI output after a human takes control.
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

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/ai/conversations` | Create an anonymous conversation and short-lived conversation credential |
| `POST` | `/api/ai/conversations/:id/messages` | Append a visitor message and reserve an AI run using an idempotency key |
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
- `conversationMessages`: immutable visitor, assistant, and human messages with visibility and provenance.
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

1. A visitor-message transaction writes the message, reserves `aiRun(CREATING, operationId, expectedModeVersion)`, and writes a start-run outbox item. The public request does not create an external run directly.
2. A worker locks or conditionally claims the run, rechecks `BOT_ACTIVE` and the expected version, then creates the Hermes run with a stable operation ID.
3. The pinned Hermes version must prove replay-safe creation. If it does not, place a persistent operation-ID mapping adapter in front of it.
4. Registration of the external run ID is conditional on the same mode version. A lost fence immediately requests cancellation.
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
| Old AI events visible after committed takeover | 0 |
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
