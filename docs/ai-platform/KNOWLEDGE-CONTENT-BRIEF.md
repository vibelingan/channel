# What the assistant needs to know — a brief for the business team

**Who this is for:** whoever owns the sales and marketing content.
**What we need from you:** documents. No system, no format, no tooling.
**How long it takes:** a focused afternoon for the first version.

---

## Where the assistant's knowledge comes from today

Only the five content files that generate the public website. Nothing else — not
the codebase, not internal documents, not email, not the CRM.

That has one good consequence and one bad one. Good: it is *designed and tested*
to answer only from that material, and to refuse rather than guess. Bad: it can
only draw on what the website says, and the website says far less than the sales
team knows.

To be precise about the guarantee, because it matters: refusing to invent things
is a policy we enforce and measure, not a mathematical certainty. The assistant
is instructed to answer only from supplied material, its answers cite their
source, and an automated check runs questions the site cannot answer to confirm
it declines. Treat it as a well-tested control, not an impossibility.

Everything below is about closing that gap.

---

## The test for whether something belongs

> Would we be comfortable if a competitor read this on our website tomorrow?

If yes, it can go in. If no, it stays out. There is no middle tier, because the
assistant talks to anonymous strangers and cannot tell a buyer from a
competitor.

---

## What to prepare — seven documents

One topic per document. Plain language, the way you would explain it to a new
salesperson. Word, PDF, or a plain text file are all fine.

### 1. Company facts
Founding year, ownership, office and factory locations, floor area, headcount,
production lines, languages spoken, business licence details that are already
public.

On capacity, the distinction matters: **rated capacity** — what the factory is
built to produce in a year — is a public credential and is welcome. **Current
capacity** — what is free next month, what is backed up — is commercially
sensitive, changes weekly, and is excluded below.

### 2. What we make
Product categories and sub-categories. For each: what it is, typical materials,
what makes ours different, and what we will *not* take on. That last part
matters — it lets the assistant decline politely instead of over-promising.

### 3. Commercial terms that can be public
Minimum order quantity by category. Sample policy — cost, whether it is
refunded, how long it takes. Lead time *ranges*, not promises. Payment terms if
you publish them. Incoterms you work with. Shipping methods and typical transit
times by region.

**No price lists, no unit costs, no discount tiers.** Pricing stays with people.

### 4. The OEM process, step by step
What happens after a customer sends an inquiry. What we need from them at each
step (drawings, samples, specifications, target cost). Who is involved. Roughly
how long each step takes. Where a project typically stalls and why.

### 5. Quality and compliance
Certification names, the standards we meet by product type, which certifications
we hold ourselves versus arrange through partners, factory audit history, and
the warranty and defect policy.

> Be exact about the standard. "ISO certified" is not usable; "ISO 9001:2015" is.

> **Certificate numbers and expiry dates only if your compliance owner has
> approved them for public disclosure.** They are often fine — many
> manufacturers publish them — but that is their call, not ours. Without
> approval, send the standard and omit the number; the assistant will say we
> hold the certification and invite an inquiry for the certificate itself.

### 6. The questions sales answers over and over
The highest-value document by far. Twenty to fifty real questions with the
answer your best salesperson gives. Pull them from actual inquiry emails and
chat logs. Include the awkward ones — "why are you more expensive", "can you
copy this competitor's product", "can we visit the factory".

### 7. Case studies
Projects we can talk about. For each: what the customer wanted, what we did,
what the outcome was, over what timeframe.

**Name a customer only where you have written permission.** Otherwise: "a
European consumer audio brand". Anonymised cases still sell.

---

## What must never be included

- Price lists, quotations, cost breakdowns, margins, discount authority
- Customer names covered by an NDA, and anything from their briefs
- Supplier and subcontractor names, and what we pay them
- Current capacity, backlog, bottlenecks, or which lines are idle
- Staff names, direct phone numbers, or personal email addresses
- Anything about legal disputes, claims, or recalls
- Internal targets, forecasts, or strategy

If a document mixes public and private material, send the public part only. It
is far cheaper to add a document later than to retract an answer a customer has
already screenshotted.

---

## How to hand it over

1. One file per topic, named for the topic — `moq-and-lead-times.docx`, not
   `final_v3.docx`.
2. Put a short header at the top of every file:

   | Field | Why |
   |---|---|
   | Owner | Who to ask when an answer looks wrong |
   | Approved for public use on | Confirms someone signed off, and when |
   | Next review due | Certifications expire; lead times drift |
   | Authoritative language | Which version wins if translations disagree |

3. If you have Chinese and English versions, send both and say which governs.
4. Send changes as a replacement for the whole file, not as a list of edits.
5. **To withdraw something**, tell us and we remove it at the next reload. Do
   not assume deleting your local copy does anything — the assistant holds a
   copy, and it keeps answering from that copy until we replace it.

---

## What happens after you send it

We load the documents and the assistant answers from them. Every answer that
states a fact links back to the document it came from; a refusal has nothing to
cite and does not pretend otherwise. If an answer is wrong or missing, that is a
content fix in your document, not an engineering change.

Two properties worth knowing:

- **It refuses rather than guesses.** Asked for a price, it says we do not
  publish prices and invites an inquiry. That behaviour is deliberate and tested.
- **It is a copy, not a live link.** Editing the website or a source document
  does not update the assistant until we reload it. Tell us when content changes.

---

## Product data from the Alibaba catalogue sync

**Not part of the assistant's knowledge in this release, and not scheduled to
arrive on its own.** Nothing currently connects the product catalogue to the
assistant: it reads the five website content files and nothing else.

That is deliberate rather than an oversight, and it is worth understanding why
before anyone asks for it.

A product record is not one thing. It carries model numbers and specifications
that are perfectly public, alongside pricing that is not uniformly public — the
storefront already serves several pricing modes, and which of them an anonymous
stranger may see is a commercial decision nobody has made yet. Wiring the
catalogue in wholesale would answer that question by accident, in the direction
of "show everything".

So before any catalogue data reaches the assistant, this has to exist:

1. **A decision from the product owner** naming exactly which price classes, if
   any, an anonymous assistant may state.
2. **A field allowlist** — an explicit list of the fields that may be indexed.
   Anything not on the list is excluded, so a new field added later is private
   by default rather than public by default.
3. **A lifecycle contract.** A product that is withdrawn, made private, or
   discontinued must disappear from the assistant on the next refresh, and a
   deletion must actually delete.
4. **Tests proving the absence** of VIP, negotiated, tiered and internal-only
   fields from the indexed data — proving a field is gone, not that a filter was
   called.
5. **An owning MIU**, so it is scheduled work rather than an assumption.

The reason to be firm about this: the assistant serves anonymous visitors with
no sign-in at all. Any price it can retrieve is a price it can show to anyone —
including the customers who negotiated a different one, and their competitors.
That is not a bug that gets noticed in testing; it is a commercial disclosure
that gets noticed by the customer who reads it.

Until those five things exist, tell customers the assistant does not have
product-level pricing, because it does not.
