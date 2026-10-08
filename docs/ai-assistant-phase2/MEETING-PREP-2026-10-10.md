# Meeting prep — the client's sales-agent flows (10 Oct 2026)

**Status:** proposal for discussion; nothing implemented
**Visual version:** [Sales Agent Flows](https://claude.ai/artifact/SHLiVpkhp49qf5nhrrTUQ9) (screens, questions, order)
and the interactive diagram [Sales Agent: Inquiry to Quote Across Chat and
Email](https://claude.ai/artifact/5EjbHy4mZCSCdJ8YJZgEy3). Both are private until shared from their Share menu.
**Companion docs:** [PLAN.md](./PLAN.md) · [TECH-REVIEW.md](./TECH-REVIEW.md) ·
[PLATFORM-VISION.md](./PLATFORM-VISION.md)

## What the client is asking for

"Resolve 80% of the sales job": know every published product in detail,
recommend products from a buyer's inquiry, handle email consultation
(read, reply, send) with the company's public knowledge, and make the knowledge
base able to answer product and customised questions.

## The job, split (our proposal to correct in the meeting)

| Sales task | Proposed owner | How |
|---|---|---|
| Product questions (specs, colours, packaging) | Agent alone | approved details of the 128 published products |
| Recommend from a vague inquiry | Agent alone | clarify once, search catalog, cards and comparison |
| Company / OEM / certifications / public terms | Agent alone | knowledge base, growing |
| Prepare a quote request | Agent prepares, buyer submits | existing quote form, prefilled |
| Price, discount, lead time, sample terms | Person | sales adds them in review |
| Read and sort inbound inquiry emails | Agent alone | classify; link to the buyer's web chat |
| Reply to inquiry emails | Agent drafts, sales approves | draft + evidence + placeholders; sent from the sales mailbox |
| Follow-ups | Agent drafts, sales approves | nudge after N days |
| Capture and qualify leads | Agent alone | Inquiries page with a needs summary |
| Keep knowledge current | Agent flags, content owner approves | weekly unanswered list → draft articles |
| Negotiate, promise, close | Person | unchanged |
| After-sales, orders, claims | Out of scope | no order data on the website |

## Flows drawn as screens

- **A · Website chat:** vague request → one clarifying question → cards from the
  catalog → comparison from approved details → quote chip.
- **B · Product page:** "this one" means the product on screen; answer with the
  source named; quote draft opens the existing form prefilled.
- **C · Email:** inbox sorted by the agent; draft with the evidence it used and
  red flags for anything a person must add (price, lead time); approve / edit /
  revise / take over; the buyer receives a normal email from a salesperson;
  follow-up suggestions. Same buyer across chat and email is one memory.
- **D · Knowledge Studio:** weekly list of unanswered questions grouped by topic
  (the September test showed payment terms, sample policy, lead-time bands,
  certifications by market as the biggest gaps); draft article for approval;
  catalog and knowledge health (128 indexed, 9 products without approved
  details).
- **E · Sales console:** the existing Inquiries page gains chat and email leads
  with the needs summary. Live takeover is a later phase.

## What stays human

Prices, discounts, lead times and sample terms; pressing Send; what counts as
public; anything about existing orders.

## Questions for the meeting

**Scope:** which rows above are wrong; the one task to remove from the team's
desk first; channels and weekly volumes (form, email, Alibaba messages,
WhatsApp/WeChat, phone); buyer languages; who reviews drafts.

**Email access and policy:** mail system for sales@ (Tencent Exmail per the
repo's default SMTP host, Outlook, Gmail?); shared mailbox or per person;
which reply classes may go out without approval; follow-up rule; signature and
tone; data residency for mailbox contents.

**Products and pricing:** price classes an anonymous visitor may see (D1);
products off-limits for recommendation; who approves detail pages; MOQ and
customization fields to use.

**Knowledge ownership:** who owns the answers to the top unanswered topics; who
approves articles and how fast; whether past sales emails may be mined.

**Success:** the 90-day measure (first-reply time, quotes requested, repeated
questions, hours saved); the must-never-happen list; CRM to feed.

## Suggested order

1. Chat that knows the products (Stage X foundation, then B/C/D of PLAN.md).
2. Email drafts with approval (new Stage E: mailbox connection, classification,
   draft with evidence, approval UI, follow-ups).
3. Knowledge Studio alongside (extends D4: gaps → articles → approval).
4. Later: live takeover, CRM sync, other channels.

## Evidence used

- Live site and catalog facts: PLAN.md §1 (observed 18 Sep 2026).
- Unanswered-question topics: `docs/ai-platform/evidence/E2E-CONTENT-AND-SECURITY-2026-09-02.md`.
- Email today: `packages/email` sends through nodemailer with
  `smtp.exmail.qq.com` as the default host; only OEM confirmations and password
  resets are sent. No inbound mail handling exists.
- Human-in-the-loop email drafting is a common pattern in open-source tools
  (draft → review → send, with pricing and commitments always reviewed); see
  PLATFORM-VISION.md §7 for references.
