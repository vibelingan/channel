# Client Product Detail UI Update

Date: 2026-09-16
Branch: feat/alibaba-wiring-closeout; starting commit 38331057544ee0031b25d82db7e30502e38d4acf
PR: https://github.com/vibelingan/channel/pull/55 (open at start)

Status: test deployment and both authenticated live acceptance scopes passed.
The latest main (including AI PR #53) has been integrated into PR #55; its
runtime tree matches the accepted test release. Main merge is the remaining step.

## Final Release Evidence

Accepted test SHA: `75475b1bb1bf6f6b02f596909f57839a27d0f451`.

| Gate | Verified result |
| --- | --- |
| Deploy Test [35099448295](https://github.com/vibelingan/channel/actions/runs/35099448295) | Both CI jobs, CloudBase deployment, AI build-address check, release smoke and public browser E2E succeeded |
| Full live acceptance [35104056246](https://github.com/vibelingan/channel/actions/runs/35104056246) | Selected full test passed; four other-scope cases intentionally skipped |
| Variant-media acceptance [35106064681](https://github.com/vibelingan/channel/actions/runs/35106064681) | All four approved product cases passed; full-scope case intentionally skipped |

Full acceptance verified the deployed admin/public/sync release IDs, the complete
public inventory, real product list/Edit/Preview/detail behavior, and a TEST ONLY
inquiry through persisted Admin completion. Category preview found zero eligible
assignments. Inquiry `ec972a1d-3bd9-4d55-8a61-63fb80877e8a` completed with email
notification disabled. Public product IDs were unchanged by acceptance.
The separate media scope verified all four original audited products, preserving
their manual fields and public inventory. No new sample was published to pass.

During the final merge check AI PR #53 advanced main to
`fe5012a5c80e397aed8ab611594ec1f8963a121d`. Its last change relative to the AI
version already on test was only ignore rules and removal of an obsolete
handoff document. That main commit, not test, was merged into the feature.
Git comparison against accepted test proved identical `apps`, `packages`,
`scripts`, `tests`, workflows, dependency lockfile and TypeScript configuration.
Only main/test-specific baseline, ignore rules and documentation differed.
The historical failures below remain diagnostic history, not pending blockers.

## Test Release Checkpoint

- Feature CI 35066530832 passed for `b4f6c11`.
- AI PR #54 advanced test to `b319dae` while the old candidate was being checked.
  The pre-push check stopped that candidate. AI changes were then merged and
  verified: 708 files passed Biome, all 19 projects passed types, production
  public/catalog/formal browser groups passed (41/67/6). AI source parity was
  confirmed against `b319dae`; its separate service deployments were untouched.
- Combined test `a20e8b2a7266f3aa97af397c079ae3f6ff9c259d` deployed successfully in
  [35072003167](https://github.com/vibelingan/channel/actions/runs/35072003167),
  including both CI jobs, CloudBase release smoke, AI widget build-address
  verification and public browser E2E.
- Full authenticated acceptance
  [35076244382](https://github.com/vibelingan/channel/actions/runs/35076244382)
  passed service release checks but failed before category/product/inquiry writes:
  the single-page inventory check could not find the fixed page-two sample.
  Read-only diagnosis: 90 public products, effective pageSize 48 despite requesting
  100; page two contained 42 products and the sample. Direct item/detail returned
  200. This was an incomplete acceptance snapshot, not an unpublished sample.
- Both full and variant-media inventories were moved to one bounded pagination helper.
  At that checkpoint it retained a legacy 100-product test-size assumption,
  not a business authorization limit. It retained fixed sample IDs and rejected
  duplicate/missing/extra products and changing pagination metadata, and only
  returned after collecting the advertised total. Mutation steps were unchanged.
  The original helpers failed the 90/48 regression; 65 helper regressions passed
  on Node 20 and 24. No UI/backend/workflow behavior changed in this correction.
- Pagination correction deployed as `3b89462` in
  [35082627074](https://github.com/vibelingan/channel/actions/runs/35082627074)
  with both CI jobs, deployment and public smoke successful.
- Acceptance rerun 35086683026 stopped in its prerequisite local browser CI,
  before any live acceptance operation. Save-Data/2g checks mistook two requests
  for the selected black image (hero and visible thumbnail with routing/cache
  disabled) for speculative fetching. There was no unselected-color request.
  The test now observes native Image-constructor prefetch directly, alongside
  unique visible-source checks. Its normal-4g positive control detects prefetch;
  removing the connection guard makes both saving-mode cases fail with three
  speculative SKU sources. The hook was restored byte-for-byte, and 15 final
  browser repetitions passed with zero retries. Only test code changed.
- Parent-observed follow-up: feature CI
  [35091259284](https://github.com/vibelingan/channel/actions/runs/35091259284)
  succeeded; test release `19a641` deployed successfully in
  [35091705246](https://github.com/vibelingan/channel/actions/runs/35091705246).
- The earlier full live run
  [35095549791](https://github.com/vibelingan/channel/actions/runs/35095549791)
  passed both CI jobs, then failed at the read-only before-snapshot check:
  107 public products exceeded the helper's legacy maximum of 100. No acceptance
  mutation ran. The parent verified the count of 107 with a read-only inventory;
  the earlier count was 90, and owner publishing had increased it. This is a
  test read-capacity failure, not an owner publication-policy violation.
- Both corrected live scopes subsequently passed; see Final Release Evidence.
  Earlier failed runs and other-scope skips are not counted as passing cases.

## Snapshot Capacity Correction

This correction started from clean `c4a1677` and changed only the shared test
snapshot helper, its regression tests and this client record. The implementing
agent made no cloud changes. The coordinator subsequently reviewed and committed
it as `75365d9`, deployed the combined test release and verified both live scopes.

- Request pageSize remains 100; response metadata must be at most the requested
  100. The observed server cap remains 48, and smaller valid pages still work.
- The complete read-only snapshot may contain at most 1,000 products and require
  at most 25 pages. More than 1,000 products or 25 required pages fails closed.
  These are test read budgets, not product-publishing policy or new write scope.
- The full and variant-media mutation steps and strict fixed product/source IDs
  are unchanged, as is the original maximum of 302 reviewed draft assignments.
  The original before snapshot remains the comparison baseline. No automatic
  skip, snapshot replacement, ignored concurrent total/pageSize change, or
  weakened duplicate/missing/extra-ID or before/after inventory assertion was added.
  Owner publishing has not been paused or made a prerequisite for this fix.
- Tests were changed first: 68 total, 63 passed and the five requested capacity
  boundaries failed against the old helper. After the helper change, all 68
  passed on both Node 20.20.0 and 24.14.1, with zero failures or skips. The old
  65-test result above is historical, not the new count.
- Explicit boundaries: 107 products use 48/48/11 rows across three pages;
  1,000 use 21 pages with 40 final rows; 25 products at one row per page succeed;
  26 at one row per page and 1,001 total products reject before another request.
  Every requested page still uses pageSize 100, including after page ten.
- Root and E2E TypeScript checks, plus direct checkJs for the helper/tests, passed.
  Scoped Biome passed for both code files; full Biome passed for 602 files.
  No SDK, API route, runtime, adapter or type declaration was changed. Review,
  deployment and authenticated acceptance were subsequently completed above.

## Final Local Results

| Check | Observed result |
| --- | --- |
| Site unit tests | 420 passed, 0 failed, 1 explicitly opt-in browser test skipped |
| Package/Astro, root and E2E types | Passed; Astro 0 errors, 0 warnings, 8 hints |
| Biome | 599 files, no errors |
| Project craft gates | Exit 0; 12 unchanged baseline items, 0 new findings, 0 execution errors |
| Production public browser suite | 41 passed |
| Production catalog/Chromium/WebKit suite | 67 passed, no retries after focus correction |
| Production formal journeys | 6 passed, retries disabled; exit 0 |
| Local Admin lifecycle and editor | 5 + 11 passed in the non-formal lane |
| Focus regression repetition | WebKit 568x320: 5 passed with retries disabled |
| Real-photo visual replay | Chromium 320x568, 390x844, 1440x1000 passed and screenshots inspected |

The last six formal cases were rerun on a fresh disposable database and fresh
production build after correcting a test's radio-vs-select assumption for the
55-configuration fixture. The focused runner retained the standard runner's
readiness, origin, build and process/database cleanup logic; it omitted only
the already-passing public and catalog groups. Temporary copy:
`/tmp/channel-formal-focused.mjs`; final log `/tmp/channel-formal-focused.log`.
The checked-in full reproduction remains:
`CI=true E2E_RECORD_ARTIFACTS=1 E2E_CATALOG_FORMAL=1 node scripts/run-catalog-admin-local-e2e.mjs`.

Real-photo replay fetched one anonymous published v3 DTO and six JPEGs (424,313
bytes total), retained the original revision and URLs, and replayed those bytes
into the actual local DEV page. All six thumbnails decoded at each viewport;
photo browsing retained the SKU and canonical URL. No horizontal overflow,
page/console errors or attempted writes were observed. Supplier notes were
visible without expansion. This sample has no description images: description
image behavior is covered separately by unit and production browser fixtures,
not claimed as real-photo coverage. The Astro DEV toolbar in these screenshots
does not ship in the production build. No network-performance claim is made.

![Desktop detail with real product images](assets/chromium-1440x1000-viewport.png)

![Mobile detail with real product images](assets/chromium-390x844-viewport.png)

Local machine-readable evidence:
`output/playwright/client-real-visual/summary.json` and viewport/full-page PNGs.

The project gate was run through
`/Users/SeanCai/Desktop/projects/dev-pipeline/tools/run-craft-gates.sh --changed-files /tmp/channel-ui-changed-files.txt --json`.
An earlier mistaken invocation of the global knowledge-library linter reported
rule-document frontmatter errors; that output is not a project code-gate result.
No baseline, rule exemption, global knowledge file or Git hook was changed.

## Client Request

- Show supplier notes and product description images directly, without opening
  collapsed controls.
- Display product photos without requiring a View product gallery link. More
  images can use the existing horizontal thumbnail scroller.
- Keep the existing desktop gallery-left/information-right layout. The main
  information area contains title, price reference, configuration choices and
  Request a quote, in that order. Remove surrounding category/key-fact and
  verbose selected-configuration panels from this area.
- Keep full specifications and notes below. On mobile, images precede title,
  price, options and the quote action. Natural scrolling is allowed; do not
  shrink text or crop information merely to force everything into one screen.
- Validate locally, publish and verify test, then merge the feature PR to main.
  Never merge test history into the main-based feature. Preserve concurrent AI
  and catalog architecture worktrees.

## Implementation Boundaries

- No backend, source observations, publication rules, pricing authority, currency
  conversion, quote transport or database changes are intended.
- One unified gallery lists explicitly assigned SKU photos first, followed by
  deduplicated general product photos. A selection without assigned photos can
  immediately display general photos, labelled as general rather than claiming
  to depict the selected configuration. Broken/unresolved assigned photos do not
  silently switch to another color. Photo browsing never changes selected SKU.
- Notes and description images use visible sections/headings instead of details
  toggles. Offscreen description images retain native lazy loading, async decoding,
  existing image caps and authenticated/public URL boundaries.
- Compact reference prices preserve website-pricing precedence, separate product
  and variant scopes and currencies, and exact minor-unit formatting. Unknown
  prices remain quote requests. Tier ranges are reference ranges, not promises
  that every quantity qualifies for the lowest price.
- Quantity and customization remain inside the quote dialog. There is one main
  CTA. No-SKU products use the supported product-level customization intent;
  invalid/pending selections and disabled Admin preview inquiries remain blocked.
- The previous country-picker Escape and touch regression remains unchanged.

## Verification Plan

1. Render regressions: visible notes/images, safe text, primary order, exact price
   authority, unavailable/mixed-currency prices, no-SKU quote and disabled states.
2. Gallery regressions: missing assignment displays general image; assigned image
   first; no toggle; general thumbnail does not select another SKU; unresolved
   private/failed assignment does not expose raw data or wrong-color fallback.
3. Browser: desktop and mobile order/layout, horizontal gallery scrolling, notes
   and description images visible without interaction, compact price on ordinary
   detail/Admin preview, quote quantity/customization and country-picker behavior.
4. Local production-build catalog/Admin and formal persisted RFQ lanes, types,
   lint, site tests and full same-SHA CI before release.
5. Before updating test, inspect latest main/test and shared deployment identity.
   An earlier isolated test merge must be re-created or updated with this final
   verified UI; never publish its older pending merge result.
6. After test deploy, verify actual SHA, ordinary public detail and Admin preview,
   and both explicitly approved live acceptance scopes before main merge.

## Current Evidence

- Parent-observed complete site run: 421 tests, 419 passed, 1 failed, 1 skipped
  (exit 1). The failure was the old detail-gallery nine-image assertion against
  the new twelve-photo merged gallery. It is not a passing full-suite result.
- Updated that assertion to verify all merged photos, deduplication and source
  order while separately retaining the legacy nine-image bound. Focused rerun:
  25 passed, 0 failed, 1 opt-in browser test skipped (exit 0).
- Added a browser submission regression for no-SKU customization with no invented
  variant ID, plus 320px coverage, visible main-region assertions and the desktop
  46/54 ratio check. E2E TypeScript and scoped Biome both passed (exit 0).
- Complete non-formal production-build local runner: public 41 passed, catalog
  66 passed plus 1 flaky WebKit case, font 1 passed, local seed 1 passed, Admin
  lifecycle 5 passed, editor 11 passed. Total 125 passed plus 1 retried case.
  Final log confirmed owned processes and temporary database cleanup.
- The flaky 568x320 WebKit case lost trigger focus after closing the quote.
  Move focus restoration from the immediate close callback (background could
  still be inert) to the next frame after closed state commits. Cancel the frame
  on reopening/unmount. The same WebKit case passed five consecutive DEV runs
  with retries disabled. The next production-build catalog run passed all 67
  tests with no retries, including this case and the country Escape regressions.
- Final site unit run after the focus fix: 421 tests, 420 passed, 0 failed,
  1 opt-in browser test skipped; exit 0. All package/Astro types passed; Astro
  reported 0 errors, 0 warnings, 8 hints. Biome checked 599 files with no errors.
- Formal production run: public 41 passed, catalog 67 passed, formal 4 passed
  and 2 failed. Real buyer RFQ persistence and Admin follow-up passed. The two
  failures expected nine photos for a seeded preview containing one assigned
  photo plus nine distinct general photos. Corrected the expected ten and added
  exact general-photo order, distinct accessible roles and preserved SKU checks.
  The next run passed five formal cases and exposed the radio-vs-select test
  assumption. After correcting that selector, all six formal cases passed on a
  fresh production build and disposable database. Earlier failed runs are retained
  as diagnostic history, not counted as passing acceptance.
- Parent opened the local preview and inspected 390px/1440px layout screenshots.
  Those screenshots use synthetic one-pixel images and only prove layout.
  Integrated-browser real-image replay was unreliable and did not qualify as
  visual acceptance. The separate independent Playwright capture subsequently
  passed all three exact viewports and was inspected; see Final Local Results.
- Static independent UI review found no further high-confidence pricing,
  private-media or inquiry-state regressions after the no-SKU correction.
- Tests are updated to assert the new client-requested behavior rather than
  deleting SKU identity, error-state or privacy checks.
- At the initial evidence checkpoint no commit/push/deployment had occurred.
  UI implementation and tests are now committed as
  `c9158356fc0f2ab2729b32e39887e328495a813d`, parent `3833105`, 22 files.
  Independent exact-commit assumption review passed with no high/medium findings;
  its only low finding was this historical status sentence, now corrected.
  Test deployment and main merge remain pending and require a fresh remote check.

## Concurrent AI Work

The owner warned on 2026-09-16 that another agent can merge AI work into test or
main at any time. Before either branch update, fetch current remote refs and
inspect added commits, open AI PR state and active deployment runs. Do not reuse
the previously prepared test merge as a release candidate. Preserve all incoming
AI changes and revalidate the actual combined tree when its base changes.

Use normal fast-forward-protected pushes only: a race that advances remote test
must reject this push, followed by a fresh merge/review/validation. Never force
push, reset shared branches or switch another agent's working tree. Merge only
the reviewed main-based feature PR into main, never test ancestry. Recheck the
deployed SHA after acceptance, since passing a superseded deployment does not
validate the currently running environment. Existing deployment serialization
must also cover any concurrent AI writer to the same target before publishing.

## Deviations

The removed secondary customization CTA is available as a checkbox within the
existing quote dialog, retaining functionality while satisfying the one-button
main-area requirement. No-SKU products must still reach this intent directly.
General and SKU photos share one gallery but have distinct accessible labels;
general product pictures must not be represented as a selected SKU photo.