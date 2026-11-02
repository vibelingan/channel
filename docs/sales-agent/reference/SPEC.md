# SPEC — AI assistant Phase 2: product-aware sales agent

**Status:** Draft for owner review · 2026-09-18
**Source request:** product owner, in chat on 2026-09-18 (paraphrased in §1)
**Plan:** [PLAN.md](./PLAN.md)

## 1. Problem

The website now shows 128 imported products, but the assistant only knows five
company documents. A buyer who asks about headphones, a product's details, or a
vague need ("something for a gym promotion") gets a generic answer or a refusal.
The assistant disappears on product pages, and after a refresh or page change
the chat panel is blank. It cannot help with real work such as finding the right
product or starting a quote.

The owner's words: it should behave "like real customer service", with enough
knowledge of the website, products and company, and help the buyer "do actual
work like init quote, look for proper product or service".

## 2. Solution

A product-aware sales agent inside the existing widget and backend:

- knows the current public catalog and searches it from vague requests;
- answers product questions from the product's approved details;
- replies with product cards that open the product page;
- keeps the conversation across refreshes, page changes and (per D2) tabs;
- knows which page and product the buyer is looking at;
- prepares, but never submits, a quote or an inquiry;
- keeps answering company and OEM questions from the knowledge base.

Architecture, memory model, permission levels and MIUs are in PLAN.md §3–§7.

## 3. Constraints

- All Phase 1 non-negotiables stand (SECURITY.md §11), amended only through
  ADR-003 where PLAN.md §3 lists the change.
- Nothing commercially binding is an assistant action.
- Catalog data reaches the assistant only after the five prerequisites in
  `KNOWLEDGE-CONTENT-BRIEF.md:153-191`.
- Only anonymous, published product data may be indexed.
- The widget is mounted per page on an approved allowlist (SECURITY §9).
- Migrations may not install PostgreSQL extensions.
- CloudRun, PostgreSQL in the Shanghai VPC and the hosted KB stay the runtime.

## 4. Non-goals

- Live human takeover console and an AI lead queue (later phase).
- Negotiated prices, discounts, sample terms or delivery promises.
- Orders, payments, or any submission without the buyer's click.
- Cross-device memory and logged-in buyer history.
- Proactive pop-ups that open the assistant uninvited.
- Voice.

## 5. Success criteria

1. On 40 labelled vague product requests, a relevant product appears in the top
   3 cards for at least 85 %.
2. Zero invented prices, product ids or certifications across the 60-case
   release set.
3. History is fully restored in 100 % of reload and page-change e2e runs.
4. On a product page, "this one" resolves to that product in the e2e suite.
5. A buyer can go from a chat to a prefilled quote form and submit it (e2e,
   test fixture).
6. First visible status within 1 s; full-answer latency target set from B0
   measurements.
7. Every SECURITY §8 cap degrades to the inquiry form, never to an unmetered
   answer.

## 6. Quality criteria

- Each MIU is independently testable and names its check before it starts.
- Every surface in PLAN.md §3's table changes in the same PR as the behaviour it
  governs (README normative surface index).
- Cards and blocks are structured data rendered by React, never model-authored
  HTML or Markdown links.
- Accessibility: keyboard reachable cards and chips, 40 px minimum targets,
  `aria-live` status line, reduced motion respected (DESIGN.md).

## 7. Blindspots considered

From an independent codebase scan on 2026-09-18; each item was checked against
the cited file before being recorded.

| Finding | Outcome |
|---|---|
| KB brief requires five prerequisites before catalog data; pricing template and eval case expect a price refusal | **Decided:** MIU B2 delivers them; v1 shows no prices (D1 pending) |
| SECURITY §11.5 forbids model output choosing a database query; §6 limits model-influenced links to citations | **Decided:** ADR-003 amends §5/§6/§11 for schema-bounded fixed queries and code-built first-party links (D3 pending) |
| Engine id gate, KB evidence tied to chat generation, provenance CHECK allows only `oci`/`git` | **Decided:** new engine id and provenance kind (C1), evidence moves to `/vector-search` (B0/B1) |
| Answer gate requires `channelkb` citations | **Decided:** add a validated `catalog:` namespace (C3) |
| Event CHECK, contracts, BFF mapping and `storeEvent` accept only current types; assistant rows store text only | **Decided:** migration 004 and blocks stored with messages (C4); transcript read from messages |
| CI forbids `CREATE EXTENSION` | **Decided:** built-in full-text search in v1; extensions only via DBA pre-install |
| Public API has no change cursor; quote needs the approved revision; some products have no approved detail | **Decided:** full reconcile sync; the product page's own sheet supplies the revision; no-detail products fall back to the inquiry form |
| VIP members would see different prices in a card and on the page | **Decided:** no prices in v1 cards |
| No page-level CSP; widget must be mounted per page | **Decided:** MIU A6; A3 mounts per page |
| Gate 10 needs named product and security owners | **Deferred to owner:** D6 |
| Handoff has no route, no sales role, no admin credentials in the BFF; an inquiry queue already exists | **Decided:** Phase 2 hands off through the existing inquiry form; AI lead queue deferred |
| Linking a conversation to a NoSQL inquiry widens retention scope | **Decided:** no link |
| SECURITY §8 caps missing; tool loop affects the worker lease | **Decided:** MIU C8 and C2; values in D7 |
| Worker loads the oldest 30 messages, so long chats lose the newest question | **Decided:** MIU A0, raised as a separate fix for production now |
| No Playwright spec covers the widget | **Decided:** A2 adds the first one |
| New secret must join `SECRET_ENV_KEYS` and the bundle secret scans | **Decided:** part of B1/C1 |
