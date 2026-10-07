# Catalog single source of truth — execution log

Per-MIU record, written when each MIU completes (what changed, tests, result,
commit). Plan: [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md). Design: [DESIGN.md](DESIGN.md).

## Status

| MIU | Title | Batch | Status | Commit |
|---|---|---|---|---|
| 1 | Normalizer omits wholesale headline when SKUs exist | 1 | Done | `98a462c` |
| 2 | Raw replay deactivates dropped `'@product'`, stores new hash | 1 | Done | `c42fc7c` |
| 3 | Price summary contract + `derivePriceSummary` | 2a | Done | `5cf2a6b` |
| 4 | Approval plan stores `priceSummary` | 2b | Done | `1b22ff5` |
| 5 | `resolvePublicVersion` shared rule | 3 | Not started | |
| 6 | Price summary backfill (db command) | 2b | Not started | |
| 7 | Backfill admin action + script | 2b | Not started | |
| 8 | Public list / item / slug read the one version | 3 | Not started | |
| 9 | Product page endpoint uses the rule | 3 | Not started | |
| 10 | Quote request uses the rule | 3 | Not started | |
| 11 | Site decoder + `Product.priceSummary` | 3 | Not started | |
| 12 | Card price / MOQ from summary | 3 | Not started | |
| 13 | Hub featured strip effective MOQ | 3 | Not started | |
| 14 | E2E: configuration switch changes price; card matches page | 3 | Not started | |
| 15 | `alibabaReviewReason` field + identity rules | 4 | Not started | |
| 16 | `publicSourceDigest` | 4 | Not started | |
| 17 | Prepare records source digest | 4 | Not started | |
| 18 | Approval receipt carries digest | 4 | Not started | |
| 19 | Promote step flags changed / removed | 4 | Not started | |
| 20 | Quarantine path + refresh contract | 4 | Not started | |
| 21 | Approve / acknowledge clears reason (not unpublish) | 4 | Not started | |
| 22 | `change-audit-mark` db command | 4 | Not started | |
| 23 | Admin badge / chip show reason | 4 | Not started | |
| 24 | "Approve changes" action | 4 | Not started | |
| 25 | Edit form shows pending Alibaba changes before Save | 4 | Pending owner review (DEC-12) | |
| 26 | `catalog-consistency-audit` script | 3 | Not started | |
| 27 | Manual draft, spec facts, MOQ-only price in the planner | 5a | Not started | |
| 28 | `manual-source` prepare command + spec fields in approval fingerprint | 5a | Not started | |
| 29 | Receipt fingerprint covers spec fields for manual owners | 5a | Not started | |
| 30 | Admin prepare — manual branch | 5a | Not started | |
| 31 | Publish gate for every product on update | 5b | Not started (ships after R9) | |
| 32 | Admin publish flow and preview include manual products | 5a | Not started | |
| 33 | Product page shows MOQ when there is no price | 5a | Not started | |
| 34 | Manual product end-to-end (local) + admin e2e updates | 5a | Not started | |
| 35 | Batch "Assign category" confirms before publishing pending changes | 4 | Pending owner review (DEC-12) | |
| 36 | Replay admin page shows `productHeadlineDropped` | 1 | Done | `f0e3da7` |
| 37 | Gate on creating an already-published product | 5b | Not started (ships after R9) | |
| 38 | Admin action `auditChangesSinceApproval` | 4 | Not started | |

## Runbook status

| Step | Status | Notes |
|---|---|---|
| R1 Unpublish the 21 | Not started — after local validation of all batches (DEC-13) | List below |
| R2 Replay rebuild | Not started | |
| R3 Pinned-offer count | Not started | |
| R4 Price summary backfill | Not started | |
| R5 Consistency audit after batch 3 | Not started | |
| R6 Changed-since-approval audit | Not started | |
| R7 Admin re-approval | Not started | |
| R8 Final audit + browser checks | Not started | |
| R9 Admin approves the 7 manual products | Not started | |
| R10 Audit with `--require-no-fallback` | Not started | |

## The 21 products (live audit 2026-10-06)

Card price ≠ product page price; the product page shows the wholesale headline
paired with the MOQ. Names are truncated as captured.

| # | Product ID | Name |
|---|---|---|
| 1 | `cd823b43-c5e8-4590-af70-3c771036e25d` | 3.5mm On-Ear Wired Headphones for Kids Safe Casque for … |
| 2 | `4ac1eef6-2d4a-4332-a8a9-55028332fc99` | 3.5mm Wired Office Headset with Microphone for Call Cen… |
| 3 | `0e18d7ff-8a92-45b8-aa3d-461634880ac8` | Adjustable Wired Over Ear Headphones With Mic Stereo So… |
| 4 | `7df1ce02-579e-43a5-ae84-57a4f7dd857a` | BH14 Custom OEM Stereo Best Headset Microphone New Chea… |
| 5 | `8f45ab2e-a44f-40b8-a57e-fd7a27feefe8` | Best Stylish Wired Headset RGB Battery Indicator ANC PS… |
| 6 | `c9a4d22d-fc31-4123-a0ba-49ee29ec020e` | Computer Gaming Accessories 3.5mm Stereo Plug Headband … |
| 7 | `e4bd5237-4d71-492f-a748-9fec706535d5` | Factory Headphones Headset Max Wired Stereo HIFI Headph… |
| 8 | `14185dbc-c03c-4f7a-ae46-0707766059b1` | Factory Price Wholesale Children's Earphone Children To… |
| 9 | `4e2f0c91-6a68-40a8-aa9b-b7277793902f` | High Quality Wired Headphones BT Noise Cancellation Fol… |
| 10 | `93a55b79-cbb5-4631-aa9b-5caef570881e` | Hot Sell Adjustable Head Band Blue Tooth5.0 Wireless Ac… |
| 11 | `2429aef6-18c9-4407-ab14-2551dac7c844` | Hot Selling Products 2025 Adjustable Wired Headphones G… |
| 12 | `a7f1b2dd-3d68-46f5-a566-ae7add1c80f5` | KH3 New Original Kin for Children School Student Headse… |
| 13 | `c5186aef-6bc1-4325-a5c9-b80e2f45bc47` | KH6 amazon Best with Mic Microphone Girl Cat Ear Cartoo… |
| 14 | `ea411ae2-9925-45dc-a609-e64237aa880d` | KH7 Original Toddler Earphone Best Headphone Head-mount… |
| 15 | `02503c24-a383-48fb-ac75-b4598cb585e1` | Lightweight Foldable 3.5mm Wired Music Earphones & Head… |
| 16 | `60722976-359d-4f77-a1d9-a569d3c88aeb` | New Premium Audio Quality Transparent White Wired Call … |
| 17 | `7ac5152c-9f3c-4538-aa31-78c625ccea52` | New Wireless Headphones Earphones Headphone Speaker Gam… |
| 18 | `23645c96-6b99-4537-a9f1-2679286b9e03` | WH5 Hot for Mobile Phones High Quality Price Over Ear C… |
| 19 | `47aed9b1-733b-4ab5-a4fd-1fd2b1ee046b` | WH7 Cheap Microphone Pc Over the Ear Wired for Call Cen… |
| 20 | `8fd31bc1-256c-4674-ac43-c8529c8d6147` | WH8 Cable Microphone Noise Canceling Computer Call Cent… |
| 21 | `7d6f778f-5275-4ad1-a77b-b56f8a1fa4cb` | Wired Headphone Stereo Foldable Headset Earphone Over-h… |

## Log

### Batch 1 review fixes (2026-10-07)
Review of MIU-1, MIU-2, MIU-36: 0 P1, 1 P2, 8 P3. Fixed:

- **P2 — replay was not repeat-safe.** The page hash included "is the headline
  offer still active", which the first apply changes, so any repeated apply failed
  with `page-changed`. The hash no longer includes it; deactivation is derived
  from the live active set, so a repeat skips it.
  - New test: a store that reflects writes, run for both a committed apply and an
    apply interrupted by a lease loss right after deactivation.
  - Mutation check: putting the flag back into the hash makes the test fail.
- **P3:**
  - The headline branch now has the same currency guard as the ladder and SKU
    branches (a non-USD headline is no longer stored as USD).
  - Boundary tests for no-SKU wholesale: CNY, batch, Lot, invalid ladder.
  - Deactivation and the content-hash write are update-only (never create stubs).
  - The content hash is asserted equal to `contentFingerprint` of a fresh
    normalisation with a different clock and payload id.
  - New negative test: a stale product-level offer on a non-wholesale product
    still fails.
  - `contentFingerprint` takes `object`; casts dropped.
- **Runbook:** the pinned-offer count (R3) now runs before the replay (R2). R2
  notes that replay never writes product rows, so their sync price refreshes only
  when a run sees the product (admin-only impact after batch 3).
- Validation: sync package 152/152, sync function 222/222, `pnpm test` exit 0,
  `pnpm typecheck`, `pnpm lint`, packaged smoke 3/3.

### MIU-4 — every approval stores the price summary (2026-10-07)
- What changed: `planCatalogDetailApproval` derives the summary from the planned
  header and all planned SKUs and stores it as `publication.priceSummary`. All
  approval paths (staged prepare, single-transaction commit, workflow review,
  local rehearsal) inherit it; `finishStagedApproval` copies it unchanged.
- Tests:
  - planner: cheapest SKU → summary; website price → summary; no price → no key;
    partial page → no throw. Red then green.
  - staging round-trip: 25 SKUs across 2 pages, the cheapest on page 2, ends up
    in the stored version. Written after the planner change, so it confirms the
    integration rather than driving it.
- No pinned approval digest broke (`pnpm test` exit 0).
- Validation: `pnpm typecheck`; `pnpm lint`; `pnpm package:functions && pnpm
  smoke:functions` 3/3.

### MIU-3 — price summary contract (2026-10-07)
- What changed: new `packages/shared/src/catalog/price-summary.ts` with
  `CatalogPriceSummarySchema` and `derivePriceSummary`. The publication schema
  gains an optional top-level `priceSummary` (never inside `header`). Re-exported
  from `product-detail.ts` (`@vibelingan-channel/shared/catalog-detail`).
  `price-summary.ts` imports only `offer-pricing.ts` (no cycle).
- Rule:
  1. A website price is authoritative: a price, or "request a quote" with an MOQ,
     becomes the summary. A website "request a quote" without an MOQ gives no
     summary and never falls back to supplier prices, matching the product page.
  2. Otherwise the cheapest priced SKU: USD, then CNY, then other currencies;
     then the lowest amount; then the earliest SKU.
  3. Otherwise the product-level price.
- Spec refinement (recorded): the authoritative-website rule is not spelled out in
  MIU-3's text. It follows `CatalogCompactPrice`'s existing "authoritative unknown
  prices never fall back" test, so card and page agree.
- Tests: 8 (red: module missing → green).
- Validation: `pnpm test` exit 0; `pnpm typecheck`; `pnpm lint`; `pnpm build`;
  `pnpm package:functions && pnpm smoke:functions` 3/3.

### MIU-36 — replay admin page accepts and shows the headline count (2026-10-07)
- What changed: the strict counts decoder (`alibaba-api.ts`) accepts
  `productHeadlineDropped` (and rejects a value above the page's observations);
  page totals include it; the replay panel shows "Headline prices removed: N".
- Tests (red → green):
  - fixtures carry the new count;
  - -1 and 21 are rejected;
  - the rendered value is shown;
  - the two-page total is 3.
- Validation: site 506 pass / 0 fail; `pnpm typecheck`; `pnpm build`; `pnpm lint`.
- Batch 1 code complete (MIU-1, MIU-2, MIU-36). Not deployed (DEC-13: all batches
  are validated locally first).

### MIU-2 — replay deactivates stored headline offers and stores the new hash (2026-10-07)
- What changed: `replayAlibabaRawPage` accepts an existing active set that equals
  the replayed set plus exactly the product-level offer, for wholesale products
  with SKUs, and on apply deactivates that offer (`active: false`). Apply also
  writes the recomputed `alibabaSourceProducts.contentHash` through a new port
  method `upsertSourceProduct`. `counts.productHeadlineDropped` reports how many.
  Parser version `alibaba-content-media-v6`. `contentFingerprint` is exported
  from `ingest.ts` and reused, so replay and ingest hash identically.
- Tests (red → green):
  - headline offer deactivated;
  - hash stored;
  - count = 1;
  - an extra missing SKU still fails `offer-set-mismatch`;
  - parser version pin updated;
  - the full counts expectation gains `productHeadlineDropped: 0`.
- Validation: sync function 220/220; `pnpm test` exit 0; `pnpm typecheck`;
  `pnpm lint`; `pnpm package:functions && pnpm smoke:functions` (3/3).
- Deploy note: the admin replay page decodes counts strictly; MIU-36 must ship in
  the same deploy.

### MIU-1 — wholesale headline is not a price when SKUs exist (2026-10-07)
- What changed: `normalizeProductDetail` emits the product-level (`'@product'`)
  offer for wholesale products only when they have no SKUs; a no-SKU wholesale
  product with a product ladder uses the ladder (USD contract) instead of the
  headline. Sourcing / FOB unchanged.
- Tests (red → green): 4 failing first —
  - headline dropped with invalid SKUs;
  - headline dropped next to SKU tiers (3.90 = cheapest tier);
  - no-SKU wholesale ladder → tiered;
  - captured camping-light wire → SKU scope only.

  The new headline-only (no SKU) test passed before and after.
- Deviation: `apps/functions/alibaba-catalog-sync/src/raw-replay.test.ts` (a 4th
  file) pinned the Sept repair adding the headline offer for the camping-light
  product (which has SKUs). Updated to the new truth: the replay produces only the
  SKU offer. Deactivating headline offers already stored by that repair is MIU-2.
- Validation: `pnpm test` (all workspaces) exit 0; sync package 151/151; sync
  function 218/218; `pnpm typecheck`; `pnpm lint`;
  `pnpm package:functions && pnpm smoke:functions` (all three functions passed).
- Doc fix found while validating: the MIU validation command is
  `pnpm package:functions && pnpm smoke:functions` (smoke reads packaged
  artifacts; `build:functions` alone leaves none). Corrected throughout.

### PT-0 review fix — tiers below the minimum order (2026-10-07, `71272a6`)
- What changed: `CatalogCompactPrice` drops tier windows that end below the
  quote's MOQ and starts the first remaining window at the MOQ; the offer-label
  order test now fails when a label is missing.
- Why: pre-push review of the price-block commits (`5913f20`, `7984dea`).
- Tests (red → green): new "tiers below the minimum order…" test failed, then
  passed; site unit tests 506 pass, 0 fail.
- Validation: lint, typecheck, build; local e2e with `E2E_CATALOG_FORMAL=1`:
  public 41, catalog suites 88 (incl. 45 product-page tests), formal journey 6,
  taxonomy and admin subcategory — all passed. Not run (need saved sample data or
  live credentials): `shared-detail-preview.spec.ts`,
  `catalog-live-acceptance.spec.ts`.
- Live data: 0 of 411 tiered offers had an MOQ above the first tier, so no visible
  change today.

<!-- One entry per completed MIU:
### MIU-n — <title> (YYYY-MM-DD, <commit>)
- What changed:
- Tests (red → green):
- Validation commands and results:
- Deviations from the spec:
-->
