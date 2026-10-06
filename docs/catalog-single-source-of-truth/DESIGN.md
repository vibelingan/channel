# Catalog single source of truth — design

Status: **Planned (docs only).** Agreed with the product owner in conversation on
2026-10-06/07. No code in this change. Execution follows
[MIU_BREAKDOWN.md](MIU_BREAKDOWN.md); progress is logged in
[EXECUTION_LOG.md](EXECUTION_LOG.md).

## 1. Background

The public catalog shows each product in three places:

| Place | Endpoint / code | What a buyer sees |
|---|---|---|
| Product list (category pages, cards) | `GET /api/products` — `apps/functions/public-api/src/handler.ts` | Name, photo, "From $X", MOQ |
| Product page | `GET /api/products/:id/detail` — `apps/functions/public-api/src/catalog-detail.ts` | Photos, configurations (colour etc.), Alibaba-style tier prices, quote button |
| Quote request record | `packages/db/src/catalog-quote.ts` | What the admin receives when a buyer asks for a quote |

Product data comes from Alibaba (ICBU) through the catalog sync, or is typed in by
an admin (manual products). Alibaba data is meant to be reviewed by an admin before
it goes public.

On 2026-10-02 the product-page price block was redesigned to the Alibaba style
(one row of tier prices with the quantity under each; PR #64 to `test`, commits
`5913f20` and `7984dea` on `feat/catalog-alibaba-price-tiers`). Checking it on the
live site exposed that some product pages show a different price from their card.
This document records the investigation and the agreed redesign.

### Terms

- **SKU / configuration** — one sellable combination of attributes (colour + plug +
  mic …). A product has one or more SKUs. Each SKU can have its own price ladder.
  On the product page a SKU is a "configuration" the buyer selects.
- **Price ladder / tiers** — quantity breaks, e.g. 10–499 pcs $1.30, 500–999 $1.22,
  ≥1,000 $1.20.
- **Approved version** — what an admin approved: `products.catalogDetailPublication`
  (header) plus immutable `catalogDetailVariants` rows keyed by product + revision +
  SKU. Each approval writes a new revision; the product points at the newest.
- **Headline price** — the single product-level price Alibaba sends for a wholesale
  product (`wholesaleTrade.price`).

## 2. Investigation (live data, 2026-10-06/07)

All numbers come from the public API on supplychainsai.com (CloudBase `test`
environment) unless marked as code.

### 2.1 List and product page disagree on price for 21 products

137 products are in the public list. 130 have an approved product page; 7 do not
(§2.5). Comparing list vs product page for the 130:

| Field | Mismatches |
|---|---|
| Name | 0 |
| Main photo | 0 |
| **Price** | **21** |

Example — *Lightweight Foldable 3.5mm Wired Music Earphones*: the card has three
tiers (10–499 $1.30, 500–999 $1.22, ≥1,000 $1.20). The product page shows one price,
"USD 1.20, ≥10 pieces", which is false: 10 pieces cost $1.30.

### 2.2 Why: two copies of the price, written by two paths

| Path | Added | Writes | Read by |
|---|---|---|---|
| Sync promotion (`apps/functions/alibaba-catalog-sync/src/promotion.ts`, `selectPrimaryOffer` in `packages/alibaba-catalog-sync/src/alibaba-merge-policy.ts`) | 2026-08-06 (`c618711`) | `products.alibabaCatalogPricing` — the cheapest SKU's ladder — **directly, no approval** | Product list |
| Approval (`packages/db/src/catalog-detail-commit.ts`, `packages/shared/src/catalog/detail-approval.ts`) | on `main` 2026-09-15 (`dbf802b`) | Approved version, including its own copy of every SKU's price | Product page, quote request |

When the approved version was introduced, the older direct path was left running.
Nothing made one of them the owner of "the price".

On 2026-09-21 the price repair (`fcf1431`, `docs/catalog-price-repair/`) re-ran
the Alibaba parser over stored raw payloads and restored 1,661 SKU prices from
"unavailable" to real ladders. By design it did not touch approved versions. The
list picked up the repaired prices; the 21 product pages kept their pre-repair
copies, in which every SKU price is "unavailable".

### 2.3 The headline price is stored as a "fixed" price

With every SKU price "unavailable", the product page fell back to the product-level
offer. For wholesale products the normalizer
(`packages/alibaba-catalog-sync/src/alibaba-normalizer.ts`, wholesale branch of
`normalizeProductDetail`) stores Alibaba's headline price as `mode: 'fixed'`.

It is not a fixed price. In **21 of 21** live products where it can be compared
with a ladder, the headline equals the **cheapest** tier, not the price at the
minimum order. The 2026-10-02 price block then paired it with the MOQ
("≥10 pieces"), turning a "from" price into a specific, wrong claim.

Products whose data has only one tier (25 live products, e.g. "USD 4.30, ≥1,000
pieces") are displayed correctly; their source data genuinely has one tier.

### 2.4 Per-SKU prices are modelled correctly

Checked end to end in code:

| Step | Per-SKU price kept? |
|---|---|
| Normalizer stores one offer per Alibaba SKU (`alibaba-normalizer.ts`) | Yes |
| Approved version stores each SKU's offers (`packages/catalog-import/src/detail-candidate.ts`) | Yes |
| Product page shows the **selected** configuration's price (`apps/site/src/catalog/presentation/CatalogQuotePanel.tsx` passes `variant?.offers` to `CatalogCompactPrice`) | Yes |
| Card shows "From $X" from the cheapest SKU (`selectPrimaryOffer`) | Yes (summary) |
| Quote request records the selected SKU (`catalog-quote.ts`) | Yes |

Today all 130 approved products have the same price for every configuration, but
nothing in the model assumes that.

Known, accepted gap (no action until the client asks): products sold by lot / kg /
set, or priced in currencies other than USD/CNY, are stored as "unavailable" and
show "Request a quote".

### 2.5 Visibility and review are split across separate steps

- **Publish** (`products.published`) controls the list.
- **Product-page approval** writes the approved version.
- **Mark reviewed** clears the "New" badge.

They are independent, so a product can be listed without an approved page. The 7
listed products without one are all **manual** products (no Alibaba link); their
product page falls back to a legacy layout built from the product row.

### 2.6 Admins are not told when an existing product changes

The admin's "New" badge is the boolean `products.alibabaReviewPending`. It is set
only when the sync creates a brand-new draft (`linking.ts`, `alibaba-product-identity.ts`)
and cleared by "Mark reviewed". The admin product list already sorts flagged
products first by default (database-side, index-backed, so pagination is correct)
and shows a per-category "• New" count. When the sync changes an existing product
(price, photos, text, removal), nothing is flagged.

## 3. Problem statements

1. **P1 — Two sources of truth.** The list reads a price written by the sync
   without approval; the product page and quote read the approved version. They
   drift whenever the sync or a repair changes data.
2. **P2 — Wrong price shown on 21 product pages** (and recorded in any quote
   requested for them), because their approved versions predate the price repair.
3. **P3 — Headline mapped as fixed.** Alibaba's wholesale headline (cheapest tier)
   is stored and displayed as a fixed price.
4. **P4 — Silent changes.** Sync changes to existing products reach the list
   immediately and never reach the admin's review queue.
5. **P5 — Fragmented gate.** Publish, product-page approval and Mark reviewed are
   separate; "approved" and "visible" can disagree.

## 4. Principles agreed with the owner

1. **One source of truth per product.** The product list, the product page and the
   quote request show the same data. Different endpoints may return different parts
   of it (a list returns many products in summary, the page returns one in full),
   but they read the same stored version.
2. **Approval is the only gate for Alibaba data.** Synced data (new or changed)
   waits for admin approval; once approved it is public everywhere at once.
3. **Data accuracy first.** No price is shown that the source data does not support.
4. **Respect the source structure.** Each SKU keeps its own price; summaries are
   derived from SKUs, never invented.
5. **No speculative features.** Lot/kg/set units and other currencies stay
   "Request a quote" until the client asks.

## 5. Decisions

Status: **Decided** = follows directly from §4 and the evidence; **Owner** = needs
the owner's confirmation before the dependent MIUs run (see README).

| ID | Decision | Status |
|---|---|---|
| DEC-1 | **One shared rule decides which version of a product is public**: the newest approved version for an Alibaba-linked product that has one (and when the product-page feature is on); otherwise the product row. List, item/slug, product page and quote all call this rule. | Decided |
| DEC-2 | The list card's price comes from a **price summary stored with the approved version at approval time** (`catalogDetailPublication.priceSummary`, top level — not inside the strict `header`). Rule: website price if set; else the cheapest priced SKU (USD before CNY, same order as today's card); else the product-level price; else "Request a quote". Existing approved versions get the summary by a one-time backfill that does not change their revision. | Decided |
| DEC-3 | For products served from the approved version, the card also shows the approved **name, photos, description and MOQ**, not row fields. | Decided |
| DEC-4 | **Manual products** (no Alibaba link — includes the 7 listed without an approved page) keep the product row as their single version: the admin writes it, so the admin's Publish is its approval. Card and page already read the same row. | Owner |
| DEC-5 | **Headline price**: for a wholesale product that has SKUs, Alibaba's headline price is not stored as a price. Prices come only from SKUs. If no SKU has a usable price, the product shows "Request a quote". Sourcing (FOB) products are unchanged (no evidence of a defect). | Decided |
| DEC-6 | **"Changed" means** a change to what a buyer would see from Alibaba: any SKU's price / tiers / MOQ, SKUs added or removed, SKU options, photos, specification facts, description text. Not stock counts, timestamps or the Alibaba title (the product name is admin-owned). | Decided |
| DEC-7 | **One review flag with a reason.** Reuse `alibabaReviewPending` (index, sort, counts and badge already exist) and add `alibabaReviewReason: 'new' \| 'changed' \| 'removed'`. Approval clears both. A later sync sets them again only if DEC-6 content differs from the approved version. | Decided |
| DEC-8 | Flag scope: "changed" applies to products that have an approved version (published or not). Manual and archived products are never flagged; never-approved drafts keep "new". | Decided |
| DEC-9 | While a product is flagged "changed", list, page and quote keep showing the **approved** version (follows from DEC-1). | Decided |
| DEC-10 | **Admin list**: keep the existing flagged-first default sort (server-side, index-backed, pagination-safe) and per-category counts; show the reason on the badge. No new tab. | Decided |
| DEC-11 | **Approve**: Publish already runs prepare → stage → finish → publish → clear flag. Add **"Approve changes"** for a flagged product that is already published (same sequence). "Mark reviewed" stays for "new" only; a "changed" flag clears only by approving (or by unpublish / archive). | Owner |
| DEC-12 | Batch category assignment re-approves the latest source silently today. It must **skip products flagged "changed"** and report them as "review first". | Decided |
| DEC-13 | **The 21 products**: unpublish now (owner's proposal), fix the data path, let the audit flag them "changed", admin re-approves. No direct write into approved versions. | Owner |

### 5.1 Why these choices

- **DEC-1 instead of "list reads approved data" alone.** The research found three
  ways list and page could still disagree after a list-only switch: the
  product-page feature flag (`CATALOG_DETAIL_APPROVAL_ENABLED`), products unlinked
  after approval (their approved version can no longer be refreshed), and linked
  products published before approval existed. One rule used by every endpoint
  removes all three.
- **DEC-2 summary at approval, not at request time.** The list is paged up to 48
  products; computing a summary per request would need every product's SKU rows
  (the database helper caps a call at 100 rows). The approval step already holds
  all SKUs in memory before writing (`planCatalogDetailApproval`), so the summary
  costs no extra database operations and stays inside the CloudBase 100-operation
  transaction limit. The strict `header` schema is decoded by both server and site;
  a new header key would make every product page fail, so the summary sits beside
  it.
- **DEC-5 drop rather than relabel.** Relabelling as "from" needs a new price shape
  across shared schema, server and site. Dropping it loses a price only for products
  whose SKUs are all unpriced, where showing "Request a quote" is the accurate
  answer.
- **DEC-7 one flag.** One flag means one sort, one count, one clearing rule; the
  reason tells the admin what kind of review it is. Two flags could disagree.

## 6. Target design

```
Alibaba ──sync (manual "Run now" or timer)──► source data
                                              (raw payloads, per-SKU offers,
                                               observations)
                                                   │
                         compare with approved ────┤ differs (DEC-6)?
                         version's source digest   │   yes → flag: changed
                                                   │   new product → flag: new
                                                   ▼
                                   Admin review queue (flagged first, counts)
                                                   │ Approve / Approve changes
                                                   ▼
                         Approved version  = header + SKU rows + price summary
                         (one per product; new revision on each approval;
                          flag cleared)
                                                   │
                    ┌──── shared rule: which version is public (DEC-1) ────┐
                    ▼                       ▼                              ▼
              List / item / slug      Product page                   Quote request
              (summary: name, photo,  (all SKUs, each with its       (selected SKU)
               price summary, MOQ)     own price)
```

What changes, in plain terms:

1. **Sync** keeps writing source data as today but no longer changes anything a
   buyer sees for a product that has an approved version (on 2026-10-06 that was
   every Alibaba-linked product in the public list; runbook R5 re-counts it). It
   raises the review flag when the source differs from the approved version. To compare cheaply, approval stores a **source digest** — a hash of the
   DEC-6 content of the data it approved. Existing digests cannot be used: they
   include timestamps and change on every sync.
2. **Approval** stores the price summary and the source digest with the version it
   publishes, and clears the flag.
3. **Public reads** all go through the shared rule. The list projects the approved
   name, photos, description, price summary and MOQ.
4. **Headline price** stops being stored as a price for wholesale products with
   SKUs; stored offers are rebuilt from saved Alibaba payloads (no new Alibaba call).

The site's card price display is unchanged in style; it reads the summary. The
product page already shows the selected configuration's own price.

## 7. Restoring the 21 products (rollout)

1. Unpublish the 21 (DEC-13, owner approval required — production write).
2. Deploy the headline fix and rebuild stored offers from saved payloads
   (dry run → apply).
3. Deploy the public-version rule, the price summary and the "changed" flag;
   backfill price summaries for existing approved versions.
4. Run the one-time "changed since approval" audit (dry run → apply). Products whose
   current source differs from their approved version are flagged "changed"; the
   rest get their source digest recorded. The 21 are expected in the flagged set.
5. Admin opens each flagged product, checks the preview, and approves. Re-approval
   rebuilds the version from the repaired data (verified in code: preparing a
   review reads the current observation, which the Sept 21 replay already rebuilt).
6. Verify on the live site: list vs product page for every product (name, main
   photo, price) — target 0 mismatches — plus browser checks at phone and desktop
   width.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Changing the approval plan changes every pending review digest; admins with a review screen open get one CONFLICT | Deploy when no review is in progress; the screen reloads |
| Normalizer change alters the source content hash for many products and can trip the sync's surge guard (≥20 changed and >30% of linked) | Replay stores the new hash with the rebuilt offers, so later syncs compare like with like |
| Replay currently refuses a dropped product-level offer (`offer-set-mismatch`) | MIU-2 teaches replay to deactivate it |
| Products whose SKUs are all unpriced lose the headline "From $X" | Accepted (DEC-5); listed in the dry-run manifest so the owner sees which |
| A missing price summary (old version, not yet backfilled) | Rollout order: summaries are computed and backfilled (and counted: 0 missing) **before** the list switches. If one is still absent, the card uses the version's own website / product-level price, else "Request a quote" — never the sync price — and the consistency audit (MIU-26) reports it |
| Sync still bumps `updatedAt` / link revision on every run, which can cause review CONFLICTs | Existing behaviour; deferred (§9) |
| "Removed" never fires while the timer and full runs are off | Deferred (§9) |

## 9. Deferred (out of scope, recorded)

- **"Removed" detection.** The sync marks a source as gone only on full runs, which
  only the timer starts, and the timer is off (`DESIRED_TIMER_TRIGGERS = {}`). The
  reason value exists; turning detection on is a separate decision.
- **Operator offer pin** (`alibabaPinnedOfferKey`) is not reflected in the price
  summary. Rollout step R3 counts pinned products; if any exist, stop and ask.
- **Product JSON-LD** for approved product pages (today only the legacy page emits it).
- **Admin "public price" column** next to the live sync price.
- **Promotion churn** (writes on every sync even when nothing changed).
- **Lot / kg / set units and other currencies** (§2.4).
- **"Needs review only" filter** in the admin list, if the queue grows long.

## 10. Prior decision this reverses

`docs/catalog-price-repair/INVESTIGATION-2026-09-17.md` recorded that lists read the
canonical product while the product page reads an approved snapshot "so a
subsequent supplier import cannot silently replace reviewed public content", and
that approval does not backfill the list price. This design keeps the protection
and extends it to the list: nothing from the sync reaches any public surface
without approval. What is reversed is only that the list reads row fields for
Alibaba-linked products.
