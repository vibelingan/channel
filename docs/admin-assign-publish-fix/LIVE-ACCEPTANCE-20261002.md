# Live Admin acceptance - 2026-10-02

Target: https://supplychainsai.com/admin, current verified deployed test SHA
`de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`, Deploy Test 36966932172 SUCCESS.
Initial acceptance used `24936f000dcfb4a77a16c642cc6a7c6fe43a7e16` /
Deploy Test 36849272212; that earlier evidence remains below.
Authenticated administrator observed in the user-shared VS Code browser.
All product writes must use Admin controls; passive response observation only.
Status: **COMPLETE for the current authorized UI/sequential scope: Phase 6 and
live acceptance.** See [Final closure](#final-closure---2026-10-02) for deployment,
post-fix acceptance and explicit deferred/gap limits. Earlier pending entries
are dated history, not current gates. Results are supplied by the acceptance
caller, not rerun by this docs-only closeout; no new runtime was tested here.

## Fixtures and execution order

1. A/C: create image-free unpublished `UI-ACCEPT-20261002-A` and
   `UI-ACCEPT-20261002-C`; original baseline is absence. Test cancellation,
   row save-only, reload persistence, navigation/selection and bulk save-only.
  Restore intermediate classification, then archive both through Admin. The
  original deletion plan was blocked by server policy; absence is unrestorable
  through the permitted UI, and the archived records must be retained.
2. B: existing `SY-T8 Wireless Headphone`, ID
   `483207676a6829f2008b7cba2ca33a11`. Withdraw through Admin, classify to
   Wired and save-and-publish, verify Admin/public persistence, immediately
   restore Bluetooth and Published. Do not leave B withdrawn during bulk tests.
3. Check responsive controls/overflow, public images/prices, passive network
   outcomes and browser errors. Never create a deliberate uncertain live write.

## B baseline observed before any write

- Legacy category `bluetooth`; effective Headphones / Bluetooth Headphones.
- Published true; Archived checkbox false; archived property absent in list data.
- No displayed SKU/source ID; no source linkage fields in the observed record.
- Model `SY-T8`, series `SY Series`, type `Over-ear · Foldable · BT 5.4`.
- Unit price 6.2, wholesale price 5.5, VIP price 4.3; public price $5.50, MOQ 500.
- No price tiers or description image fields in the observed record.
- Nine product images, in this exact order:
  `483207676a69b12900a5f0791337bc14`,
  `179185b66a69b1330087ce9a7405bfe2`,
  `7b76ee416a69b172015a1519130d2ab2`,
  `179185b66a69b1950087d5d3707b7f25`,
  `483207676a69b1ae00a5fb0c28310349`,
  `483207676a69b1b700a5fbf53f4ff493`,
  `0e0afdc26a69b1c00076c93b7e2d9b4a`,
  `483207676a69b1c900a5fdb42ac3bc66`,
  `0e0afdc26a69b1ce0076ca2269250d20`.
- Original updatedAt `2026-07-31T06:40:28.486Z`; revision/audit timestamps and
  temporary public changes cannot be undone by business-field restoration.
- Full original record retained in browser observation state for comparison;
  credentials excluded from the observation ledger.

## Historical initial execution ledger

The pending items below describe the initial acceptance checkpoint. Current
results and limits are in [Final closure](#final-closure---2026-10-02).

- Read-only Edit confirmed all nine product images and pricing; cancelled.
- Delete confirmation `Delete this record?` inspected and dismissed; no delete.
- Main-category edit dropdown is blank for this legacy record while saved
  classification is Headphones. Investigate compatibility; no Edit save performed.
- A created as `ccbff7a5-0dcf-463b-b948-c2f592ed95d8`, C as
  `f2d0337f-c29a-4a62-bc78-25d9989bfa1f`: Headphones, no subcategories,
  unpublished, unarchived, no images/prices. Both create responses succeeded.
- A row Save classification to Wired succeeded with exactly one assignment and
  no publication update. Cancel returned focus to Classify; Cancel confirmation
  made no write. A restored with Clear subcategories. Public search for the
  fixture prefix returned zero products.
- B withdrawal, Wired Save and publish and authoritative readback succeeded:
  exactly one assignment with includeSavedRevision and one revision-checked
  publication update; result displayed one published and enabled Done. Public
  Wired-filtered search returned B at $5.50/MOQ 500. B immediately restored through
  Save classification to Bluetooth while remaining Published.
- A+C bulk Replace to Office, Append Bluetooth and Clear all succeeded. Both
  remained unpublished; final intermediate baseline is Headphones / None.
  Ordinary Clear selection removed selection without a write.
- No observed pageerror. Pending: reload/final field comparison, responsive
  verification, draft deletion, issue investigation and repair.

## Historical issues under initial investigation

Keep these original observations; later resolutions and remaining proof gaps
are recorded below and in [Final closure](#final-closure---2026-10-02).

- Live update `{published:false}` cleared B's legacy category from `bluetooth`
  to empty, changing the row to Needs classification. The update did not request
  a classification change. Prices, description and nine image IDs stayed intact.
  B's business-visible classification/publication was restored using the new
  classification controls; its representation is now explicit productFamily and
  subcategoryIds. Investigate and fix the generic update normalization path.
- Escape through the VS Code Playwright keyboard did not close the classification
  dialog, whereas Cancel worked and restored focus. Distinguish browser transport
  limitations from application cancel handling before changing code.
- Ordinary selection toolbar did not remain visible on returning from Overstock
  to Products before restoring the search. Check selected IDs versus current-page
  visibility and the approved retained-review scope before classifying a defect.
- Automation initially targeted transient native select elements during component
  enhancement. Target stable `button[role=combobox]` controls; no duplicate writes.
- Save-only success closes the dialog and clears bulk selection; waiting for Done
  or reusing the prior bulk selection was an incorrect test expectation, not a
  product failure. No write was retried.

## Historical initial acceptance results - 2026-10-02

1. Before any live test, deployed SHA `24936f0` and Deploy Test run
   `36849272212` were verified. The authenticated live Admin identity was an
   actual admin. A/C were created through Admin as image-free drafts with the
   IDs above. A's Wired row save made assignment only; cancellation made no
   write and returned focus. Clear restored its subcategories.
2. B's initial legacy category was `bluetooth`, with no explicit family,
   `published:true` and the nine ordered images recorded above. Actual prices
   were unit 6.2, wholesale 5.5, VIP 4.3 and MOQ 500. Withdrawal through UI
   unexpectedly cleared category on an unrelated `{published:false}` update.
   Wired Save and publish then showed one published, per-ID verified status and
   enabled Done; public Wired search showed B at $5.50/MOQ 500.
3. Before any bulk draft test, B was restored through UI to Headphones /
   Bluetooth Headphones / Published. Comparing all original keys except
   `category` and `updatedAt` returned `differences:[]`; this is not a claim of
   identical representation or timestamps. Current representation is explicit
   `productFamily:headphones`, `subcategoryIds:[headphones-bluetooth]`, empty
   legacy category. The save plan added `createdAt:2026-10-02T03:25:31.832Z`;
   latest `updatedAt` is `2026-10-02T03:26:10.694Z`. Timestamps and temporary
   storefront visibility cannot be rewound.
4. A+C bulk Replace Office, Append Bluetooth (retaining Office) and Clear to
   None succeeded. Both remained drafts; public fixture-prefix search returned
   zero. Clear selection made no write. Ordinary scope changes intentionally
   reset ordinary selection; preservation of unresolved-review selection and
   receipts is proven locally, not by that ordinary live navigation case.
5. Measured live viewports 375, 390, 734, 1024 and 1440px had no root overflow.
   At 390px the modal bounds were left 16/right 374, with scrollWidth 357 and
   clientWidth 357; screenshot showed no overlaps. Exact 768px is proven locally
   only: editor zoom prevented an exact live viewport. Synthetic native
   `cancel` closed the dialog and returned focus; VS Code keyboard Escape did
   not. This is a transport limitation, not an equivalent real-key pass. Real
   Chromium Escape passed locally.
6. Live Remove on A returned HTTP 400: `Products must be archived instead of
   deleted`. This is deliberate server policy; no retry or bypass was attempted.
   A and C were archived via Edit UI with `published:false`, `archived:true`
   and `subcategoryIds:[]`; both succeeded. They remain archived records, NOT
   deleted. Their original absence cannot be restored through permitted UI.
   No pageerror was observed; the console 400 is the known failed Remove, so
   this is not a clean-console result.

## Historical local repairs and then-remaining gates

- Fix 1: DB save plan now clears legacy category only for an explicit recognized
  non-headphone family. Red-first regression, DB 51/51 and typecheck passed.
- Fix 2: product row/bulk Delete becomes Archive with exactly
  `{archived:true,published:false}`. Local single/bulk readback passed. The API
  allows only that safe two-field combination, rejects other product bulk
  updates, deduplicates at <=20 and runs sequentially with an unknown-result
  stop. API 16/16 and owned Admin 8/8 passed.
- Latest pre-integration tree: 2,755 unit passes/3 skips; full default 158/158
  and formal 144/144 browser passes with disposable cleanup; 19 workspace and
  E2E typechecks plus site/test types passed using pinned no-install equivalents.
  Root Biome checked 760 files after formatting terminal newlines in three
  local ignored review JSON files. Root `pnpm typecheck` and `build:functions`
  wrappers offered unpinned pnpm via npx; installation was declined and pinned
  equivalents passed. Three function builds and artifact smoke passed.
- Independent assumption-checker found no new P1/P2; archive graph PASS.
  Residual coverage: the new browser case uses drafts only; published-product
  withdrawal is covered by existing server tests, not that new browser case.
- User's test-fix-all authorization covers the discovered backend legacy fix
  and UI policy repair. No SDK, schema or atomic-batch change was made.
- Remote `test` advanced to `2f8567f` through PR #64 price tiers. Integration,
  commit, exact-SHA review, CI, merge, deployment and post-fix live acceptance
  remain pending. A blank public-images screenshot from the hidden shared tab
  is under investigation; independent public-only image verification is pending.
  Do not attribute it to a product defect or declare public images accepted yet.

## Public media verification follow-up

- An isolated read-only Chromium session opened the actual public catalog and
  SY-T8 details through their controls. The catalog image loaded; View All
  exposed nine gallery controls. Each control loaded its corresponding original
  image with naturalWidth 790 or 800, in the baseline order. Detail price was
  $5.50, MOQ was 500 and pageerror was empty. Screenshot:
  `output/playwright/live-syt8-public-20261002.png` (local artifact).
- The legacy product has no approved formal-detail snapshot: its sections-media
  request returned 404, followed by the working legacy details/gallery fallback.
  Record this expected fallback response rather than claim zero HTTP errors.
- The earlier hidden shared-tab blank image is not reproduced in this independent
  browser. No image/storage code or product media was changed.
- Executable craft gates returned zero new findings and zero execution errors;
  12 existing baseline findings remain recorded, not claimed fixed.

## Historical delivery and live observations - 2026-10-02, through 05:08:47

**Status at 05:08:47: IN PROGRESS; superseded by Final closure below.** These caller-verified facts
supersede older pending entries above only where explicitly resolved. This
documentation pass did not rerun checks or interact with the live system.

### Integrated validation and merge

- Only the new repair commit was rebased onto PR #64's `origin/test` base
  `2f8567f302accb8790898e6f274436bd5a71439a`. Exact reviewed fix HEAD:
  `be8d463da51ab462728bf9c914c69b4a9298be3a`.
- Exclusive main-agent integrated runs passed all 19 workspace typechecks,
  E2E TypeScript and site/test types; full Biome checked 760 files (761 with
  later ignored review metadata); 2,760 unit tests passed with 3 existing skips.
  Full owned default 158 and formal 144 browser cases passed and their disposable
  DBs were removed. All three function builds, packaging and artifact smokes passed.
- Six independent exact-SHA reviewers reported 0 P1 / 0 P2. P3 coverage
  suggestions remain: published-product/multi-select Archive browser fixtures;
  DB assertions for changed legacy name/status and published-name-only updates;
  an incomplete archive-pair response test. These are not completed coverage.
- Executable craft gate: 12 baseline findings, 0 new findings, 0 execution
  errors. Baseline debt is not fixed. The `be8d463` blessing and normal push
  hooks passed.
- [PR #65](https://github.com/vibelingan/channel/pull/65) was created, then
  squash-merged at `2026-10-02T04:59:15Z` into `test` as
  `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`. The reported
  `git diff be8d463..origin/test` was empty: the merged tree exactly matches the
  tested tree and preserves PR #64.
- Process exception: `gh pr merge --auto` merged immediately because branch
  protection did not require all PR CI checks. **No premerge remote CI pass is
  claimed.** PR CI `36966277671` was still running at its last observed check;
  merge-SHA test CI `36966932042` and Deploy Test `36966932172` were running.
  Deploy Test explicitly requires its complete reusable merge-SHA CI to succeed
  before deployment. No production publication is allowed ahead of that gate.

### Independent runtime and read-only product evidence

- Independent read-only probes of all three services at 05:05:25 and 05:08:47
  each returned `2f8567f`, HTTP 200 and status `ok`. The latest observed runtime
  is still the old PR #64 tree; the repairs are **not yet verified deployed**.
- A `waitForFunction` call returned a constant target SHA, contradicted by the
  independent three-service probe. It is not runtime proof; no acceptance
  started on that result.
- Authenticated read-only B/SY-T8 Edit at 05:03 confirmed saved Headphones /
  Bluetooth / Published and public-price preview $5.50 / MOQ 500. All nine Admin
  image elements had `complete:true` and naturalWidth 790 or 800. Cancelled
  without saving. The earlier Image unavailable was transient loading, not a
  reproduced product bug.
- Independent public-only Chromium already verified the catalog and all nine
  original ordered gallery images, $5.50 / MOQ 500 and no pageerror. Legacy
  approved sections returned 404 followed by the working fallback, not a
  zero-HTTP-error result. Screenshot:
  `output/playwright/live-syt8-public-20261002.png`.
- The original browser baseline was preserved across the upcoming reload with
  `addInitScript`; credentials were never included.
- Latest Admin UI search/readback for A at 05:07 returned
  `ccbff7a5-0dcf-463b-b948-c2f592ed95d8`, `archived:true`, `published:false`,
  `subcategoryIds:[]`, `updatedAt:2026-10-02T03:29:21.046Z`. C's prior readback
  at `2026-10-02T03:29:22.298Z` also showed archived true / published false.
  Neither fixture was deleted; their original absence is not restored.
- B's original business keys excluding category/audit were already verified
  unchanged, not byte-for-byte baseline identity. Representation is explicit
  `productFamily:headphones`, `subcategoryIds:[headphones-bluetooth]`, empty
  legacy category; added `createdAt:2026-10-02T03:25:31.832Z` and
  `updatedAt:2026-10-02T03:26:10.694Z` remain recorded.

### Acceptance gates still open at 05:08:47 (now resolved below)

1. Finish remote CI and Deploy Test, respecting the complete merge-SHA CI gate.
2. Independently prove the deployed merge SHA on all three running services.
3. Only then exercise new UI Archive cancellation, row A Archive, and two-product
   A/C bulk Archive through Admin controls only, retaining receipts and readbacks.
4. Complete final B baseline comparison and public fixture exclusion checks;
   retain archived A/C and disclose representation/audit restoration limits.
5. Mark the final plan complete only after these gates; until then Phase 6 and
   live acceptance remain IN PROGRESS.

## Final closure - 2026-10-02

**Phase 6 and live acceptance: COMPLETE for the authorized UI/sequential scope.**
The caller verified the following after the historical 05:08:47 checkpoint.
This is documentation-only closeout of the verified implementation, not a new
test run, runtime release or deployed doc-only follow-up. No final documentation
commit SHA is supplied or invented.

### Remote gates and running release

- Implementation [PR #65](https://github.com/vibelingan/channel/pull/65) merged
  as `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`; its tree is identical to
  reviewed `be8d463da51ab462728bf9c914c69b4a9298be3a`. The exact-tree local
  static/unit/default 158/formal 144/build/artifact/review gates recorded above
  remain the implementation evidence, not tests of an eventual docs-only SHA.
- Remote PR CI `36966277671` finished SUCCESS at `05:11:57`; separate test CI
  `36966932042` finished SUCCESS. Deploy Test `36966932172` completed SUCCESS:
  both full reusable CI jobs and the Build/deploy/smoke job succeeded. Complete
  merge-SHA CI was required before deployment publication. Deployed smoke and
  public browser E2E passed.
- Optional catalog-acceptance was skipped by push design; optional media/OEM
  upload smokes were not requested and are not claimed run.
- The premerge exception remains: auto-merge completed at `04:59:15Z`, before
  branch CI completed, because protection did not require every PR check. No
  protection bypass flag was used; later green CI is not a premerge CI pass.
- Independent health checks of all three services at browser time `05:45:13`
  each strictly returned HTTP 200, `ok:true`, `status:ok`, and `releaseId`
  `de5e347bdc7e60e1b9736600e96bf4cbe1eb59f3`. Build times on 2026-10-02:
  public API `05:19:53.821Z`, Admin `05:19:53.787Z`, Alibaba `05:19:53.706Z`.
  These checks supersede the earlier old-SHA probes, not their history.

### Authenticated UI-only Archive acceptance

- Reloaded the actual authenticated Admin, preserving the original B baseline
  across reload. There were zero Delete buttons; A/C Archive buttons were
  disabled while those products were already archived.
- Via Edit, temporarily unarchived A as a draft. Published false was asserted
  before Save; HTTP 200 confirmed `archived:false`, `published:false`,
  `updatedAt:2026-10-02T05:48:18.940Z`.
- Dismissed native confirmation `Archive this product? It will no longer be
  published.` Observed zero product mutation requests. A fresh UI list readback
  retained that same timestamp, `archived:false` and `published:false`.
- Accepted row Archive. The UI issued exactly
  `{archived:true,published:false}`; HTTP 200 matched A's ID with those values,
  `updatedAt:2026-10-02T05:49:28.355Z`. Archive was disabled afterwards.
- Prepared A/C drafts via Edit, asserting Published false before each Save:
  A `updatedAt:2026-10-02T05:50:11.330Z`, C
  `updatedAt:2026-10-02T05:50:14.827Z`. Selected exactly A/C and accepted native
  confirmation `Archive 2 products? They will no longer be published.`
- The UI sent two sequential update requests, each with the exact safe values
  `{archived:true,published:false}`. Both HTTP 200 receipts matched their
  respective IDs and archived/unpublished values. The existing generic receipt
  reads **`2 disabled`**, not `2 archived`; response data and fresh reload proved
  both products actually archived.
- Final fresh-reload A: `ccbff7a5-0dcf-463b-b948-c2f592ed95d8`,
  `updatedAt:2026-10-02T05:50:45.553Z`; C:
  `f2d0337f-c29a-4a62-bc78-25d9989bfa1f`,
  `updatedAt:2026-10-02T05:50:44.727Z`. Both were archived/unpublished,
  `productFamily:headphones`, `subcategoryIds:[]`, without images or prices;
  both Archive buttons were disabled and there were no alerts.
- The bridge surfaced one `requestFailed ERR_ABORTED` after row Archive, with
  unknown action and a 1969 timestamp. Its cause and request type are unproven:
  do not label it a read or a mutation failure. The row update had HTTP 200 and
  later reload proved archival. No claim of zero all-network errors is made.

### Final B, responsive and public readbacks

- Fresh Admin B search/readback compared all original keys except `category`
  and `updatedAt`, returning `differences:[]`. B remained Headphones /
  `[headphones-bluetooth]` / Published / not archived, unit 6.2, wholesale 5.5,
  VIP 4.3, MOQ 500. Original description/name/model and all nine ordered image
  IDs were unchanged. There were **no B writes in this post-fix round**.
- B's original `updatedAt` was `2026-07-31T06:40:28.486Z`. Its added `createdAt`
  `2026-10-02T03:25:31.832Z` and latest `updatedAt`
  `2026-10-02T03:26:10.694Z` were unchanged by this round. Explicit family /
  subcategory representation remains; this is business-visible restoration,
  not byte-identical timestamps or representation.
- Measured the new UI at actual 390px: Section and Product family comboboxes
  were present, with no horizontal root overflow. Selecting B only made no
  product write; opening the existing Actions `details/summary` showed Publish,
  Disable and Archive, no Delete. All three button bounds were left 41.24 /
  right 183.99, width 143; text fit and no overlap was observed. An initial
  button-role lookup for Actions timed out; clicking the actual summary worked.
  This was an automation selector mistake, not a product defect. Cleared
  selection and restored actual 1440px/root 1440, leaving B visible/unselected.
- Fresh shared public URL search for `UI-ACCEPT-20261002` showed `0–0 of 0` and
  no products. UI search SY-T8 showed one product, $5.50 / MOQ 500.
- Independent post-deploy headless Chromium was read-only, unauthenticated and
  made no API product mutations. Native UI fixture search returned zero; B's
  catalog image actually loaded. Actual product-card click, details View All
  and each View image 1..9 passed. Every `currentSrc` contained its original
  expected ID in the exact baseline order, naturalWidth 800 or 790 and positive
  height. Screenshot `output/playwright/live-syt8-postfix-20261002.png` was
  inspected; `pageerror:[]`; browser closed in `finally`.
- Legacy formal-detail sections/media 404 with working fallback remains
  recorded; no zero-HTTP-error claim. Shared hidden-image `complete:false`
  remains a browser-visibility artifact; the independent native loaded-image
  evidence is the valid media proof.

### Explicit closure limits

- True atomic batching remains deferred. Only existing <=20 revision-checked
  sequential behavior is accepted; no SDK/schema/atomicity improvement claimed.
- Live real-key Escape and exact 768px are not passes; local native Escape and
  exact 768px are passes. Deliberate lost-response/uncertain-write cases remain
  isolated local checks and were never intentionally induced live.
- Cleanup is retained archived A/C, not deletion or restored original absence.
  B's business-visible state is restored, not byte-identical representation,
  timestamps, audit history or undone temporary storefront changes. The original
  Remove HTTP 400 remains historical evidence, not erased by successful Archive.
- P3 suggestions (published/multi-select Archive browser fixtures, changed
  legacy name/status and published-name-only DB assertions, incomplete
  archive-pair response test) remain suggestions, not completed local coverage.
  Live two-draft bulk proof does not replace those additions or prove published
  Archive browser coverage. All 12 baseline craft findings remain debt.
- Completion applies only to the authorized UI/sequential release and live
  acceptance, not deferred features, optional smokes or these coverage gaps.
