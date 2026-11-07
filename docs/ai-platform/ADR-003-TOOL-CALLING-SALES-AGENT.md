# ADR-003: Tool-calling sales agent with a catalog index

- **Date:** 2026-09-18
- **Status:** Proposed. Acceptance requires the B0 evidence spike and owner
  decision D3 in [the Phase 2 plan](../ai-assistant-phase2/PLAN.md#9-decisions-needed-from-the-owner).
- **Amends:** ADR-002 (the retrieval engine stays; its role narrows) and LLD-002
  (the port gains a tool-calling model boundary).

## Context

Phase 1 sends the conversation to the AnythingLLM-compatible engine, which
retrieves from five public documents and writes the answer. The worker withholds
that answer until the citations pass policy. This works for company questions.

Phase 2 needs the assistant to find products from vague requests, answer from a
specific product's details, show products as cards, and prepare a quote. Three
facts shape the choice:

1. The catalog is structured, changes daily through the Alibaba sync, and has
   128 public products today (observed 2026-09-18).
2. Prices, MOQ and stock must never come from the model. They must come from
   the same data the product page shows.
3. ADR-002 §5 named "retrieval joined to relational state (e.g. per-product)" as
   a trigger for moving retrieval into our own PostgreSQL. This is that case.

## Options

**A. Put product pages into the knowledge base as documents.** Least code. But
the index would lag the catalog, answers would be text only, citations would map
to documents rather than product ids, filters (family, category) would not
exist, and nothing could be prepared or opened for the buyer.

**B. Deterministic router, no model tools.** Code classifies the question, runs
a product search, and attaches cards; the knowledge base writes the text. Safe
and cheap, but keyword routing fails on exactly the vague requests Phase 2 is
for, and multi-step turns ("compare the first two, then quote the cheaper one")
need hand-written flows.

**C. Tool-calling loop in the worker (chosen).** The worker calls an
OpenAI-compatible model with a small set of tool schemas. The model chooses which
read-only tools to call; the worker executes them against PostgreSQL (catalog)
and AnythingLLM `/vector-search` (company knowledge, retrieval only); the model
returns text plus UI blocks that name product ids; policy code validates the
blocks and fills every commercial number from catalog data.

## Decision

Adopt C, behind `AI_AGENT_MODE=tools|kb-only`. The current Phase 1 path remains
as `kb-only` and is the automatic fallback when the model or tool path fails
readiness.

- Catalog retrieval lives in the AI PostgreSQL (`catalog_products`), filled by a
  worker sync from the **anonymous** public API projection. Built-in PostgreSQL
  full-text search first (migrations may not install extensions); `pg_trgm` or
  pgvector only if the labelled query set misses target and a DBA pre-installs
  them.
- AnythingLLM stays the company-knowledge store and content UI. The worker uses
  its retrieval endpoint, which ADR-002 §4 already preferred ("we retrieve chunks
  from it, apply our own answer policy and refusal rules, and call the model
  ourselves"). The `channelkb` prefix gate is unchanged.
- The worker holds a model-provider credential in Secret Manager. The browser and
  the BFF never do.
- Answers stream. Because sources are retrieved and approved before the model
  writes, the whole-answer hold is no longer needed; the commercial-value check
  runs per sentence before each fenced append. The BFF relays the event log as
  AI SDK UI message stream parts. Details and targets:
  [TECH-REVIEW.md](../ai-assistant-phase2/TECH-REVIEW.md).
- Tools are read-only or produce UI proposals. There is no tool that submits,
  sends, books, or changes any record outside the conversation's own session
  facts.
- Prefer the narrower alternative if B0 fails: fixed code runs the product
  search first from the visitor's text, and the model only picks from the ids it
  is handed. That keeps SECURITY §11.5 unamended at the cost of weaker handling
  of vague requests.

## Consequences

**Positive:** product answers come from current catalog data; vague requests work
because the model rewrites them into searches; cards, comparisons and quote
drafts become possible; one database holds conversations and the catalog index,
so retention and joins stay in one place.

**Negative:** a second credential in the worker; more model calls per turn
(cost, latency); a new adapter and policy surface to test; the tool loop becomes
the component most exposed to prompt injection through supplier text.

**Must change together** (README normative surface index; full table in
[PLAN.md §3](../ai-assistant-phase2/PLAN.md#what-has-to-change-with-it)):

- **SECURITY.md §11.5 and §6.** Today model output may never "choose a database
  query", and the only link it may influence is a citation URL. This ADR amends
  both: a tool whose arguments are bounded by a schema (free-text keywords capped
  in length, enum filters, a product id that must exist in the index) and that
  runs a fixed, parameterized, read-only query over public data is an approved
  read-only knowledge tool. Product links in blocks are first-party paths built
  by code from validated ids; the model never supplies a URL. The side-effect
  enumeration test §6 asks for is written in the same MIU.
- **SECURITY.md §3 and §5.** The model key moves from the engine profile to the
  worker. The worker's tool registry is the asserted exact set.
- **Engine gate and provenance.** A new engine id, a provenance kind for a
  hosted model API (provider, model id, applied-config digest) with a migration
  to the provenance CHECK, and KB evidence that proves `/vector-search` rather
  than chat generation.
- **Events.** Migration 004 adds `status` and `block`; `packages/ai-contracts`,
  the BFF mapping, `storeEvent` and the LLD-001 §4.3 writer table change with it.
- **Answer gate.** A `catalog:` citation namespace validated against the index,
  beside the unchanged `channelkb` rule.
- **Catalog prerequisites.** The five items in
  `KNOWLEDGE-CONTENT-BRIEF.md` ("Product data from the Alibaba catalogue sync")
  exist before any catalog row is indexed.
- **Deploy.** `MODEL_API_KEY` joins `SECRET_ENV_KEYS` and the bundle secret
  scans.
- **Extensions.** Migrations still install none; v1 search uses built-in
  full-text search.

## Evidence required before acceptance (MIU B0)

- The chosen provider models return valid tool calls for the planned schemas,
  with measured argument validity, latency and cost per turn.
- Streaming or non-streaming behaviour with tools is recorded; the worker already
  withholds text until policy passes, so non-streaming is acceptable.
- The hosted knowledge base answers `/vector-search` with approved sources using
  the production credential.
- Empty-content-with-tokens responses (ADR-002 §7) are detected as failures in
  the tool path too.
