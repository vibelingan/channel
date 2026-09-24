# Catalog Navigation and Subcategories Execution

Updated: 2026-09-19. This document is the restart checkpoint after VS Code crash.
Branch: feat/catalog-multi-subcategories
Starting main: ba3cd6296cddf3eb0fd67866b0819cd7b0db33bd
Status: Pagination deployed and merged; multi-subcategories deployed and accepted, main PR finalization pending.
Current phase: deliver (taxonomy; separate release)
Current/next MIU: 8 (main-based PR #58 merge and post-merge CI).

## Admin Subcategory Visibility (2026-09-23)

Branch `fix/admin-subcategory-delivery-20260923` from main fcf1431. Reworked
from the 2026-09-22 handoff because its bundle, patch and commits never reached
this machine or GitHub; nothing here is the original implementation.

What operators see (admins only; contributors keep the list without it):

- Products list: "Headphone type" (the legacy scalar `category`) is replaced by
  "Website subcategories", the names the storefront actually uses. Names come
  from saved `subcategoryIds` through the family registry; products without that
  field fall back to the legacy Headphones type exactly like the storefront.
  States: None, archived names suffixed "(archived)", "Invalid saved
  subcategories" for unknown/cross-family/malformed data, loading, and a retry.
- The main-category column now uses the same legacy fallback, so legacy
  Headphones rows no longer read "Needs classification" inside the Headphones tab.
- A "Website subcategory" filter appears inside one main-category tab. The
  server resolves ids against that family's saved registry (archived allowed,
  unknown/cross-family rejected, contributors forbidden) and ANDs the scope
  with search and any AND/OR filter before counting and paging. The choice is
  kept in the URL (`subcategory=`), survives reload/history, and is cleared by
  switching tabs. Clients cannot supply the internal scope object.
- Edit Product shows a read-only "Saved website classification" summary of the
  last saved values. Viewing the list, filter or summary never writes products.

Out of scope (unchanged): atomic batch publish and category data migration.

### Bulk classify and publish (2026-09-24, pending test release)

- In the Products selected-row bar, Assign category now opens the saved taxonomy
  picker with a checked option to publish after all selected classifications
  succeed. Uncheck it to save classifications as drafts. The single-row Classify
  action remains classification-only. Both choices require a preview and an
  explicit confirmation.
- This is a sequential workflow, **not an atomic batch transaction**. The Admin
  assignment endpoint returns confirmed saved timestamps only on request. If
  any selected assignment is rejected, uncertain, or lacks a saved timestamp,
  the UI does not attempt any publication. Each subsequent publish write carries
  that product's saved timestamp, checked inside the same product transaction;
  intervening edits produce a conflict and leave that product private. Product
  publication validation, permissions and media rules still apply independently.
  Confirmed earlier publications are never claimed rolled back. Supplier-linked
  products requiring the separate detail-approval/media workflow are directed
  to Edit instead of silently advancing approval in the bulk path.
- The disposable production-build browser journey verifies saved names and
  scoped filters, two selected products classified then published, an unselected
  product unchanged, an invalid product remaining private with row-level
  feedback, and a concurrent edit blocked between classification and publish.
  The default and approval-enabled browser lanes passed with owned local data;
  neither is a deployed-environment acceptance claim. Same-SHA CI, test branch
  deployment, and live read-only verification remain release gates.

Verification before release (worktree above, local disposable DB only):

- Unit: admin handler 174 (two new subcategory-scope tests), shared taxonomy 11,
  local JSON adapter 9, public API 115, admin UI taxonomy/tabs/form 43. Full
  `pnpm test` exit 0 (site 497 + 1 skipped, admin 233, db 227, shared 157,
  local-server 152); the shared-Select usage guard now expects 4 in CollectionView.
- New browser journey `tests/e2e/admin-subcategory-visibility.spec.ts` runs in
  both local lanes before the taxonomy journey: 25 toys drafts, archived child,
  legacy Headphones row, filter 23 → page 2 of 3 rows, archived filter 1,
  reload/back/forward, tab reset, read-only edit summary, injected registry
  failure then Retry, 390px filter, and unchanged `updatedAt` for every
  inspected product (display never writes).
- Two lane fixes found on the way: the strict public.spec admin mock now
  answers the read-only registry request, and `loginAdmin` waits out one
  `RATE_LIMITED` (10 logins/source/60s) because the extra journey pushed the
  shared-address login count over the production limit.
- Default lane: 149 passed. Formal lane: 137 passed. Both removed their owned
  temporary DB/site directories.

Post-revision-guard verification (2026-09-25, release worktree 5a6317e plus
pending feature diff): `pnpm lint`, all 19 package/app typechecks and E2E
typecheck, `pnpm test`, `pnpm test:deploy-smoke`, `pnpm verify:cloudbase-sdk`,
and staged/unstaged `git diff --check` passed. Both disposable built-site
browser lanes passed, including two selected publications, partial rejection,
and an intervening edit remaining unpublished; the approval-enabled lane also
passed its formal journeys. The first default run had one `ECONNRESET` on a final
read-only product revision check after the UI assertions; a fresh isolated run
passed the entire lane without changes. Its cause remains unproven. These are
local results, not proof that the test environment has been deployed or accepted.

## Latest Delivery and Resume State

- Taxonomy application commit: 9305e3acf04bd0cf1bd43efaf360c7bf12bc0307;
  feature CI 35355586034 succeeded after the test-only session-reuse correction.
  PR https://github.com/vibelingan/channel/pull/58 remains main-based.
- Taxonomy release fd6c1b4c0fa0e7af4b49e2653085f0e732a26c34 was pushed normally
  to test, with parents 84a813f / 9305e3a. Independent integration review confirmed
  exact preservation of both parent trees, without importing price or AI branches.
  Release root/E2E/site-test TypeScript, Biome, SDK and craft checks passed.
  Craft: 12 baseline findings, zero new findings, zero execution errors, exit 0.
- Test CI 35359859809 and Deploy Test 35359860254 both succeeded for fd6c1b4.
  Deployment includes same-SHA function smoke, public/catalog browser acceptance,
  and the complete reusable CI with isolated admin/taxonomy and AI checks.
  Live public-api and admin health independently confirmed release fd6c1b4.
- Read-only live acceptance at https://www.supplychainsai.com passed all four
  families at exact widths 390 and 1440: menu names/child links agree with the
  public registry, real visible product images load, no horizontal overflow,
  unknown child URLs fail closed and explicit Clear filters recovers the list.
  Child selection survives reload. Public registry exposes only approved fields.
  Existing totals remain headphones 120, AI gadgets 5, toys 3, miscellaneous 0.
  Headphones wired/office/bluetooth totals are 8/7/14; collecting every filtered
  page at pageSize 12 matches each count with no duplicate products.
- Seven sampled existing public unit prices matched the predeploy values. The
  price repair branch remains unmerged; existing unavailable-price cards are
  not claimed fixed by this taxonomy release. No customer category assignments,
  source mappings, prices or taxonomy registries were changed during live acceptance.
  Four-family admin mutation journeys used disposable local data; the earlier
  real CloudBase transaction/query probe used cleaned synthetic collections.
- Live evidence: /tmp/channel-taxonomy-live-fd6c1b4/ (16 screenshots plus the
  desktop/API report), /tmp/channel-taxonomy-live-desktop.log, and temporary
  /tmp/channel-taxonomy-live-acceptance.mjs. The first run passed all four mobile
  views, then timed out after 60 seconds while the desktop headphones list was
  loading. Independent API reads returned 200 (products about 1.6 seconds);
  an instrumented desktop rerun passed all four views without application changes
  or relaxed assertions. The original timeout's cause is unproven; this was not
  a zero-flake combined manual run. Both browser contexts were closed.
- Last pre-merge refresh: main b0015c0, test fd6c1b4, price branch
  88a669090c3352a8dd924b4026450fdaffdb62cf unchanged, AI PR #57 still open.
  PR #58 is mergeable/clean with no reviews. Preserve other agents' contracts;
  recheck shared refs before merge. Final merge and post-merge CI evidence will
  be attached to PR #58; this checkpoint does not predeclare either successful.

Historical implementation and verification checkpoints follow.

- Pagination feature commit: ad0c587e9d384c368993d52e7cdafcdef849e691.
  PR https://github.com/vibelingan/channel/pull/56 merged normally into main as
  b0015c015c7410b9b1c383ee5a83bbc160b8d5b8. No test history merged into main.
- Pagination deployed test commit: 84a813f633075290ca48334908519aeb1bef84f8, parents
  75475b1bb1bf6f6b02f596909f57839a27d0f451 and ad0c587. Release worktree:
  .claude/worktrees/catalog-pagination-test-release (clean).
- Feature CI 35267490781, test CI 35297514053, and Deploy Test 35297514253
  all succeeded. Deploy includes same-SHA cloud smoke and public/catalog browser
  tests. A local gh watcher lost its network connection during upload; a later
  direct API read confirmed the workflow succeeded, not a second deployment.
- Live site https://www.supplychainsai.com/headphones/?page=2 verified with
  actual data: 12 replacement cards, no Load More, refresh, browser Back and detail
  return preserving page 2 and focus. Four families at exact 390/1440 widths had
  no overflow. Observed totals: headphones 120, AI gadgets 5, toys 3, misc 0.
  Real visible images loaded in headphones/AI/toys; misc showed its empty state.
- Visual evidence /tmp/channel-pagination-live-84a813f/ (eight PNGs), temporary
  read-only script /tmp/channel-pagination-live-acceptance.mjs. Early captures
  preceded image loading and were replaced after image-ready assertions. One
  desktop detail-return wait timed out; diagnostic rerun passed without source
  changes. Cause is unproven; do not label the entire manual run zero-flake.
- Main post-merge CI 35301157888 succeeded for exact b0015c0.
- At the initial taxonomy checkpoint, work was uncommitted on feat/catalog-multi-subcategories, based on
  b0015c0; dirty changes were preserved when switching from the merged PR branch.
  Parent worktree path remains catalog-navigation-subcategories.
- Implemented local slices: shared registry/assignment validators (10 tests),
  transaction read/save with immutable IDs/slugs, archive-only removal, strict
  16 KiB commands, admin authorization and expected revision (24 tests), plus
  legacy transaction regression (3 tests): 37 passed. Real admin API integration
  and persistent local restart/concurrent-edit test plus old scenarios: 3 passed.
  Root/local-server/admin typechecks and touched-file Biome passed.
- Subsequent implementation: transactional product assignments with product and
  registry version checks, explicit clear, archive retention, and registry fence;
  42 focused save regressions passed. Admin assignment API supports replace,
  append, clear and up to 20 products; five real local API scenarios pass,
  including partial conflicts and unknown outcomes stopping the remaining batch.
  Admin management and classification components are wired into CollectionView;
  migrated-product ordinary forms omit old classification fields.
- Public active-only taxonomy and strict ID filters pass 39 tests. Cloud predicate
  is serialized by both installed SDKs; six tests include 6,336 local parity
  comparisons. Frontend list and desktop/mobile header consume the taxonomy;
  frontend agent reports 61 focused tests and mocked browser checks passing.
  Local route delegates the public handler; migration script is offline/dry-run
  only. No customer backfill has occurred.
- Cloud CLI 3.5.7 device login authorized; optional telemetry declined. MCP still
  reports unauthenticated, so the probe uses CLI session credentials in memory,
  never printed or persisted by the script. Target confirmed NoSQL, Shanghai.
- Real SDK probe scripts/probe-catalog-taxonomy.mjs passed on the actual env:
  headphones 26 results (25 assignments plus one absent-field legacy row), each
  other family 25; three 12-item pages per family, malformed/empty/scalar/private
  rows rejected. Concurrent same-revision transactions yielded saved/conflict.
  All 131 synthetic records cleaned; remaining count 0. Empty ADMINONLY collection
  taxonomyProbedca5a9b3f8af48b2 retained. Earlier attempt hit ETIMEDOUT; its one
  unconfirmed deletion was explicitly cleaned and count 0 confirmed in
  taxonomyProbebc5c2605defb444e. No customer collection was written.
- Alibaba multi-child mapping, checkbox configuration and suggestion draft/apply
  now exist. Mapping writes revalidate inside transactions. Accepted suggestions
  carry their evidence into the existing product transaction; source/link/mapping
  dependencies, actor authorization and taxonomy are fenced. Seventy-four focused
  integration tests passed after wiring evidence and actor IDs. Product-save
  timestamps advance monotonically to reject same-clock stale requests.
- Independent review found four backend and four frontend issues. Fixes include
  transactional mapping validation and permission rechecks; full checkbox selection
  means the unfiltered main list; explicit recovery from archived/unknown URL IDs;
  generation-guarded registry reload; BFCache header taxonomy reload. Twelve new
  frontend regressions passed. Updated service tests pass 20 integration cases.
- Full site unit suite passed 476 with one existing opt-in skip before the last
  review fixes. Shared full suite passed 156; DB later passed 181. A helper used
  the wrong public package filter (matched zero packages): that is NOT a pass;
  rerun @vibelingan-channel/fn-public-api explicitly. Local-server full-suite result
  must also be re-established after the transaction/caller changes.
- Closed browser defects: CollectionView mounts the registry manager on first
  disclosure open; initial catalog requests await initial taxonomy completion;
  invalid selected IDs show errors without broadening queries; desktop header
  tests distinguish five primary destinations from child links. Focused category
  spec passed 23/23 with zero retries after the fixes.
- A real-backend E2E caught a client/server mismatch hidden by an incorrect mock:
  reads return replayed, initial saves configured, subsequent saves applied.
  Client decoder and mock now match; two observed failures became 17 passing
  client tests. Save replies also require expected revision + 1.
- Registry status output no longer simultaneously announces saving and saved.
  Unclassified-product assertions preserve absent legacy category. The new E2E
  chooses a publicly readable seed image rather than an arbitrary prior test's
  invalid image ID, retaining image-load assertions. Actual production-build
  admin plus four-family taxonomy journey passed 6/6, zero retries, in 48.1s:
  /tmp/channel-taxonomy-journey-ready.log; 16 screenshots under the corresponding
  /tmp/channel-taxonomy-journey-ready/test-results/catalog-taxonomy-* directory.
- Probe bootstrap errors are sanitized without raw child stdout/JSON/cause;
  transaction probe waits for both operations to settle before cleanup. Twelve
  helper tests plus 18 resource tests pass. Resource assertions now cover 28
  ADMINONLY collections and the added product-family public index.
- Probe invocation (Node 22+): TCB_ENV_ID=<target> node --experimental-strip-types
  scripts/probe-catalog-taxonomy.mjs --allow-isolated-writes. CLI credentials stay
  in memory. No new live probe was needed for helper-only hardening.
- SDK contract follows the production adapter's delegate into the actual save
  transaction callback, rather than requiring the old inline method body.
  Contract check passed with SDK_EXIT=0. A temporary duplicate variable in the
  script was fixed and verified before resuming full validation.
- Final serial validation completed in terminal
  4ea230a6-4d32-43ac-bbea-625e2ef7def7: pnpm test and standard production runner
  passed; formal runner exposed the approval-path test mismatch below. Logs
  /tmp/channel-taxonomy-final-all-unit.log,
  /tmp/channel-taxonomy-final-standard.log, /tmp/channel-taxonomy-final-formal.log.
  Script suite passed 424; local-server full suite passed 149. The overall command
  exited 1, not a full green claim. Subsequent focused formal verification is below.
- The standard runner has now finished successfully: public 41, catalog 87,
  font 1, seed 1, admin lifecycle 5, editor 11, taxonomy journey 1; every lane
  passed without retries in this run, and the disposable directory was removed.
  Formal runner had one failed scenario and five passes; no test data was retained.
- Formal approval regression now uses the existing Edit Product path for its
  unmigrated already-published fixture. The dedicated classifier intentionally
  requires withdrawing before a parent move; retain concurrent withdrawal and
  terminal publication assertions in the ordinary-edit approval test, and retain
  new draft classification followed by explicit Publish in taxonomy E2E.
- A narrow form regression reproduced and fixed: changing only the main category of an already-published
  product must omit an unchanged published=true field. Explicit withdrawal,
  draft publication, same-family saves and migrated detail edits stay unchanged.
  The new test failed before the fix; all 14 form tests passed afterward. Legacy
  category clearing also needed accepting the established empty-string sentinel
  at the product write-schema boundary; a focused red test became 15 passing
  product-contract tests. No other enum field was relaxed.
- Formal fixture restoration now refreshes its browser list after an API-only
  republish, avoiding editing an obsolete unpublished row. Its concurrent
  withdrawal and persisted approval assertions remain. Final production-build
  formal plus taxonomy journey: 7 passed, zero retries, FORMAL_FINAL_EXIT=0,
  /tmp/channel-taxonomy-formal-final.log. Earlier font-screenshot timeout is
  recorded, not misreported as functional success.
- Final release checks after these last two runtime changes: shared 156/156,
  site 490 passed / 1 existing opt-in skip / 0 failures. Root, E2E and site-test
  TypeScript passed; Biome checked 749 files; diff check passed. Craft gate:
  12 baseline findings, zero new findings, zero execution errors; baseline unchanged.
  A helper incorrectly invoked root pnpm typecheck and prompted
  to install pnpm 12.4.2; installation was declined, no dependencies replaced.
  Root check was then run successfully with node node_modules/typescript/bin/tsc --noEmit.
- Concurrent price ownership verified against Git objects at
  origin/feat/catalog-price-repair-handoff 88a669090c3352a8dd924b4026450fdaffdb62cf.
  Three overlapping tracked files: admin handler, DB adapter exports and DB index
  exports. Pricing keeps ownership of its partial-price-save approval change,
  currency normalization and repair evidence. This feature does not import or
  rewrite the unmerged price implementation. Future integration must combine
  both export sets and preserve price's requiresApproval=config.enableDetailApproval
  condition, not restore the old published-only condition. Taxonomy's save-helper
  extraction still forwards the full input to planCatalogProductSave.
  Classification changes intentionally stale any previous price-repair dry-run;
  replan those records rather than weakening evidence checks. No price worktree,
  refactor worktree, dirty root checkout, or remote price branch was modified.
  Recheck remote main/test/price immediately before publishing: this is a snapshot,
  not a lock against another agent completing work.
- Feature commit 792db3400a1250f4e8bc3dd826f254a02d2b88ff pushed normally;
  PR https://github.com/vibelingan/channel/pull/58 is main-based and mergeable.
  First CI 35353107705 passed AI and prior browser lanes, but the new taxonomy
  journey redundantly logged in via API then UI and hit the shared login limit
  on fast CI. Artifact confirms 'Too many requests. Please retry in 33s.'
  The test now reuses its actual API-issued session for the same local origin;
  no authentication/limiter implementation changed. Focused production taxonomy
  journey passed with zero retries, SINGLE_SESSION_EXIT=0, 52.6s, owned DB cleaned.
- That pre-release checkpoint still required green same-SHA CI, test deployment
  and main-based PR delivery. The release and live-acceptance results above supersede
  that status; earlier test counts are not substitutes for the exact release evidence.

Earlier checkpoints below are historical evidence, not the current release state.

## User-Approved Requirements

- Deliver completed parts separately; do not wait for all work before deployment.
- First release: replace Load More with numbered pages, 12 products per page,
  for all website product families. Keep card styling. Search/filter changes reset
  to page 1; refresh/history/detail return preserve page and filters. Stale requests
  must not overwrite a newer page, and failed requests must remain retryable.
- Second release: all main categories support the same two-level relationship;
  each product retains one parent and may have multiple children of that parent.
  Families without children remain usable. Admin centrally manages children;
  individual and batch editing, source suggestions, persistence, public APIs,
  cloud functions, UI state/components, filters and navigation must agree.
- Alibaba is a source/mapping input only; confirmed manual classification wins.
  Classification saves do not publish. Preserve prices, media, approvals, and
  historical products. Future single-child restriction requires data resolution.
- Price repair belongs to another agent. Latest observed branch:
  feat/catalog-price-repair-handoff at 88a669090c3352a8dd924b4026450fdaffdb62cf.
  Do not modify or force-push it, or overwrite its changes when integrating.
- Preserve all refactor worktrees. Cleanup was an audit only; no deletion approved.

## Recovery Observations

- This worktree existed at ba3cd629 with no modified files and no feature commits.
  Previous promises to implement do not constitute implementation evidence.
- Current CatalogFamilyPage requests pageSize 12; headphonesCatalogState appends
  pages. SharedCatalogPreview keeps the list mounted while showing a detail.
- PR #55's earlier detail-layout/media work is complete; do not reopen that task.
- Root research checkout and all other worktrees are untouched by this feature.

## Technical Work Units

1. Page state/query contract and regression tests: replacement pages, committed
   vs pending state, URL normalization, generation identity, invalid/out-of-range
   pages. Done when focused tests fail before and pass after the implementation.
2. List controller/grid integration: numbered controls, filter/search/history,
   detail-return and focus, zero/error/retry states. Existing price components
   remain unchanged. Done when types and focused browser tests pass.
3. Production-build browser acceptance: 0/1/12/13/25 products, multiple families,
   last page, empty filter, rapid A-B-A navigation, failure, reload, Back/Forward,
   details and mobile overflow. Verify current source, not --list output.
4. Pagination delivery: review, push feature, verify same-SHA CI; integrate latest
   test without overwriting price/AI work; deploy and verify live. Then main PR.
5. Taxonomy contract/storage/read compatibility and SDK proof; safe revisioned
   administrative operations and legacy migration dry-run.
6. Admin multi-child editing/batch operations and Alibaba mapping/manual ownership.
7. Public child filters/navigation using one classification source and paged APIs.
8. Taxonomy tests, migration verification, independent review and separate release.

Units 5-7 are implemented and validated. Unit 8 has passing feature/release CI,
successful test deployment and live acceptance; main PR finalization remains pending.
Each unit uses small testable slices and immediate focused checks. No destructive
data migration or broad customer-data modification is hidden in a UI release.

## Current Checkpoint

- Verified on 2026-09-18: the three focused pagination/history/detail bugs below.
  HEAD remains ba3cd6296cddf3eb0fd67866b0819cd7b0db33bd; changes are uncommitted.
- Local production-build catalog acceptance passed: 87 tests, including all 23
  tests in catalog-category.spec.ts. This is not whole-feature release approval.
- Full site run subsequently found one historical source-contract assertion that
  still required the append-state module. It now verifies the numbered-state
  import and actual begin/receive calls while retaining all presentation/content
  separation guards; the original old-state tests are unchanged. The focused
  source-contract plus numbered-state run passed 31/31.
- Final serial verification completed with PAGINATION_FINAL_EXIT=0: site suite
  452 total / 451 passed / 0 failed / 1 explicit browser-opt-in skip; standard
  non-formal and formal production runners both succeeded, including public
  41, admin lifecycle 5, editor 11, and formal journeys 6. Logs are
  /tmp/channel-numbered-final-unit.log, /tmp/channel-numbered-final-admin.log,
  /tmp/channel-numbered-final-formal.log.
- The formal catalog run had 86 passed and 1 flaky screenshot: the 390px image
  waited for external fonts; retry passed. The three mock geometry cases now
  explicitly use fallback fonts. The final full catalog rerun passed 87/87 with
  retries disabled, FINAL_CATALOG_EXIT=0, in 5.6 minutes. This is not evidence
  that real deployed fonts or product images load; live acceptance remains due.
- Two temporary-runner attempts stopped before browser tests because the
  required E2E_CATALOG_RESULT_DIR was omitted. After inspecting its contract,
  reran with that output directory configured; all owned resources were cleaned.
- Pending: parent release/review work, all deployment steps, all subcategories.
- No commit, push, merge, deployment, dependency install, or cloud/customer-data
  write occurred in this fix pass. Pricing code and other agents' work were not
  modified. All E2E writes used the runner-owned disposable local database.

### Focused Fixes and File Boundary

Only these four repository files were edited in this pass; the larger worktree
diff includes pre-existing parent changes and must not be attributed to this pass:

- apps/site/src/islands/shop/CatalogFamilyPage.tsx: a matching pending request is
  reusable for history only when no page is committed, or the committed query
  already matches the history target. Otherwise abort and start a replace request,
  retaining the parent's clearing of committed query, products, and total.
- apps/site/src/islands/shop/SharedCatalogPreview.tsx: pass current search as an
  optional second renderList argument. CatalogFamilyList observes it separately
  from listener setup/cleanup, so a fresh detail close rereads the URL without a
  fabricated global popstate event or aborting a duplicate valid history request.
- tests/e2e/catalog-category.spec.ts: retain the original history failure test but
  require zero cards, page-2 URL, error, and successful retry. Add controlled
  overlapping-click/history failure and fresh page-99 detail-close regressions.
- docs/catalog-navigation-subcategories/EXECUTION.md: this evidence checkpoint.

Callback trace: SharedCatalogPreview -> renderList(open, search) ->
CatalogFamilyPage -> CatalogFamilyList.locationSearch -> readLocation. The other
consumer, HeadphonesPage, remains compatible with its one-argument callback.
Existing id/variant parsing is unchanged. Four families' page-2 detail returns
still restore focus and cards without refetching. The overlap test counts four
page-2 requests: initial success, pending click, replacement history, and retry;
duplicate location notifications do not add requests.

### Executed Verification

Runtime: /Users/SeanCai/.nvm/versions/node/v24.14.1/bin/node. All executions used
the absolute catalog-navigation-subcategories worktree, never the root checkout.
Temporary runner: /tmp/channel-catalog-navigation-focused-20260918.mjs, derived
from scripts/run-catalog-admin-local-e2e.mjs with its API identity checks,
production build, matching SITE_URL/E2E_SITE_URL, and cleanup retained. The
repository runner and its release gates were not edited.

| Check | Actual result |
| --- | --- |
| Red: category spec, grep `history\|deep link\|page-two detail`, retries 0, workers 1 | 5 passed, 2 failed; exit 1 |
| Green: identical focused invocation after runtime fix | 7 passed; exit 0 |
| Full catalog lane via temporary runner `--full-catalog`, retries 0, workers 1 | 87 passed in 6.5m; exit 0 |
| Catalog unit combination: numbered state, family render, headphones state, API, shared navigation | 69 passed, 0 failed/skipped; exit 0 |
| Additional combination using headphones render instead of headphones state | 64 passed, 0 failed/skipped |
| Root / E2E / site-test TypeScript `--noEmit -p` checks | All exit 0 |
| Biome `check .` | 714 files; no changes; exit 0 |
| `git diff --check` | Exit 0 |

Full catalog lane: header-navigation, catalog-hub, catalog-family-routes,
catalog-category, and sku-detail specs. Final standard runs also executed
public.spec.ts (41 passed).
ESLint is not configured; Biome is the repository lint/format gate.

The table records the earlier focused pass; the checkpoint above adds final
standard-runner and deterministic mock-screenshot verification. The opt-in
shared-catalog-navigation development preview spec was updated but not executed
in these ordinary production runners. No claim of coverage is made for it.

Final catalog command (run from the exact worktree):

```sh
CI=true E2E_RECORD_ARTIFACTS=1 \
E2E_CATALOG_RESULT_DIR=/tmp/channel-numbered-final-browser \
node /tmp/channel-catalog-navigation-focused-20260918.mjs --full-catalog
```

The runner specifies --retries=0 and --workers=1. Terminal
ac9c57bf-5537-4dad-b98e-5a3196c7df96 reported 87 passed and FINAL_CATALOG_EXIT=0.
The complete output is /tmp/channel-numbered-screenshot-final.log.

## Completed Unit Outcomes

- Unit 1: added numbered-catalog-state.ts and its typed regression tests.
  Replacement pages and separate requested/committed queries prevent stale
  responses or failures from changing the wrong page. Tests cover malformed
  URLs, explicit-empty filters, A-B-A ordering, cancellation, response validation,
  bounded out-of-range recovery and totals 0/1/12/13/25. Focused tests passed.
- Unit 2: wired CatalogFamilyPage, CatalogFamilyGrid, CatalogPagination and the
  SharedCatalogPreview location notification. All four live families use numbered
  controls and preserve detail-return state. Card/price markup is unchanged.
  Family render and source-contract tests were updated; old append-state tests
  remain. Root, E2E and site-test typechecks and Biome passed.
- Unit 3: updated catalog-category/public/shared-catalog-navigation browser
  assertions. Actual production-build runs cover 12/12/1 page replacement for
  25 products, filters, history/reload/detail return, stale/failure/retry cases,
  and 320/390/1440 geometry. The history defects were reproduced before fixes
  (5 passed, 2 failed), then passed the same narrow check (7 passed). Final
  ordinary catalog lane: 87 passed with zero retries. Unit 3 is locally complete;
  real remote assets and deployment behavior belong to unit 4.

## Deviations

- Total-count boundaries 12 and 13 are checked in state tests, not separate
  browser database fixtures. Browser fixtures verify 25 products as 12/12/1;
  the two kinds of evidence are intentionally not described as interchangeable.
- Mock screenshot tests isolate fallback-font geometry after an external-font
  timeout. Real-font and real-image acceptance remains required on the deployed
  site; suppressing real fonts across the entire suite was rejected.
- The existing opt-in development-preview navigation suite is updated but not
  run by the ordinary production runner. Actual live family routes are covered
  by the catalog lane; a passing preview-only suite is not claimed.

## Release Review

- Final independent test/presentation review inspected all 12 changed/new files
  against ba3cd629 and six screenshots; no actionable defects. Assumption-checker
  also passed against the approved requirements. Parent directly reviewed the
  numbered state and list controller after two runtime-review agent connection
  failures. No review was claimed from either failed agent invocation.
- Root/E2E/site-test TypeScript and Biome were rerun after the final test edit:
  all exit 0. Craft gate exit 0: 12 existing baseline findings, zero new findings,
  zero execution errors; no baseline was modified.
- Remaining coverage risks: cancellation invalidation is not isolated from the
  pending guard in a mutation test; pagination-specific browser tests use
  Chromium, while the catalog lane also exercises existing WebKit mobile flows.
- Exact-HEAD blessing, feature push/PR, test integration/deploy, live acceptance
  and main merge are still pending. No release is claimed yet.

Logs (local artifacts retained outside the repository):

```text
/tmp/channel-catalog-navigation-red-20260918.log
/tmp/channel-catalog-navigation-green-20260918.log
/tmp/channel-catalog-navigation-full-20260918.log
/tmp/channel-catalog-navigation-unit69-20260918.log
/tmp/channel-catalog-navigation-unit-20260918.log
/tmp/channel-catalog-navigation-root-tsc-20260918.log
/tmp/channel-catalog-navigation-e2e-tsc-20260918.log
/tmp/channel-catalog-navigation-site-test-tsc-20260918.log
/tmp/channel-catalog-navigation-biome-20260918.log
```

Red failure evidence: overlapping history expected URL page 2 but received 3;
fresh detail close expected page 3 but received 99. The original history test
and all four ordinary page-2 detail-return checks already passed in red.

```text
/tmp/channel-catalog-navigation-red-20260918/test-results/catalog-category-history-B-49c8e-ick-when-both-requests-fail-chromium/trace.zip
/tmp/channel-catalog-navigation-red-20260918/test-results/catalog-category-fresh-det-fd54b-recovered-last-catalog-page-chromium/trace.zip
```

All three browser runs confirmed removal of their owned temporary API, build,
media, and DB directories. Full-run terminal 6342dc71-21f6-4b8f-bddc-0870c716090b
finished with FULL_CATALOG_EXIT=0; it is not an active command to await.

## Restart Procedure

Read this file, then git status/log in THIS worktree. Re-read touched files before
editing. Check exact running command IDs/log terminal results; empty or cached
output is not test success. Do not launch overlapping terminal test processes.
Update this record at verified boundaries with actual test counts, commit IDs,
PR/run IDs and deployed SHA. Never mark the whole task complete if a later unit
remains. New queued questions do not silently replace unfinished delivery.
