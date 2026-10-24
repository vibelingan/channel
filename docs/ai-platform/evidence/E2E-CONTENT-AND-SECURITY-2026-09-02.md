# Phase 1 E2E — buyer-content coverage and engineering findings

**Date:** 2026-09-02 · **Stack:** local BFF/worker/PostgreSQL against hosted KB
`kb.supplychainsai.com`, workspace `supplychainsai-public-prod`, corpus
generation `1788241419198` (5 public documents).
**Method:** 35 questions asked through the real BFF path a visitor uses —
create conversation, POST message, read SSE — recorded event-by-event.

Raw data: `content.jsonl` (per case: question, event types, answer, citations,
latency, conversation id for database trace-back).

## Headline

**33 of 35 questions were answered. 28 of those 33 could not state a fact and
routed the buyer to an inquiry form instead.**

The assistant is behaving correctly — it refuses to invent what the corpus does
not contain, and it grounds everything it does say. The problem is not the
assistant. It is that the corpus is five marketing pages, and a purchasing
manager's questions are almost all about terms the marketing pages never state.

A buyer who asks five questions and is told "send us an inquiry" five times does
not perceive a careful assistant. They perceive a brochure with a chat box.

## Coverage by decision stage

| Stage | Asked | Answered | Could state a fact |
| --- | --- | --- | --- |
| Supplier qualification | 6 | 6 | partly — founding year, locations, facility size |
| Commercial terms | 8 | 7 | **1 of 7** — only the $500 minimum order |
| Product | 5 | 5 | partly — families and categories, no specifications |
| Customisation / OEM | 4 | 4 | yes — this is the corpus's strongest area |
| Compliance & QC | 4 | 4 | partly — QC process yes, certifications inconsistent |
| Logistics | 2 | 2 | no — capability stated, no terms |
| After-sales | 2 | 2 | no |
| Buying journey | 2 | 2 | yes |

Latency p50 **15.2s**, p95 **22.5s**, measured from message POST to `final`.

## What the client must add to the knowledge base

Ordered by how often a real buyer is blocked by its absence.

### Priority 1 — commercial terms (7 of 8 questions unanswerable)
- Payment terms (T/T, L/C, deposit %, net terms)
- Incoterms offered and shipping port
- Production lead time bands: first order vs repeat, by product family
- Sample policy: cost, whether it is credited against the order, turnaround
- Tooling/mould cost model and who owns the tooling afterwards
- Volume-break structure, even as bands rather than prices

Pricing itself should stay off the corpus deliberately — the gate is designed to
refuse it. But "how we price" and "what terms we work on" are not prices.

### Priority 2 — product specifications
The site has no product data at all today. Every technical question failed.
This is the gap the Alibaba/product sync is expected to close; when it lands,
the KB should consume the synced catalogue so the assistant can answer on
models, specifications, materials, packaging and MOQ per SKU.

### Priority 3 — compliance evidence
- A definitive certifications list with scope and validity dates
- Which market certifications are supported vs out of scope (FDA, UL asked)
- Social/environmental audit status (BSCI, Sedex, ISO 14001 asked)

### Priority 4 — risk and assurance
- Warranty and defective-on-arrival policy
- NDA/IP position — asked directly, unanswerable, and it gates sharing designs
- Factory visit and third-party audit policy
- Company registration details for buyer due diligence

### Priority 5 — reachability
- A direct sales email and phone number. The assistant gave
  `info@supplychainsai.com` for one question and said it had no email for
  another, because the address appears in only one document.

## Defects found

### D1 — Statistics are corrupted during ingest (HIGH)
The assistant told a prospective buyer the company has **"5,000+ engineers"**.
The site says **40+ Engineers** and **5000+ m² Facility**. A 125x overstatement
of engineering headcount, stated confidently and with citations.

Root cause is `contentToText` in `scripts/ai-ingest-content.mjs`. A stats list
flattens to one line per leaf, with the value and its label on separate lines
sharing an identical path prefix:

```
factory → Factory & Team Strength → stats → value: 20+
factory → Factory & Team Strength → stats → value: 40+
factory → Factory & Team Strength → stats → label: Engineers
factory → Factory & Team Strength → stats → value: 5000+
factory → Factory & Team Strength → stats → label: m² Facility
factory → Factory & Team Strength → stats → label: Countries
```

Nothing binds a value to its label except adjacency. Worse, the function
deduplicates identical lines — and because every item shares the same path
prefix, a repeated value is deleted outright. `40+` is used for both Engineers
and Countries, so one copy vanished and every pair after it shifted. In the
corpus, `20+` has no label and `Countries` has no value.

Every value/label statistic in the corpus is affected: 20+ years, 40+ engineers,
5000+ m², 40+ countries, 50+ case studies, 30+ trusted clients,
100+ certifications. These are exactly the numbers a buyer uses to judge a
supplier.

Fix: emit each list item as a single line that carries its own pairing
(`Engineers: 40+`), and scope de-duplication to whole items rather than lines.

### D2 — Ask-side commitment interception is dead code (MEDIUM)
`classifyCommitmentRequest` is exported, unit-tested and used by the eval
harness, but **no runtime code calls it**. Neither the BFF nor the worker
imports it. The only live enforcement is the answer-side gate plus the model's
prompt.

The answer-side gate is working — it caught the ISO 9001 overclaim in C24 — so
this is defence-in-depth that is believed present and is absent. A reader of the
design documents would conclude a request is intercepted before it reaches the
model. It is not.

### D3 — The worker emits no logs at all (MEDIUM)
`docker logs channel-ai-worker` is empty across the entire run, including for
two runs that terminated `failed` with category `transient`. The failures are
visible only by querying `conversation_events` directly. An operator watching
logs would see a silent worker while visitors received errors.

### D4 — Over-refusal when one unsupported item appears in a list (LOW-MEDIUM)
"What certifications do you hold — CE, FCC, RoHS, ISO 9001?" returned the
generic certification refusal, because ISO 9001 is unsupported. CE, FCC and RoHS
**are** published and were stated freely in a different answer. The buyer asking
the most natural version of the question gets the least useful answer.

Worth considering: answer the supported part and name the unsupported part,
rather than refusing the whole turn.

### D5 — Two deterministic-looking failures, unconfirmed (OPEN)
`C12` (sample policy) and `C35` (Chinese-language query) both failed with
`transient` and reproduced on retry. However the retries ran as this machine's
network was degrading, and connectivity was lost entirely shortly after, so the
reproduction is not trustworthy. **Re-run both before drawing any conclusion.**

## Verified working

- Multi-turn context: three-turn conversation resolved "those" to headphones and
  stayed on topic. Confirmed against the database — 3 messages, 3 runs, 3 finals
  — after an initial harness artifact made it look like the model was repeating
  itself. The harness now resumes from the last sequence.
- Citation integrity: every citation across 33 answers carried the approved
  `channelkb-g1788241419198-` prefix and resolved to a live first-party URL.
- Commercial refusals: price, discount, lead-time and tooling questions were all
  refused and routed to sales, with no invented figures.

## Not yet run

The 29-case security battery (prompt injection, system-prompt extraction,
internal-corpus probing, PII, commitment extraction under pressure,
output-channel injection, scope abuse) is written and staged but **was not run**:
this machine lost DNS and all outbound connectivity partway through, and the
hosted KB is unreachable. No security conclusion should be drawn from this
document.

Browser/UI verification of the widget is likewise outstanding.
