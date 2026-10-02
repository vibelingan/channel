# Findings ledger

Status: **COMPLETE: Phase 6 and live acceptance for the authorized UI/sequential
scope.** See [Final findings](#final-findings---2026-10-02) and the
[final live ledger](LIVE-ACCEPTANCE-20261002.md#final-closure---2026-10-02).
Earlier source observations, hypotheses and pending gates are dated history.

## Historical observations from main source

- `CollectionView` opens per-row Classify with `publishOnSave: false` and bulk Assign category with `publishOnSave: true`. Single-row Classify therefore never offers the publish checkbox; bulk defaults it on but allows opting out.
- `ProductClassificationEditor` performs assignment first. Only fully confirmed saved results with revisions can trigger `publishConfirmedClassification`, which makes a separate `batchUpdateRecords(..., { published: true }, revisions)` call. The editor waits for publication and query invalidations before clearing `pending`.
- Unit tests check SSR labels and mocked publication results. The disposable local E2E browser suite also proves bulk assignment then publication of two products, partial rejection and concurrent conflict; it does not verify this customer's record or long-lived progress. A temporary delayed-publication browser test failed exactly because the modal has no distinct "publishing" state; it was removed pending design approval.
- Production shared Admin tab is authenticated. At a 734px viewport the nav has 1104px of content in a 715px scroll region, the table is 1994px wide inside its own ~683px scroller, and `html.scrollWidth` reports 1799px while `body.scrollWidth` is 715px. Offscreen buttons/table cells have internal overflow-clipping ancestors; do not attribute the right-side blank area to one escaping container without a discriminating before/after viewport check.
- Bulk toolbar offers Publish, Disable, Assign category, Delete, Clear selection together. Single-row Classify is draft-only; bulk Assign category defaults to publish but can opt out. Already-published same-family classification edits can change public filtering immediately; moving a published main family is guarded. Supplier-linked publication can require Edit approval. The bulk Assign category command is visible even where the server forbids non-admin assignment.

## Historical falsifiable local hypothesis

The per-row action is draft-only by design but not usable for an operator who expects "assign and publish". The combined pending state hides the two-write and refetch stages, leaving controls disabled longer than the actual assignment. G1-approved intent: separate "Save classification" and "Save and publish" commands in the same dialog (not a default-on checkbox for single or bulk). The stage feedback, mixed-selection guard, copy and layout remain proposed at G2; no implementation is approved.

## Unknown at initial investigation (historical)

- Which production request dominates the wait and whether the customer's observed publication was rejected, unconfirmed, or never requested. Inspect only authenticated UI and read-only requests; do not infer from tests. Final mobile/tablet layout and mixed-selection copy await G2 approval and viewport verification; G1 approved only the explicit two-action outcome.

## True-batch SDK investigation (2026-09-29, client contract verified; remote proof blocked)

- Tested hypothesis: `@cloudbase/node-sdk@3.17.2` exposes `transaction.collection(name).where(filter).update(patch)` at the type level, but its actual multi-update request omits `transactionId`. The no-network runtime capture below confirmed this; remote rollback and size limits are still unknown.
- Separate proof obligations: write-time revision and approval guard for every selected product; consistent image `publishedRefCount` updates in the same commit; all-or-nothing acknowledgement; recoverable result after a committed request loses its HTTP response. Do not write production records during these checks.
- Confirmed local transport gap: the installed `@cloudbase/database@1.4.3` `Query.update()` sends `database.modifyDocument` with `multi: true`, **without** `transactionId`, even when reached from `transaction.collection(...).where(...)`. A fake request capture observed `startTransaction`, a non-transactional `modifyDocument`, then `commitTransaction`. The compiled code agrees; its separate `updateAndReturn` branch does pass the ID. `@cloudbase/node-sdk@3.18.6` still pins database 1.4.3, so a 3.x upgrade does not fix this path. No remote atomicity claim follows from the fake transport probe.
- New-major comparison: npm `@cloudbase/node-sdk@4.1.0` no longer depends on `@cloudbase/database`; its entry re-exports `@cloudbase/js-sdk`. The latter's embedded database module is 1.5.1 and exposes a corrected transactional update and a `runCommands` path. Official CloudBase NoSQL OpenAPI describes `runCommands` with a `transactionId` field; suitability for guarded product + image publication remains unverified remotely.
- Inspected npm `@cloudbase/js-sdk@3.9.2` and today's resolved `3.10.1` source maps: both embed database 1.5.1. Its `Query._update()` adds `transactionId` before sending `database.modifyDocument`; transaction collections preserve the ID. The gateway `database.runCommands` posts EJSON commands and an optional transaction ID to `/commands`. An isolated `/tmp` install of Node SDK 4.1.0 + JS SDK 3.10.1 passed fake-transport probes for start -> multi-update with matching transaction ID -> commit, and for simulated failure -> abort. Node SDK 4.1.0 declares the top-level `database()` return as `any`; a production migration needs a verified narrow type/contract and full storage/DB regression tests, not a drop-in version bump.
- Official CloudBase NoSQL OpenAPI (local MCP copy `~/.cloudbase-mcp/openapi/nosql.openapi.yaml`) defines start/commit/rollback and `POST /commands` with `transactionId`, returning a two-dimensional command result array; it does not specify per-product match semantics, batch-size/time quotas, or lost-response recovery. Do not transfer guarantees from unrelated PostgreSQL documentation. Current product publication also checks `expectedUpdatedAt`, `alibabaReviewPending`, supplier source identity, `validateProductPublication`, and detail approval fingerprint/receipt; image `publishedRefCount` runs after product commit and swallows counter errors. A naive bulk flag update violates these checks.
- Remote proof blocked by environment safety, not SDK absence: after the user's device authorization, `queryEnv` confirmed `diversity-123-d9grnqfux221323bb` is a working NoSQL environment, but `queryGateway(listCustomDomains)` found both `www.supplychainsai.com` and `supplychainsai.com` plus the `/api/admin` function route **in that same environment**. Deployment docs call it `test`; the gateway proves it also serves production traffic. `queryHosting(domainStatus)` returned "account has no such domain" because it checks static hosting domains, not HTTP gateway domains; do not use that result as proof of isolation. No remote transaction, rollback, count, concurrency or lost-response test was run; no cloud collection was read or written. Obtain a physically separate NoSQL environment before any write probe.

## UI-only acceptance (2026-09-30; supersedes earlier pending UI approvals above)

- The user approved completing all remaining UI phases. The editor's settled outcomes flow to the list warning, which retains confirmed publication receipts and selected IDs; Check later and list recovery only read product statuses and do not retry writes automatically. A mismatched get-by-ID response fails verification.
- The former narrow horizontal nav is replaced by a role-filtered Section picker below 1280px; the original sidebar remains at desktop widths. Existing mobile/tablet form and classification specs were adjusted to navigate through the picker and passed in the full local E2E runner.
- The real Admin page showed no root overflow at 1440 or 720 CSS px, while wide table columns remained locally scrollable. Browser tooling scaled requested sizes by 1.25, so actual innerWidth was asserted. A 720px reflow was used as a 200%-zoom-width proxy; native browser zoom was not independently exercised.
- Full local acceptance: 157 passing Playwright browser cases on a disposable production-build site and JSON database, 502 passing site unit tests (one existing skip), workspace/E2E typechecks and repository-wide Biome. This verifies existing sequential publication, not atomic backend batching or a deployed CloudBase environment.

## Historical initial live acceptance and repair findings - 2026-10-02

Facts at this checkpoint were reported by the acceptance caller and superseded
earlier hypotheses where noted. Current deployment/acceptance status is in
[Final findings](#final-findings---2026-10-02); local-only wording below is history.

- Deploy `24936f0` / run `36849272212` was verified before actual-admin live
	testing. A/C image-free draft creation, A assignment-only save, no-write
	cancellation/focus and Clear restoration passed. Bulk Replace Office, Append
	Bluetooth retaining Office and Clear None kept both drafts and public-prefix
	results at zero. Clear selection made no write.
- B withdrawal cleared legacy `category:bluetooth` on an unrelated publication
	update. The normalization path was broader than the requested change; earlier
	UI-focused green tests did not expose this legacy-record case. Red-first DB
	coverage now proves clearing only for an explicit recognized non-headphone
	family (51 DB tests and tsc green). This repair is local, not deployed.
- B Wired Save and publish showed one published with per-ID verified Done and
	public $5.50/MOQ 500. UI restored Headphones / Bluetooth Headphones / Published
	before any bulk draft test. Actual unit/wholesale/VIP prices are 6.2/5.5/4.3.
	Original keys excluding category/updatedAt compare `differences:[]`, not full
	identity: explicit family `headphones`, subcategories `[headphones-bluetooth]`
	now replace the legacy category, and save plan added createdAt
	`2026-10-02T03:25:31.832Z`; updatedAt is `2026-10-02T03:26:10.694Z`.
	Temporary visibility and timestamps cannot be undone. Nine ordered images
	and the full baseline are retained in the live ledger.
- Product deletion is deliberately forbidden server-side: live Remove A returned
	HTTP 400 `Products must be archived instead of deleted`. No retry/bypass.
	Edit UI successfully archived A+C, unpublished with empty subcategories;
	retained records are NOT deleted and original absence is unrestorable. The
	prior UI deletion plan assumed confirmation implied deletion support; the
	live policy rejection disproved it. Local row/bulk actions now use Archive
	with exact `{archived:true,published:false}`. API rejects other combinations,
	deduplicates <=20, proceeds sequentially and stops on unknown; single/bulk
	readback, API 16 and owned Admin 8 tests pass.
- Ordinary selection resets on scope change intentionally. Unresolved-review
	selection and receipts persist in local tests; ordinary live selection loss
	is not that recovery defect. Synthetic native cancel closes/returns focus;
	transported VS Code keyboard Escape did not, so it is not a real-key live
	pass. Local real Chromium Escape passes.
- Actual live widths 375/390/734/1024/1440 had no root overflow. At 390px modal
	left/right were 16/374 and scrollWidth/clientWidth 357/357, with no screenshot
	overlaps. Exact 768px was proven locally, not live due editor zoom. No
	pageerror; known failed Remove produced console 400, not a clean console.

## Historical pre-integration verification and unresolved gates

- Before integrating advanced remote `test`: 2,755 unit passes/3 skips, default
	158/formal 144 browser passes with cleanup, 19 workspace/E2E types and
	site/test types green. Pinned no-install equivalents passed after the root
	typecheck/function-build wrappers offered unpinned pnpm through npx and that
	install was declined. Biome 760 green after terminal-newline formatting of
	three local ignored review JSON files; three function builds/artifact smoke
	passed. These are local-tree results, not post-integration or live repair proof.
- Independent assumption-checker: no new P1/P2; archive graph PASS. New browser
	case uses drafts only; existing server tests cover published withdrawal.
- Backend legacy fix and UI policy repair are authorized deviations under the
	user's test-fix-all request. No SDK/schema/atomic-batch changes were made.
- Remote `test` is now `2f8567f` from PR #64 price tiers. Integration, commit,
	exact-SHA review, CI, merge, deploy and post-fix live acceptance remain pending.
	Public-images screenshot was blank in a hidden shared tab; cause is under
	investigation and independent public-only verification is pending. This is
	neither confirmed broken media nor a completed image acceptance check.

## Historical findings - 2026-10-02, through 05:08:47

These caller-verified facts supersede resolved pending entries above, while
preserving their chronology. **Status then: IN PROGRESS; current COMPLETE
status and closure limits are in Final findings below.**

- Tested and merged trees agree, but the running system is still observed on
	old PR #64 `2f8567f`. Only the new repair commit was rebased onto base
	`2f8567f302accb8790898e6f274436bd5a71439a`, producing reviewed HEAD
	`be8d463da51ab462728bf9c914c69b4a9298be3a`. PR #65
	(https://github.com/vibelingan/channel/pull/65) squash-merged at
	`2026-10-02T04:59:15Z` as `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`;
	empty reviewed-HEAD-to-origin/test diff proves tree equality and PR #64
	preservation, not successful deployment.
- Exclusive integrated checks passed 19 workspace typechecks, E2E and site/test
	types, Biome 760 (761 with later ignored review metadata), 2,760 units with
	3 existing skips, full default 158/formal 144 owned browsers with disposable
	DB removal, and all three function builds/packaging/artifact smokes. Six
	exact-SHA reviewers: 0 P1 / 0 P2; blessing and normal push hooks passed.
	Craft gate: 12 baseline findings, 0 new / 0 execution errors; not fixed debt.
	P3 suggestions remain published/multi-select Archive browser fixtures, DB
	changed legacy name/status/published-name-only assertions, and an incomplete
	archive-pair response test; draft browser coverage is not published coverage.
- `gh pr merge --auto` merged immediately: branch protection did not require
	all PR CI checks. Local gates and review did not guarantee remote CI had
	finished, so no premerge remote CI pass is claimed. PR CI `36966277671`,
	merge-SHA test CI `36966932042` and Deploy Test `36966932172` were still
	running at their last observations. Deploy Test requires its complete reusable
	merge-SHA CI success before deployment; no production publication ahead of it.
- Independent all-three-service probes at 05:05:25 and 05:08:47 returned
	`2f8567f`, HTTP 200 / status ok. The constant target SHA returned by
	`waitForFunction` was contradicted and is not runtime proof; no acceptance
	started on it. Repairs are not yet verified deployed.
- The image concern is resolved as transient loading, not a reproduced product
	bug. Authenticated read-only SY-T8 Edit at 05:03 confirmed saved Headphones /
	Bluetooth / Published, $5.50 public-price preview / MOQ 500, and nine complete
	images at naturalWidth 790 or 800; cancelled unsaved. Independent public-only
	Chromium verified catalog and all nine original ordered gallery images,
	$5.50 / MOQ 500, no pageerror, and legacy approved sections 404 followed by
	working fallback. Screenshot `output/playwright/live-syt8-public-20261002.png`.
	Original browser baseline survives upcoming reload via `addInitScript`, with
	no credentials included.
- A's 05:07 Admin readback confirmed `ccbff7a5-0dcf-463b-b948-c2f592ed95d8`,
	archived true, published false, subcategoryIds empty and updatedAt
	`2026-10-02T03:29:21.046Z`. C's prior `2026-10-02T03:29:22.298Z` readback
	also showed archived true / published false. These records are retained, not
	deleted; absence is not restored. B's unchanged original business keys exclude
	category/audit. Its explicit headphones/[headphones-bluetooth]/empty-category
	representation, added createdAt `2026-10-02T03:25:31.832Z` and updatedAt
	`2026-10-02T03:26:10.694Z` are not byte-for-byte restoration.
- Remaining: finish CI/deploy and independent three-service merge-SHA proof,
	then UI-only Archive cancel, row A and A/C bulk Archive with receipts/readbacks;
	final B baseline comparison/public fixture exclusion and final plan completion.

## Final findings - 2026-10-02

**Authorized UI/sequential Phase 6 and live acceptance COMPLETE.** These are
caller-verified findings; this docs-only pass did not rerun runtime checks.

- The repaired running system is now independently proven, not inferred from
	merge or a constant wait result: PR #65 merge
	`de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3` is tree-identical to reviewed
	`be8d463da51ab462728bf9c914c69b4a9298be3a`. At browser `05:45:13` all three
	services strictly returned HTTP 200, ok true, status ok, that releaseId.
	Public API/Admin/Alibaba build times were `2026-10-02T05:19:53.821Z` /
	`2026-10-02T05:19:53.787Z` / `2026-10-02T05:19:53.706Z`.
- PR CI `36966277671` SUCCESS finished `05:11:57`, separate test CI
	`36966932042` SUCCESS and Deploy Test `36966932172` completed SUCCESS:
	both full reusable CI jobs and Build/deploy/smoke SUCCESS, deployed smoke and
	public browser E2E passed. Complete merge-SHA CI gated publication. Optional
	catalog-acceptance skipped by push design; media/OEM upload smokes not requested.
	Auto-merge at `04:59:15Z` still preceded branch CI; no bypass flag or premerge
	CI pass. Later success does not erase that process exception.
- Actual authenticated Admin no longer offers Delete. Reload preserved B's
	original baseline; already archived A/C Archive controls were disabled.
	Draft-unarchived A (Published false asserted before Edit Save) had HTTP 200,
	updatedAt `2026-10-02T05:48:18.940Z`. Native row confirm cancellation made
	zero product mutation requests and fresh list readback was unchanged. Row
	Archive used exact `{archived:true,published:false}`, HTTP 200 matching A,
	updatedAt `2026-10-02T05:49:28.355Z`, then disabled Archive.
- A/C Edit draft preparation (Published false guards) yielded timestamps
	`05:50:11.330Z` / `05:50:14.827Z` on 2026-10-02. Exact-two native bulk
	confirmation produced two sequential safe-pair UI updates and two matching
	HTTP 200 receipts. Receipt copy is `2 disabled`, not `2 archived`; data plus
	reload proved archived. Final A/C updatedAt `2026-10-02T05:50:45.553Z` /
	`2026-10-02T05:50:44.727Z`, both archived/unpublished/headphones/empty
	subcategories/no images or prices, Archive disabled/no alerts. This proves
	two live drafts, not completed suggested published-Archive browser coverage.
- Fresh B readback compared every original key except category/updatedAt:
	`differences:[]`. Headphones/Bluetooth/Published/not archived, unit 6.2,
	wholesale 5.5, VIP 4.3, MOQ 500; original name/model/description/nine ordered
	image IDs unchanged. No B writes in this round. Added createdAt
	`2026-10-02T03:25:31.832Z` and latest updatedAt
	`2026-10-02T03:26:10.694Z` stayed unchanged, not restored to July 31 or
	legacy representation. Business-visible restoration is not byte identity.
- Measured actual 390px new UI had Section/Product family comboboxes/no root
	overflow; B-only selection made no product write. Actions is details/summary,
	not a button-role element: the initial automation timeout was not a defect.
	Publish/Disable/Archive buttons, no Delete, all left 41.24/right 183.99/width
	143, text fit/no overlap. Cleared selection/restored actual/root 1440;
	B visible/unselected. Fresh public fixture-prefix search zero; B $5.50/MOQ 500.
- Independent native post-deploy read-only/no-auth Chromium verified catalog
	image and actual card/details/View All/View image 1..9: original IDs in exact
	currentSrc order, naturalWidth 800 or 790, positive heights, pageerror empty.
	Screenshot `output/playwright/live-syt8-postfix-20261002.png` inspected,
	browser finally closed. Hidden shared-image complete false is a visibility
	artifact; native loaded-image proof controls acceptance. Legacy formal-detail
	sections/media 404 with working fallback remains, not zero HTTP errors.
- The bridge's row-Archive-adjacent requestFailed ERR_ABORTED has unknown action
	and a 1969 timestamp; causal attribution and request type are unproven. It
	cannot justify claiming mutation failure or calling it a read. HTTP 200 and
	reload proved row Archive; original Remove HTTP 400 remains. No claim of
	zero all-network errors.
- Closure limits: atomic batching/isolated CloudBase transaction proof deferred;
	<=20 revision-checked sequential only. Live real-key Escape/exact 768px not
	passes; local native Escape/exact 768px passed. Deliberate uncertain writes/
	lost responses tested only locally, never induced live. A/C archived, not
	deleted/original absence; B restored business visibility, not timestamps/
	representation/audit or undone temporary storefront history. Existing P3
	suggestions (published/multi-select Archive fixtures, DB changed legacy
	name/status/published-name-only assertions, incomplete archive-pair response)
	and all 12 baseline craft findings remain debt, not fixed by this completion.
- Recorded exact-be8d463 static/unit/default 158/formal 144/build/artifact/review
	gates apply to the implementation tree. This five-doc closeout is not a new
	runtime; its eventual commit SHA is not newly runtime-tested or deployed.
	No final documentation commit ID or doc-only deployment is claimed.
