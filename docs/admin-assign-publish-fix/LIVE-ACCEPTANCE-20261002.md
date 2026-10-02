# Live Admin acceptance - 2026-10-02

Target: https://supplychainsai.com/admin, deployed test SHA
`24936f000dcfb4a77a16c642cc6a7c6fe43a7e16`, Deploy Test 36849272212 passed.
Authenticated administrator observed in the user-shared VS Code browser.
All product writes must use Admin controls; passive response observation only.
Status: **IN PROGRESS.** The deployment above was verified before live testing;
the subsequent local repairs are not deployed or accepted live. Latest results
below are supplied by the acceptance caller, not rerun by this documentation pass.

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

## Execution ledger

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

## Issues under investigation

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

## Latest chronological results - 2026-10-02

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

## Local repairs and remaining gates

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
