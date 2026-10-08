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
| 5 | `resolvePublicVersion` shared rule | 3 | Done | `3407529` |
| 6 | Price summary backfill (db command) | 2b | Done | `96c3157` |
| 7 | Backfill admin action + script | 2b | Done | `bcfac0a` |
| 8 | Public list / item / slug read the one version | 3 | Done | `b7153f5` |
| 9 | Product page endpoint uses the rule | 3 | Done | `443f22d` |
| 10 | Quote request uses the rule | 3 | Done | `375b139` |
| 11 | Site decoder + `Product.priceSummary` | 3 | Done | `e9f696c` |
| 12 | Card price / MOQ from summary | 3 | Done | `f41d391` |
| 13 | Hub featured strip effective MOQ | 3 | Done | `0a8b59e` |
| 14 | E2E: configuration switch changes price; card matches page | 3 | Done | `0ac6f8f` |
| 15 | `alibabaReviewReason` field + identity rules | 4 | Done (local) | `91659ab` |
| 16 | `publicSourceDigest` | 4 | Done (local) | `2e33853` |
| 17 | Prepare records source digest | 4 | Done (local) | `0d85a37` |
| 18 | Approval receipt carries digest | 4 | Done (local) | `a34b267` |
| 19 | Promote step flags changed / removed | 4 | Done (local) | `fc2631f` |
| 20 | Quarantine path + refresh contract | 4 | Done (local) | `fb7ba50` |
| 21 | Approve / acknowledge clears reason (not unpublish) | 4 | Done (local) | `8ef0b3a` |
| 22 | `change-audit-mark` db command | 4 | Done (local) | `ab7b3c1` |
| 23 | Admin badge / chip show reason | 4 | Done (local) | `756a364` |
| 24 | "Approve changes" action | 4 | Done (local) | `d5a601d` |
| 25 | Edit form shows pending Alibaba changes before Save | 4 | Pending owner review (DEC-12) | |
| 26 | `catalog-consistency-audit` script | 3 | Done | `4d69d06` (review fix `844d98b`) |
| 27 | Manual draft, spec facts, MOQ-only price in the planner | 5a | Done (local) | `4a76230` |
| 28 | `manual-source` prepare command + spec fields in approval fingerprint | 5a | Done (local) | `788d134` |
| 29 | Receipt fingerprint covers spec fields for manual owners | 5a | Done (local) | `15a1f90` |
| 30 | Admin prepare — manual branch | 5a | Done (local) | `572877b` |
| 31 | Publish gate for every product on update | 5b | Not started (ships after R9) | |
| 32 | Admin publish flow and preview include manual products | 5a | Done (local) | `20e8a2e` |
| 33 | Product page shows MOQ when there is no price | 3 (moved from 5a) | Done | `00a157a` |
| 34 | Manual product end-to-end (local) + admin e2e updates | 5a | Not started | |
| 35 | Batch "Assign category" confirms before publishing pending changes | 4 | Pending owner review (DEC-12) | |
| 36 | Replay admin page shows `productHeadlineDropped` | 1 | Done | `f0e3da7` |
| 37 | Gate on creating an already-published product | 5b | Not started (ships after R9) | |
| 38 | Admin action `auditChangesSinceApproval` | 4 | Done (local) | `9e7b020` (+ script `f250478`) |

## Runbook status

| Step | Status | Notes |
|---|---|---|
| R1 Unpublish the 21 | Not started — after local validation of batches 1–3 (DEC-13, owner 2026-10-08). 2026-10-08: the session's permission check refused this production write; needs the owner | List below |
| R2 Replay rebuild | Not started | |
| R3 Pinned-offer count | **Done 2026-10-08**: 0 of 1,118 products have `alibabaPinnedOfferKey` → R2 may proceed | Read-only admin list |
| R4 Price summary backfill | Not started | |
| R5 Consistency audit (before and after batch 3) | **Before done 2026-10-08** (production, read-only): 137 listed, 130 approved, 7 fallback (the manual products), 0 errors, 0 name/photo changes; every approved card lacks a summary until stage B (expected) | After: not started |
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

### Batch 4 review and fixes (2026-10-08, `ec74c2e`)
- Two reviewers on `2e34df6..d5a601d`. Drift: WARN, no P1 (R6 had no runnable
  tool — fixed by `f250478`; "Approve changes" shows no before/after; the
  "changed" signal includes supplier description/gallery changes that
  approval cannot publish → DEC-18 proposed). Code: one P1, two P2.
- P1 fixed: prepare's short-circuit (already prepared from the same data)
  skipped recording the fingerprint, so approvals of most live products would
  carry none and the sync could never flag them. It now records it. Test
  reproduced the bug first.
- P2 fixed: the audit compared the approved description (the admin's text)
  with the supplier's and reported false "changed"; descriptions are no
  longer compared. The product-level price comparison now has a test.
- P2 fixed: an approval built from older supplier data could clear a fresh
  "changed" flag. The sync records `alibabaSourcePublicDigest` (last seen);
  publish keeps the flag when the approval's digest differs. Tested both ways.
- P3s fixed: unlink clears the last-seen digest; manual prepare drops an old
  Alibaba digest; facts hashed trimmed; `Object.hasOwn` for reason lookups;
  "Mark reviewed" allow-list; "Compare with the live page" link; module doc
  comments moved back; offer-order test with several offers per SKU.
- MIU-32 lane failure fixed before any push: the classification journey now
  expects the browser to refuse an image-less manual product before any
  publish write; the message says "image" (the attention list matches it).
- Stage B PR #68 CI green (build and smoke incl. both browser lanes).

### MIU-23, 24, 38, R6 script, MIU-27 to 32 (2026-10-08, local)
- MIU-38 `9e7b020`: admin action `auditChangesSinceApproval`. Plan builds the
  candidate with the same builder and configuration ids as a real approval
  (the id rule and category label are now shared with prepare), compares
  configurations added/removed, each configuration's price and options, the
  product-level price, facts and description (not images). Apply re-plans on
  the server and writes through MIU-22. Test fixtures build the "approved"
  side with the real builder, so the identical case proves no false
  "changed". Mutation (configuration price comparison disabled) failed 2 tests.
- `f250478`: `scripts/catalog-change-audit.mjs` (runbook R6), same shape as
  the backfill script; done when no `unchanged` row is left.
- MIU-23 `756a364`: badge/chip read New / Changed / Removed / Edited; tabs and
  filter say "N products to review" / "• Needs review"; "Mark reviewed" only for
  New. One e2e pattern updated for the new tab name.
- MIU-24 `d5a601d`: "Approve changes" (publish again = full approval) and, for
  Removed, "Unpublish". Deviation: no separate before/after price diff (the
  preview shows each configuration's current price).
- MIU-27 `4a76230`: planner builds a manual product's version (spec facts;
  MOQ-only price for manual products, DEC-16). Synced plans unchanged.
- MIU-28 `788d134`: `manual-source` command; refuses linked, archived and
  configured products (the server lists configuration rows, because the
  transaction can only read by id); approval fingerprint now covers SKU /
  Series / Model / Type (open reviews get one CONFLICT after deploy).
- MIU-29 `15a1f90`: publication fingerprint covers the spec fields for manual
  owners only; synced receipts unchanged (red seen with the old code).
- MIU-30 `572877b`: admin prepare takes the manual path; a product with
  configuration rows gets a clear refusal.
- MIU-32 `20e8a2e`: publishing a manual product runs the approval first; no
  photo → refused before any approval call; category-only save on a published
  manual product refreshes its version; the classification flow's revision
  guard carries through. Behaviour change: the classification bulk publish
  now approves a manual draft first (its test updated; synced products are
  still refused there).
- Batch 4 full validation at `d5a601d`: all package tests, build, both browser
  lanes pass.

### Deploy status (2026-10-08 07:55 JST)
- Feature branch pushed at `2e34df6` (batch 3 reviewed and blessed; batch 4
  work after it is local only until its own review).
- Stage A: PR [#67](https://github.com/vibelingan/channel/pull/67) into `test`,
  CI green (lint, typecheck, unit tests, function smoke, site build, both
  browser lanes). **Not merged:** this session's permission check refused the
  merge (a production deploy); it needs the owner.
- Stage B: draft PR [#68](https://github.com/vibelingan/channel/pull/68),
  identical to the reviewed head; merge only after stage A, R1, R2 and R4.
- R1 (unpublish the 21) was refused the same way. R2 and R4 are production
  writes too, so they also wait for the owner.

### MIU-15 to MIU-22 — batch 4 back end (2026-10-08, local)
- MIU-15 `91659ab`: read-only `alibabaReviewReason`; new draft = 'new'; unlink
  clears it; the legacy-row repair sets 'new' only when it sets pending.
- MIU-16 `2e33853`: `publicSourceDigest` (server-only export
  `shared/catalog-source-digest`). Deviation: each SKU's own photos are hashed
  too (DEC-6 counts photos). The parity test lives in `catalog-import`, because
  `shared` must not depend on it; typecheck caught the input type not accepting
  the real observation type (strict optional properties) and it was fixed.
- MIU-17 `0d85a37`: prepare stores `detailSourcePublicDigest`; a non-observation
  shape stores none and a re-prepare never keeps an old one.
- MIU-18 `a34b267`: job and receipt carry `sourceDigest` (optional; receipt
  readers accept the extra key).
- MIU-19 `fc2631f`: the promote transaction flags 'changed' (digest differs) or
  'removed' (inactive source) on products with an approved digest; never
  clears, keeps the stronger reason (removed > changed > edited > new), never
  touches the approved version; archived products are never flagged.
- MIU-20 `fb7ba50`: quarantine approval passes the same digest; a reviewed
  product stays reviewed unless its source moved. Dated note added to the
  review-queue doc.
- MIU-21 `8ef0b3a`: publish and archive clear the reason; unpublish never does
  (pinned by a test); "Mark reviewed" only for 'new' (CONFLICT otherwise).
- MIU-22 `ab7b3c1`: `change-audit-mark` command. Deviation: also skips
  archived products ('archived'), and the digest rule for 'unchanged' is
  checked in the command, because a refined schema cannot join the persistence
  discriminated union (caught by the tests).
- Each written test-first and seen failing for the intended reason. Validation
  per MIU: the touched suites (sync function 228, db 245, admin 250, shared,
  catalog-import), `pnpm typecheck`, `pnpm lint`, and
  `pnpm package:functions && pnpm smoke:functions` where the spec asks.

### Final re-review of the fixes (2026-10-08)
- One reviewer on `95ee994..5ff409c`: **PASS**, no P1. It rebuilt stage A
  independently and ran typecheck, every package's tests and both CI browser
  lanes on it: all pass.
- Fixed (this commit): P2 — the stage A recipe must be applied top to bottom
  (`de87798` and `8958d90` share three files); the doc now says so and names the
  built commits. P3 — the R4 list refuses plan rows without `variantCount`
  instead of returning nothing; `--only-fields` rejects unknown names, prints
  read errors and is in the usage line; a re-run of apply keeps the earlier
  run's record (`previousResults`) and a response without a results list keeps
  the rows confirmed before it; the rollback rule covers every approval, not
  only R4; one timeline for the 21 (re-approved after stage B and R2, before
  batch 4); operator scripts run from the branch head; MOQ wording.
- Stage A as built (`b5f50c9` = `bcfac0a` + `7e1b20c` + `ae5d81d` + merges of
  `main` and `test`): equals `main` plus 26 stage files; install, typecheck,
  lint and all 15 packages' tests pass (about 2,800 tests).
- Validation (branch head): scripts 457; site 517; lint.

### Batch 3 fix re-review (2026-10-08)
- Two reviewers on `4d69d06..7ad213a`: code (no P1/P2, 7 P3) and docs/drift
  (one conditional P1, one P2, P3s).
- P1: the stage A deploy (then planned as `bcfac0a` + `de87798`) lacked the
  planner's `variantCount`, so R4's check for product-level card prices would
  have matched nothing. Fixed in the recipe: stage A also takes the three
  `8958d90` planner files (bases verified identical).
- P2: R5 "Before" needed every name/photo change; the audit printed only the
  first 20 of all mismatches. Added `--only-fields` (tested).
- P3 fixed (`fa4e78d` and this commit): page shows the MOQ of any price with
  nothing orderable; MOQ line spacing; backfill receipt keeps every confirmed
  row, rejects short responses, clears an old failure, and the plan prints the
  R4 list; audit fails on an empty list; price repair needs positive evidence
  of an approved version; runbook wording (no admin screen for the backfill,
  functions always deploy before the site, `invalid-variant-rows` handling,
  stage B pinned when shipped, MIU-7 arguments); README lists DEC-17.
- Deploy plan changed: batches 1, 2a, 2b ship as one deploy (stage A) with no
  approvals during it; batch 3 as stage B (MIU_BREAKDOWN "Order").
- Also fixed while running both CI browser lanes locally (`95ee994`): MIU-1 had
  broken the approved-product lane's fixture, which still expected the $7.67
  headline. Lane 1: 151 passed. Lane 2: all passed after the fix.
- Production, read-only (2026-10-08): R3 done (0 pinned offers); R5 "Before"
  baseline recorded in the runbook table.
- Validation: site 517; scripts 14 + 8 + 7 for the touched files, full
  `pnpm test:deploy-smoke` earlier 449; typecheck; lint.

### Batch 3 review fixes (2026-10-08)
- Review of `bcfac0a..4d69d06` by four reviewers (assumption drift, deep +
  cross-file + security, tests + types, old data + other readers). No P1 in the
  code; 8 P2. Findings: `.claude/review-findings-4d69d06.md` (local).
- Fixed:
  - `42d4cb5`: tests pin that an approved product with no stored summary
    ships no price, MOQ or row description; a VIP viewer gets no row price for
    an approved product; a not-yet-approved product projects the same with the
    flag on or off. Stale comment corrected. Mutation (row description leaks)
    failed the new test.
  - `844d98b`: the audit counts only "Detail not available" as fallback (any
    other 404 is an error; a card with a summary must have a page); compares
    the MOQ; rejects row price fields on approved cards. New tests for the
    missed-backfill shape and a failing list page. The reviewer's two
    mutations now fail tests.
  - `583208e`: the row-page price block shows the summary price; an equal
    range shows one price; tests for tiers below the MOQ; hub and e2e fixtures
    use a row MOQ that differs from the summary's; the e2e test fails on any
    unmocked API call (re-run: passed).
  - `8958d90`: backfill plan rows carry `variantCount` (R4 lists product-level
    summaries on products with configurations); the backfill script keeps its
    receipt on a partial failure; `catalog-price-repair.mjs` no longer fails
    for products served from their approved version; the size-cap and
    revision-check tests now fail when the check is removed (verified); MOQ
    precedence, full product-page response and oldest legacy row shape tested.
  - `00a157a`: MIU-33 pulled into batch 3 (see its entry).
- Docs (this commit): deploy recipe per batch (the batch 1 and 2b fixes were
  committed after later work; each deploy = the batch's last commit plus its
  fix files, bases verified identical); R4 is a hard gate for batch 3 with a
  0-`ready` criterion; R5 runs before and after batch 3; audit commands spelled
  out; MIU-38 compares product-level offers; DESIGN §8 drops the promised
  fallback to the version's own product price (it could show the retired
  headline) and records the remaining known limits; "As built" notes on MIU-11,
  12, 13, 14, 26, 33.
- Behaviour decision made here (DESIGN §8): an approved version without a
  stored summary shows "Request a quote" on its card. Showing nothing is
  safer than showing a possibly retired price; R4 makes the case not occur.
- Left for the owner: DEC-17 (open the product on the card's configuration).
- Separate task offered (pre-existing, not this branch): public search matches
  the Alibaba product ID.
- Validation: shared 176, db 235, admin 247, public-api 125, site 517, scripts
  449 — all pass; `pnpm typecheck`; `pnpm lint`; `pnpm build`; MIU-14 e2e.

### MIU-33 — product page shows the MOQ when there is no price (2026-10-08, `00a157a`)
- What changed: `CatalogCompactPrice` shows "≥N pieces" under "Request a
  quote" when the quote states a minimum order: website price first; else the
  product's own quote, then the selected configuration's (the card summary's
  order). No new copy keys.
- Why now: batch 3 already shows "Request a quote · MOQ N" on the card, so
  the page needed the same line (batch 3 review #9).
- Tests (red → green): website unavailable MOQ 50 → "≥50 pieces"; product
  negotiable MOQ 200 → "≥200 pieces"; configuration-only MOQ 1 → "≥1 piece";
  no MOQ → no line. The existing "unknown configuration prices" test is
  unchanged and passes.
- Validation: site 517 pass; typecheck; lint; build.

### MIU-26 — `catalog-consistency-audit` script (2026-10-07)
- What changed: new read-only `scripts/catalog-consistency-audit.mjs`. It pages
  through the public list, reads each product's page (every configuration page,
  pinned to the first page's revision, 8 at a time) and, for approved products,
  compares name, main photo (by image id) and the card's price summary with the
  price the page's own offers give under the approval rule. Products without an
  approved page are listed apart as row fallback. Exit 1 on any mismatch or
  unconfirmed read; `--require-no-fallback` also fails on any fallback product.
  Prints counts, fallback IDs and the first 20 mismatches (card value vs page value).
- Run: `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN`
  (HTTP only for localhost). No credentials: public API only.
- Deviations:
  - It imports `derivePriceSummary` from the shared package instead of
    re-implementing the rule (same pattern as `catalog-taxonomy-migration.mjs`),
    so there is no second copy to drift. The parity test still checks the input
    mapping against a direct `derivePriceSummary` call.
  - It reads the unfiltered list (every family at once) instead of each family's
    list, so every product is checked exactly once.
- Tests (7, written first; first run failed on the missing module):
  agree → 0; price mismatch → 1 with the product named; name and photo compared,
  photo by id; fallback counted apart, `--require-no-fallback` → 1; every list
  page and configuration page read, pinned to one revision; a 500 is an error,
  never a pass; parity with `derivePriceSummary`. Mutation checks: skipping later
  configuration pages failed 1 test; comparing photos by URL failed 5.
- Live run against the real local API (`apps/local-server`, scratch database,
  detail enabled): its 12 seeded products → `listed 12, approved 0, fallback 12`,
  exit 0. After adding two approved products (one correct, one whose stored card
  price was $9.00 while its page offer is $5.00) → `listed 14, approved 2,
  mismatched 1` naming the stale one, exit 1. This also confirms over HTTP that
  the list serves the approved name, photo and summary (MIU-8).
- Validation: `pnpm test:deploy-smoke` 443 pass, 0 fail; `pnpm lint`.

### MIU-14 — e2e: card shows the summary; each configuration its own tiers (2026-10-07)
- What changed: one new scenario in `tests/e2e/sku-detail.spec.ts`. The list
  serves an approved product the way MIU-8 does (summary from White, no row
  prices); the product page has Black (2–99 $6.61, 100–999 $5.55, ≥1,000 $4.76)
  and White (≥1,000 $4.30). The test opens `/toys/`, checks the card, clicks it,
  then switches configurations on the page that opens.
- Assertions: card "From $4.30" and "MOQ 1000"; Black → three
  `[data-price-tier]` rows (`USD 6.61 2-99 pieces`, `USD 5.55 100-999 pieces`,
  `USD 4.76 ≥1,000 pieces`); White → `USD 4.30 ≥1,000 pieces`.
- Deviation: added as a separate test next to the existing card test instead of
  extending the 836–870 loop, which runs 6 times (3 widths × 2 price sources)
  and does not open the page from a card.
- Mutation check: rebuilt with the pre-MIU-12 `EffectiveCatalogPricingBlock.tsx`;
  the test failed (card showed "Request a Quote"). Restored and rebuilt.
- Validation: `sku-detail.spec.ts` on chromium, 34 passed, against this
  worktree's build served by `astro preview --port 4329` (`E2E_SITE_URL`); port
  4321 was another checkout's dev server and was left alone. `pnpm typecheck`
  (includes the e2e project); `pnpm lint`.

### MIU-13 — hub featured strip shows the effective MOQ (2026-10-07)
- What changed: the electronics-toys hub strip (`FeaturedProducts.tsx`) reads
  `effectiveCatalogMoq(product)` instead of the raw `product.moq`, so it shows
  the same MOQ as the catalog card. Still no price on the strip.
- Deviation: the card markup moved into an exported `FeaturedProductCard`
  component (same markup) so it can be rendered in a test without the network
  fetch. The component had no test before; `featured-products.test.ts` is new.
- Tests: approved product → summary MOQ 10; row-fallback product with manual
  tiers from 20 and row `moq` 2 → 20; no MOQ anywhere → no MOQ line. First run
  failed only on the missing export; a mutation check (raw `product.moq` put
  back) failed the row-fallback test, then passed again after restoring.
- Validation: site 514 pass, 0 fail; `pnpm typecheck`; `pnpm lint`; `pnpm build`.

### MIU-12 — card price and MOQ read the summary (2026-10-07)
- What changed:
  - `effectiveCatalogPriceSummary` and `effectiveCatalogMoq` check
    `readPriceSummary` first. When a valid summary is present it is the only
    input: row prices, row `moq` and any Alibaba quote are ignored.
  - Card text: fixed → the amount; tiered and range → "From <lowest orderable
    amount>"; negotiable / unavailable → the quote label. USD and CNY use the
    card formatter ("$1.20"); other currencies use `formatCatalogQuoteAmount`
    ("EUR 12.00").
  - MOQ: the summary's stated minimum order, else the first tier's start.
- Deviation (one rule instead of copies):
  - `lowestOrderableAmountMinor` (was the private `lowestAmount`) and a new
    `priceSummaryMoq` are exported from `packages/shared/src/catalog/price-summary.ts`
    and re-exported through `@vibelingan-channel/shared/catalog-detail`.
  - The public API's private `summaryMoq` (MIU-8) was removed; it now calls
    `priceSummaryMoq`, so the API's `moq` and the card's MOQ come from one function.
  - Not in the spec's file list: `price-summary.ts`, `product-detail.ts`,
    `apps/functions/public-api/src/handler.ts`.
- Tests (red → green), in `catalog-family-render.test.ts`:
  - tiered 130/122/120 USD → "From $1.20", MOQ 10 (from the first tier);
  - fixed EUR 1200 → "EUR 12.00", MOQ 50; range CNY → "From CN¥4.50", no MOQ;
  - MOQ-only negotiable → quote label and MOQ 200, even with a row `wholesalePrice`;
  - summary wins over stale `wholesalePrice`, `moq` and `alibabaCatalogPricing`,
    and that card's markup equals the plain manual card's markup;
  - malformed summary → row prices (passed before and after, as intended).

  The first two tests failed before the change ("Request a Quote", "$99.00").
  The existing row-fallback tests are unchanged and pass.
- Validation: site 511 pass, 0 fail; shared 175/175; public-api 122/122;
  `pnpm typecheck`; `pnpm lint`; `pnpm build`.

### MIU-11 — site accepts `priceSummary` without trusting it (2026-10-07)
- What changed:
  - `Product.priceSummary` is typed `unknown`.
  - New `readPriceSummary` in `catalog-pricing.ts` runs
    `CatalogPriceSummarySchema.safeParse` at use time; malformed reads as absent.
  - `isProduct` is unchanged: it already ignores unknown keys, so one bad
    summary can never fail a page.
- Deviation:
  - `api.ts` needed no change.
  - The helper lives in `catalog-pricing.ts`, not `catalog-types.ts`, which
    holds only types.
  - No cycle: `api.ts` does not use the helper.
- Tests: a valid summary is read back; a malformed summary leaves the product
  and the page decodable and reads as absent. Written before the implementation
  but not run red in between.
- Validation: site 508/509 pass (1 existing skip), 0 fail; `pnpm build` (the
  shared schema bundles into the browser fine); `pnpm typecheck`; `pnpm lint`.

### MIU-10 — quote request uses the shared rule (2026-10-07)
- What changed: `planCatalogQuote` decides with `resolvePublicVersion` (all nine
  `approved.data` references renamed). No behaviour change; the snapshot is
  unchanged.
- Tests: new characterisation test, passing before and after the refactor:
  - an approved manual product with zero configurations records a
    customization quote with the header snapshot and website price;
  - a never-approved product is `unavailable`.

  (My first version of the test used an invalid customization input, which the
  quote schema rejects: it needs a type and a 10+ character brief. Fixed the
  input, not the code.)
- Validation: `pnpm test` exit 0; `pnpm typecheck`; `pnpm lint`.

### Batch 2 review fixes (2026-10-07)
Review of the batch 1 fix, MIU-3, MIU-4, MIU-6 and MIU-7: 0 P1, 2 P2, 12 P3.
Fixed:

- **P2 — the backfill trusted the caller's summary.** `apply` now re-plans each
  product on the server (`planProductPriceSummary`) and writes the server's
  summary only when it equals the reviewed row; otherwise it skips with
  `summary-changed` / `plan-changed`. Test: a forged summary is refused and
  nothing is written.
- **P2 — deploy order.** Runbook: batch 2a (`5cf2a6b`) deploys alone, before any
  writer.
- **P3:**
  - card/page parity: tiers below the MOQ are ignored;
  - DEC-16 for synced products: a "request a quote" with an MOQ yields a summary
    (rule 4);
  - currency ranking ignores case;
  - the schema ties `variantId` to SKU summaries and requires a price or an MOQ;
  - the planner applies the public reader's row checks (storage key, variant id,
    contiguous positions);
  - 64 KB request cap;
  - script totals by reason;
  - replay comment on update-only false;
  - runbook: redo the replay dry run after deploy; check no staging job before R4;
    re-plan before batch 3;
  - more tests (range, case, CNY SKU vs USD product, MOQ-only, schema, row
    forgery, positions, header mismatch).
- **Not fixed (out of scope, noted):** the local JSON adapter's `_id gt`
  comparison (`packages/shared/src/query.ts`) can mis-page unusual ids. Local
  rehearsal only; CloudBase is unaffected.

### MIU-9 — product page endpoint uses the shared rule (2026-10-07)
- What changed: `getProductDetail` uses `resolvePublicVersion` for both its first
  read and its consistency re-read. No behaviour change: the old check already
  ignored the Alibaba link. The rule is now shared with the list.
- Tests: new `catalog-detail.test.ts` (the endpoint had no unit test).
  Approved synced and approved manual (zero configurations, website price)
  serve the detail; not-yet-approved and mismatched → `NOT_FOUND`. Written as
  characterisation tests before the refactor; they passed before and after.
- Caught during validation: my first refactor missed one rename
  (`= approved.data;`). The new tests and 17 local-server tests failed until it
  was fixed; local-server is now 152/152.
- Validation: public-api 122/122; local-server 152/152; `pnpm typecheck`.

### MIU-8 — public list / item / slug read the one version (2026-10-07)
- What changed: `enableCatalogDetail` moved from `PublicHttpConfig` to
  `PublicApiConfig` (the same config object already reaches the catalog
  handlers). New `publicItem(…) → { doc, kind }` wraps `publicDoc`, whose
  signature is unchanged because tests in other packages import it.
  - For an approved product (`resolvePublicVersion`) it projects:
    - name, photos (absolute, at most 9, header order) and description from the
      approved header;
    - `priceSummary`, and `moq` from the summary;
    - optional identity and classification fields as for row products.
  - It never ships `unitPrice`, `wholesalePrice`, `clearancePrice`, `moq` from
    the row, `manualCatalogPricing`, `catalogPricingMode`, `vipPrice`, any
    `alibaba*` marker, or row `variants` (the list and `withVariants` skip
    `attachVariants` for approved items).
- Tests:
  - approved projection;
  - synced and manual approved products have identical keys and no `alibaba*`;
  - feature off or not yet approved → today's row projection;
  - item and slug equal the list item.

  The latter two passed before the change (unchanged behaviour); the first two
  went red → green.
- Validation: public-api 119/119; `pnpm test` exit 0; `pnpm typecheck`;
  `pnpm lint`; packaged smoke 3/3. Deploy smoke rules (family, at most 9 images,
  forbidden keys) still hold.
- Must ship with MIU-11/12 (site reads `priceSummary`).

### MIU-5 — `resolvePublicVersion` (2026-10-07)
- What changed: new `packages/shared/src/catalog/public-version.ts`. A product is
  served from its approved version when the detail feature is on, the
  publication decodes, and `header._id` matches. The Alibaba link is not
  checked. Everything else uses the row fallback.
- Deviation (corrects the docs review's N12 suggestion): published as the subpath
  `@vibelingan-channel/shared/catalog-public-version`, not re-exported from
  `catalog/index.ts`. `product-detail.ts` imports that index at load time, so the
  re-export would create a load cycle that reads `PublicProductSchema` before it
  is defined.
- Tests: synced and manual approved → approved; feature off, never approved,
  malformed, id mismatch, non-object → row.

### MIU-7 — backfill admin action and operator script (2026-10-07)
- What changed:
  - New admin action `backfillPublicationPriceSummary`. It is admin-only and
    needs `enableDetailApproval`.
    - `plan`: read-only, a page of 20 products from the planner (MIU-6), using a
      db reader that queries approved SKU rows exactly as the public detail
      endpoint does.
    - `apply`: at most 20 reviewed rows, each sent to the revision-checked
      staging command.
  - New script `scripts/catalog-price-summary-backfill.mjs`, modelled on the
    price-repair script:
    - token only from `CHANNEL_ADMIN_TOKEN`; HTTPS origin; owner-only manifest;
    - `plan` pages through the whole catalog;
    - `apply` sends only `ready` rows in batches of 20, stops on any unconfirmed
      row, then re-plans and exits 2 if anything is still `ready`.
- Deviations (extra files):
  - `packages/db/package.json` gains the subpath export
    `./catalog-price-summary-backfill` (existing pattern; the admin function
    imports db through package exports).
  - `scripts/catalog-price-summary-backfill.test.mjs`, a script test like the
    price-repair one. Script and test were written together, not red-first.
- Tests: handler (contributor and approval-off refused; bad mode rejected; plan
  is read-only; apply writes the summary; second apply skipped; 21 rows
  rejected) and script (paging, ≤20 per batch with the outcome field stripped,
  stop on an unconfirmed row).
- Validation: admin function 245/245; `pnpm test` exit 0 (includes
  `test:deploy-smoke` script tests); `pnpm typecheck`; `pnpm lint`; packaged
  smoke 3/3.
- Batch 2b code complete (MIU-4, MIU-6, MIU-7).

### MIU-6 — price summary backfill (db) (2026-10-07)
- What changed:
  - New `catalog-price-summary-backfill.ts`: a read-only planner with an
    injected reader (no db imports, no import cycle). It classifies products as
    `ready` (with the proposed summary), `already-present`, `not-approved`,
    `invalid-variant-rows` (row count ≠ `variantCount` or an invalid row) or
    `no-price`. It reads SKU rows by storage mode (`immutable-v1` / legacy).
  - New staging command `price-summary-backfill`. It is admin-only; re-checks the
    publication revision and an existing summary inside the transaction; writes
    the row back with only `catalogDetailPublication.priceSummary` added.
- Checked before writing: neither `publicationContentFingerprint` nor
  `approvalProductFingerprint` covers the publication, so existing approvals and
  in-flight jobs stay valid.
- Deviation: the result field is `backfill: 'applied' | 'skipped'`, not `kind`.
  The review result uses `kind: 'review'`, and an existing test narrows with
  `'kind' in result`. MIU_BREAKDOWN (MIU-6, MIU-22) updated.
- Tests: planner (immutable and legacy storage, every classification) and apply
  (only the summary changes, idempotent, changed revision skipped, contributor
  refused). Written before the implementation; first run after it.
- Validation: db package all green; `pnpm test` exit 0; `pnpm typecheck`;
  `pnpm lint`; packaged smoke 3/3.

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
