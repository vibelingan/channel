# Client answers and resulting decisions — 12 Oct 2026

**Status:** captured from the owner's review of the meeting-prep questions;
decisions below are proposals unless marked agreed.
**Related:** [MEETING-PREP-2026-10-10.md](./MEETING-PREP-2026-10-10.md) ·
[PLAN.md](./PLAN.md) · [PLATFORM-VISION.md](./PLATFORM-VISION.md)

## 1. Answers, as given

| Topic | Answer | What it changes |
|---|---|---|
| Volume | Site still under construction (SEO/GEO); fewer than 10 inquiries a day today | Batch processing is fine; one or two admins can review every draft; cost is not a design driver yet |
| Languages | English | One answer language; keep Chinese input tolerant but reply in English unless asked |
| Mail system | Tencent (WeCom) enterprise mail; a few admins have access | IMAP/SMTP on `sales@` is the realistic path (see §3); an admin must enable it and mint a client authorization code |
| Mailbox model | One shared mailbox for now | One IMAP connection, one Drafts folder, one Sent folder to watch |
| Approval policy | Auto-acknowledge first; then a real reply drafted by the agent and approved by an admin | Two reply classes: `ack` (automatic, templated) and `substantive` (draft → approve → send) |
| Follow-up rule | 1 – 3 – 7 days, in the company's name | Follow-up schedule 1/3/7 days after the last outbound; each nudge is still approved |
| Signature / tone | None today | We draft one with the client in Stage E0 |
| Prices in the assistant | Anything already on the page may be shown; the agent saves the buyer the search | **D1 decided:** cards and answers may show the public price the product page shows to an anonymous visitor; never the member (VIP) tier |
| Off-limits products / discounts | None; anything publicly displayed may be recommended; no discount policy exists | No exclusion list in v1; "discount" questions go to the standard refusal + quote path |
| MOQ and customization fields | "How do I know which fields?" | Answered in §2 below |
| Knowledge owners | Admins know the answers; not in the knowledge base yet; add during the build | Knowledge Studio starts with the September gap list; the admin fills it |
| Article approval | Site admin user; usually 1 day | Approval SLA 1–2 days; approver = admin role in the site |
| Mining past emails | Not hoped for; keep the option | Stage E5 may use edit diffs of *our* drafts; mining the historical mailbox stays optional and needs separate consent |
| Success | Faster first reply, more quotes, fewer repeated questions, hours saved; plus "no downtime, quick, consistent" in real use | Add service targets: availability, p50/p95 latency, consistency on the eval set |
| Must never happen | No invented price; no email without approval; no private data in a public answer | Unchanged; already in the policy gates |
| CRM | None | Leads stay in the Inquiries page |
| Data residency | "Why not pass through? Everything under TCB should pass" | Explained in §4: the concern is the model provider, not TCB |
| Delivery order | Approved | Chat first, email second, Knowledge Studio alongside, takeover later |
| Notifying approvers | WeCom notification @ a few admins when a draft is ready | Stage E3 uses a WeCom group robot webhook with mentions (§3) |

"Which rows are wrong / which task first" was a prioritisation question for
the client: it asks which sales task hurts most today so that we build that
one first. With the volume answer above, the honest order is the one already
approved.

## 2. Product fields the agent can read (from the public API code)

What any visitor's browser already receives for a published product
(`apps/functions/public-api/src/handler.ts`, `PUBLIC_CATALOG_FIELDS`):

- identity and text: `name`, `category`, `series`, `modName`, `modType`,
  `description`, `productCode`
- commercial, ungated: `moq`, `inventory`, `unitPrice`, `wholesalePrice`,
  `clearancePrice`, `manualCatalogPricing`, `catalogPricingMode`
- Alibaba-linked pricing, ungated and identical for anonymous and signed-in
  callers: `alibabaCatalogPricing` with `mode` (fixed / range / tiered /
  negotiable / unavailable), the amounts, `sourceMoq` and tiers;
  `alibabaSourceStatus`, `alibabaSourceLastSyncedAt`
- approved product details (`/api/products/:id/detail`): `specifications`,
  `packaging`, `notes`, `facts`, and per variant: options, images, inventory
  state, offers

What is gated or stripped and therefore never reaches the agent:

- `vipPrice` (the only role-gated field, members only)
- supplier offer identifiers (`sourceOfferKey`, `sourceProductId`,
  `sourceSkuId`), the source key itself (replaced by the word `linked`),
  `imageIds`, timestamps

So "MOQ" comes from `moq` or `alibabaCatalogPricing.sourceMoq`; price from
`alibabaCatalogPricing` (or the manual pricing when the product uses it).
**Customization is not a per-product field.** The quote form offers generic
types (logo, packaging, material, colour, certification, other). The agent
should say customization is requested through the quote, unless a product's
approved details mention it.

## 3. Email: how approval can work without building an email client

Facts checked on 2026-10-12 (reported from Tencent/WeCom documentation and
third-party guides; verify in the client's admin console):

- Tencent enterprise mail supports IMAP (`imap.exmail.qq.com`, port 993,
  SSL) and SMTP (`smtp.exmail.qq.com`, port 465, SSL). An admin enables the
  IMAP/SMTP service scope in the WeCom admin console (协作 → 设置 → 第三方客户端),
  and the mailbox owner generates a client authorization code.
- The WeCom **mail API** can send mail and list/read mail, but the inbox it
  reads is the **application's own mailbox** (replies to mail the app sent),
  and mail it sends comes **from the app's mailbox address**, not from
  `sales@`. New-mail callbacks exist. So for a shared `sales@` the API alone
  does not fit; IMAP/SMTP does.
- WeCom **group robot webhooks** post text/markdown/cards into an internal
  group and can mention members (`mentioned_list`, `<@userid>`); the
  webhook URL is a secret. The Vibelingan hub in `hermesinfra` already pushes
  to a group this way (`_push_customer_to_wecom`).

Proposed mechanics (Option A, recommended for v1):

1. The worker reads `sales@` over IMAP, classifies each new mail, and sends
   the automatic acknowledgement over SMTP as `sales@` for the classes the
   client allows.
2. For a substantive reply it writes the draft into the mailbox's **Drafts**
   folder (IMAP APPEND) and posts a WeCom message to the admins' group:
   subject, buyer, the flags (price asked, delivery promise), and a link to
   the review page.
3. An admin opens the draft in their normal WeCom mail client, edits, adds the
   price, and **sends it themselves**. That send is the approval.
4. The worker watches the Sent folder, logs the sent reply as a lead in the
   Inquiries page, schedules the 1/3/7-day follow-ups, and records the diff
   between draft and sent (Stage E5).
5. The **review page** in the site admin is not an email client. It shows the
   queue, the evidence each draft used, the flags, the buyer's web-chat
   history, and the audit trail. Nothing is sent from it in v1.

Option B (later, if admins prefer one place): approve on the review page and
let the system send over SMTP as `sales@`. Same backend; one more button and
one more audit path.

What this avoids: a second inbox to keep open, drafts that only exist in our
database, and any send path that bypasses the mailbox the client already
trusts.

## 4. Data residency, in plain terms

Nothing in this design moves mailbox contents outside Tencent Cloud **except
the model call**. The services run in the client's Shanghai VPC on CloudBase
Run, and the database is TencentDB. To draft a reply, the text of the buyer's
email is sent to the model provider. Today that provider is zenmux, whose
policy (reported) stores account data in Singapore with some processing in
Malaysia, keeps usage records (model, time, token counts) for 180 days, says
it does not keep full prompts and outputs as part of those records, and offers
a DPA; a third-party guide mentions a zero-retention mode we have not
confirmed.

That is the question for the client: are buyer emails allowed to be processed
by a model provider outside mainland China under a DPA? If not, the
alternative is a model served from Tencent Cloud's China site (Hunyuan or a
hosted DeepSeek), which keeps the call inside Tencent; we found no written
in-country guarantee for its API either, so it needs the same contractual
check. This is a decision, not a blocker, and the model is one configuration
value in the worker.

## 5. Product knowledge: async sync, no new servers

Agreed direction: publishing a product does not call the assistant. The
existing `ai-worker` container runs a scheduled reconcile (every 15 minutes
in the plan) against the anonymous public API and updates the catalog index.
No new instance is needed; the worker already runs at one instance for the
outbox. A "publish hook" that triggers an early reconcile is an optional
later addition.

Today the assistant answers zero product questions because no product data
is indexed; this is Stage B.

## 6. Card and context behaviour (UI side)

- **Product cards** are a block type, not prose. Desktop: a horizontal row
  with arrows. Phones: a stacked deck with arrows and swipe, same direction as
  the arrow. Key facts on the card: image, name, family, the public reference
  price (D1), MOQ, colour/variant count, "View product", "Add to list".
- **The agent chooses the block**: cards for discovery, a comparison table
  for two or three named products, a single detail card on a product page.
  The surface supports all three; the choice is the agent's, validated by
  code.
- **"This" resolution**: a product named in the message wins; otherwise the
  product on the current page; otherwise the last product discussed. Every
  message carries the page context, so when the buyer opens another product
  the widget shows "Now viewing: X" and the agent's "this" moves with it. When
  the referent changes, the agent says so in one short phrase ("For the BT
  Headset: …"). Session facts keep a `products_discussed` list so "the first
  one" and "the cheaper one" resolve.

## 7. Where the Knowledge Studio and the review page live

`hermesinfra` (local checkout read on 2026-10-12) is Vibelingan's own agent
platform: a Python hub and dispatcher on systemd, Hermes agent containers
talking A2A, a React Router customer portal with SSE chat, WeCom login and
group-webhook push, MySQL, and a KB gateway in front of **vibekb**, which is
the AnythingLLM instance the Channel assistant already uses. Its frontend
modernization is in progress and lists assistant-ui as a proposal. Several
September RCAs (stream IDOR, zero-auth bridge, port exposure) show its
security posture is still maturing; its docs say the live state is
unverified.

Recommendation:

- The sales-agent brain stays in the Channel repo on CloudRun for Phase 2. It
  is deployed, reviewed, and fenced. `hermesinfra` keeps hosting the knowledge
  base, as today.
- The **Knowledge Studio approval workflow** (gaps → draft article → approve →
  publish to the KB) and the **email review page** live in the Channel site
  admin, where the client's admins already log in. Raw document management
  can use the AnythingLLM UI with a client account if they want it; that is
  the "UI Hermes already has" for documents.
- The Vibelingan portal is a different product with a different login; giving
  client admins accounts there mixes products and is not recommended now.
- Once the protocol in PLATFORM-VISION.md exists, `hermesinfra` can become a
  second backend behind the same surface. That is the path to one platform,
  without moving the Channel brain now.

## 8. Decisions updated in PLAN.md

| # | Was | Now |
|---|---|---|
| D1 | No prices in cards | **Decided:** show the public page price (anonymous view) in cards and answers; never `vipPrice` |
| D4 | Existing inquiry form | **Decided:** Inquiries page + WeCom notification for drafts; email per §3 |
| D5 | English, Chinese on request | **Decided:** English |
| D6 | All public catalog pages | Confirmed; named owners still needed for gate 10 |
| D7 | Spend caps from B0 | Unchanged; low volume makes this easy |
| new | — | Model-provider data residency: client decision (§4) |
