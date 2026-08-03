# Home Form And Headphones UI Fix - Execution Log

Status: G3/G4 approved by the user's 2026-07-30 instruction to correct the reviewed screens and
start implementation. Runtime work proceeds one isolated MIU/test deployment at a time.

This tracked document is the durable implementation-status source.
`home-form-headphones-ui-fix-miu-breakdown.md` defines the technical units; `ARCHITECTURE.md`,
`ui-design.md`, `PERFORMANCE.md`, and
`UI-SCREEN-BOARD.html` define their approved intent after G3. Local `.claude/*.json` files are only
disposable pointers.

## Completed Before Remaining MIUs

### P0 product visibility - complete and deployed

- Commit: `741b0af` (`fix(headphones): restore product visibility`).
- Environment: public custom domain backed by the test CloudBase environment.
- Change: removed `.reveal` from asynchronous `HeadphonesPage` wrappers and added stable
  product-card/detail test anchors.
- Proof: cards visibly render at 390px and 1440px; computed ancestors are visible; detail opens and
  returns; Deploy Test run `30419402071` passed with 19 public E2E tests and 2 intentional skips.
- Boundary: this does not complete site-wide MIU 5. `global.css` still defaults static `.reveal`
  consumers to opacity zero and remains pending hardening.

### Deployment route checkpoints - pre-existing complete

| MIU | Commit | Existing result | Remaining action |
|---:|---|---|---|
| 14 | `ce19963` + `27c70c0` | Real `/headphones` 200 smoke plus the source-contract rejection of the removed tautological placeholder; `/overstock` remains 404 | Revalidate after assembled MIU 13; edit only on a red check |
| 15 | `3feeb60` | Current CloudBase/CICD docs already describe Headphones live and Overstock retired | Revalidate against MIU 14; green means no edit |
| 16 | `26a636a` | Canonical production-readiness route disposition already reconciled | Revalidate against MIUs 14-15; green means no edit |

These checkpoints are not evidence that the remaining form, hero, catalog, gallery, focus, or
performance work is complete.

### SY-T8 import verification - operational evidence only

- Existing product retained its ID and now references 18 canonical active images.
- All 18 public image URLs and all 18 browser gallery switches were verified.
- This proves media bytes/publication are healthy. It does not complete MIU 8: current Gallery
  still auto-pans a 200% hover background and mounts all thumbnails.

## Pending Approval

The approved G3 package includes:

1. progressively customizable native Product Category with classic native fallback;
2. the nine-screen visual board and focused page composition;
3. gated hero media, 12-item Load More, and four-preview Gallery request budgets;
4. no CloudBase image variants or copied public hero derivative in this delivery;
5. the exact per-MIU skill/rule registry and revalidation-only treatment of MIUs 14-16.

The user also approved the implementation loop: each runtime MIU completes its test/review cycle,
lands its exact reviewed SHA on `test`, and exposes the custom-domain result before the next visible
MIU.

## Approved Visual Calibration Slice - Complete

- The user approved preventing the squeezed Screen 02 header in the actual implementation. Initial
  regression coverage proved the current shared header overflowed after account hydration at 768,
  1024, and 1280px, so the conservative root fix widened this calibration to `SiteHeader.astro`.
- The measured contract uses 1360px as the minimum desktop candidate, then enables desktop only
  when the legal brand, five links, hydrated account actions, current font metrics/text size, and
  32px gutters fit. Otherwise the native mobile disclosure remains available, including without
  JavaScript. The unreachable `More` island is removed rather than hydrating a hidden component and
  document listener.
- Reduce current product-card price weight from 700 to 600 and `View details` from 600 to 500.
- Correct Screen 02 to give the desktop header a full-width lane and mirror the real shared-header
  responsive contract.
- This calibration is a narrow pre-MIU correction requested during G3 review. After its test
  deployment, execution resumes at MIU 1.

### Result

- Commit/release: `41c5255fcc2ce243c1fe9a253563e2b12fc3a87c`.
- Deploy Test: [run 30599832000](https://github.com/vibelingan/channel/actions/runs/30599832000),
  all lint/typecheck/build/deploy/smoke/public-E2E gates passed.
- Custom-domain health returned the exact `41c5255` release ID.
- Desktop evidence: [1440x900 full page](deployed-calibration-41c5255/desktop-1440x900.png)
  and [product-card crop](deployed-calibration-41c5255/product-cards-1440.png).
- Mobile evidence: [390x844 open native menu](deployed-calibration-41c5255/mobile-menu-390x844.png).
- Measured evidence: [evidence.json](deployed-calibration-41c5255/evidence.json) records desktop
  mode, non-overlapping regions, zero horizontal overflow, Inter price/action typography at
  weights 600/500, and an independently scrollable mobile menu.
- Remaining blank/slow product-media states in the screenshot belong to the approved media and
  Gallery performance MIUs; this calibration did not claim to solve image delivery or loading.

## Remaining MIU Status

| MIU | Status | Notes |
|---:|---|---|
| 1 | Complete | Commit `800b9f4`; behavior-neutral dead-surface cleanup and source-contract test |
| 2 | Complete | Node 22.12+ site-build floor; independently pinned Nodejs20.19 function runtime |
| 3 | Complete | Stable `_id asc` public catalog ordering with local/CloudBase parity |
| 4 | Complete | Progressive native Product Category control shared by homepage and `/oem` |
| 5 | Complete | Default-visible reveal baseline with bounded one-time animation cleanup |
| 6 | Not started | Abortable catalog client |
| 7 | Not started | Typed Headphones copy and hero provenance |
| 8 | Not started | ProductMedia and bounded Gallery |
| 9 | Not started | Load More state reducer |
| 10 | Not started | Catalog/card async-state presentation |
| 11 | Not started | Product detail presentation |
| 12 | Not started | Product-led Astro hero and focused shell |
| 13 | Not started | Thin page controller, pagination, focus lifecycle |
| 14 | Complete; revalidate | Existing commits `ce19963` + `27c70c0` |
| 15 | Complete; revalidate | Existing commit `3feeb60` |
| 16 | Complete; revalidate | Existing commit `26a636a` |

## MIU 1 - Headphones dead-surface Step 0 cleanup

Status: Complete

Commit: `800b9f4` (`refactor(headphones): remove dead page strings`)

What changed:

- Removed the four hero declarations from the React `PageStrings` interface while retaining and
  positively testing their live Astro declarations and render consumers.
- Removed only the dead route-local/interface `detailHeading` and `unitPriceLabel` declarations;
  the distinct live `content.detail.unitPriceLabel` contract remains unchanged.

Why: both production files exceed 300 lines, so the approved structural work requires this
behavior-neutral dead-surface cleanup as a separate Step 0 commit.

Best-practice sources and exact rules:

- Applied: current TypeScript structural-typing/excess-property documentation, `EC-grep`,
  `EC-build`, and `EC-review`.
- Not applicable: React rendering/composition rules because no component behavior or JSX changed.
- Rejected with reason: no broader formatting or adjacent unused-index cleanup; neither belongs to
  the six-symbol MIU 1 contract.

Tests written first: two focused assertions failed on all six intended declarations before the
cleanup; the hardened green contract also requires all four hero fields to remain rendered by
Astro.

Focused validation: 2/2 source-contract tests, 44/44 site tests, all nine package/application
typechecks plus E2E TypeScript with zero errors, 197-file Biome pass, and an 18-page Astro build.

Assumption check: PASS. Independent review reported no P1/P2 finding; its low test-coverage note was
closed by adding the positive Astro ownership assertions before the final validation run.

Cross-file traces: `pageStrings -> HeadphonesPage` is the only changed boundary. No environment
variable, route, SDK option, event, mock, conditional effect, or wrapper lifecycle changed.

Build/Deploy/Runtime result: behavior-neutral site-source cleanup. Per MIU 1's explicit contract,
the separate cleanup commit does not deploy independently and has no visible pixel change.

Deviations: none.

Result: mandatory Phase A Step 0 is complete; MIU 2 may begin under the user's existing Continue
approval.

## MIU 2 - Node build-floor and function-runtime contract

Status: Complete

Commit: This record ships in the isolated `build: enforce Node runtime contract` commit.

What changed:

- Raised the root development/build engine from Node `>=20.0.0` to the Astro 6.4.6 floor,
  `>=22.12.0`; CI and Deploy Test remain pinned to compatible Node `22.13.0`.
- Added a semantic runtime contract that parses the named CI `checks` and Deploy Test `deploy`
  jobs, requires unconditional non-ignorable build/test/package steps in the correct order, and
  rejects step-level function-runtime overrides.
- The contract analyzes deploy/smoke JavaScript through the TypeScript AST and loads both effective
  tsup exports, proving CloudBase defaults/sinks remain `Nodejs20.19` and both bundles target
  `node20` without accepting matching comments or dead text.
- Deploy Test now runs `pnpm test:deploy-smoke` before function packaging and deployment.

Why: the lock-resolved Astro version cannot build on the root's former Node claim. The site-build
floor must change without silently coupling CloudBase's creation-time-locked function runtime to
the newer build process, and the contract must be a prerequisite of the workflow that deploys.

Best-practice sources and exact rules:

- Applied: `EC-build`, `EC-review`, config-drift/four-consumer reasoning, cross-file Trace 1, and
  dev-pipeline Rule 14 (an automatic gate must be wired where deployment cannot bypass it).
- Applied libraries: `yaml@2.9.0` for structured workflow parsing and the functions' existing
  `tsx/cjs/api` plus TypeScript AST for executable config/script inspection.
- Not applicable: UI, React, route, database, auth, event, mock, conditional-effect, and wrapper
  lifecycle rules; this MIU changes only build/deploy contracts.
- Rejected with reason: whole-file regex/count checks and transitive YAML resolution, because both
  can false-green; root `yaml` is declared and lock-pinned explicitly.

Tests written first: the initial contract failed with root `engines.node >=20.0.0` and passed only
after the root floor changed. Independent review then identified deployment-gate and semantic
false-green cases; the final contract rejects all twelve isolated mutations, including missing,
disabled, ignored, or unrelated-job gates, CI reachability loss, workflow and step runtime drift,
dead/commented CLI text, Node 22 function bundling, a missing site build, and Node 22.11.

Focused validation: semantic runtime contract 3/3; deploy-smoke suite 15/15; all 331 workspace tests;
all nine package/application typechecks plus E2E TypeScript with zero errors; 198-file Biome pass;
both Node 20 function builds and cold-start artifact smokes; 18-page Astro production build; frozen
pnpm 11.5.0 install with no unrelated lock resolution drift.

Assumption check: implementation PASS. The review warning concerned only the original two-file
documentation boundary; the required workflow and lockfile consumers are recorded below.

Cross-file traces:

- Root build floor: `package.json -> CI jobs.checks setup-node/build -> Deploy Test jobs.deploy
  setup-node/build`, both pinned to Node 22.13.0 and tested against `>=22.12.0`.
- Function runtime: `Deploy Test job env -> deploy/smoke || Nodejs20.19 defaults -> generated config,
  CLI --runtime, drift guards, post-deploy config check, and live smoke`, with no step override.
- Function bundle target: both function package build scripts -> effective tsup exports -> `node20`.
- Parser dependency: root `yaml@2.9.0` manifest -> root lock importer -> runtime-contract import.

Build/Deploy/Runtime result: local build and deploy-artifact gates are green. This MIU changes build
eligibility and the Deploy Test prerequisite only; it does not alter function code or the live
CloudBase runtime. There is no user-visible pixel change or new screenshot to inspect.

Deviations: the approved MIU listed `package.json` and `scripts/runtime-contract.test.mjs`. Review
proved that contract could not block Deploy Test, so `.github/workflows/deploy-test.yml` became a
required consumer. Structured YAML parsing added the matching root importer in `pnpm-lock.yaml`.
The final implementation remains one infrastructure MIU with four implementation files; this
execution record is the fifth and final file in the phase.

Result: MIU 2 is locally complete and ready for isolated commit, immutable-SHA review, push, and
Deploy Test verification before MIU 3 begins.

## MIU 3 - Stable public catalog page ordering

Status: Complete

Commit: This record ships in the isolated `fix(api): stabilize catalog ordering` commit.

What changed:

- Added explicit `{ field: '_id', dir: 'asc' }` ordering to the shared `listCatalog` query used by
  both public `products` and `overstock` list routes.
- Kept the existing `{items,total,page,pageSize}` envelope, publication/category/search filters,
  public-field allowlist, current-user role revalidation, cache headers, image URL projection, and
  VIP attachment rules unchanged.
- Made the in-memory shared comparator treat `_id` as a lexical string key, matching CloudBase's
  native `orderBy('_id', 'asc')`; numeric coercion remains unchanged for every non-ID sort field.

Why: offset pagination without an explicit total order can skip or duplicate records when the
adapter's default sort ties. `_id` is unique, so it gives catalog pages a stable order. Local and
test adapters also need string semantics for numeric-looking IDs such as `01` and `1`; otherwise
they can tie under numeric coercion and diverge from CloudBase.

Best-practice sources and exact rules:

- Applied: Public API Projection allowlisting, Auth & Session optional-auth fail-closed behavior,
  CloudBase SDK contract verification, cross-file sort tracing, and TDD boundary-value coverage.
- Not applicable: schema/index/resource, route, environment, UI, media lifecycle, or response-shape
  changes; no new CloudBase resource or compound index is introduced.
- Rejected with reason: sorting projected response items after pagination. Ordering must happen in
  the database query before `skip/limit`, or page membership remains unstable.

Tests written first: two tests failed against insertion order before the production sort was added.
Review then exposed numeric-looking string ID ties and a weak unauthorized VIP assertion; the final
55-item fixture inserts `1` before `01` but requires lexical `01` then `1` across two pages, while
the role matrix requires zero VIP fields for anonymous/viewer and all VIP fields for
member/contributor/admin.

Focused validation: 39/39 public API tests, 70/70 shared tests, both affected typechecks, focused
Biome, and the CloudBase SDK contract passed.

Full validation: frozen pnpm 11.5.0 install; all 333 workspace tests; all nine
package/application typechecks plus E2E TypeScript with zero errors; 198-file Biome pass; both
Node 20 function builds and cold-start artifact smokes; 18-page Astro production build.

Assumption check: runtime/API contract PASS. The only warning was that the approved untracked MIU
breakdown still lists the original two-file scope; it is deliberately not staged wholesale into
this implementation commit. The required shared comparator deviation is recorded here.

Independent review: no P1/P2 findings after both review corrections. Residual risks are the
documented offset-pagination lack of snapshot consistency during concurrent writes and missing
focused overstock/search/category combination coverage; both routes use the same owning query path.

Cross-file traces:

- Public route -> `listCatalog` -> DB facade sort -> CloudBase `orderBy('_id', 'asc')`.
- Local/test route -> `listCatalog` -> Memory/JSON adapter -> shared `compareBySort` lexical `_id`.
- Catalog viewer -> current users row -> unchanged `canSeeVipPricing` projection; ordered IDs are
  identical for anonymous, viewer, member, contributor, and admin.

Build/Deploy/Runtime result: changes the public-api artifact and user-visible default catalog order
only. No schema, index, route, environment variable, response shape, or site pixel changes. Per the
approved MIU contract, this backend unit is packaged and smoke-tested locally but is not deployed
independently; it will ship with the assembled release.

Deviations: review expanded the implementation from the two declared public-api files to include
`packages/shared/src/query.ts`, because local/test `_id` ordering had to match CloudBase string
semantics. Final implementation scope is three code/test files plus this tracked execution record.

Result: MIU 3 is locally complete and ready for isolated commit and immutable-SHA review. MIU 4 may
begin only after the reviewed commit is recorded; MIU 3 has no standalone visual screenshot.

## MIU 4 - PublicSelect and ProjectForm native integration

Status: Complete

Commit: This record ships in the isolated `feat(form): add progressive product select` commit.

What changed:

- Added `PublicSelect.astro`, a reusable single-select primitive with one native named control,
  label/required association, literal option values, 48px trigger, classic-picker styling, and
  capability-gated `base-select` picker/option/open/selected states.
- Replaced only `ProjectForm`'s inline select branch. Text/file controls, `form.elements`
  serialization, direct COS upload, `submitProject`, redirect, and payload contracts are unchanged.
- Removed the form card's `.reveal` visibility dependency so both homepage and `/oem` forms remain
  fully visible without JavaScript; site-wide reveal hardening remains MIU 5.
- Native validation uses one `reportValidity()` path. An empty screen-reader live region is present
  from page load, then error text, `aria-invalid`, `aria-describedby`, and visible styling are
  synchronized on invalid/change/reset without permanently describing a valid control as erroneous.

Why: the product category field is a shared form primitive on two real consumers. Native select
semantics retain browser keyboard, typeahead, touch, reset, validation, and no-JavaScript behavior;
customizable-select CSS adds polish only where supported and never creates a second control/value.

Best-practice sources and exact rules:

- Applied: G2-approved Surface 1 design, current MDN customizable-select contract, current Web
  Interface Guidelines, UI/UX Pro accessibility/touch guidance, native form semantics, reduced
  motion, and cross-file form/payload tracing.
- Applied review fixes: default-visible no-JS ancestor chain, disabled/muted/open states, trigger-
  width picker anchoring, single invalid event, and live-region state synchronization.
- Rejected with reason: a JavaScript ARIA listbox. It would duplicate native behavior and expand
  keyboard, focus, touch, reset, and serialization risk with no product benefit.

Tests written first: both focused Playwright tests failed on the missing shared primitive. The final
tests cover homepage and `/oem`, exactly one labelled/named/required select, placeholder and literal
`Other`, first-invalid focus, synchronized error lifecycle, exactly one serialized category value,
and no-JavaScript effective opacity plus native selection.

Focused validation: Chromium Product Category tests 2/2; one-invalid-event probe; 44/44 site tests;
Astro and E2E typechecks; focused Biome; production build; existing deployed OEM upload test remains
discoverable and its `selectOption('Headphones')` path is structurally unchanged.

Cross-browser and visual evidence:

- Chromium at 390px and 1440px on homepage and `/oem`: one named control/form element, 48px height,
  selected `Other`, 2px focus outline, and no horizontal overflow. Four local screenshots are kept
  under ignored `output/playwright/miu4-select/` and are not part of the commit.
- Firefox no-JavaScript classic fallback on both pages: `appearance: none`, selected `Other`, one
  named/form control, effective opacity `1`, and no horizontal overflow.
- WebKit binary download failed because all Playwright CDN hosts returned DNS `ENOTFOUND`; Safari/
  WebKit remains the explicit residual browser gap. The classic fallback contains only standard
  `<label>`, `<select>`, and text `<option>` markup.

Full validation: frozen pnpm 11.5.0 install; all 333 workspace tests; all nine
package/application typechecks plus E2E TypeScript with zero errors; 199-file Biome pass; both
Node 20 function builds and cold-start artifact smokes; 18-page Astro production build.

Assumption/design/review result: final assumption check PASS; design check found no blocker/P1/P2;
independent review found no remaining P1/P2 after no-JS opacity and live-region repairs. The full
public suite's API/canonical failures against the site-only dev server were rejected as environment
mismatch (no local API and wrong build-time SITE_URL); its 16 page-only checks and both MIU tests
passed. Deploy Test is the authoritative integrated public-browser gate.

Cross-file traces:

- Homepage `CTASection` and `/oem` -> shared `ProjectForm` -> `PublicSelect` -> one
  `form.elements.category` -> unchanged `submitProject` payload.
- Existing OEM upload smoke -> `[name=category].selectOption('Headphones')` -> same native control.
- CSS capability query -> enhanced Chromium picker; unsupported Firefox -> classic native picker.

Build/Deploy/Runtime result: site-only component and browser-test change; no dependency, lockfile,
backend, route, environment variable, or payload change. MIU 3 deployed successfully at `9e675ff`
through Deploy Test run `30781616399`; PR #6 is open, clean, mergeable, and all checks are green.
Pushing this MIU commit will update that PR, trigger CI/Deploy Test for its exact SHA, and receive an
explicit `@codex review` request.

Deviations: none from the approved three-file implementation boundary. Removing `.reveal` from the
form card is a local prerequisite of MIU 4's explicit no-JavaScript visibility contract; it does not
replace MIU 5's site-wide reveal hardening.

Result: MIU 4 is locally complete and ready for isolated commit, immutable-SHA review, PR update,
and test deployment. Its visible result is the shared Product Category control on both forms.

## MIU 5 - Default-visible reveal animation contract

Status: Complete

Commit: This record ships in the isolated `fix(site): make reveal content fail visible` commit.

What changed:

- Made every `.reveal` node visible by default (`opacity: 1`, no transform). No JavaScript,
  unsupported observers, registration failures, reduced motion, and late client content therefore
  fail visible instead of remaining transparent.
- The BaseLayout controller now registers each existing static node before assigning
  `reveal-pending`, and only below-fold nodes are armed. Initial-viewport content is never hidden.
- Intersection starts one opacity/transform transition, unobserves immediately, ignores descendant
  and non-opacity transition events, and removes pending/visible classes through the real opacity
  completion or an 800ms timeout fallback.
- `will-change` exists only during the active transition. Cleanup restores the plain reveal class,
  so card hover transforms and compositor resources are not retained.

Why: the previous CSS made content availability depend on a later observer class. That hid static
content without JavaScript and created silent blank-page states when observers or lifecycle timing
failed. Animation is now optional enhancement; visibility is the invariant.

Best-practice sources and exact rules:

- Applied: progressive enhancement, reduced-motion visibility, observer registration-before-hide,
  one-time observer cleanup, transition lifecycle ownership, bounded timeout fallback, and
  Headphones P0 computed-visibility regression protection.
- Rejected with reason: `MutationObserver` support for dynamic nodes. The approved contract
  explicitly keeps one initial static query; dynamic nodes remain visible by default.
- Rejected with reason: animation-fill keyframes on `.is-visible`. Review proved this creates a
  visible -> hidden -> visible flash, retains `will-change`, and overrides existing hover transforms.

Tests written first: normal/pre-enhancement, observer-unavailable, and no-JavaScript tests failed at
opacity `0`. The final six-test suite covers visible baseline, missing observer, throwing
registration, no-JavaScript, reduced motion, one-time transition cleanup, independent descendant
and property event guards, untouched pending `will-change: auto`, and timeout cleanup when native
transition completion is delayed.

Focused validation: six reveal lifecycle browser tests; 44/44 site tests; Astro and E2E typechecks;
focused Biome; no reveal `MutationObserver`; `git diff --check`.

Full validation: frozen pnpm 11.5.0 install; all 333 workspace tests; all nine
package/application typechecks plus E2E TypeScript with zero errors; 199-file Biome pass; both
Node 20 function builds and cold-start artifact smokes; 18-page Astro production build.

Assumption/review result: final production-code review found no remaining P1/P2 after fixing
visible-to-hidden flash, observer fallback animation, registration failure, descendant event
cleanup, persistent `will-change`, and timeout coverage. The required controller update is recorded
as a scope deviation below.

Cross-file traces:

- `BaseLayout` static query -> successful `IntersectionObserver.observe()` -> optional below-fold
  `reveal-pending` -> one intersection -> opacity transition -> event/timeout cleanup.
- Missing JavaScript/observer/registration and reduced motion -> untouched visible CSS baseline.
- Existing Headphones product cards remain reveal-free and retain their deployed computed-ancestor
  visibility test.

Build/Deploy/Runtime result: site CSS/controller and public browser tests only; no dependency,
lockfile, backend, route, environment, API, or payload change. After commit, PR #6 and `test` will
receive the exact reviewed SHA and Deploy Test will verify static pages plus Headphones P0 live.

Codex review status: PR #6 is open, clean, and mergeable. `@codex review` was posted twice, but as of
this MIU boundary GitHub REST, GraphQL timeline/review threads, check runs, and the rendered PR page
contain no Codex-authored review payload. No finding was invented or silently attributed to Codex;
the request remains active for the updated PR head.

Deviations: the approved MIU listed `global.css` and `public.spec.ts`. Review proved the existing
BaseLayout controller was the owning lifecycle surface, so `BaseLayout.astro` became the necessary
third implementation file. This execution record is the fourth file in the phase.

Result: MIU 5 is locally complete and ready for isolated commit, immutable-SHA review, PR update,
and test deployment.

## Per-MIU Record Template

`doc-writer` appends one section at every completed MIU boundary:

```text
## MIU N - <technical name>
Status:
Commit:
What changed:
Why:
Best-practice sources and exact rules:
  applied:
  not applicable:
  rejected with reason:
Tests written first:
Focused validation:
Assumption check:
Cross-file traces:
Build/Deploy/Runtime result:
Deviations:
Result:
```
