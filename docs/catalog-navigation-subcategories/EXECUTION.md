# Catalog Navigation and Subcategories Execution

Updated: 2026-09-18. This document is the restart checkpoint after VS Code crash.
Branch: feat/catalog-navigation-subcategories
Starting main: ba3cd6296cddf3eb0fd67866b0819cd7b0db33bd
Status: Pagination implemented and locally verified; delivery in progress.
Current phase: deliver (pagination only)
Current/next MIU: 4 (pagination release), then 5 (taxonomy contracts/storage).

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

Units 5-8 remain pending; they are not completed by shipping pagination.
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
