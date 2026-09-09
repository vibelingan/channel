# Client acceptance closeout — 2026-09-09

Baseline: `fix/alibaba-sync-storage-wiring@0094048` plus preserved local work.
This is an implementation and acceptance ledger. Historical entries below retain
their original verification boundaries; the newest release evidence takes precedence.
All releases in this closeout use CI/CD, not direct local cloud deployment.

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
