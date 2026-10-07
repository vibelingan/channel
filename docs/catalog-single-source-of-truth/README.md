# Catalog single source of truth

**Goal:** every public surface — product list, product page, quote request — shows
the same approved data for a product, synced from Alibaba or entered by an admin,
and admins see and approve every Alibaba change before it goes public.

**Status (2026-10-07):** planned, docs only (plus one review fix to the earlier
price-block commits, see EXECUTION_LOG). Branch `feat/catalog-alibaba-price-tiers`
(not yet merged to `main`; continue here).

## Read in this order

1. [DESIGN.md](DESIGN.md) — background, live investigation, problems, decisions,
   manual products (§5.2), target design, rollout, risks, deferred items.
2. [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md) — 34 technical MIUs in five deploy
   batches, plus the rollout runbook (R1–R10).
3. [EXECUTION_LOG.md](EXECUTION_LOG.md) — status per MIU and runbook step; the list
   of the 21 products.

## In one paragraph

The product list reads a price the Alibaba sync writes without approval; the
product page and quote read the admin-approved version. After the Sept 21 price
repair they disagreed on 21 products, and the page showed Alibaba's headline price
(the cheapest tier) as if it applied at the minimum order. The fix:

- one shared rule decides which version of a product is public, and every
  endpoint uses it;
- each approved version stores the list's price summary;
- the headline price is no longer treated as a price;
- products whose Alibaba data changed since approval are flagged for review;
- manual products go through the same approval and look exactly like synced ones;
- the 21 products are restored through normal re-approval.

## Open decisions (owner)

| ID | Question | Recommendation |
|---|---|---|
| OWN-1 | Approval is admin-only. Contributors can publish manual products directly today. After the change, should a contributor's save on a published product stay a draft (flagged "edited") until an admin publishes it? | Yes |
| OWN-2 | The Hermes / WeCom importer publishes through raw API calls, which the new gate refuses. Should Hermes create drafts for an admin to publish in the admin UI? | Yes |

Only MIU-31 waits for these. Decided on 2026-10-07: DEC-4 (manual products are
first-class approved versions), DEC-11 (unpublishing does not clear the flag),
DEC-12 (Save never publishes unreviewed supplier changes), DEC-13 (unpublish the 21
after the fix is validated locally).

## Owner questions answered (2026-10-07)

- **Does switching colour switch the price?** Yes. The page passes the selected
  configuration's own offers to the price block (`CatalogQuotePanel.tsx`:
  `variantOffers={variant?.offers}`). MIU-14 adds an e2e test to pin it.
- **What is a SKU?** One full attribute combination (colour + plug + mic …), with
  Alibaba's SKU ID and our own variant ID.
- **Stored by SKU or by product?** Both, as one unit: an approved version is one
  product header plus one row per SKU under the same revision.
- **What is the "price summary", and is it a second source?** No. It is the single
  "From $X" a card needs, worked out from the same SKU rows when the admin approves
  and saved in the same approved record. It sits next to the header rather than
  inside it only because the page rejects unknown fields inside the header
  (DESIGN §5.1).
- **What is "one reader"?** One shared server function (`resolvePublicVersion`,
  MIU-5) that decides which stored version is public. The list (many products),
  the item / slug / product page (one by ID) and quotes all call it.
- **Flag vs fingerprint?** The flag is what the admin sees ("Changed"; the
  existing flag with a reason). The fingerprint is a hidden summary of the supplier
  data saved at approval so the sync can tell whether anything changed; the
  existing one includes timestamps and stock, so it would say "changed" every time.
- **What is "Removed", and what is the impact?** A product deleted on Alibaba is
  only noticed by a full sync run, which only the (switched-off) timer starts. So
  a deleted product stays on our site and can still get quote requests, and nobody
  is told. Deferred as a separate decision (DESIGN §5.1, §9).
- **Save vs publish:** Save stores the admin's edits; it never publishes supplier
  changes nobody reviewed. Publish / Save & publish / Approve changes do. Today
  "save only" on an already-published product silently re-publishes the latest
  Alibaba data — MIU-25 fixes that (DEC-12).
- **Do manual products get the same tiered price display?** Yes. Their manual
  pricing (tiers, or one price with MOQ) becomes the website price of the same
  approved version and is shown in the same Alibaba-style block, list card and
  quote (DESIGN §5.2).
- **Lot / kg / set units, other currencies:** stay "Request a quote" until the
  client asks.

## Planning record

The planning ran on 2026-10-06/07 in one session (dev-pipeline plan, phases 1–6):

- **Spec:** agreed in conversation with the owner; recorded as DESIGN §3–§5
  instead of a separate `SPEC.md`.
- **Code research:** three analysts: public read path; sync and admin flows;
  manual products. Their findings are folded into DESIGN §2, §5 and §8 and into
  each MIU's file and line references.
- **Tech stack:** known (Astro 6 + React 19 site, CloudBase functions bundled by
  `tsup`, pnpm workspace).
- **Tooling:** no new tools or SDK surfaces. No CloudBase SDK method is added, so
  the SDK contract gate is not triggered.
- **UI:** the admin changes reuse existing components. Manual products move to the
  existing shared product page. No new UI design was needed.
- **Test plans:** included in each MIU (tests written first).
