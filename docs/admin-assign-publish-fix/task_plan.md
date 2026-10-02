# Admin category assignment and publication (2026-09-28)

Goal: deliver the explicit category-and-publication workflow plus responsive Admin navigation. Initial live inspection was read-only; the later authorized Admin-page acceptance is limited to the A/C test drafts and B product with captured baseline and UI-only restoration in [G4-TEST-PLAN.md](G4-TEST-PLAN.md). Do not modify other customer products.

## Phases

1. [complete] Detect stack/deploy, confirm main and inspect production UI read-only.
2. [complete] Lock dual-button intent and record G1 requirements approval in SPEC.
3. [complete] Audit responsive navigation and classification design; user approved G2.
4. [complete for UI-only scope] Lock the revised architecture, MIUs, prototype and test plan after the user deferred true backend batching and authorized the remaining UI phases.
5. [complete for UI-only scope] Implement and review classification outcomes, read-only recovery and responsive Admin navigation; validate the local production build and disposable-DB E2E.
6. [in progress] Initial delivery `24936f0` / Deploy Test 36849272212 was verified before live acceptance. Integrate the subsequent local repairs with advanced `origin/test`, commit, review exact SHA, pass CI, merge/deploy and repeat post-fix live checks; do not mark delivery or live acceptance complete.

Deferred separately: a true atomic backend batch with transaction, approval, image-counter and lost-response proofs in an isolated NoSQL environment. The UI release retains the existing <=20 revision-checked sequential publication behavior; it makes no atomicity claim.

Branch: `fix/admin-assign-category-publish-20260928` originally from `origin/main` at `bf699b4`, then replayed onto `origin/test` at `4b1e6d5` for delivery. Other dirty worktrees stay untouched.

## Safety

- Production browser: the earlier reconnaissance was read-only. For the later approved acceptance, allow Save/publish and A/C archival only on the captured A/C/B products through Admin. Restore B's business-visible baseline before bulk draft tests; record unavoidable audit/public-visibility history. A/C deletion was rejected by deliberate server policy, so retain the archived records and disclose that their original absence cannot be restored through permitted UI. No retry/bypass or direct database/API calls for product changes or cleanup.
- No automatic retry of ambiguous writes. Never claim publication succeeded without a confirmed per-product result.
- Keep local/disposable fixtures separate from live customer records.
- The env documented as `test` (`diversity-123-d9grnqfux221323bb`) routes the production site and `/api/admin`; treat it as PRODUCTION. The approved UI-only A/C/B checks are the sole live product writes here. No SDK/direct-DB transaction probe, including disposable collections; an independently isolated NoSQL env is required for the **deferred batch feature**. Automated mutating E2E uses the owned local JSON DB.
- The previous single-row publish experiment and red progress test were removed from this branch pending design approval; 24 baseline classification unit tests pass.

## Latest plan adjustment - 2026-10-02

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
