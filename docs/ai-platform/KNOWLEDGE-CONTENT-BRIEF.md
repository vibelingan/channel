# What the assistant needs to know — a brief for the business team

**Who this is for:** whoever owns the sales and marketing content.
**What we need from you:** documents. No system, no format, no tooling.
**How long it takes:** a focused afternoon for the first version.

---

## Where the assistant's knowledge comes from today

Only the five content files that generate the public website. Nothing else — not
the codebase, not internal documents, not email, not the CRM.

That has one good consequence and one bad one. Good: the assistant can never
say something the website doesn't already say. Bad: it can *only* say what the
website says, and the website says far less than the sales team knows.

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
production lines, annual capacity, languages spoken, business licence details
that are already public.

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
Certifications with their exact names, numbers, and validity dates. Test
standards we meet by product type. Which certifications we hold ourselves versus
arrange through partners. Factory audit history. Warranty and defect policy.

> Be exact here. "ISO certified" is not usable. "ISO 9001:2015, certificate
> number X, valid to March 2027" is.

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
2. Put a date and an owner's name at the top of each file.
3. State the language. If you have Chinese and English versions, send both and
   say which is authoritative.
4. Send changes as a replacement for the whole file, not as a list of edits.

---

## What happens after you send it

We load the documents, the assistant answers from them, and every answer links
back to the source. If something is wrong or missing, that is a content fix in
your document, not an engineering change.

Two properties worth knowing:

- **It refuses rather than guesses.** Asked for a price, it says we do not
  publish prices and invites an inquiry. That behaviour is deliberate and tested.
- **It is a copy, not a live link.** Editing the website or a source document
  does not update the assistant until we reload it. Tell us when content changes.

---

## Product data from the Alibaba catalogue sync

Once the catalogue sync work lands, product records become available to the
assistant automatically — model numbers, specifications, categories, images,
public pricing.

One hard boundary, recorded here so it is not decided by accident later:

> **VIP and customer-specific pricing must never enter the assistant's
> knowledge base.**

The storefront already gates that pricing behind a signed-in session, and it
fails closed when the signing secret is absent. The assistant serves anonymous
visitors with no session at all, so any VIP price it could retrieve would be a
price it could show to anyone — including the customers who negotiated a
different one, and their competitors.

Concretely, when the sync is wired in:

- Only fields marked public on a product may be indexed.
- Tiered, negotiated, and VIP prices are excluded at the point of ingestion, not
  filtered out later in the answer.
- Draft, discontinued, and internal-only products are excluded.
- A product that becomes private must disappear from the assistant on the next
  refresh, which is why refreshes replace the whole set rather than adding to it.
