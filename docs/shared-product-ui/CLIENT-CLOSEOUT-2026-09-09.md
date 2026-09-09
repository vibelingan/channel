# Client acceptance closeout — 2026-09-09

Baseline: `fix/alibaba-sync-storage-wiring@0094048` plus preserved local work.
This is an implementation and acceptance ledger. Historical entries below retain
their original verification boundaries; the newest release evidence takes precedence.
All releases in this closeout use CI/CD, not direct local cloud deployment.

### Editor/contact release — 2026-09-10 (Japan time)

PR #38 head `ab8ca302ad1a6906b1f22739eabb2775cc0d2516` passed full feature CI
`34371921815`. It merged into **test**, not main, as
`caf7e8d261f153002ade0a258e607ac3467bda36`. Deploy Test `34373228478` passed its
same-SHA prerequisite CI and deployed resources, functions and static pages.
**The deployment completed successfully**, including authenticated resource/health
smoke, **41 public browser checks** and **19 catalog browser checks**. The workflow
verified admin/public-api/alibaba-catalog-sync all report that same release SHA.
Evidence: https://github.com/vibelingan/channel/actions/runs/34373228478 and
`/tmp/channel-editor-release-success.log`.

Independent live browser/API checks against that release:

- Both public-api/admin health responses return `caf7e8d`.
- WH3 Edit opens at 1152px in a 1742px viewport, with no horizontal overflow,
  no raw URL-array text and no generic Alibaba Source Images field dump.
- All six owned previews decode from authenticated Blob URLs; all six supplier
  thumbnails decode. The real viewer was opened and advanced to image 6/6, where
  Next is disabled; the large image decodes correctly.
- At the bottom of the inner scroll area (scrollTop 800, scrollHeight 1423),
  both Close and footer actions remain in the viewport. Closing an unchanged
  editor returns focus to the same product's Edit button and makes no update.
- Manual USD 3.10 and MOQ 1000 prefill correctly. New User remains a separate
  512px form with Username/Email/Role/Status, not product fields; it was cancelled
  without creating a user.
- Ordinary public page footer, mailto and both structured-data emails use
  sales@supplychainsai.com. SMTP and recipient configuration are unchanged.
- The public API still returns the exact same nine product IDs as the pre-release
  baseline. No customer product was newly published or edited during this check.
- Product Inquiries on the final release still returns the original single TEST
  ONLY record as Completed, with zero unprocessed inquiries. No second request
  was created and no email was sent.

The earlier attempted browser print interaction did not produce a verified PDF
file; this release does not claim PDF-download or email-delivery acceptance.

### Combined customer follow-up — editor, contact email and release sequence

Scope: product Edit only for the layout/media changes, existing website footer and
structured data for the email change. No new customer publication, RFQ creation,
SMTP change or direct cloud deployment is included. The form had rendered every
read-only Alibaba field through JSON.stringify; this was an inappropriate customer
surface, not a request for customers to edit raw provider data. Its max-w-lg shell
and bottom-only Cancel also explain the wasted desktop space and excessive scrolling.

Implementation: wide desktop/two-column product form, one bounded scroll body,
fixed header/footer, top close, unsaved-discard confirmation and pending-operation
guards. Shared image viewer covers owned previews and safe supplier thumbnails;
private owned bytes render as revocable Blob URLs. Raw evidence remains untouched.
Existing failed-upload Retry/Remove stay interactive while Save/Close remain blocked.
The public email is sales@supplychainsai.com in both visible content and structured
data. This does not configure or verify delivery to that mailbox.

Local acceptance for this follow-up: full workspace tests **1,474 passed**;
post-fix site rerun **362 passed**, lint and workspace/E2E typechecks passed.
Production-build browser lanes ran sequentially: **76 baseline checks passed**
and **61 formal-route checks passed**, including a disposable real local database
for RFQ submission and Admin follow-up. The new editor test also verifies owned
Blob previews decode and are revoked on close. Desktop and mobile screenshots
were inspected at `output/playwright/editor-1440.png` and `editor-390.png`.
Logs: `/tmp/channel-editor-workspace.log`, `/tmp/channel-editor-unit.log`,
`/tmp/channel-editor-browser.log`, `/tmp/channel-editor-formal.log`.
These are local results; this editor/email follow-up still requires its own
feature CI and same-SHA test deployment before it can be called live.

Verification gap: the earlier tests proved persistence, capacity and page-wide
overflow but did not assert the actual Edit shell width, sticky actions or raw-field
absence. New coverage measures 320/390/768/1024/1440px, modal focus, nested Escape,
dirty cancellation/reopen, bad/duplicate source images and upload-pending dismissal.
The two production-build lanes must run sequentially locally: separate output/DB
directories do not isolate Astro's shared intermediate .astro/.prerender cache.

The four historical failing browser cases in run `34336632804` were:

1. **Headphones products remain visibly rendered after client catalog load**:
   the old test looked for the retired in-list Back button after route navigation.
2. **Headphones Gallery bounds media, falls back, and resets across products**:
   the fixture mocked only the list, missing the new approved-detail/legacy fallback
   requests; the expected gallery was never reached.
3. **admin ImageManager enforces catalog capacity before upload**:
   the test transport threw on `inquiryCapabilities`, a new dashboard readiness read.
4. **Headphones keyboard flow moves focus card -> detail -> back to origin card**:
   the fixture/selector still assumed inline detail. Repairing the real route test
   additionally exposed missing focus on the async legacy heading, fixed in the UI.

These were four failed test cases, not four proven database/API failures. None was
waived: route-compatible fixtures retained the original behavior checks, the focus
bug was repaired, and subsequent deployed public/catalog suites passed. The older
live media-binding collection omission was a separate actual persistence defect,
not an explanation of these four automation failures.

### Resumed live acceptance — 2026-09-10 (Japan time)

The one authorized private test inquiry is
`5a0bd614-5c3a-41f3-8435-736cd502360f`. It was submitted through the deployed buyer
form on 9 September at 21:41 Hong Kong time, for the already-public WH3 sample,
quantity 1000, with explicitly synthetic TEST ONLY contact details. Quantity zero
was rejected before submission. No second test inquiry is authorized by this entry.

The normal authenticated Admin UI verified the saved product/SKU/revision,
manual website price USD 3.10 and separate supplier tier USD 3.28. Viewing and a
note-only save left it unprocessed; explicit In progress and Completed actions
persisted, with a required completion reason. After the interrupted session,
reopening the page on 10 September still returned Completed, all three history
entries and zero unprocessed inquiries. The page confirmed email notifications
disabled. This closes the real browser-to-cloud persistence loop, not an order,
invoice, payment or email-delivery test.

PR #37 head `80cd77b` passed full CI `34358334845` and merged into `test` as
`ac859ebb1a30cef512dbcb9adb452bb75e33b829`. The resulting Deploy Test run
`34368427049` deployed matching artifacts and passed authenticated resource/health
smoke, but its final public browser step failed one check (39 passed).
Independent readback already returns that SHA from both public-api/admin health
endpoints. The ordinary WH3 page displays USD 3.10 before quantity entry, and the
authenticated Catalog Import page shows its customer-facing read-only empty state.
The first live card now opens an approved shared detail, while that smoke test
still required the legacy-only `data-product-detail` marker. The failure screenshot
shows the correctly rendered SY-T11 detail and six-image gallery. A read-only local
rerun against the deployed site reproduced this deterministically; replacing the
legacy-only assertion with a new/legacy detail identity assertion passes on the
same deployed bytes (mobile and desktop, 1 test, 10.2 seconds). No product data or
rendering was changed. Logs: `/tmp/channel-ac859-repro.log` and
`/tmp/channel-ac859-verified.log`. The workflow remains historically red; the fix
must pass the next full same-SHA deployment gate, not be described as a rerun success.
This merge targets `test`, not `main`: feature CI precedes the merge, then the
test-branch workflow runs complete CI again before updating cloud resources,
functions, configuration and static pages. An Actions start is not release success.

### Authenticated browser follow-up

**Latest evidence:** `c56f86d` completed CI/CD run `34354186747`, including 40 public
and 19 catalog browser checks. With the same six source URLs and unchanged import
code, gallery import changed from six `write-failed` results to six admitted
owned images after provisioning `catalogSourceLinks`. Both allowed already-public
samples were saved through the normal browser editor. Independent public API and
Chromium readback verify six images each, one/three canonical SKUs, and preserved
manual fixed/tiered website pricing. Every image loaded; mobile overflow and browser
page-error checks passed. No new draft was published and no live inquiry was created.

PR #37's local formal-journey CI then failed on a DevTools response-body lookup,
not submission: the trace has HTTP 200 and the buyer-visible saved reference.
The test now reads that visible reference, verifies idempotent API replay and Admin
persistence, and disables retries against its already-mutated disposable database.
The full local formal lane passes after this correction. Visual readback additionally
caught fixed prices hidden until quantity entry; fixed/range reference prices now
remain visible alongside quantity/MOQ feedback, with blank/invalid/zero/below-MOQ/
valid quantity render regressions. These follow-ups are not yet released.

The user's normal Chrome session reproduced the first sample's exact gallery
failure: six source URLs were present; all six imports returned `write-failed`.
The failed form was cancelled without saving or changing publication. PR #36
merged as `c56f86da345e06e2b83141e3ee7eec842662c286`; its full prerequisite CI
passed and the same-SHA deployment is in progress. The missing media-link
collection remains the leading hypothesis until a post-deployment retry passes.

The same browser showed the applied category remediation in the real Admin menu:
291 Misc, 5 AI Gadgets and 6 Toys entries marked new, and 56 needing classification.
These are review-badge counts, not the complete category totals. Historical
classification changes did not publish any new products.

The visible read-only Catalog Import page also returned `Unexpected server error`.
Its `catalogImportJobs` and `catalogImportItems` collections were absent from the
resource manifest, independently reproduced by a failing resource-contract test.
The follow-up declares private collections and indexes matching the page queries,
and makes authenticated post-deployment smoke read both collections. Provisioning
these resources does not enable the Excel worker or authorize an import. Live
confirmation remains pending CI/CD; no manual console resource mutation is used.
The import empty state no longer instructs customers to run local development
commands. A rendered-page regression proves it explains the read-only boundary
and omits CLI/environment paths. All 360 site tests and 43 deployment tests pass.

### Subsequent auth release and publication-intent regression

PR #35 merged as `84f0315af5d39231d54ea5e0dd45f61a8aa319bd` and deployed
successfully through run `34347737035`. Both API health responses and the login
SSR markup independently confirm the new version/protection. The deployed
browser gate passed 40 public and 19 catalog cases without retries; two independent
live auth checks also passed using no real credentials. Bounded data acceptance
`34350178772` installed 30 approved rules, applied 302 eligible drafts and verified
zero remaining eligible drafts with the public product IDs unchanged. It then
stopped on a source-gallery error BEFORE saving the first public sample. Neither
sample migration nor live RFQ acceptance is complete. Safe diagnostic tokens are
now included in failed gallery assertions without uploading private admin artifacts.

The deployment manifest also omitted `catalogSourceLinks`, now required by API
media binding regardless of whether the optional Excel worker has ever run.
A failing resource-contract test confirmed the omission; CI/CD now provisions
it as ADMINONLY before functions. This is a verified deployment gap, not yet a
confirmed explanation of the failed live image request. No direct cloud change
was made to investigate it.

A final category concurrency check reproduced another boundary: the browser
converted a category-only edit into an explicit publication request. If another
admin withdrew that product during the operation, the classification could
republish it. Category refresh now preserves publication intent: it may refresh
an approved detail, but never writes `published: true`. Only an explicit Publish
or checked Published form action does that. The failing unit test and a real
local browser/API interleaving both cover this; the latter withdraws the product
during source preparation and verifies it remains private after classification.
This follow-up is pending its own same-SHA CI/CD release, not a direct hotpatch.

## Released version and acceptance — 2026-09-09

- PR #34 merged the final application changes into `test` as
  `b24e91e1e6cf0a947c7cda660b589a86732c2a85`. The feature branch at `38c65f5`
  has the same application tree. Commits and fixes are pushed, not local-only.
- Deploy Test run `34342154312` succeeded: same-SHA prerequisite CI, resource
  preflight, function packaging/runtime checks, functions/configuration/static site,
  authenticated API smoke, then **38 public + 19 catalog browser cases** against
  the deployed domain. Both admin and public-api health independently returned
  the exact merge SHA. No direct MCP function deployment was used.
- Independent browser checks against the live domain passed the four focused
  regressions: catalog visibility after hydration, bounded/failing galleries,
  image-manager capacity, and card/detail/Back keyboard focus. The admin capacity
  case uses mocked transport; it is not evidence of a live customer-record write.
- Both production-build local browser lanes also passed: 72 baseline cases and
  58 formal-route cases. The lanes share cases; these are not 130 unique tests.
  The formal journey uses real handlers and a disposable file database and checks
  persisted category approvals, RFQ idempotency and follow-up concurrency.
- Public API readback still returned the original nine public product IDs.
  Email and the Excel import worker remain disabled.
- Authenticated live acceptance `34344809997` passed its complete prerequisite CI
  but stopped at browser login, BEFORE category/product writes. SSR rendered an
  enabled login form without a method before React hydrated, so native submission
  used GET. The test password was GitHub-masked in output, but may exist in origin
  access logs; credential rotation has been requested. This is a real existing
  auth-form boundary failure, not an Alibaba/API failure. Live remediation,
  gallery migration and inquiry acceptance remain unverified.
- The follow-up fix makes login/register/reset forms inert until hydration, uses
  explicit POST as defense in depth, and guards duplicate submits. Two new browser
  cases reproduced the missing protection against the live build (no real
  credentials): JavaScript disabled, and delayed hydration. The live acceptance
  spec now checks the safe SSR method and ready state BEFORE entering credentials.
  Fresh local verification of this follow-up: lint/typecheck and all 1,467 tests
  passed; production-build browser lanes passed 74 baseline and 60 formal cases
  (shared cases are intentionally counted in both lanes). No-JS and delayed-script
  tests use synthetic values; normal UI login is also exercised by the real local
  catalog/Admin and RFQ journeys. Logs are `/tmp/channel-auth-unit.log`,
  `/tmp/channel-auth-baseline.log` and `/tmp/channel-auth-formal-green3.log`.

## Post-deployment regression closure (history before the successful release)

PR #32 merged as `1fd3e97e724ca6e37ad1daecacfe2c7c136ea575`. CI/CD
run `34336632804` deployed matching admin/public-api release IDs, resources,
configuration and static pages. Basic authenticated API smoke passed; the nine
previously public product IDs were unchanged. The subsequent public browser
gate failed four cases, so release acceptance is NOT complete. The next queued
deployment (`34338358490`) was cancelled before deployment while investigating.

The legacy fallback lacked keyboard focus on its asynchronously loaded heading;
this is a real accessibility regression now patched. Gallery/back tests still
assumed the retired in-list expansion interaction and mocked only list data, not
the new approved-detail 404 plus legacy-item fetch. Their replacement continues
to assert bounded multi-image loading, broken-image fallback, mobile overflow,
return-to-origin focus and repeat activation through the real route shell. The
Admin image-manager mock now handles the added capabilities/review-summary reads.

Expanding the pre-deployment route suite also exposed duplicate slug reads:
the shared resolver and legacy page could fetch concurrently, masking an initial
failure. Slug resolution now owns one request and explicit retry, passes a decoded
product to legacy fallback, and rejects conflicting slug/id inputs. Browser cases
also prove 403 never triggers a legacy fallback. Public error copy does not expose
internal approval terminology.

Repeated hero geometry checks then isolated an initial-load scroll regression:
the route shell treated hydration as browser Back and scrolled past the hero.
Scroll/focus restoration now requires an actual popstate event; initial catalog
hydration is asserted to leave scrollY at zero. Hero retry tests isolate catalog
cards, since sharing an image URL is not evidence of a hero retry loop.

Another regression test exposed that bulk website-family changes on an already
public source product could leave the approved detail's category label stale.
Those updates now run the existing prepare/approve/finalize workflow; draft-only
classification still does not publish. Failed approval is not reported as a
successful batch. A formal browser case checks Misc then Headphones against the
persisted approved snapshot.

Both disposable production-build browser lanes now run the full public and
catalog route suites BEFORE deployment, in addition to their admin/RFQ cases.
Local fixtures include the hero's three image identities with synthetic owned
bytes and real published ownership; the built canonical origin matches the
disposable server. No live image URLs or production database are copied.
Live category remediation, two existing-public gallery/approval migrations and
the explicitly marked RFQ acceptance remain pending successful release gates.

## 2026-09-09 integration closure update (supersedes remaining-work notes below)

Baseline repairs are committed and pushed as `25275b4`; readiness parsing is
`5bb3712`. PR #32 targets `test`. The following coupled implementation is now
present and locally exercised; deployment is still gated on the final pushed CI.

- Normal ID/slug detail routes consume the approved shared DTO, not a DEV preview.
  Unmigrated legacy products retain their old page until their saved source is
  prepared and approved. Merely deploying a route does not approve customer data.
- The admin producer reads the persisted full-product Alibaba observation. It
  stages 20 canonical SKUs per transaction, seals a complete generation, then
  stages immutable approval pages before one atomic publication-pointer switch.
  Sync may independently fetch Alibaba; review/approval never invokes its API.
- Imported gallery URLs persist deterministic owned-image bindings, including
  byte-deduplicated aliases. A SKU may use only an image attached to that product.
  Old approved gallery references remain protected during draft edits; replacement
  adjusts reference counts atomically and retries do not double-decrement.
- Published-product Save and batch Publish use source preparation + approval before
  the final publication update. A server-side content fingerprint rejects races
  involving title, gallery, family, manual price or source generation changes.
- Manual website price is a distinct approved field; supplier offers remain source
  evidence. Public rendering and the immutable RFQ snapshot use the manual override
  when set. Current website main category overrides stale source candidate labels.
- Public RFQ uses the real HTTP handler, strict response decoding and a stable
  idempotency key. Admin viewing/note-only actions leave the inquiry unprocessed;
  version checks protect follow-up updates, and completion persists in the DB.

Fresh local browser acceptance: 15 baseline cases passed, plus an ordinary-route
journey using a disposable real handler/file DB and 21 SKUs (two preparation pages).
That journey checks both actual image loads, source quantity tiers, invalid quantity,
country selection inside the modal, submission/retry without duplication, note-only
unprocessed state, stale-version rejection, processing/completion/reload, and mobile
slug navigation. Logs: `/tmp/channel-baseline-browser.log` and
`/tmp/channel-formal-browser.log`. Synthetic image bytes test transport, not product
photography. Cloud storage transport and existing live product migration require the
post-CI deployed acceptance; no claim of live completion is made here.

The CI prerequisite now includes both browser lanes. Deployment owns resource
preflight, packaged functions, feature configuration and static frontend at one SHA.
Email and the Excel worker remain off. The first CI failure was ANSI-colored Astro
readiness detection, not a cloud mutation; it was corrected in `5bb3712`.

### Explicit live acceptance entry

PR #32 merged as `1fd3e97` after CI success. Chrome's unrelated extension UI
blocked interactive acceptance, so `Deploy Test` gains an explicit
`catalog_acceptance_only=true` dispatch. That path still requires same-SHA CI,
does **not** run the deployment job, and receives only the existing application
test login, not CloudBase IAM/JWT signing/SMTP credentials. Both live health
responses must match the triggering SHA before any write. Browser credentials
are neither exported nor recorded in traces/videos/screenshots.

The bounded scope is the already approved category remediation (at most 302
eligible drafts; never overwriting assigned/published products), the two already
public sample IDs named in the acceptance spec, and one clearly marked private
test inquiry completed through Admin. Existing public product IDs must remain
identical, manual title/category/prices/MOQ must remain unchanged, and inquiry
capabilities must confirm email is disabled. Unexpected live state fails the test;
it never silently skips or publishes another sample. This is opt-in one-time
release remediation, not an automatic test that repeatedly rewrites customer data.

## Verified field provenance / agreed business rules

- `products.unitPrice`, `wholesalePrice`, deprecated `vipPrice`: website legacy
  fields, not Alibaba response field names. Do not manufacture all three from
  one provider price. VIP remains out of this workflow.
- Alibaba extraction reads `sourcing_trade` FOB currency/range, product/SKU
  quantity ladders (`product_sku.skus[].bulk_discount_prices`) and SKU `price`.
  `alibabaCatalogPricing` is our normalized projection, not a literal upstream key.
- `category_id` / `cat_id`: upstream taxonomy. `productFamily`: website main
  category (`headphones`, `ai-gadgets`, `toys`, `misc`). `category`:
  historical optional headphone facet (`wired`, `office`, `bluetooth`).
- Manual website pricing wins when the operator intervenes. Merely opening or
  saving unrelated fields must not create an override. Sync must preserve it.
- Admin comparison evidence and customer preview are different surfaces. Public
  UI must choose one effective quotation, including currency and quantity bands.

## MIU CA-07 — One effective price and explicit editing intent

### Runtime problem

`resolveCatalogPricing` returns the linked Alibaba branch before looking at
manual values; several production UI consumers duplicate that precedence rather
than calling the shared resolver. Preview lists source and legacy prices together.

```ts
if (Object.hasOwn(product, 'alibabaPrimarySourceKey')) return sourcePrice;
// A persisted manual override is never reached.
```

### Data shape / ownership

| Value | Lifetime | Owner |
| --- | --- | --- |
| `alibabaCatalogPricing` | persistent, latest eligible source projection | sync |
| `manualCatalogPricing` / legacy scalar prices | persistent website settings | admin |
| `catalogPricingMode?: 'manual' \| 'source'` | persistent explicit choice | admin |
| Editor prefill / dirty state | one edit session | browser |

Absent mode preserves old data using valid manual tiers/scalars first, then source.
Explicit `source` ignores but preserves prior manual prices so restoring source
does not require destructive field deletion. Explicit `manual` never silently
falls back to a supplier quote on malformed or absent manual data.

### Technology constraint

The registry drives API validation and forms; public allowlists and the frontend
decoder must include the new non-secret mode. Money remains integer minor units.
An opened source-priced form must not submit its displayed value as an override.

### Design / best-practice fix

Reuse the shared pricing resolver for all current public price/SEO consumers and
the Admin preview. Add a focused product pricing editor around the existing tier
editor instead of inventing another pricing model. Existing scalar values remain
compatible; ordinary product editing emphasizes one complete pricing scheme.

### Alternatives rejected

- Copy every provider value to manual fields: freezes future sync accidentally.
- CSS-hide one price: leaves API, SEO and other routes inconsistent.
- Delete legacy price fields: destroys existing operator input.
- Guess ranges into quantity ladders: a min/max range does not define breakpoints.

### Code translation

```ts
// Explicit source preference first; otherwise manual tiers/scalars, then source.
// Explicit invalid manual choice returns quote-required rather than source price.
resolveCatalogPricing(product, createAlibabaPricingAdapter());
```

### Risk / tests (red before green)

Shared resolver: manual linked tiers and legacy scalar override; source preference;
missing/null/empty/malformed, currency, zero vs absent, invalid manual fail-closed.
Rendered public/preview seams: exactly one effective price; MOQ and SEO agree.
Browser + real local API: save/reopen source without override; edit/save manual;
restore source; unrelated title/category save; invalid tiers block saving.

## Remaining coupled units / release gate

- CA-02/03: main-category batch and gallery browser regressions passed locally.
  Cloud gallery transport and the approved category backfill still require release
  and scoped live readback; neither was run against customer records here.
- CA-01: mixed-validity batch publication passed through real local HTTP/file DB:
  per-record error visible, rejected rows remain selected, unpublish also verified.
- CA-05: finish approved common detail production/approval and formal RFQ routing;
  do not enable a development-only/raw-data path as a production shortcut.
- CA-06: reconcile deployed code/resources/config to committed source; full same-SHA
  CI before coordinated resources/functions/frontend deployment, release readback
  and legacy regression. Test serves the real domain. Email/Excel worker stay off.
- Session security migration remains separately tracked from this catalog repair;
  do not silently fold a shared authentication rewrite into a price fix.

## Verification status

Production-build Chromium acceptance: **15 passed**:

- 1 external-font failure case, with only that external transport suspended;
- 1 owned-database seed/public projection audit;
- 5 real local HTTP/handler/file-database product lifecycle cases, including
  no-op source save, manual edit, persistence/reopen, matching public price and
  SEO, source restoration without deleting manual settings, main-category batch,
  mixed publication, draft visibility, unpublish and archive;
- 8 controlled HTTP frontend cases: gallery partial failure/retry/deduplication,
  save/reopen, nine-image limit, server errors, invalid/overlapping price tiers,
  keyboard editing, mobile category selection, and in-flight upload/save gating.

The final eight use mocked HTTP responses at the boundary. They exercise the
actual production UI, but do not prove CloudBase/COS upload or persistence.
The real local lane uses an owned temporary DB and normal administrator login;
no production token, cloud write, customer product or email is involved.
The runner removed only its generated DB/media/build directories. User sample
databases and other worktrees were not reset. Mobile pricing screenshot inspected:
`output/playwright/manual-price-mobile.png` (390px viewport, no clipped form edge).

### Additional failure found by the browser gate

The initial extended rerun stalled before product hydration: the existing external
Google Fonts stylesheet blocked parsing/script progression when DNS timed out.
An independent curl also observed a resolving timeout. A regression that holds
only the font request failed at page navigation (8 seconds) before the fix and
passed after it. BaseLayout now loads those same fonts as a post-load enhancement;
existing system-font fallbacks keep content/navigation available without them.
No user-facing debug banner, API mock or larger timeout was used to hide it.

Evidence logs: `/tmp/channel-client-font-red.log`,
`/tmp/channel-client-browser-20260909.log`.

### Workspace verification

- Full workspace: **1,439 passed, zero failed/skipped**, exit 0; log
  `/tmp/channel-client-20260909-tests.log`.
- Workspace and E2E types passed; Astro reports zero errors/warnings and eight
  existing hints. Lint passed (548 files); SDK contract verification passed.
- The owned runner built 15 static production pages before browser acceptance.
  No DEV-only route is counted as a formal-route pass.

### Browser gate is now a deployment prerequisite

CI previously ran only Playwright discovery, not these interactions. The same-SHA
reusable CI workflow now unconditionally installs Chromium and runs
`pnpm test:e2e:catalog-admin-local` before Deploy Test may begin. This lane needs
no cloud credentials or customer data. Failure evidence is retained for seven days.
The scheduler-input contract tests were observed failing before the new steps and
passing afterward; they also reject a discovery-only replacement or softened failure.
This is a local workflow change, **not** a completed GitHub Actions run.
The same browser command was also rerun with `CI=true` and failure-artifact capture:
15 passed, no retries needed. All 37 deployment contract tests passed after the
workflow edit. Logs: `/tmp/channel-client-browser-ci-20260909.log` and
`/tmp/channel-client-ci-gate-20260909.log`.

## Exact next implementation unit (not another live deployment probe)

Update: the [staged persistence and read-compatibility portion](CUI-09B2-STAGED-SNAPSHOTS-2026-09-09.md)
is now implemented and tested locally. This does not complete the cloud candidate
producer or activate the new formal UI. The following dependency closure remains
the release gate; it is not only a rerun of yesterday's E2E.

09B.2 must replace the **local-only** candidate materializer boundary with a
shared, server-side producer for complete source observations and canonical SKU
bindings. It must preserve operator title/category/price/media overrides, seal
only complete source generations, and retain the previous approved snapshot on
partial failure or concurrent sync. Large SKU collections need staged immutable
snapshots and an atomic pointer switch, not a truncated 100-row transaction.

Then connect that approved revision to the existing new detail UI, formal list
navigation and RFQ transport. Acceptance must use a production build with ordinary
URLs and include buyer submission → Admin follow-up. Only after that dependency
closure is tested should this workstream be committed/pushed and integrated into
test through same-SHA CI/CD. This pass has **not** committed, pushed or deployed.
