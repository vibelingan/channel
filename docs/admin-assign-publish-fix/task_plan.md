# Admin category assignment and publication (2026-09-28)

Status: **COMPLETE: Phase 6 and live acceptance for the current authorized
UI/sequential scope.** See [Final plan closure](#final-plan-closure---2026-10-02)
and the [final live ledger](LIVE-ACCEPTANCE-20261002.md#final-closure---2026-10-02).
Earlier pending entries are dated history, not current outstanding gates.

Goal: deliver the explicit category-and-publication workflow plus responsive Admin navigation. Initial live inspection was read-only; the later authorized Admin-page acceptance is limited to the A/C test drafts and B product with captured baseline and UI-only restoration in [G4-TEST-PLAN.md](G4-TEST-PLAN.md). Do not modify other customer products.

## Phases

1. [complete] Detect stack/deploy, confirm main and inspect production UI read-only.
2. [complete] Lock dual-button intent and record G1 requirements approval in SPEC.
3. [complete] Audit responsive navigation and classification design; user approved G2.
4. [complete for UI-only scope] Lock the revised architecture, MIUs, prototype and test plan after the user deferred true backend batching and authorized the remaining UI phases.
5. [complete for UI-only scope] Implement and review classification outcomes, read-only recovery and responsive Admin navigation; validate the local production build and disposable-DB E2E.
6. [complete for authorized UI/sequential scope] PR #65 merged as `de5e347`, tree identical to reviewed `be8d463`. Remote PR/test CI and Deploy Test 36966932172 succeeded, including both full reusable CI jobs and Build/deploy/smoke. Independent three-service health proved the merge SHA before post-fix UI-only Archive cancel/row/bulk acceptance, final B comparison, responsive checks and independent public image verification passed. See final closure for explicit deferred/gap limits; this is not atomic-batch completion.

Deferred separately: a true atomic backend batch with transaction, approval, image-counter and lost-response proofs in an isolated NoSQL environment. The UI release retains the existing <=20 revision-checked sequential publication behavior; it makes no atomicity claim.

Branch: `fix/admin-assign-category-publish-20260928` originally from `origin/main` at `bf699b4`, then replayed onto `origin/test` at `4b1e6d5` for delivery. Other dirty worktrees stay untouched.

## Safety

- Production browser: the earlier reconnaissance was read-only. For the later approved acceptance, allow Save/publish and A/C archival only on the captured A/C/B products through Admin. Restore B's business-visible baseline before bulk draft tests; record unavoidable audit/public-visibility history. A/C deletion was rejected by deliberate server policy, so retain the archived records and disclose that their original absence cannot be restored through permitted UI. No retry/bypass or direct database/API calls for product changes or cleanup.
- No automatic retry of ambiguous writes. Never claim publication succeeded without a confirmed per-product result.
- Keep local/disposable fixtures separate from live customer records.
- The env documented as `test` (`diversity-123-d9grnqfux221323bb`) routes the production site and `/api/admin`; treat it as PRODUCTION. The approved UI-only A/C/B checks are the sole live product writes here. No SDK/direct-DB transaction probe, including disposable collections; an independently isolated NoSQL env is required for the **deferred batch feature**. Automated mutating E2E uses the owned local JSON DB.
- The previous single-row publish experiment and red progress test were removed from this branch pending design approval; 24 baseline classification unit tests pass.

## Historical plan adjustment - 2026-10-02, before integration

- [observed in reported live acceptance] Actual admin created image-free A/C;
	row save-only, cancellation/focus, bulk Replace/Append/Clear, draft/public
	exclusion and ordinary selection behavior passed. B was restored to
	Headphones / Bluetooth Headphones / Published before bulk tests. A/C now
	remain archived, unpublished, with empty subcategories; they are not deleted.
- [locally validated; not deployed] Repair unrelated visibility updates clearing
	B's legacy category, and replace product Delete with policy-compatible Archive.
	Latest full gates: 2,755 unit passes/3 skips, default 158 and formal 144 browser
	passes with cleanup, 19 workspace/E2E and site/test types, Biome 760, three
	function builds/artifact smoke. Pinned equivalents passed after declining the
	wrappers' unpinned pnpm install. No new P1/P2 in independent assumption review;
	archive graph PASS. These results precede remote integration.
- [pending] Preserve PR #64 price-tier work at remote `test` `2f8567f` during
	integration; then commit, exact-SHA review, CI, merge, deploy and post-fix live
	acceptance. Independently verify public images: hidden shared-tab blank
	screenshot is still under investigation. Exact live 768px and transported
	real-key Escape are not passes; their exact-width/real-key evidence is local.

## Deviations

- The approved UI-only plan met a backend legacy-category bug when withdrawing
	B. Under the user's test-fix-all authorization, the conservative repair limits
	category clearing to explicit recognized non-headphone families. A broader
	catalog migration or schema/SDK redesign was not taken.
- Cleanup originally required deleting A/C, but the server deliberately rejects
	product deletion. The authorized repair uses Archive with exactly
	`{archived:true,published:false}` and preserves sequential <=20 behavior with
	deduplication and unknown-stop. No deletion bypass, direct cleanup API,
	SDK/schema change or atomic batch was introduced. Retaining archived fixtures
	is an explicit restoration limitation, not restored baseline absence.

## Historical plan status - 2026-10-02, through 05:08:47

Caller-verified updates below supersede resolved pending entries above; older
validation and failures remain historical. **Status then: IN PROGRESS;
current status is COMPLETE within the final closure limits below.**

- [complete locally] Only the new repair commit was rebased onto PR #64 base
	`2f8567f302accb8790898e6f274436bd5a71439a`; reviewed HEAD is
	`be8d463da51ab462728bf9c914c69b4a9298be3a`. Exclusive integrated runs passed
	19 workspace typechecks, E2E and site/test types, Biome 760 (761 with later
	ignored review metadata), 2,760 units / 3 existing skips, default 158 / formal
	144 owned browser cases with disposable DB removal, and all three function
	builds, packaging and artifact smokes. Six exact-SHA reviewers: 0 P1 / 0 P2.
	Craft gate: 12 baseline findings, 0 new, 0 execution errors; baseline debt
	remains. Blessing and normal push hooks passed.
- [merged; not runtime proof] [PR #65](https://github.com/vibelingan/channel/pull/65)
	squash-merged at `2026-10-02T04:59:15Z` as
	`de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`. Empty reviewed-HEAD-to-`origin/test`
	diff proves the merged tree matches the tested tree and preserves PR #64.
	`gh pr merge --auto` merged immediately because branch protection did not
	require all PR CI; no premerge remote CI pass is claimed.
- [pending deployment] PR CI `36966277671`, test CI `36966932042` and Deploy
	Test `36966932172` were running at their last observations. Deploy Test must
	pass its complete reusable merge-SHA CI before deployment; no production
	publication ahead of that gate. Independent three-service probes at 05:05:25
	and 05:08:47 still returned old `2f8567f`, HTTP 200 / status ok. The constant
	target SHA returned by `waitForFunction` was contradicted, not accepted as proof.
- [read-only evidence complete] Public Chromium verified catalog, nine original
	ordered gallery images, $5.50 / MOQ 500 and no pageerror, with expected legacy
	sections 404 followed by fallback. Authenticated B Edit at 05:03 confirmed
	Headphones / Bluetooth / Published and nine loaded images; cancelled unsaved.
	Earlier Image unavailable was transient loading. Baseline survives upcoming
	reload via `addInitScript`, with no credentials included.
- [pending live acceptance] After independent all-three-service merge-SHA proof,
	test new UI Archive cancel, row A, and A/C bulk Archive with receipts/readbacks;
	finish B baseline comparison and public fixture exclusion, then final plan.
	A's 05:07 readback remains archived/unpublished/empty subcategories with
	updatedAt `2026-10-02T03:29:21.046Z`; C's prior timestamp is
	`2026-10-02T03:29:22.298Z`, archived/unpublished. Neither is deleted. B's
	business-key comparison excludes category/audit, not byte-for-byte identity;
	explicit representation and added timestamps remain as recorded above.
- [P3 coverage suggestions, not completed] Published/multi-select Archive browser
	fixtures; DB assertions for changed legacy name/status/published-name-only;
	incomplete archive-pair response test. Full details and final gates:
	[LIVE-ACCEPTANCE-20261002.md](LIVE-ACCEPTANCE-20261002.md).

## Final plan closure - 2026-10-02

- [complete] Implementation PR #65 merged
	`de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`, tree identical to exact-reviewed
	`be8d463da51ab462728bf9c914c69b4a9298be3a`. Recorded integrated static/unit/
	default 158/formal 144/build/artifact/review gates remain valid for that tree.
- [complete] PR CI `36966277671` SUCCESS, finished `05:11:57`; separate test CI
	`36966932042` SUCCESS; Deploy Test `36966932172` completed SUCCESS, both full
	reusable CI jobs and Build/deploy/smoke SUCCESS. Complete merge-SHA CI gated
	deployment publication; deployed smoke and public browser E2E passed. Optional
	catalog-acceptance skipped by push design; media/OEM upload smokes not requested.
- [complete] Independent browser-time `05:45:13` health of public API/Admin/
	Alibaba each strictly returned HTTP 200, `ok:true`, `status:ok`, releaseId
	`de5e347`. Build times: `2026-10-02T05:19:53.821Z`,
	`2026-10-02T05:19:53.787Z`, `2026-10-02T05:19:53.706Z`, respectively.
- [complete] Actual authenticated Admin reload: no Delete controls, archived
	A/C Archive disabled. A native-confirm cancel made zero product mutations
	with unchanged fresh readback; accepted row A Archive and exactly-two A/C
	sequential bulk Archive had exact `{archived:true,published:false}` requests,
	matching HTTP 200 receipts and fresh reload proof. Generic receipt was
	`2 disabled`, not `2 archived`. Final A/C timestamps:
	`2026-10-02T05:50:45.553Z` / `2026-10-02T05:50:44.727Z`; both archived,
	unpublished, headphones/empty subcategories/no images or prices, no alerts.
- [complete] Fresh B comparison of original keys except category/updatedAt
	returned `differences:[]`; unchanged images/name/model/description/prices/MOQ,
	Published/not archived/headphones/Bluetooth. No B writes in this round;
	added createdAt `03:25:31.832Z` and latest updatedAt `03:26:10.694Z` on
	2026-10-02 remained unchanged. Actual 390px/new Actions summary and restored
	1440px fit without root overflow; B left visible/unselected. Public fixture
	search zero and B $5.50/MOQ 500; independent native catalog/details/gallery
	1..9 loaded in original ID order, screenshot inspected, pageerror empty.
- [preserved exception] Auto-merge at `04:59:15Z` preceded branch CI completion;
	no protection bypass flag, no premerge remote-CI pass. Historical old-SHA
	probes, original Remove HTTP 400 and the unknown-action bridge ERR_ABORTED
	remain recorded. No zero-all-network/zero-HTTP-error claim; legacy sections/
	media 404 has working fallback. Actions button-role timeout was a selector
	mistake; hidden shared-image visibility does not negate independent image proof.
- [deferred / gaps] True atomic batch unchanged; <=20 revision-checked sequential
	behavior only. Live real-key Escape/exact 768px are not passes (local native
	Escape/exact 768px are). Lost-response/uncertain writes were deliberately
	tested only in isolation, never live. A/C cleanup means archived, not deleted
	or restored absence; B is business-visible restoration, not byte-identical
	representation/audit/timestamps or undone temporary storefront history.
	P3 test suggestions and all 12 baseline craft findings remain outstanding.
- [docs-only closeout] No commands/tests/commit/push or runtime change in this
	documentation pass. An eventual documentation commit is not a newly tested
	runtime; no final doc SHA or deployment is claimed. Full receipts and limits:
	[Final live closure](LIVE-ACCEPTANCE-20261002.md#final-closure---2026-10-02).
