# Catalog single source of truth

**Goal:** every public surface — product list, product page, quote request — shows
the same approved data for a product, and admins see and approve every Alibaba
change before it goes public.

**Status (2026-10-07):** planned, docs only. Branch
`feat/catalog-alibaba-price-tiers` (not yet merged to `main`; continue here).

## Read in this order

1. [DESIGN.md](DESIGN.md) — background, live investigation, problems, decisions,
   target design, rollout for the 21 affected products, risks, deferred items.
2. [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md) — 26 technical MIUs in four deploy batches,
   plus the rollout runbook.
3. [EXECUTION_LOG.md](EXECUTION_LOG.md) — status per MIU and runbook step; the list
   of the 21 products.

## In one paragraph

The product list reads a price the Alibaba sync writes without approval; the
product page and quote read the admin-approved version. After the Sept 21 price
repair they disagreed on 21 products, and the page showed Alibaba's headline price
(the cheapest tier) as if it applied at the minimum order. The fix makes one
shared rule decide which version is public and has every endpoint use it; stores
a list price summary with each approved version; stops treating the headline as a
price; flags products whose Alibaba data changed since approval; and restores the
21 through normal re-approval.

## Open decisions (owner)

| ID | Question | Recommendation |
|---|---|---|
| DEC-4 | The 7 manual products (typed in by admin, no Alibaba link) cannot go through Alibaba approval. Is the product row their single version, with the admin's Publish as their approval? | Yes — card and page already read the same row |
| DEC-11 | For a "changed" product, does the flag clear only by approving (or unpublishing), with "Mark reviewed" kept for "new" only? | Yes |
| DEC-13 | Unpublish the 21 now and bring them back through re-approval after the fix? | Yes (owner's proposal) — needs a go-ahead because it changes the live site |

Everything else in DESIGN §5 follows from the agreed principles (DESIGN §4).

## Owner questions answered (2026-10-07)

- **Does switching colour switch the price?** Yes. The product page passes the
  selected configuration's own offers to the price block
  (`CatalogQuotePanel.tsx`: `variantOffers={variant?.offers}`). MIU-14 adds an e2e
  test with two differently priced configurations to pin it.
- **Is a SKU one colour?** No — one SKU is one full attribute combination (colour +
  plug + mic …), with Alibaba's SKU ID and our own variant ID. Its option set is
  unique within the product.
- **Stored by SKU or by product?** Both, as one unit: an approved version is one
  product header plus one row per SKU, all under the same revision. The list's
  "From $X" is computed from those same SKU rows at approval, so list and page
  cannot conflict.
- **What is "one reader"?** One shared server function (`resolvePublicVersion`,
  MIU-5) that decides which stored version of a product is public. The list
  endpoint (many products), the item / slug / product page endpoints (one product
  by ID) and the quote request all call it. Different endpoints, same record.
- **Lot / kg / set units, other currencies:** stay "Request a quote" until the
  client asks (DESIGN §2.4).

## Planning record

The planning ran on 2026-10-06/07 in one session (dev-pipeline plan, phases 1–6):

- **Spec:** agreed in conversation with the owner; recorded as DESIGN §3–§5
  instead of a separate `SPEC.md`.
- **Code research:** two analysts, one on the public read path and one on sync and
  admin. Their findings are folded into DESIGN §2, §5.1 and §8 and into each MIU's
  file and line references.
- **Tech stack:** known (Astro 6 + React 19 site, CloudBase functions bundled by
  `tsup`, pnpm workspace).
- **Tooling:** no new tools or SDK surfaces. No CloudBase SDK method is added, so
  the SDK contract gate is not triggered.
- **UI:** the admin changes reuse existing components (badge text, one button,
  batch feedback). No new UI design was needed.
- **Test plans:** included in each MIU (tests written first).
