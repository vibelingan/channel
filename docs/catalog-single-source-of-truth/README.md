# Catalog single source of truth

**Goal:** every public surface — product list, product page, quote request — shows
the same approved data for a product, synced from Alibaba or entered by an admin,
and admins see every Alibaba change before it goes public.

**Status (2026-10-08 morning):**
- Batches 1–3 are reviewed, tested and ready to ship as two deploys:
  stage A = [#67](https://github.com/vibelingan/channel/pull/67) (CI green,
  nothing visible changes) and stage B =
  [#68](https://github.com/vibelingan/channel/pull/68) (draft, CI green;
  customers see this one). **Neither is merged**: the session's permission check refuses production
  deploys and production data writes, so those steps are yours (or allow them).
- Batch 4 (the "changed since approval" flag) is built, reviewed and fixed
  locally, except MIU-25/35, which wait for DEC-12. Batch 5a (manual products
  approvable: MIU-27 to 30, 32) is built locally; MIU-34 (its end-to-end test)
  and batch 5b are not started. These ship after stage B.
- Decisions 2026-10-08: DEC-12 yes (build MIU-25/35); DEC-17 closed (no product prices its options differently); DEC-18 decided (approval applies the supplier's new description and photos unless an admin edited them; MIU-39). None blocks batches 1–3.
- Branch `feat/catalog-alibaba-price-tiers` (not yet merged to `main`).

## Morning checklist (production, in this order)

Each step needs the one before it. Steps 1, 3, 4 and 7 change production data.

1. **Hide the 21 wrong products.** Admin → Products → search each name (list in
   [EXECUTION_LOG.md](EXECUTION_LOG.md)) → tick it → **Disable**. Check: their
   pages say not found.
2. **Deploy stage A.** Merge [#67](https://github.com/vibelingan/channel/pull/67)
   into `test`; wait for "Deploy Test" to finish. Nothing on the site should
   change. Do not approve or publish products while it deploys.
3. **Rebuild the stored Alibaba offers.** Admin → Alibaba Sync → observation
   replay: **Validate** (dry run) → check the counts ("Headline prices removed"
   is expected, no `offer-set-mismatch` failures) → **Apply**.
4. **Give older approvals their card price.** From the repo:
   `CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-summary-backfill.mjs plan /private/backfill.json https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`,
   read the output (`productPriceWithConfigurations` lists products whose card
   would show a product-level price although they have configurations; unpublish
   or re-approve those), then the same command with `apply`. The token is your
   admin login's session token (browser DevTools → Application → Local Storage →
   `channel.token`); never paste it anywhere else. Done when the re-plan shows
   0 `ready` rows.
5. **Deploy stage B.** Mark [#68](https://github.com/vibelingan/channel/pull/68)
   ready, merge it into `test`, wait for "Deploy Test".
6. **Check card = page everywhere.**
   `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`
   must exit 0 (fallback: the 7 manual products).
7. **Bring the 21 back with correct prices.** For each: Admin → Products →
   Preview (check the configurations' prices) → **Publish**. Publishing runs the
   approval from the replayed data. Check on the site that the card and the page
   show the same price, and switch configurations.

If you prefer that Claude runs steps 1–7, allow it in the session's permission
settings (merging into `test` and admin writes from the logged-in browser).

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

**DEC-18 — what counts as "changed".** A product's description and main photos
belong to the admin: approval publishes the admin's text and photos, not the
supplier's. So flagging a supplier description or photo change leads nowhere:
approving it changes nothing on the site, and the flag disappears. Proposal:
flag only what approval actually takes from Alibaba (configurations, their
prices, options and photos, the product price, and facts). Alternative: keep
flagging description and photo changes and make approval adopt the supplier's
versions. Batch 4 ships either way after a small change.

**DEC-17 — which configuration the product page opens on.** The card shows the
cheapest configuration ("From $4.30 · MOQ 1000" for a headset whose White option
starts at 1,000 pieces). The page opens on the first configuration (Black,
"$6.61, 2–99 pieces"). Both are right, but the first screen does not match the
card; this is also how the site behaves today. Proposal: open the page on the
configuration the card's price comes from. Alternative: keep today's behaviour.
Batch 3 ships either way.

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
