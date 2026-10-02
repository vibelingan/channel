# AI assistant Phase 2 — product-aware sales agent

**Status:** Proposed plan, awaiting owner decisions (section 9)
**Date:** 2026-09-18
**Base:** `origin/main` at `b0015c0`
**Spec:** [SPEC.md](./SPEC.md) · **Decision record:** [ADR-003](../ai-platform/ADR-003-TOOL-CALLING-SALES-AGENT.md) · **Technical review:** [TECH-REVIEW.md](./TECH-REVIEW.md)
**Visual version:** [Sales Agent Phase 2](https://claude.ai/artifact/3Am4dwBztj8cM5uqNaWMso) (private until shared from its menu)

Evidence labels: **observed** (checked in code or on the live site on
2026-09-18), **reported** (a named doc or source says so), **assumed** (not yet
checked; the MIU that checks it is named).

---

## 1. Where the assistant stands today

Phase 1 is live and does one job well: it answers company and OEM questions
from five approved public documents, cites them, and refuses when it has no
source.

| Area | State | Evidence |
|---|---|---|
| Live on the website | Yes, on `/`, `/headphones`, `/oem` only | observed live; `apps/site/src/lib/ai-widget-routes.ts:8` |
| Backend | BFF + worker on CloudRun, PostgreSQL in the Shanghai VPC, hosted AnythingLLM KB | reported: `docs/ai-platform/CLOUDRUN-DEPLOY-EXECUTION-2026-09-15.md` |
| Knowledge | Five public site content files, `channelkb` prefix | reported: `PHASE-1-REMOTE-KB-HANDOFF.md`; `packages/ai-policy/src/index.ts` |
| Grounding | Answer withheld until citations pass the prefix gate and the commercial-value check | observed: `apps/ai-worker/src/worker.ts:355-420` |
| Model context | Server keeps the conversation; up to 20 turns sent, contact data redacted | observed: `preparePublicTurns` — but see bug below |
| Tools | None; `AI_MAX_TOOL_CALLS=0` | observed |

**Live bug found during this review (observed in code, not reproduced in a
run):** `getRunExecutionContext` loads the *oldest* 30 messages
(`packages/ai-store/src/store.ts:466-472`, `ORDER BY created_at ASC LIMIT 30`).
After about 15 exchanges the newest question is not sent to the model. This is
MIU A0 and was raised as a separate fix task because it affects today's
production assistant.

### Gaps against the Phase 2 goal

1. **It does not know the catalog.** 128 public products are live (120
   headphones, 5 AI gadgets, 3 toys; observed via `/api/products`). None are in
   the knowledge base. This is deliberate: `KNOWLEDGE-CONTENT-BRIEF.md:153-191`
   lists five prerequisites before any catalog data may reach the assistant.
2. **The site's product search cannot handle vague requests.** It is a
   substring match over `name`, `series`, `modName`
   (`packages/shared/src/collections.ts:278`). Observed live: `headphones for
   gym` returns 0, although "OEM ODM Over-ear Sport Wireless Bluetooth
   Headphones for Running Jogging" is published.
3. **It can only reply with text.** Public events are `token`, `citation`,
   `final`, `error` and control events, and a database CHECK enforces that list
   (`001_ai_assistant.up.sql:96-111`).
4. **The conversation disappears from the screen.** The widget keeps the key in
   `sessionStorage` but mounts with an empty list, and there is no transcript
   route (`AssistantWidget.tsx:28`, `server.ts:257-265`).
5. **It vanishes where buyers decide.** Observed live: no widget on `/toys/` or
   `/products/item/`.
6. **It does not know the current page.** Message body is `{ message,
   idempotencyKey }`.
7. **It cannot act.** No tools, no handoff route, no sales view; the `leads`
   table has no writer.
8. **A new tab is a new conversation**, and the key expires after 24 hours.
9. **Spend limits are incomplete.** Only per-minute global and per-IP limits
   exist (`server.ts:96-112`); SECURITY §8's per-conversation, per-run and
   daily-spend caps do not. A tool loop makes this matter more.

---

## 2. What Phase 2 delivers

In one conversation, across page changes and refreshes, a buyer can:

- Describe a need vaguely ("cheap headphones for a gym promotion, about 2,000
  pieces") and get 3–6 matching products as cards, or one short clarifying
  question first when the request is too open.
- Ask about a specific product ("does this come in black?", "what is in the
  box?") and get an answer from that product's approved details.
- Compare two or three products side by side.
- On a product page, say "this one" and have the assistant know which product.
- Leave, browse, come back: the conversation is still on screen.
- Start a quote: the assistant collects quantity, delivery month and
  customization, then opens that product's existing quote form with those
  fields filled. The buyer adds contact details and presses Submit.
- Ask for a person: the assistant opens the existing inquiry form with an
  editable summary of the needs; the buyer adds contact details and submits. It
  lands in the Inquiries page sales already use.

Company, OEM, certification and policy questions keep using the knowledge base.

---

## 3. Architecture change

### The decision (ADR-003, proposed)

The worker stops asking the knowledge base to write the whole answer. It runs a
short **tool-calling loop** with the language model: the model picks which
read-only tools to call, the worker runs them as fixed parameterized queries,
and the model returns text plus UI blocks that name product ids. Code then
validates the blocks and fills every displayed fact from catalog data.

The model is good at turning "for the gym" into a search; it is not a safe
source of prices, stock or product ids. So the model chooses *which* products;
code decides *what* is shown about them.

```text
Browser widget ──HTTPS──> BFF (CloudRun, public)
   │                         │ writes message + page context, reserves run
   │                         v
   │                     PostgreSQL (VPC)  <── catalog sync (every 15 min)
   │                         │                    reads the anonymous public API
   │                         v
   │                     Worker (CloudRun, private, NAT egress)
   │                         │ 1. context: profile, session facts, page, recent turns
   │                         │ 2. model call with tool schemas ──> LLM provider
   │                         │ 3. tools (max 4 per turn), fixed queries only:
   │                         │      search_products / get_product_details -> PostgreSQL
   │                         │      search_knowledge -> AnythingLLM /vector-search
   │                         │ 4. model returns text + blocks
   │                         │ 5. policy gate v2
   │                         v
   └──<── SSE: status, token, block, citation, final ── committed events
```

The current Phase 1 path stays as `AI_AGENT_MODE=kb-only`, the fallback when
the tool path fails readiness.

### What has to change with it

These surfaces enforce today's design and would reject Phase 2 unless changed
together (README "Normative Surface Index"):

| Surface | Today | Change |
|---|---|---|
| `SECURITY.md` §11.5, §6 | model output may never "choose a database query"; the only link it influences is a citation URL | amend: schema-bounded arguments to fixed, parameterized, read-only queries over public data are approved tools; card links are first-party paths built by code from validated ids; add the enumerated side-effect test §6 asks for |
| `SECURITY.md` §3, §5 | model key held by the engine profile; exact tool set asserted | worker holds `MODEL_API_KEY`; the tool set becomes the worker's own registry, asserted exactly at startup |
| LLD-002 port | no tools, no database access in an engine | new tool-calling model boundary beside `ConversationEngine`; tools live in the worker, not the adapter |
| Worker engine gate | only `fake` / `anythingllm` (`worker.ts:822`); KB evidence proves chat generation | new engine id; KB evidence proves `/vector-search` instead of generation |
| Provenance | `oci` or `git`, DB CHECK (`003_git_config_provenance.up.sql`) | new provenance kind for a hosted model API (provider, model id, config digest), migration |
| Events | CHECK allows 8 types; `storeEvent` throws on others (`worker.ts:441-452`) | migration 004 adds `status`, `block`; contracts, BFF mapping, LLD-001 §4.3 writer table |
| Assistant messages | final text only (`store.ts:879`) | store blocks with the message so the transcript can redraw cards |
| Answer gate | every citation must start `channelkb`; any price text is replaced by the template | add a `catalog:` citation namespace validated against the index; commercial-value rule per decision D1 |
| Deploy | `SECRET_ENV_KEYS` = DB, KB, IP hash (`cloudrun-service-manifest.mjs:29`) | add `MODEL_API_KEY`; bundle secret scans (`ci.yml`, `deploy-test.yml`); runtime bundle check |
| Extensions | CI test fails any `CREATE EXTENSION` (`migrations.test.ts:18-28`) | v1 uses built-in full-text search only; `pg_trgm`/pgvector only if a DBA pre-installs them and readiness checks |
| Budgets | per-minute global and per-IP only | per-conversation turns, per-run tokens, daily spend; `BUDGET_EXHAUSTED` degrades to the inquiry form |

### Rules that do not change

- No vendor credential reaches the browser.
- Nothing commercially binding is an assistant action
  (`CHANNEL_AI_ASSISTANT_ARCHITECTURE.md` §4). The assistant prepares; the buyer
  submits through an existing form; staff commit.
- Knowledge-base citations still need the `channelkb` prefix; mixed evidence
  still fails as a unit.
- No fallback that answers from the model's own memory (SECURITY §8).
- Takeover fence and ordered events (LLD-001) apply to every new event type.

---

## 4. Memory: what is remembered, where, for how long

| Layer | What | Where | Lifetime |
|---|---|---|---|
| Browser key | conversation id + credential | today `sessionStorage` (one tab); proposed `localStorage`, 7-day sliding, "New chat" resets | decision D2 |
| Transcript | visitor and assistant messages, citations, blocks | PostgreSQL `conversation_messages` (+ blocks) | retention policy (gate 4, still open) |
| Model context | the most recent turns (after A0), contact data redacted | built per run | per run |
| Session facts | family, use case, quantity, delivery month, customization, shortlisted ids, products viewed | PostgreSQL `conversation_facts`, strict schema, written by `update_session_facts` | same as transcript; needs its own deletion row |
| Page context | path and product id per visitor message, resolved server-side | on the message row | same as transcript |

Not remembered by the model: name, email, phone, company. Those are typed by
the buyer into the existing forms and go straight to the existing inquiry
store. No conversation id is attached to an inquiry, so the NoSQL inquiry data
stays outside the assistant's retention scope (SECURITY §7).

After a page change: the page loads, the widget (mounted on that page) reads the
key, calls the transcript route, redraws history and reopens if it was open. On
a product page it offers "Ask about this product". The next message carries
`page.productId`; the server resolves it against the catalog index, so a forged
id finds nothing.

---

## 5. What the assistant may do

| Level | Actions | Who confirms |
|---|---|---|
| Look up, on its own | search products, read product details, search company knowledge, update session facts | nobody; read-only, fixed queries, max 4 calls per turn |
| Offer, buyer clicks | product cards, comparison, open product page, add to inquiry list, open prefilled quote form, open prefilled inquiry form | the buyer, on a first-party control |
| Commit, staff only | final price, discount, sample terms, delivery promise, anything binding | sales, outside the assistant |

Prefill travels in same-origin browser memory, never in URL parameters. The
product page's own quote sheet supplies the current approved `revision` from its
live detail request (`quote-draft.ts:59-66`), so the assistant never needs to
know it. A product without an approved detail page (detail returns 404,
`catalog-detail.ts:38-41`) falls back to the general inquiry form.

---

## 6. Catalog index: fresh and public-only

```text
Alibaba ICBU ──sync fn──> CloudBase products (NoSQL, includes private fields)
                              │
                              v  anonymous projection, published only
                  public-api GET /api/products, /api/products/:id/detail
                              │
                              v  every 15 min, full reconcile
                  worker catalog sync ──> PostgreSQL catalog_products
```

- **The five prerequisites in `KNOWLEDGE-CONTENT-BRIEF.md:153-191` become MIU
  B2**: owner decision on price classes (D1), a field allowlist, a lifecycle
  contract, absence tests for VIP/negotiated/tiered/internal fields, and an
  owning MIU.
- The sync calls the public API **without** a session token, so role-gated VIP
  pricing cannot enter the index (catalog routes vary by `Authorization`,
  `http-adapter.ts:156-166`).
- The public API withholds timestamps (`handler.ts:139-141`), so there is no
  change cursor. Each sync is a full reconcile, bounded like the existing
  acceptance helper (1,000 products, 25 pages). Products missing from the
  result are removed. A failed sync keeps the last good snapshot; two misses turn
  readiness degraded.
- Supplier text from Alibaba is untrusted. It is stored as data, passed to the
  model inside delimited, length-capped tool results, and never rendered as HTML.
- Search v1: built-in PostgreSQL full-text search (`tsvector`,
  `websearch_to_tsquery`) with family/category filters, plus the model's own
  query rewrite. No extension needed. If the labelled query set misses target,
  `pg_trgm` or pgvector (reported: TencentDB PostgreSQL 12+ ships pgvector 0.8.x)
  require a DBA pre-install and a readiness check.

---

## 7. Delivery plan

> **Revised 2026-09-19 by [TECH-REVIEW.md](./TECH-REVIEW.md).** A new
> **Stage X — chat foundation** goes first: retrieve-then-generate in the worker
> with real streaming, the BFF speaking the AI SDK UI message stream protocol,
> and a widget rebuilt on `useChat` + AI Elements. It absorbs A1, A2, A4 and
> B0's model measurements, so those rows below are done inside X, not on the
> current widget. Stages B, C and D keep their order.

Stage A needs no model change and fixes the most visible problems, so it can
ship while B0 answers the model question.

### Stage A — Continuity

| MIU | What | Done when |
|---|---|---|
| A0 | Send the newest turns, not the oldest | store test with more than 30 messages fails before, passes after |
| A1 | Transcript route (from messages), its own read rate bucket | contract tests: order, 401 on wrong credential, no internal fields |
| A2 | Widget restores history and open state; first Playwright spec for the widget | e2e: ask → reload → history; ask → navigate → history |
| A3 | Mount the widget **per page** on the approved pages; update allowlist and its test | route test proves exact allow and deny sets (SECURITY §9 forbids a shared-layout conditional) |
| A4 | Storage lifetime per D2, "New chat" | unit tests for expiry and reset; e2e new tab (if D2 = device) |
| A5 | Optional `page { path, productId }`, validated, stored (migration) | contract tests reject unknown paths and malformed ids |
| A6 | Page security headers / CSP on allowlisted pages (SECURITY §9 names it load-bearing and unowned) | policy asserted on the deployed pages; inline scripts in `BaseLayout.astro` accounted for |

### Stage B — Catalog knowledge

| MIU | What | Done when |
|---|---|---|
| B0 | Evidence spike: tool calling on the chosen models; latency, argument validity, cost per turn; hosted `/vector-search` with the production credential | evidence committed; go/no-go recorded in ADR-003 |
| B1 | Accept ADR-003; amend SECURITY §3/§5/§6/§11, LLD-002, LLD-001 §4.3, TEST_STRATEGY | reviewed; every row of the surface table in §3 updated |
| B2 | Catalog field allowlist, lifecycle contract, absence tests (KB brief prerequisites) | tests prove VIP, tiered, negotiated and internal fields are absent from indexed rows |
| B3 | Migrations `catalog_products`, `catalog_sync_runs`, built-in FTS index | up/down tests on PostgreSQL 16; extension test still passes |
| B4 | Sync job: anonymous list + detail, full reconcile, approved revision stored | fake-API tests: add, update, unpublish, 404 detail, malformed row, partial failure keeps last snapshot |
| B5 | `searchProducts` and `getProductDetails` | 40 labelled vague requests: a relevant product in the top 3 for at least 85 % |

### Stage C — Agent and cards

| MIU | What | Done when |
|---|---|---|
| C1 | Tool-calling model adapter + new provenance kind (migration) | conformance tests on recorded fixtures; empty-content-with-tokens is a failure |
| C2 | Tool registry: schemas, fixed queries, 4-call and time budget, lease config | tests: invalid args, unknown tool, budget exhaustion, timeout; lease > stream + 5 s |
| C3 | Policy gate v2: `catalog:` citations, id validation, commercial rule per D1, untrusted-text handling, side-effect enumeration test | eval cases: invented price, invented id, injected instruction in a description, mixed sources |
| C4 | `status` and `block` events (migration 004), contracts, BFF mapping, blocks stored with messages | contract tests; transcript after reload shows blocks |
| C5 | `AI_AGENT_MODE` switch, readiness reports mode, automatic fallback | both modes pass acceptance |
| C6 | Widget renders cards, comparison, chips, status line | visual check against the UI spec; e2e click-through to the product page |
| C7 | "This product" on product pages | e2e: "does this come in black?" answered for the viewed product |
| C8 | Budgets per SECURITY §8: turns per conversation, tokens per run, daily spend | tests: each cap degrades to the inquiry form, never to an unmetered answer |
| C9 | Release eval set (60 cases), updating `scripts/ai-eval-cases.mjs` (its pricing case changes only if D1 allows prices) | report attached to the release PR |

### Stage D — Actions

| MIU | What | Done when |
|---|---|---|
| D1 | Quote draft block → product page opens with its quote sheet prefilled (requirement fields only) | e2e: chat → draft → sheet prefilled → submit against the test fixture |
| D2 | "Add to inquiry list" on cards, via the existing inquiry cart | e2e: item appears in the inquiry bar |
| D3 | "Talk to sales" → existing inquiry form with an editable needs summary; no conversation id attached | e2e: summary prefilled, contact empty, submission reaches the admin Inquiries page |
| D4 | Weekly counts of refused and unanswered questions | report job test; no transcript text in the report |

**Rough effort (assumed, one developer, this repo's review standard):** A 1.5
weeks, B 2 weeks, C 3.5 weeks, D 1.5 weeks. B0 can change C.

**Deferred to a later phase:** live human takeover console (LLD-001 in full), an
AI lead queue in PostgreSQL with a sales role, cross-device memory, logged-in
buyer history.

---

## 8. Risks

| Risk | Effect | Control |
|---|---|---|
| The provider's models handle tool calls poorly | wrong args, loops, empty answers | B0 before any C work; `kb-only` fallback; 4-call cap |
| Supplier descriptions carry instructions | prompt injection | delimited, capped tool results; every block validated against data; no write tools |
| Model invents a product, price or claim | commercial and trust damage | model supplies ids only; code fills facts; unknown ids dropped; commercial-value check on prose |
| A VIP member sees one price on the page and another in a card | confusion, disclosure complaints | v1 cards carry no price (D1); the page shows the viewer's own price |
| Catalog index goes stale | card for a removed product | 15-min reconcile; card click always loads the live page; stale-sync readiness alarm |
| Tool loop is slow | buyer waits | status event within 1 s; per-turn time cap |
| Longer browser memory on a shared computer | next person sees the chat | "New chat"; 7-day expiry; the transcript holds only what the visitor typed |
| Cost per conversation rises | budget overrun | C8 caps; B0 measures cost per turn |
| Wider widget placement widens the XSS surface around `channel.token` | session theft | A6 CSP; blocks are structured data rendered by React, not Markdown |

---

## 9. Decisions needed from the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Which price classes, if any, may the assistant show? (KB brief prerequisite 1.) Note that the pricing template says "We don't publish prices here" while product pages now show supplier reference ranges; that wording needs the owner too. | v1: **no prices in cards or text**; "View product" shows the viewer's own price. Revisit anonymous reference ranges after B2's absence tests exist |
| D2 | How long should a browser remember a chat? | Same device, 7 days sliding, with "New chat" |
| D3 | Give the worker its own model-provider key and amend SECURITY §11.5 so a product search is an approved tool? Without it Phase 2 stops at Stage A. | Approve after B0 |
| D4 | Where does "talk to sales" land? | Existing inquiry form and admin Inquiries page; live takeover and an AI lead queue later |
| D5 | Answer languages | English; reply in Chinese when the buyer writes Chinese |
| D6 | Which pages show the assistant, and who are the named product and security owners for gate 10 and page CSP (A6)? | All public catalog pages including `/products/item/`, plus `/`, `/oem`, `/portfolio`; never admin, sign-in, account or result pages |
| D7 | Spend caps: turns per conversation, daily model spend | set from B0's measured cost per turn |

---

## 10. Industry patterns used

| Pattern | Seen in | Used here as |
|---|---|---|
| Natural-language catalog search as an agent tool; results as product cards with actions | Shopify Storefront MCP `search_shop_catalog`, MCP-UI cards | `search_products` + card block with "View product" and "Add to inquiry list" |
| Questions about the product being viewed | Amazon Rufus (now Alexa for Shopping) | page context + "Ask about this product" |
| Clarifying questions and a drafted RFQ for B2B buyers | Alibaba.com Accio | one clarifying question; prefilled quote form the buyer submits |
| Handoff that carries collected facts to the human | Intercom Fin procedures | inquiry form prefilled with the needs summary |

Sources: [Shopify Storefront MCP](https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront),
[Shopify MCP-UI](https://shopify.engineering/mcp-ui-breaking-the-text-wall),
[Amazon on Rufus](https://www.aboutamazon.com/news/retail/how-to-use-amazon-rufus),
[Alibaba Accio (Digital Commerce 360)](https://www.digitalcommerce360.com/2026/07/24/alibaba-accio-work-agentic-ai-b2b-sourcing/),
[Intercom handoffs](https://www.intercom.com/learning-center/ai-human-collaboration-procedures-handoffs),
[TencentDB pgvector guide](https://www.tencentcloud.com/document/product/409/80360).
