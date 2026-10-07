# Catalog single source of truth

**Goal:** every public surface — product list, product page, quote request — shows
the same approved data for a product, synced from Alibaba or entered by an admin,
and admins see every Alibaba change before it goes public.

**Status (2026-10-07):** plan approved except DEC-12 (below); execution started in
batch order. Branch `feat/catalog-alibaba-price-tiers` (not yet merged to `main`;
continue here).

## Read in this order

1. [DESIGN.md](DESIGN.md) — background, live investigation, problems, decisions,
   manual products (§5.2), target design, rollout, risks, deferred items.
2. [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md) — 38 technical MIUs in seven deploy
   steps, plus the rollout runbook (R1–R10).
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

## Waiting for owner review

**DEC-12 — what Save does on a product that is already live.**

How it works today:

1. A product is approved and published with Alibaba data version A.
2. A later sync stores version B (say, a price change) in our database. The
   product page still shows A.
3. An admin opens the edit form to fix a typo and clicks Save. Save re-runs the
   approval with the product's **latest** data, so B goes live too. The edit
   form never showed B; it shows the admin's own fields, not the Alibaba
   configurations and prices.

So Save already is an approval, as you said. My earlier wording "unreviewed" was
misleading: the precise gap is that the admin is not *shown* what else gets
published.

**Proposed** (DESIGN DEC-12, MIU-25, MIU-35):

- Save keeps working exactly as today: it takes effect on the live site
  immediately. Nothing is unpublished, and there is no extra step.
- When the product is flagged "Changed", the edit form shows a notice above Save:
  "Alibaba data changed since the last approval. Saving publishes these changes
  too." It has a "See changes" button that opens the preview with the
  per-configuration differences.
- The batch "Assign category" bar shows no product details, so before saving it
  lists the flagged products and asks Continue / Skip those.
- Saving clears the flag.

This replaces my earlier proposal, which held the changes back and needed a
separate "Approve changes" step. "Approve changes" stays in the preview for
approving without editing anything.

## Decided on 2026-10-07

| ID | Decision |
|---|---|
| DEC-4 | Manual products are first-class approved versions, indistinguishable from synced ones |
| DEC-11 | Publishing (including Save on a live product) or archiving clears the "Changed" flag; unpublishing does not |
| DEC-13 | Unpublish the 21 only after the fix is validated locally |
| OWN-1 | A contributor's save on a published product stays a draft, flagged "edited", until an admin publishes it |
| OWN-2 | Hermes creates drafts for an admin to publish. Its import currently fails (client report); not investigated now |
| Removed | Behaviour stays: Alibaba changes, deletions included, reach us only through a sync; no new detection |

## Owner questions answered

- **Does switching colour switch the price?** Yes. The page passes the selected
  configuration's own offers to the price block (`CatalogQuotePanel.tsx`). MIU-14
  pins it with an e2e test.
- **SKU:** one full attribute combination (colour + plug + mic …). An approved
  version is one product header plus one row per SKU.
- **Price summary:** yes — part of the same approval, just a different part of the
  same record for a different display (the card's "From $X"). No separate
  approval.
- **"One reader":** one shared server function (`resolvePublicVersion`) used by
  the list, the product page and quotes.
- **How do manual products get configurations if there is no editor?** The admin
  form cannot create them. The Excel (Dianxiaomi) import can, but:
  - the admin "Catalog import" page is only a read-only preview of import jobs;
  - the import itself is a command-line tool that has not run in production
    (`docs/dianxiaomi-excel-import/REMAINING-PRODUCTION-STEPS.md`).

  So no live manual product has configurations. Manual approval supports zero
  configurations. It refuses a product that has configuration rows rather than
  dropping them silently. Carrying them through is a follow-up, needed before the
  Excel import goes live (DESIGN §5.2, §9).
- **What are the seven deploy steps?** Each step ships only what the next one
  needs, so the site never depends on something not yet deployed:
  1. **Batch 1** — stop treating the headline as a price; rebuild stored offers
     from saved Alibaba data; the replay page shows how many changed.
  2. **Batch 2a** — teach the servers to *read* a price summary. Nothing writes
     one yet. This is the safety step: from here on we can always roll back.
  3. **Batch 2b** — write the summary at every approval, and fill it in for all
     already-approved products.
  4. **Batch 3** — switch the list, product page and quote to the one approved
     version, and run the consistency audit.
  5. **Batch 4** — the "Changed" flag and the admin screens for it. A one-time
     audit flags products whose Alibaba data changed since approval, including
     the 21. The admin re-approves them.
  6. **Batch 5a** — manual products can be approved. The admin approves the 7
     live ones.
  7. **Batch 5b** — only then, "publishing always needs an approved version"
     starts for every product. If it came earlier, a live manual product with no
     approval yet could not even save a fix.
- **Lot / kg / set units, other currencies:** stay "Request a quote" until the
  client asks.

## Planning record

The planning ran on 2026-10-06/07 (dev-pipeline plan, phases 1–6):

- **Spec:** agreed in conversation; recorded as DESIGN §3–§5.
- **Research:** three analysts (public read path; sync and admin; manual products).
- **Review:** three review rounds of these docs against the code. All findings
  were fixed (`bc8377d`, `e789de7`).
- **Tooling:** no new CloudBase SDK surface, so the SDK contract gate is not
  triggered.
- **Test plans:** in each MIU (tests written first).
