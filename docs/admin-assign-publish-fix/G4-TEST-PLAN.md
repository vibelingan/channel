# G4 test plan: Admin classification UX and responsive navigation

Status: **COMPLETE: Phase 6 and live acceptance for the current authorized UI/sequential scope.** See [Final gate closure](#final-gate-closure---2026-10-02) for CI/deployment, independent runtime proof, post-fix UI results and explicit gaps. Earlier pending states, 157/143 results and failures are preserved as history, not current gates. Live Admin-only acceptance is authorized for the known production-serving `test` target with per-product state snapshots. Scope is the current <=20-product, revision-checked sequential publication workflow in [SPEC.md](SPEC.md), [ui-design.md](ui-design.md) and [miu-breakdown.md](miu-breakdown.md), plus the authorized legacy-category and Archive policy repairs recorded below. The true backend batch and SDK cloud-transaction proof remain deferred in [SDK-PROBE.md](SDK-PROBE.md).

## Test boundary and proof of isolation

- Write unit tests before each active MIU (2 -> 3 -> 4; MIU 5 independent), reusing `apps/site/src/islands/admin/catalog-taxonomy-ui.test.ts` and the existing batch API tests. The initial UI-only plan had no backend repair; live testing later required the authorized legacy-category and safe Archive repairs with red-first DB/API coverage. No SDK/schema/atomic-batch change.
- Extend `tests/e2e/admin-subcategory-visibility.spec.ts` for assignment/publication and focus; extend `tests/e2e/admin-product-family-tabs.spec.ts` for responsive selectors. Run with `pnpm test:e2e:catalog-admin-local`: the runner creates an owned temporary JSON DB and media directory, checks API health `mode:local` and exact DB path, builds a disposable Astro site, sets `E2E_CATALOG_LOCAL_SEED=1`, `E2E_ALLOW_MUTATION=1` and synthetic local credentials, then deletes its temporary directory. The classification spec must reject missing local opt-in. Never set these flags against a CloudBase URL.
- For a focused local Admin regression, `node scripts/run-catalog-admin-local-e2e.mjs --admin-only` uses the same owned DB, production build and cleanup but runs only the seven classification browser cases. This is a diagnostic lane, not a substitute for the unchanged default full regular and formal CI suites.
- The EnvId called `test` in deployment docs routes the live production domains and `/api/admin`. The user explicitly acknowledged this and authorized deployment plus Admin-only live acceptance, selecting products through the signed-in browser. The one existing published candidate below is a real storefront product: its brief withdrawal is customer-visible even if Admin restores business fields. Never use live write probes for SDK atomicity; those still require a physically separate environment.

## Behavior matrix (red-first assertions)

| Scenario and owner | Positive assertion | Negative / side-effect assertion |
| --- | --- | --- |
| MIU 2: row and multi-select default | Both show Save classification and Save and publish, correct selected IDs/count and saved public/draft status; Confirm save sends one `catalogCategories` assignment without `includeSavedRevision`. | No `update` publication call, no default-on publish checkbox, no mutation when Back/Escape is used before confirm. |
| MIU 2: confirmed publish (1 and 2 drafts) | Confirm save and publish sends assignment with `includeSavedRevision:true`; after all saved revisions are returned, sends revisioned `update` requests for exactly those IDs and shows their confirmed final status after readback. | No publish request before full confirmation; zero duplicate calls on repeated Confirm, no claim that the group was atomic or rolled back. |
| MIU 2: rejected assignment / approval | One stale taxonomy/product revision, invalid draft, or supplier detail needing Edit shows the named next action, retaining selected IDs. | Any assignment not fully saved makes **zero** publish updates; supplier review is never silently approved; no automatic retry. |
| MIU 2: partial publish / auth failure | First product confirmed, second rejected -> result shows one confirmed and one needs review; an auth error halts remaining requests. | Confirmed first product is not described as rolled back; `not-attempted` IDs receive no update; no per-product live counter or percentage. |
| MIU 2: timing / readback | Hold assignment and early/late publish responses; immediate result skips a transient indicator, slower result shows one waiting state; a failed active list refetch retains the write receipts. | No second write from Refresh statuses, no `Done`-as-success on failed readback, no busy button/Close interaction during a request. Test the candidate 250 ms threshold deterministically rather than inferring performance from elapsed CI time. |
| MIUs 2–4: ambiguous outcome and safe exit | Drop a publish response after the handler may have committed; final state names confirmed/unknown/not-attempted. Refresh statuses performs reads. When verification remains unavailable, Check later or settled-state Close/Escape returns focus, keeps selection, confirmed receipts and a visible list warning. | Unknown is neither failed nor published, no automatic replay, no second `catalogCategories`/`update` request, no forced stay in the dialog after the request has settled. While a request is still running, Close/Escape cannot dismiss it. |
| MIU 3: role and independent commands | Admin row/bulk entry shares the default-save editor; standalone Publish/Disable use their existing actions and semantic colors; non-admin lacks bulk Assign category. | Opening editor, Clear selection and switching family/section send **zero** write actions; visibility commands never send classification. |
| MIU 5 + MIU 3: responsive geometry | At exact CSS viewport widths 375, 390, 734, 768, 1024 and 1440px, assert document/nav width and table-local scrolling. Manual browser checks at 1440 and 720 CSS px used measured `innerWidth` and a reflow proxy for 200% zoom; native browser zoom remains untested. Desktop keeps active left rail; narrower widths expose labeled Section and family Select. | No document-wide overflow, clipped button, inaccessible action, role-hidden selector choice or label overlapping a preceding/following control. Preserve original Admin command colors. |
| MIU 4: keyboard and focus | Tab through actions and options; before-write Escape/Close cancels with focus returned to opener; after Done/Check later focus returns to row or bulk action. `aria-live=polite` reports meaningful stage/result changes once. | No focus trapped on a hidden element; do not announce a percentage, per-item live counter or falsely final outcome. |

## Acceptance gates

1. Scope approval: the user approved the G1 actions, G2 layout/palette, deferred true backend batching and explicitly confirmed that `test` deploys the live site. They authorized deployment and asked the agent to select products in the signed-in Admin. A/C must be newly created test-only drafts; B's temporary customer-visible withdrawal and complete UI restoration must be logged and rechecked.
2. Per MIU: first observe the relevant assertion fail, implement only that 1–3-file slice, rerun its focused test and typecheck; preserve the preexisting positive/negative API coverage. All existing frontend/API unit tests and the owned local browser lane pass after integration.
3. Before delivery: `pnpm --filter @vibelingan-channel/site test`, `pnpm --filter @vibelingan-channel/site typecheck`, `pnpm exec tsc --noEmit --project tsconfig.e2e.json`, `pnpm exec biome check .`, `pnpm --filter @vibelingan-channel/site build`, and `pnpm test:e2e:catalog-admin-local` must succeed. Inspect browser console/network for errors and verify actual CSS viewport sizes before counting screenshot evidence. Branch-specific CI does not substitute for this local lane.
4. Exit criteria: no schema/SDK/deploy configuration change, no unauthorized production data mutation, no claim of throughput or atomicity improvement. The discovered backend legacy-category fix and safe Archive policy repair are explicitly authorized deviations. Approved live writes require B's business-visible restoration through Admin and A/C archival; disclose that baseline absence, timestamps/audit and transient public visibility cannot be undone. No deletion bypass.

## Authorized Admin-only live acceptance and restoration (complete within final limits)

The procedure below preserves the approved plan and intended gate order. Actual
completion, the premerge exception and restoration limits are recorded in
[Final gate closure](#final-gate-closure---2026-10-02).

The `test` branch push automatically deploys the shared CloudBase environment after CI; pushing this feature branch alone does not. First finish the owned local production-build runner, workspace typecheck/lint, diff review, and release-SHA review. Push the reviewed feature branch, pass PR checks, then merge into `test` after identifying safe fixture candidates in Admin. Verify the deployed SHA and read-only public/Admin smoke before a live product write. Never dispatch `catalog_acceptance_only=1`: that existing workflow sets `E2E_ALLOW_MUTATION=1` and uses direct API-backed fixtures outside this UI-only acceptance scope.

Use A/C as two uniquely named, test-only **unpublished, image-free** products created through Admin after deployment. Their original state is absence; do not upload media. The original delete-cleanup plan was disproved by live HTTP 400: products must be archived. Restore/check intermediate categories, archive through Admin, verify unpublished/archived/empty subcategories, and retain the records; absence cannot be restored through permitted UI. B is the existing source-key-empty, published `SY-T8 Wireless Headphone` (Headphones / Bluetooth Headphones; website price $5.50, MOQ 500; preview images loaded). Before touching B, use Admin to capture its unique row identity/SKU, all image and pricing fields, archived/published flags, category and subcategories. Do not assume its displayed name alone is a stable ID. No Alibaba-linked or supplier-review product is a substitute. Admin UI actions necessarily issue the application's own network requests; the tester must not issue standalone `fetch`, `curl`, `adminAction`, direct DB changes or cleanup APIs. Passive browser network observation is allowed only to corroborate what the UI did.

| Fixture and browser action | Positive check via Admin/public pages | Negative check |
| --- | --- | --- |
| A: row Classify -> Save classification -> Confirm save | Category changes in Admin after reload; product remains a draft and absent from the public catalog. | No publication status change; no second write from preview or Cancel. Restore A's starting category before the next case. |
| B: use Admin to withdraw B, then row Classify -> Save and publish -> Confirm save and publish | Changed category and Published status survive Admin reload; the product appears in the public storefront. | A and C are unchanged; no duplicate confirmation write or atomic-batch claim. Immediately restore B's original Bluetooth category while Published and compare all captured fields. |
| A + C: select only these two -> Assign category -> Save classification | Both receive the chosen category after reload and remain drafts. | No product is published; B retains its restored Published baseline. Restore/check A/C's intermediate category, then archive both through Admin and verify archived/unpublished with empty subcategories; do not claim deletion or absence. |

After **each** scenario, use only Admin controls to restore the affected fields before moving on, then reload Admin and public views and compare the captured business-visible state. Do not leave B withdrawn during A/C tests; restore B's original category and Published state before starting the bulk scenario. Archive A/C through Admin at the end and verify retained archived records, unpublished and absent from public search, rather than deleted records. If any write or status is unknown, stop subsequent cases, refresh through Admin only, preserve screenshots/receipts and do not retry blindly; request manual resolution before declaring restoration. Record the cause and recovery of every issue. UI restoration cannot rewind added `createdAt`, `updatedAt`, revisions, audit history, original A/C absence or the temporary public absence/category change of B: only B's original business-visible state can be compared.

## Historical evidence and follow-up gates - 2026-10-02, before integration

- Reported live results and exact fixture IDs/baseline are in
	[LIVE-ACCEPTANCE-20261002.md](LIVE-ACCEPTANCE-20261002.md). Actual-admin row
	save-only/cancellation, B publish/per-ID Done/public price and immediate
	restoration, draft Replace/Append/Clear and no-write Clear selection passed.
	A/C were archived successfully via Edit UI, not deleted. B actual prices are
	unit 6.2/wholesale 5.5/VIP 4.3, MOQ 500; nine original ordered images retained.
- Live geometry passes are actual 375/390/734/1024/1440px; 390px modal bounds
	16/374 and scrollWidth/clientWidth 357/357, screenshot no overlaps. Exact
	768px is local only due editor zoom. Synthetic native cancel closes/returns
	focus; transported VS Code keyboard Escape did not. Local real Chromium
	Escape passed; do not call synthetic cancel an equivalent live real-key pass.
	Ordinary scope changes reset ordinary selection intentionally; unresolved
	selection/receipt persistence is proven by local recovery tests.
- Local repair checks: red-first DB regression + DB 51/51 + tsc; safe exact
	Archive `{archived:true,published:false}`, single/bulk authoritative readback,
	API 16/16 and owned Admin 8/8. Reject other product bulk-update combinations;
	deduplicate <=20, sequential execution and unknown-stop, with no atomicity
	claim. New browser case uses drafts only; existing server coverage proves
	published withdrawal. Independent assumption-checker no new P1/P2, archive
	graph PASS.
- Full pre-integration gates: 2,755 unit passes/3 skips, default 158/formal 144
	browser passes with cleanup, 19 workspace/E2E plus site/test types green,
	Biome 760 green after terminal-newline formatting in three local ignored
	review JSON files, three function builds/artifact smoke green. Root
	typecheck/build:functions wrappers offered unpinned pnpm via npx; declined
	installation, then pinned no-install equivalents passed.
- Pending: integrate PR #64 price-tier changes at remote `test` `2f8567f`,
	commit, exact-SHA review, CI, merge, deploy and post-fix live acceptance.
	Independent public-only image check remains pending after a blank screenshot
	in the hidden shared tab. No pageerror observed; console 400 from failed
	Remove is known and must not be labeled clean console. Do not mark deployment
	of the repairs or overall live acceptance complete.

## Historical gate evidence - 2026-10-02, through 05:08:47

Caller-verified evidence below distinguishes later facts from the earlier pending
entries. **Status then: IN PROGRESS; current COMPLETE status is limited by
Final gate closure below.**

- Integrated local gate passed: only the repair commit was rebased onto PR #64
	`2f8567f302accb8790898e6f274436bd5a71439a`; reviewed fix HEAD
	`be8d463da51ab462728bf9c914c69b4a9298be3a`. Exclusive main-agent runs passed
	19 workspace typechecks, E2E TypeScript and site/test types, Biome 760 (761
	with later ignored review metadata), 2,760 units / 3 existing skips, full
	default 158 and formal 144 owned browser cases with disposable DB removal,
	and all three function builds/packaging/artifact smokes.
- Six independent exact-SHA reviewers: 0 P1 / 0 P2. P3 suggestions are still
	published/multi-select Archive browser fixtures, changed legacy name/status/
	published-name-only DB assertions, and incomplete archive-pair response
	coverage. Do not claim those additions passed. Craft gate: 12 baseline
	findings, 0 new / 0 execution errors, not fixed baseline debt. Blessing and
	normal push hooks passed for `be8d463`.
- [PR #65](https://github.com/vibelingan/channel/pull/65) created and
	squash-merged at `2026-10-02T04:59:15Z` as
	`de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`. Empty
	`git diff be8d463..origin/test` proves merged/tested tree equality and PR #64
	preservation. This was a process exception to the intended premerge checks:
	`gh pr merge --auto` merged immediately because protection did not require
	all PR CI. **No premerge remote CI pass.** PR CI `36966277671`, test CI
	`36966932042` and Deploy Test `36966932172` were running at last observation.
- Deployment is still unverified. Deploy Test requires complete reusable
	merge-SHA CI success before deploying; no production publication ahead of
	that gate. Independent all-three-service read-only probes at 05:05:25 and
	05:08:47 returned old `2f8567f`, HTTP 200 / status ok. A constant target-SHA
	`waitForFunction` result was contradicted, not runtime proof; acceptance did
	not start on it.
- Read-only media checks passed independently: public catalog and all nine
	original ordered gallery images, $5.50 / MOQ 500, no pageerror; legacy approved
	sections 404 then working fallback. Screenshot:
	`output/playwright/live-syt8-public-20261002.png`. Authenticated SY-T8 Edit
	at 05:03 showed saved Headphones / Bluetooth / Published, $5.50 / MOQ 500
	preview, nine `complete:true` images at naturalWidth 790 or 800; cancelled
	without saving. Earlier Image unavailable was transient loading, not a
	reproduced product bug. `addInitScript` preserves original browser baseline
	across upcoming reload; credentials are excluded.
- Current restoration evidence, not final sign-off: A's 05:07 Admin UI readback
	is `ccbff7a5-0dcf-463b-b948-c2f592ed95d8`, archived true, published false,
	empty subcategoryIds, updatedAt `2026-10-02T03:29:21.046Z`; C's prior
	`2026-10-02T03:29:22.298Z` also shows archived true / published false.
	Neither was deleted or restored to absence. B's original business keys
	excluding category/audit were already unchanged; explicit headphones /
	`[headphones-bluetooth]` / empty category and added createdAt
	`2026-10-02T03:25:31.832Z`, updatedAt `2026-10-02T03:26:10.694Z` remain.
	Do not claim byte-for-byte restoration.

### Exit checks still pending at 05:08:47 (now resolved below)

1. Complete remote CI and Deploy Test; independently observe exact merge SHA
	 `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3` on all three running services.
2. Only after that proof, exercise new UI Archive cancel (no write), row A
	 Archive, then two-product A/C bulk Archive. Use Admin controls only; retain
	 receipts and authoritative UI readbacks, with no blind retry or deletion.
3. Finish final B baseline comparison and public fixture exclusion, preserving
	 archived A/C and disclosing category/audit representation limits.
4. Finalize plan only after these checks; Phase 6/live acceptance stay IN PROGRESS.

## Final gate closure - 2026-10-02

**Phase 6 and live acceptance COMPLETE for the authorized UI/sequential scope.**
This closeout records caller-verified results, not a new execution of tests.

| Exit check | Final evidence / boundary |
| --- | --- |
| Reviewed and merged implementation | PR #65 merged `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`; tree identical to reviewed `be8d463da51ab462728bf9c914c69b4a9298be3a`. All recorded exact-tree static/unit/default 158/formal 144/build/artifact/review gates remain implementation evidence. |
| Remote CI and deployment | PR CI `36966277671` SUCCESS finished `05:11:57`; separate test CI `36966932042` SUCCESS. Deploy Test `36966932172` completed SUCCESS: both full reusable CI jobs and Build/deploy/smoke SUCCESS. Complete merge-SHA CI required before deployment publication; deployed smoke/public browser E2E passed. Optional catalog-acceptance skipped by push design; optional media/OEM upload smokes not requested, not claimed run. |
| Independent running release | Browser time `05:45:13`: public API/Admin/Alibaba all strict HTTP 200, ok true, status ok, releaseId `de5e347`. Build times `2026-10-02T05:19:53.821Z` / `2026-10-02T05:19:53.787Z` / `2026-10-02T05:19:53.706Z`, respectively. |
| New row Archive cancel / accept | Actual authenticated reload preserved B baseline, zero Delete buttons and disabled Archive for already-archived A/C. Edit made A draft/unarchived with Published false guard, HTTP 200 updatedAt `2026-10-02T05:48:18.940Z`. Dismissed native `Archive this product? It will no longer be published.`: zero product mutations, fresh unchanged flags/timestamp. Accepted row Archive: exact `{archived:true,published:false}`, matching A HTTP 200, updatedAt `2026-10-02T05:49:28.355Z`; Archive disabled. |
| Exactly-two A/C bulk Archive | Edit prepared drafts with Published false guards, A/C updatedAt `2026-10-02T05:50:11.330Z` / `2026-10-02T05:50:14.827Z`. Accepted native `Archive 2 products? They will no longer be published.`; two sequential exact-safe-pair requests, two matching-ID HTTP 200 receipts. Existing generic receipt `2 disabled`, not `2 archived`. Data plus fresh reload proved both archived/unpublished/headphones/empty subcategories/no images or prices, disabled Archive/no alerts. Final A/C updatedAt `2026-10-02T05:50:45.553Z` / `2026-10-02T05:50:44.727Z`. |
| Final B comparison / restoration | Fresh original-key comparison except category/updatedAt: differences empty. Headphones/Bluetooth/Published/not archived; unit 6.2/wholesale 5.5/VIP 4.3/MOQ 500; original name/model/description/nine ordered IDs unchanged. No B writes this round; added createdAt `2026-10-02T03:25:31.832Z` and latest updatedAt `2026-10-02T03:26:10.694Z` unchanged. Original July 31 timestamp and legacy representation not restored. |
| Responsive new controls | Actual 390px Section/Product family comboboxes/no root overflow. B-only selection, no product write; existing Actions details/summary exposed Publish/Disable/Archive, no Delete. All three buttons left 41.24/right 183.99/width 143, text fit/no overlap. Cleared selection/restored actual/root 1440; B visible/unselected. Initial Actions button-role timeout was an automation selector mistake, not product defect. |
| Public exclusion / B gallery | Shared fresh fixture-prefix URL search zero; SY-T8 one product/$5.50/MOQ 500. Independent post-deploy headless Chromium read-only/no auth/no API product mutations: native fixture search zero, catalog image loaded, actual card/details/View All/View image 1..9 passed. Each currentSrc original expected ID in exact order, naturalWidths 800 or 790, positive heights; screenshot `output/playwright/live-syt8-postfix-20261002.png` inspected; pageerror empty; browser finally closed. |

### Exceptions and unclaimed coverage

- Auto-merge at `04:59:15Z` preceded branch CI completion; no protection bypass
	flag. Later PR CI success is not a premerge pass. The deployment's complete
	merge-SHA CI gate did succeed before publication; these are separate facts.
- Original Remove HTTP 400 remains. Bridge requestFailed ERR_ABORTED after row
	Archive had unknown action/1969 timestamp: neither proven mutation failure nor
	proven read. Row HTTP 200 and later reload establish Archive success. Legacy
	formal sections/media 404 has working fallback; no zero-all-network or
	zero-HTTP-error claim. Hidden shared-image complete false is a visibility
	artifact; independent native loaded-image proof is valid.
- Live real-key Escape and exact 768px remain unverified/not passes; local
	native Escape and exact 768px passed. Deliberate lost-response/uncertain-write
	cases stayed isolated local, never intentionally induced live. No optional
	upload smoke or catalog-acceptance result is implied by complete status.
- Only <=20 revision-checked sequential behavior is accepted. True atomic batch,
	SDK/isolated transaction proof and atomicity/throughput improvement deferred.
- A/C cleanup is archived retained records, NOT deletion/restored absence. B
	business-visible restoration is NOT byte-identical representation/timestamps/
	audit or undone temporary public history. Complete means this authorized scope.
- P3 suggestions remain published/multi-select Archive browser fixtures, DB
	changed legacy name/status/published-name-only assertions, incomplete
	archive-pair response test. Live two-draft bulk proof does not implement those
	additions or prove published Archive browser coverage. All 12 baseline craft
	findings remain debt, not fixed.
- Current closeout edits only these five existing docs. No terminal/git/tests/
	commit/push, no runtime change or doc-only deployment. An eventual doc commit
	SHA is not a newly tested runtime; no final doc commit ID is invented.
	Detailed receipts: [Final live ledger](LIVE-ACCEPTANCE-20261002.md#final-closure---2026-10-02).
