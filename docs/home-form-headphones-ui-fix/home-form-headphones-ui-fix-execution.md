# Home Form And Headphones UI Fix - Execution Log

Status: G3/G4 approved by the user's 2026-07-30 instruction to correct the reviewed screens and
start implementation. Runtime work proceeds one isolated MIU/test deployment at a time.

This tracked document is the durable implementation-status source.
`home-form-headphones-ui-fix-miu-breakdown.md` defines the approved technical units, decisions,
non-goals, tests, visual/performance contract, and execution loop. This log records their current
results. Uncommitted worktree planning artifacts and local `.claude/*.json` files are not required
for a fresh-clone handoff and are never treated as durable evidence.

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
- This proved media bytes/publication were healthy but did not complete MIU 8. At that import
  checkpoint, Gallery still auto-panned a 200% hover background and mounted all thumbnails; MIU 8
  subsequently removed both behaviors.

## Approved G3 Package

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
- Recorded browser evidence at 1440x900 showed desktop mode, non-overlapping brand/nav/account
  regions, zero horizontal overflow, and Inter price/action typography at weights 600/500.
- Recorded browser evidence at 390x844 showed the native menu open, zero horizontal overflow, and
  an independently scrollable menu region. The Deploy Test run above is the durable executable
  source; local screenshots are optional worktree artifacts rather than fresh-clone dependencies.
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
| 6 | Complete | Abortable catalog page client with fresh-session and media normalization tests |
| 7 | Complete and deployed | Runtime/content release `9c126d5`; Deploy Test `30813825143` |
| 8 | Complete; deployment pending | ProductMedia and bounded Gallery |
| 9 | Complete and deployed | Commit `887ffac` + review closure `88d87dd`; release `bbd6dcb` |
| 10 | Complete and deployed | Commit `aa57434` + review closure `88d87dd`; release `bbd6dcb` |
| 11 | Complete and deployed | Commit `a94c55a` + review closure `88d87dd`; release `bbd6dcb` |
| 12 | Complete and deployed | Commit `c20a93a` + review closure `bbd6dcb` |
| 13 | Complete and deployed | Commits `01cd72f` + `199a00f` + closure `7a844c2`; release `55937bd` |
| 14 | Revalidated green at `55937bd` | Existing commits `ce19963` + `27c70c0`; no edit |
| 15 | Revalidated green at `55937bd` | Existing commit `3feeb60`; no edit |
| 16 | Revalidated green at `55937bd` | Existing commit `26a636a`; no edit |

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

Deployment correction: initial MIU 5 SHA `1bcda25` built, deployed, and passed CloudBase smoke in
Deploy Test run `30797599579`, but the authoritative public E2E failed the new no-JavaScript
horizontal-overflow assertion. Live 390px diagnosis found the hidden, absolutely positioned
desktop nav extended to 480px while the body itself fit at 374px. The header's measurement lanes
now use fixed positioning while hidden, preserving their intrinsic widths for `desktopFits()` but
removing them from document scroll overflow; desktop mode still restores static visible layout.
The reveal plus calibrated header regression suite passes 9/9 after this correction.

Codex review status: PR #6 is open, clean, and mergeable. `@codex review` was posted twice, but as of
this MIU boundary GitHub REST, GraphQL timeline/review threads, check runs, and the rendered PR page
contain no Codex-authored review payload. No finding was invented or silently attributed to Codex;
the request remains active for the updated PR head.

Deviations: the approved MIU listed `global.css` and `public.spec.ts`. Review proved the existing
BaseLayout controller was the owning lifecycle surface, so `BaseLayout.astro` became the necessary
third implementation file. The deployed no-JavaScript overflow gate then exposed a pre-existing
SiteHeader measurement-lane defect, making `SiteHeader.astro` the required fourth implementation
file. This execution record is the fifth and final file in the phase.

Result: MIU 5 requires the reviewed header follow-up commit and a green replacement Deploy Test
before completion.

Replacement deployment result: follow-up `05de95b` passed push CI `30799180670`, PR CI
`30799183303`, and replacement Deploy Test `30799180632`, including public browser E2E. Live
health reports the exact release; no-JavaScript and reduced-motion reveal content computes to
opacity `1`/transform `none`, and the 390px document no longer overflows. A visual explanation with
tracked before/fixed screenshots is available in [MIU5-REVEAL-EVIDENCE.md](MIU5-REVEAL-EVIDENCE.md).

## Responsive Headphones detail note - planned ownership

The reported medium-breakpoint product-detail overflow (long copy/spec rows and horizontal
thumbnail strip extending beyond the detail band) is already inside the approved replacement
architecture and is not hotfixed in the current monolith:

- MIU 8 owns responsive contained media, the 520px frame cap, four-preview limit, bounded wrapping
  `View All`, and browser overflow assertions at 390/768/1024/1440px.
- MIU 11 replaces the current detail presentation with composed Gallery/spec/pricing structure.
- MIU 13 wires the responsive detail controller and browser focus/overflow lifecycle.

The screenshot symptom is now an explicit acceptance example for those MIUs: at medium widths,
long product text must wrap within `min-width: 0` content tracks, spec values must wrap rather than
widen the band, thumbnail previews must wrap or stay within their bounded container, and
`scrollWidth <= clientWidth` must hold before and after `View All`. Fixing the soon-to-be-replaced
monolith now would duplicate MIUs 8/11/13 and risk conflicting implementations.

## MIU 6 - Abortable catalog page client

Status: Complete

Commit: code/test phase `7fa6d30` (`feat(catalog): support abortable page requests`); this tracked
record and MIU 5 visual evidence ship in the following docs-only commit.

What changed:

- Added an optional trailing `AbortSignal` to `fetchCatalog` and forwarded the exact signal to the
  native `fetch` call. Existing two-argument callers remain source-compatible.
- Preserved exact category/search/page/pageSize query construction, current-token lookup on every
  call, the existing `CatalogPage` envelope, and relative/absolute media URL normalization.
- Added complete typed Product/CatalogPage factories and three API tests for page 2/page size 48,
  signal identity, token replacement/removal, media normalization, and native AbortError
  propagation without a successful result.
- Made the existing relative API fallback importable under the Node test runner when Vite's
  `import.meta.env` is absent; production Vite builds still embed the configured API origin.
- Quoted the recursive site test glob so POSIX CI shells discover nested tests. The standard site
  command now runs 53 tests, including all three MIU 6 tests, instead of silently stopping at 44.

Tests written first: the client initially could not be imported outside Vite, then the signal test
failed and the abort test remained pending because no signal reached the fetch mock. After the
runtime fix, review added a 250ms watchdog so future missing-signal regressions fail promptly rather
than hanging CI.

Focused validation: standard `pnpm --filter @vibelingan-channel/site test` discovers and passes
53/53 tests; Astro check reports zero errors; focused Biome, production build, and diff checks pass.

Assumption/review result: behavioral contract PASS with no P1/P2. The canonical three-file core
boundary is `api.ts`, `api.test.ts`, and its typed factory. The completed implementation also
required two reviewed deviations: `api-url.ts` for the Node-import seam and `apps/site/package.json`
for shell-independent nested test discovery. The resulting historical implementation touched five
files. No dependency, lockfile, backend, route, DTO, or wire-shape change occurred.

Build/Deploy/Runtime result: site bundle and test-discovery change only. Superseded controller
requests can now be aborted; generation/state rules remain MIU 9/13 responsibilities.

Result: MIU 6 code and its tracked evidence were assembled and deployed at
`79d8a998d9c792f140c60d13b1786db3c2cf9f17` through Deploy Test run `30803899603`, including the
public browser gate and exact live-release verification.

## MIU 7 - Typed Headphones content and gated hero provenance

Status: Complete and deployed.

Commits: `2a3fe65` (`feat(headphones): define storefront content contract`), `3fffbae`
(`test(headphones): verify hero provenance policy`), and `3ed0c54`
(`fix(headphones): preserve content rollout boundary`), plus `0a32b77`
(`docs(headphones): close MIU 7 review findings`), the range-tip test/docs closure that hardens
media metadata policy and the portable handoff. This record-only commit pins that closure SHA and
does not change runtime behavior.

What changed:

- Expanded `HeadphonesContent` with typed hero, catalog recovery/pagination, detail media/navigation,
  and persistent OEM CTA copy so later Headphones presentation MIUs consume one content source.
- Added a fixed three-source tuple for product `0e0afdc26a6820b900523bfb27a9a5cd` with the reviewed
  ordered image IDs, 800x800 dimensions, and exact SHA-256 provenance. The content contains no media
  URL, storage path, byte buffer, encoded image, or copied asset.
- Added concise product-led hero/proof copy and the loading, error, retry, empty, Load More, detail,
  and OEM-enquiry labels required by MIUs 8-13. No advantage, quality, certification, or client
  section was introduced.
- Preserved the `79d8a99` values of the currently consumed `emptyLabel` and `inquiryCta`, plus
  `backLabel` for the inactive shared detail path. Future presentation copy lives on the new
  `emptyStateLabel`, `backToModelsLabel`, and `oemInquiryCta` keys until MIUs 10-11 migrate those
  consumers.
- Added a structured source-contract test that parses the complete YAML frontmatter with unique-key
  enforcement, deep-equals every section, and rejects unreviewed source count/order/fields plus
  URL/byte-bearing content.

Why: route-local copy and unconstrained media selection would let later hero/catalog/detail modules
drift from the reviewed product identity, security-gated media order, and content-ownership design.
The typed Markdown contract establishes those values before its consumers are decomposed.

Best-practice sources and exact rules:

- Applied: current TypeScript `readonly` tuple and `satisfies` guidance through Context7; current
  Astro typed eager Markdown import guidance through Context7; `ui-ux-pro-max` product-led copy,
  responsive hierarchy, meaningful alt, and content-ownership guidance.
- Applied: repository-declared `yaml@2.9.0` for structured source-contract validation rather than
  ad hoc frontmatter parsing; no new dependency or lockfile change was introduced.
- Not applicable: React render/effect/composition rules because this MIU adds no `.tsx` consumer or
  runtime interaction. MIUs 8-13 own rendering, fallback progression, pagination, and focus.
- Rejected with reason: storing absolute service URLs, signed URLs, media bytes, static copies, or
  path/href fields in the hero object; URL construction remains code-owned. Existing `shopNav.href`
  navigation values are legacy content outside the hero-media policy and remain unchanged.

Tests written first: both focused tests failed before implementation because no typed `hero`
contract or recovery/navigation/OEM CTA content existed. Review then found color-specific shared
alt text and source-regex false-green paths; the final test parses and deep-equals the complete
frontmatter and the shared alt is source-neutral.

Focused validation: 2/2 MIU 7 tests; 55/55 standard site tests; Astro check with zero errors;
focused Biome; the 16-MIU mechanical validator; and the 18-page production Astro build pass.
Full non-browser validation passes 344 tests (15 deployment contracts plus 329 workspace tests),
all nine package/application typechecks plus E2E TypeScript, 202-file Biome, both Node 20 function
builds, and both cold-start artifact smokes.

Browser validation: the first 31-test run mixed a localhost site with the live allowlisted API;
27 page tests passed, two credential-gated cases skipped, and the two expected cross-origin API/
catalog cases failed because the live function returned `Access-Control-Allow-Origin` for the
custom domain. That evidence was rejected as an environment mismatch. A fresh build then used an
isolated local API on a temporary JSON database with the same public handlers and wildcard local
CORS: all 30 runnable public browser tests passed, including Headphones hydration, catalog/public
projection, media headers, and member VIP pricing; one CloudBase-only loading-state test skipped.
The temporary services were stopped and the temporary database removed. Deploy Test `30813825143`
then passed on exact runtime/content SHA `9c126d5febe49587d4ce6094d274e10c43803547`, including
CloudBase deployment, deployed smoke, Chromium installation, and public browser E2E.

Live provenance validation: each gated image was downloaded independently after immutable review;
all three returned `image/jpeg`, decoded at 800x800, and produced the exact recorded SHA-256 values:
`c214432ede60268b25c7001dc06873240a533094c3adc89760df95c2f4e7179c`,
`154a9b12ac090bcb8330c5ec968077caf90eaece14cbdc8ce87d8fc477062241`, and
`e4480b78b451261611e74a373ab84048dded0fe255803315247d444bf41c1de6` in fallback order.

Assumption check: final PASS with no P1/P2/P3. Independent code/test review also found no remaining
P1/P2/P3 after exact tuple length, whole-frontmatter shape, duplicate-key, URL/bytes, alt-text, and
MIU 6 metadata-history corrections.

Cross-file traces:

```yaml
cross-file-reasoning:
  scope: headphones.ts -> content/headphones/en-US.md -> later MIUs 8-13
  symbols-traced:
    - name: HeadphonesHeroSource / HeadphonesContent
      type: typed-content-contract
      trace: exact Markdown frontmatter -> eager Astro loader -> existing route/island -> planned consumers
      verdict: PASS
  failure-mode-matches: []
  verdict: PASS
```

No environment variable, route, SDK option, event, class mock, conditional effect, or async wrapper
changed. Existing consumers compile because the additions are read from the complete locale object;
the legacy `zoomHint` remains until MIU 8 removes its two current Gallery consumers.

Build/Deploy/Runtime result: site content/build only; no currently rendered consumer reads the new
hero/recovery/CTA fields, so this MIU intentionally has no visible pixel change. Hero bytes remain
behind the existing public image gate when MIU 12 consumes the IDs. No API, schema, environment,
authorization, media-gate, dependency, route, or static-asset change occurred.

Deviations: the approved future contract removes hover zoom, but deleting `zoomHint` here broke the
current `HeadphonesPage` and `ProductDetail` consumers. The conservative choice keeps that existing
field unchanged; MIU 8 removes it together with automatic Gallery magnification. MIU 6 metadata was
also repaired to preserve a valid three-file core plan while explicitly retaining its two reviewed
historical deviations and five-file implementation truth.

Result: MIU 7 implementation/review code is complete across `2a3fe65`, `3fffbae`, `3ed0c54`, and
the pinned test/docs closure. Runtime/content SHA `9c126d5febe49587d4ce6094d274e10c43803547`
passed push CI `30813825290`, PR CI `30813827434`, and Deploy Test `30813825143`. Live health
reports that exact release; `/api/products?page=1&pageSize=12` preserves the catalog envelope; the
custom-domain Headphones route returns 200 with its pre-MIU-7 visible copy unchanged. MIU 7 itself
has no visible pixel change; later presentation MIUs may change the catalog, Gallery, detail, and
hero independently.

## MIU 8 - ProductMedia and bounded Gallery

Status: Complete locally after immutable-review hardening; final closure deployment pending.

Commits: `4f35201` (`feat(headphones): bound product gallery media`), `9aed7b0`
(`test(headphones): preserve gallery behavior`), and `3e0837a`
(`refactor(content): remove retired gallery zoom copy`), `5ad9036`
(`docs(headphones): close MIU 8 review`), `ea4869e`
(`fix(catalog): enforce image count boundary`), `688e35c`
(`fix(media): announce unavailable products`), `b559f7e`
(`feat(content): add gallery collapse label`), `7a1f3db`
(`fix(gallery): reset and bound product media`), `3e1cb25`
(`test(gallery): preserve bounded interactions`), and `4864f7c`
(`fix(admin): enforce catalog image capacity`), `64c6b4f`
(`docs(headphones): finalize MIU 8 closure`), `539be61`
(`refactor(media): canonicalize catalog image ids`), `d5990da`
(`refactor(catalog): define public collection boundary`), `3fdf598`
(`fix(media): align catalog visibility counters`), and `59149aa`
(`fix(gallery): preserve selected thumbnail`), plus this final tracked reconciliation.

What changed:

- Added `ProductMedia`, a keyed ordered-source session with a pure reducer. Each failed source
  index advances once, repeated URLs remain distinct ordered attempts, stale/duplicate events are
  ignored, and exhaustion renders a branded square fallback without another media request.
- Replaced Gallery's pointer-driven 200% background zoom and eager full thumbnail row with a
  contained square main frame capped at 520px, four lazy low-priority previews, and an inline
  wrapping `View All` disclosure. No modal, transform URL, derivative, retry, or media-gate change
  was introduced.
- Added selected-state and keyboard contracts: thumbnails expose `aria-pressed`; `View All`
  remains mounted, controls the thumbnail region with `aria-expanded`/`aria-controls`, retains
  focus after expansion, and uses visible `focus-visible` rings.
- Wired the existing typed `viewAllLabel` and `imageUnavailableLabel` content into the live
  Headphones Gallery and made detail scrolling immediate under `prefers-reduced-motion: reduce`.
- Removed the retired `zoomHint` prop and locale/type fields from Gallery, its remaining detail
  callers, and the Headphones/Overstock content contracts.
- Added one shared 18-image policy. Products/overstock write schemas reject oversized arrays while
  preserving historical malformed-value compatibility; public list/detail projection filters
  malformed IDs before capping; Gallery clamps defensively; and `ImageManager` consumes the same
  registry metadata before minting uploads.
- Centralized filtering, trimming, order preservation, duplicate preservation, and the 18-image cap
  in `normalizeCatalogImageIds`; declared `PUBLIC_CATALOG_COLLECTIONS` once for products and
  overstock. Public projection, legacy absent-counter scans, online admin refcount updates, and DB
  reconciliation now consume the same contract, with per-document deduplication only after
  normalization.
- Stabilized legacy image-visibility pagination with `_id asc` and aligned both online and backfill
  counters to the explicit public collection scope. This prevents fields outside the canonical
  prefix, malformed IDs, or non-public collections from keeping media visible accidentally.
- Keyed Gallery by product ID plus ordered media, added localized `Show Less`, and preserved focus
  through collapse/re-expand and same-media product reset.
- Kept an active image beyond the first four represented by one selected thumbnail after collapse;
  duplicate URL occurrence keys now derive from the full ordered list, so React cannot transfer a
  prior occurrence's `ProductMedia` fallback state to the selected row.
- Replaced fallback-only semantics with one persistent polite announcement that updates after
  source exhaustion while decorative thumbnail failures remain hidden.
- Hardened admin capacity UX with whole-batch reservations, single-claim retries, stale-attempt
  rejection, failed-upload discard/replacement, one preview request per ID, visible/live notices,
  and keyboard-only recovery from a historical 19-image record.

Why: the previous Gallery cropped originals, mounted every thumbnail, and hid the main image behind
a pointer-following 200% background. That produced the reported image-only scrolling sensation,
unbounded requests for 18-image products, and no deterministic terminal state when media failed.

Best-practice sources and exact rules:

- Applied: `VR-derived`, `VR-event`, `VR-ref`, `VR-memo`, `VR-conditional`, `VC-variants`,
  `EC-async`, `EC-aria`, `EC-e2e`, current Web Interface Guidelines, `ui-ux-pro-max`, and the
  approved Gallery design/acceptance record.
- Applied: keyed component reset rather than prop-mirroring effects; event-driven selection and
  expansion; semantic buttons; intrinsic media dimensions; meaningful/decorative alt separation;
  explicit reduced-motion behavior; stable occurrence keys for repeated image URLs.
- Not applicable: bundle splitting, virtualization, image derivatives/transforms, RSC/Suspense,
  memoization, pointer refs, modal focus trapping, or new dependencies. The approved maximum is 18
  thumbnails and all expansion stays in the existing site bundle.
- Rejected with reason: preserving hover magnification, fetching all thumbnails while hidden, or
  bypassing `/api/images/:id`; each contradicts the reviewed interaction, request, or security
  boundary.

Tests written first: the initial compiler failed because `ProductMedia`, `GalleryThumbnailList`,
and `viewAllLabel` did not exist. Focused tests then exposed and closed a missing intrinsic
`object-contain` baseline, repeated-URL fallback stalls, fallback geometry, disclosure semantics,
typed caller-copy wiring, reduced-motion scroll selection, and per-index image remount identity.

Focused validation: the exact `59149aa` code head passes 15/15 deploy-smoke tests, 75/75 shared,
42/42 public-api, 139/139 admin, and 70/70 site tests. All nine package/application typechecks plus
E2E TypeScript report zero errors; repository Biome checks 205 files; the CloudBase SDK contract
passes; both Node 20 function artifacts build and cold-start from isolated packages; and the
18-page production site build passes.

Browser validation: an isolated Playwright catalog with six media sources passed at 390x844,
768x1024, 1024x768, and 1440x900. Initial detail mounted one main image plus four previews; `View
All` exposed all six inline; frames measured 358/520/460/520px square respectively; every viewport
retained `scrollWidth <= clientWidth`, `object-fit: contain`, keyboard focus/selection state, and no
dialog. Fine-pointer movement changed no image geometry, opacity, transform, background, or scroll
offset. A forced 404 reached the stable fallback with two bounded requests and no loop. Reduced
motion computed `transition-property: none`. The same scenario is now committed in
`tests/e2e/public.spec.ts`: it uses real pointer movement, computed focus/selection visuals,
CloudBase admission-page handling, exact two-request fallback accounting, and a mounted source-list
reset between products with identical media, localized collapse/re-expand focus, and bounded
request multiplicity. A second non-mutating browser scenario mounts the real AdminApp/RecordForm/
ImageManager with intercepted admin/storage calls and verifies a 19→17 keyboard recovery, exactly
one preview request per persisted ID, 20-file admission capped at 18, duplicate retry suppression,
failed-item discard, and replacement. Both scenarios pass locally and repeated review runs.
The final assembled rerun executed both focused Chromium scenarios together at `59149aa`: 2/2
passed in one worker against a fresh isolated Astro server.

Assumption check: the first audit blocked duplicate-URL progression, fallback geometry, disclosure
state/focus, reduced motion, and typed-copy wiring; all production findings were repaired. The
final audit found no P1 production issue. Later immutable review rounds challenged one-off evidence,
same-media reset, unavailable-state semantics, the unenforced 18-image rationale, request-budget
false-greens, no-op disclosure behavior, and admin producer UX. Each finding received a failing
focused or mounted browser test before correction. Final per-phase reviews report no P1/P2 finding.

Cross-file traces:

```yaml
cross-file-reasoning:
  scope: ProductMedia.tsx -> Gallery.tsx -> HeadphonesPage.tsx -> typed HeadphonesContent
  symbols-traced:
    - name: ProductMedia / productMediaReducer
      type: component-state-contract
      trace: ordered normalized URLs -> keyed session -> per-index error event -> terminal fallback
      verdict: PASS
    - name: viewAllLabel / imageUnavailableLabel
      type: typed-content-consumer
      trace: en-US Markdown -> HeadphonesContent -> HeadphonesPage -> Gallery
      verdict: PASS
    - name: detailScrollBehavior
      type: conditional-effect
      trace: card event -> current reduced-motion media query -> smooth|auto scrollIntoView
      verdict: PASS
    - name: CATALOG_IMAGE_MAX_COUNT / FieldDef.maxItems
      type: producer-consumer-policy
      trace: shared 18 -> products/overstock write metadata -> public projection -> Gallery -> ImageManager
      verdict: PASS
    - name: normalizeCatalogImageIds / PUBLIC_CATALOG_COLLECTIONS
      type: projection-counter-reconciliation-policy
      trace: shared policy -> public projection + legacy scan -> admin online deltas -> DB backfill
      verdict: PASS
    - name: productId / showLessLabel
      type: component-lifecycle-content
      trace: catalog identity + typed locale -> caller -> keyed Gallery session + disclosure
      verdict: PASS
    - name: VisibleGalleryThumbnail.key
      type: react-list-lifecycle
      trace: full ordered occurrence identity -> collapsed visible subset -> ProductMedia key/state
      verdict: PASS
  failure-mode-matches: []
  verdict: PASS
```

No environment variable, route, SDK option, backend event, auth rule, API envelope, database
migration, media-authentication mechanism, or storage URL contract changed. The visibility-gate
policy intentionally narrows: malformed, over-cap, and non-public-collection references can now
change `/api/images/:id` from 200 to 404. The shared registry gained optional array-cardinality
metadata and an explicit public-catalog scope; existing malformed legacy values remain compatible
but no longer extend public projection or refcounts beyond the canonical prefix.

Build/Deploy/Runtime result: the assembled range changes the admin and public-api function artifacts,
shared validation/reconciliation behavior, local parity server behavior through its delegated
function/DB paths, the site bundle, and browser contracts. Deployment must therefore update both
CloudBase functions and the site together. It remains pending until the final closure SHA passes
push CI, Deploy Test, exact live-release verification, public projection/image visibility checks,
and the narrow Headphones Gallery/admin-capacity smokes.

Deviations: the approved MIU named a three-file core, but review proved two acceptance requirements
lived at the existing caller: typed Gallery copy and reduced-motion detail scrolling. Immutable
review then required durable public E2E coverage, removal of compatibility copy, enforcement of the
documented 18-image maximum at every producer/consumer, reliable fallback announcements,
product-aware reset/collapse, admin capacity recovery, canonical normalization/scope, visibility
counter parity, and duplicate-safe selected collapse. The work was split into fifteen committed
phases with 5/5/5/3/5/3/3/5/1/4/3/2/2/5/3 files, as recorded in Git and the canonical breakdown.
MIU 9 still owns pagination state, request generations, and stale-commit rejection; MIU 13 owns
controller consumption, request abort wiring, and the complete card/detail-heading/Back focus cycle.

Result: MIU 8 is locally complete across fifteen implementation/review commits. This final tracked
reconciliation is pending its isolated documentation commit; that resulting combined SHA must pass
immutable review, push, Deploy Test, and live verification before MIU 9 begins.

## MIU 9 - Headphones Load More state reducer
Status: complete (implementation); adversarial-review corrections closed in `88d87dd`.
Commit: `887ffac`
What changed: new pure module `headphonesCatalogState.ts` + unit suite. Deterministic state for
loaded products, total, next page, request generation, initial/loading-more/error status, and
active product id. Offset pagination modeled as eventual consistency: unseen ids append in
first-seen order, duplicates are discarded, next page always advances, total follows the latest
server report; an empty committed page is terminal (total clamps to loaded so `hasMore` ends
rather than live-looping on an unreachable counted document — added by the review round).
Why: MIU 9 spec; replaces the monolith's fetch-all snapshot claim.
Best-practice sources and exact rules: engineering-craft request-generation/stale-commit-rejection
group applied; react sources not applicable (no `.tsx`).
Tests written first: yes — red run (missing module) preceded implementation.
Focused validation: reducer suite green; site tests, `astro check`, Biome green at commit.
Assumption check: generation guard proven load-bearing by mutation only AFTER the review round
added the fresh-generation-loading stale-commit tests; original stale tests were status-guard
vacuous (P1 test-quality finding, fixed).
Cross-file traces: consumes `CatalogPage`/`Product` from `catalog-types.ts` only; no shape
redeclared; controller consumption lands in MIU 13.
Build/Deploy/Runtime result: site bundle only; not yet deployed (deploys with the assembled
MIU 13 range).
Deviations: exhaustion clamp added beyond the literal spec after the adversarial review proved the
Load More live-loop scenario.
Result: complete pending the assembled-range deploy.

## MIU 10 - HeadphonesCatalog and HeadphonesProductCard render contract
Status: complete (implementation); review corrections closed in `88d87dd`.
Commit: `aa57434`
What changed: presentational `HeadphonesCatalog.tsx` + `HeadphonesProductCard.tsx` +
`headphones-catalog-render.test.ts`. Four mutually exclusive branches (polite-status loading
skeleton, actionable initial-error alert with retry, OEM-linked empty state, category-grouped
cards), result progress from the `{loaded} of {total}` content template, busy/disabled Load More
gated on `hasMoreProducts`, recoverable load-more alert beside usable cards. Card is a semantic
in-page expansion button using ProductMedia (lazy/low priority) with calibrated hierarchy
(identity strongest, price `text-sm font-semibold` = 14px/600, action `text-xs font-medium` =
12px/500) and the existing `data-product-card*` anchors.
Why: MIU 10 spec.
Best-practice sources and exact rules: vercel react-best-practices (presentational purity, key
stability) and composition-patterns (contract props, no shape redeclaration) applied;
ui-ux-pro-max hierarchy rules per DESIGN.md.
Tests written first: yes — 12 render-contract tests.
Focused validation: render suite green; full site suite, `astro check`, Biome green at commit.
Assumption check: grouping order was under-pinned (review P2) — the suite now asserts
single-heading-per-category and in-group placement of late-arriving cards.
Cross-file traces: props typed as `HeadphonesContent['list']` + `HeadphonesCatalogState`;
`OEM_INQUIRY_HREF` consumed from `site-navigation.ts`.
Build/Deploy/Runtime result: site bundle only; components unmounted until MIU 13.
Deviations: none beyond the strengthened tests.
Result: complete pending the assembled-range deploy.

## MIU 11 - HeadphonesProductDetail presentational contract
Status: complete (implementation); review corrections closed in `88d87dd`.
Commit: `a94c55a`
What changed: presentational `HeadphonesProductDetail.tsx` + `headphones-detail-render.test.ts`.
Gallery media contract, spec sheet, PriceBlock entitlement (locked VIP chip now renders with
`signInHref={null}` per the MIU acceptance line "output contains no /login" — review P2), a
programmatically focusable `data-detail-heading`, a `data-detail-back` BUTTON (pinned as a button,
never a navigation anchor), and every enquiry command as an anchor to `/#oem-inquiry`. Both detail
columns are `min-w-0` tracks, now carrying `data-detail-media-column`/`data-detail-info-column`
so the wrap contract is pinned structurally.
Why: MIU 11 spec.
Best-practice sources and exact rules: as MIU 10, plus web-design-guidelines focus-target and
in-page-disclosure semantics.
Tests written first: yes — 5 render-contract tests (strengthened to 5-with-teeth by the review).
Focused validation: detail suite green; full site suite, `astro check`, Biome green at commit.
Assumption check: the /login-in-output conflict between "existing PriceBlock behavior" and the
explicit no-/login acceptance line was adjudicated to the explicit line, using the established
`signInHref={null}` suppression pattern from `ProductCard.tsx`.
Cross-file traces: consumes `HeadphonesContent['detail']`, Gallery/PriceBlock props verified
against their real prop types; category label resolved by the caller.
Build/Deploy/Runtime result: site bundle only; unmounted until MIU 13.
Deviations: `Product Code` spec-row label remains hardcoded (no matching content key exists);
flagged for a content follow-up rather than inventing a semantic mismatch with `modelLabel`.
Result: complete pending the assembled-range deploy.

## MIU 12 - Headphones Astro hero and focused shell
Status: complete; deployment pending (assembled range deploys after MIU 13).
Commit: `c20a93a`
What changed: `headphones.astro` hero now consumes `hp.hero` (content contract) exclusively —
eyebrow/heading/body/proof/CTAs — and renders real product media through `ProductMedia
client:load` over the three reviewed gated 800x800 sources built via
`apiMediaUrl('/api/images/<id>')`, with reserved geometry, eager/high priority, ordered fallback,
and terminal branding. Mobile: 34px H1, 160-180px media before a compact proof/CTA row; desktop:
55/45 unframed grid-area composition. Island switched `client:only` -> `client:load` (SSR +
hydrate) with a `noscript` recovery link to the OEM enquiry section. No standalone
quality/certification/client band exists on the route. The source-contract test pins hero copy to
the content contract and the gated media wiring.
Why: MIU 12 spec + ui-design responsive acceptance matrix.
Best-practice sources and exact rules: vercel react-best-practices (SSR hydration safety,
resource priority), PERFORMANCE.md budgets (single eager hero request, no derivative), DESIGN.md
hero composition.
Tests written first: yes — the hero E2E block (SSR presence, mobile order, hint visibility
without overflow, single-source 404 -> second source, all-404 -> terminal fallback without a
request loop, no quality/cert/client bands) failed before the astro rewrite.
Focused validation: hero E2E green; full public E2E green page-level (one pre-existing homepage
carousel timing flake under zero-retry local runs, absent in CI's retry config); site suite 105,
`astro check` 0 errors, Biome clean, production build 18 pages.
Assumption check: the E2E exposed a REAL progressive-enhancement defect — a server-rendered image
that fails before hydration attaches onError never advances the ordered fallback (the error event
is not replayed). Fixed inside ProductMedia with a hydration-time `complete && naturalWidth === 0`
check; this is a deliberate, reviewed touch on the MIU 8 component surface justified by MIU 12
introducing its first SSR consumer.
Cross-file traces: `hp.hero.sources` -> apiMediaUrl -> ProductMedia sources; hero copy keys exist
in the locale content file; island props unchanged (advantages/CTA wiring retained until MIU 13).
Build/Deploy/Runtime result: site bundle only; hero bytes stay behind the public image function
with refcount revocation.
Deviations: gallery E2E no-hover-zoom sampling hardened (settle scroll, hover before sampling) —
its invariant was racing Playwright's own actionability scroll after the hero height change.
Result: complete pending the assembled-range deploy; MIU 13 remains the final wiring unit.

## MIUs 9-12 review closure and deployment
Status: complete and deployed.
Commit/release: `bbd6dcb` (`fix(shop): close adversarial review findings on MIU 12`).
Deploy Test: run `31026614725`, all gates green on the first attempt, including the public
browser E2E suite.
Live verification (custom domain, test CloudBase env):
- `GET /api/health` reports releaseId `bbd6dcb...`, buildTime 2026-08-05T16:44:15Z.
- `GET /headphones` raw HTML contains `client="load"` and a server-rendered
  `data-product-media="image"` whose `src` is the first reviewed gated source
  (`0e0afdc26a68209e00523aa031e56460`) — i.e. the SSR hero contract holds in production.
- That gated image returns HTTP 200, 63062 bytes, `image/jpeg` through the public image function,
  so refcount-gated delivery still serves real product media.

Review rounds behind this release:
- MIUs 9-11: 20-agent adversarial review; 6 confirmed findings closed in `88d87dd` (P1 vacuous
  generation-guard tests, Load More empty-page live-loop, `/login` leak in detail output, and three
  under-pinned assertions).
- MIU 12: 3 reviewers. The ProductMedia hydration-time broken-image check was probed across
  chromium/firefox/webkit (dimensionless SVG, lazy-deferred, `display:none`, async-decode,
  in-flight) and returned NO defect — no valid image can be misread as failed. Five real defects
  closed in `bbd6dcb`: the hero SSR assertions could not fail (now assert `client="load"` plus a
  server-rendered `data-product-media="image"`; mutating back to `client:only` was verified to fail
  the test), a dead `data-certifications` assertion removed, source-0-first now pinned, the mobile
  media band tightened to the matrix's 160-180px, the gallery no-hover-zoom invariant restored
  (sample outside hover; raw `page.mouse.move` avoids the actionability-scroll race; snapshot now
  records the CSS `scale` property because Tailwind v4 `scale-*` does not touch `transform`), the
  noscript block's false "no models available" claim replaced and its never-resolving SSR skeleton
  hidden, and hero width/height sourced from `hp.hero.sources[0]`.

Known follow-ups carried into MIU 13:
- The noscript recovery sentence is a route-local literal; fold it into the content contract when
  MIU 13 removes route-local `PageStrings`.
- The island still SSRs its loading skeleton (2 nodes) and still renders advantages + InquiryForm;
  MIU 13 owns removing them.

## MIU 13 - HeadphonesPage Load More and focus controller
Status: complete; deployment pending at time of writing (ships with this range).
Commits: `01cd72f` (controller), `199a00f` (required browser coverage), `7a844c2` (review closure).
What changed: the monolith became a thin controller owning fetching, request generations,
abortion and the focus lifecycle, delegating all presentation to HeadphonesCatalog and
HeadphonesProductDetail. Route-local `PageStrings`, InquiryForm, the advantages band and all React
`.reveal` are gone; 12-item user-triggered pagination; generation reset on auth identity change
with AbortController supersede; focus cycle card -> detail heading -> Back -> origin card;
interaction-gated Gallery mounting.
Why: MIU 13 spec.
Tests written first: partially — the controller landed before its required browser coverage, which
is a real deviation from the MIU's own test plan. Closed in `199a00f`: route-mocked pagination
(one initial call at pageSize=12, recoverable load-more error keeping cards, page-2 retry,
overlapping-page dedup 12+11=23) and a 768/1024px keyboard/budget test (focus round trip, no
gallery thumbnail before selection, active image + <=4 previews after, no high-priority image
outside the hero, every detail enquiry link to the OEM anchor, advantages absent, no horizontal
overflow before or after View All).
Focused validation: monorepo typecheck, e2e tsc, 105 site unit tests, Biome, site build, and the
full public Playwright suite (34 passed / 2 skipped / 0 failed).
Assumption check: implementation-time browser runs caught a real defect — `setState` updaters run
asynchronously, so reading the new generation out of one handed the fetch a stale generation and
the reducer's own guard rejected every commit (the catalog rendered zero cards). Transitions are
now computed against a render-synchronised `stateRef` before dispatch.
Review round (2 agents): the async core was attacked and CONFIRMED correct — stateRef mirror,
abort-then-replace, cleanup-vs-next-effect ordering, identity-string stability (SessionUser.id is
always populated, so no collision and no spurious reset), fetchCatalog abort semantics, nextPage
arithmetic, and effect dependencies were each disproved as defects. Five real findings closed in
`7a844c2`: raw transport error text rendered instead of authored copy; re-activating the
already-open card was a dead interaction (focus effect keyed on an object identity that does not
change — now an open token, with a browser assertion); a cross-tab auth change unmounted an open
detail band and stranded focus on `<body>` (now rescued to the catalog heading); reduced motion
not honoured on skeleton pulse, card lift and image zoom; missing explicit focus-visible rings on
card/Back/Load More/Retry, plus `CSS.escape` on the origin-card selector and a retry guard
symmetric with Load More.
Cross-file traces: consumes `fetchCatalog`/`CatalogPage` from api.ts, reducer state from
headphonesCatalogState.ts, content from i18n/headphones.ts, presentation from
HeadphonesCatalog.tsx / HeadphonesProductDetail.tsx. No shape redeclared.
Build/Deploy/Runtime result: site bundle only; no route, API, or authorization change.
Deviations and known follow-ups: tests followed rather than preceded the controller (recorded
above); `Product Code`, the `model`/`models` plural and Gallery's thumbnail `aria-label` remain
English literals with no content keys; the refactor orphaned `list.filterLabel`, `list.allLabel`,
`list.resultsLabel`, `list.emptyLabel`, `detail.backLabel`, `detail.modelLabel`,
`detail.oemInquiryCta`, `detail.notFound` and the whole `inquiry.*` block as unread typed surface.
Result: MIU 13 complete; MIUs 14-16 revalidation is the remaining work.

## MIU 13 deployment and MIUs 14-16 revalidation
Status: complete. Release `55937bd`; Deploy Test run `31033460480` passed every gate on the first
attempt, including the full public browser E2E suite.
Live verification (custom domain, test CloudBase env):
- `GET /api/health` reports releaseId `55937bd...`, buildTime 2026-08-05T18:11:17Z.
- `GET /headphones` raw HTML carries `client="load"` twice (hero media + catalog island), the
  server-rendered hero `data-product-media="image"`, and the new `data-catalog-heading` focus
  target — i.e. the MIU 13 controller is the one actually serving production.

### MIU 14 - CloudBase Headphones route smoke revalidation: GREEN, no edit
- `pnpm test:deploy-smoke`: 15 tests, 15 passed.
- `node --check scripts/smoke-cloudbase-deploy.mjs` parses under the current Node.
- Source contract intact: `/headphones` has a real 200 assertion (smoke-cloudbase-deploy.mjs:136)
  and `/overstock` remains asserted 404 (:131).
- The assembled deployed smoke ran inside run `31033460480` against the real routes, drained
  response bodies, and exited naturally. No drift; per the MIU's own instruction no diff was
  manufactured.

### MIU 15 - Current deployment documentation revalidation: GREEN, no edit
- `CLOUDBASE_DEPLOYMENT_DESIGN.md`, `CLOUDBASE_DEPLOYMENT_EXECUTION.md` and `CICD_DESIGN.md` each
  already state `/headphones` 200 and `/overstock` 404, with the OEM-refresh dual-404 finding
  explicitly labelled superseded rather than rewritten.
- Scoped grep for contradictory current-route claims (headphones-404, public bucket access,
  bypassed refcount gating) returned only the correct split-outcome statements.
- Every referenced repository script resolves: `scripts/smoke-cloudbase-deploy.mjs`,
  `deploy-cloudbase-test.mjs`, `cloudbase-nosql-resources.mjs`, `set-cloudbase-github-secrets.mjs`;
  package scripts `test:deploy-smoke`, `smoke:cloudbase`, `deploy:cloudbase:test`,
  `verify:cloudbase-sdk`, `test:e2e:public` all exist.
- `git diff --check`: clean.

### MIU 16 - Canonical production-readiness route revalidation: GREEN, no edit
- `CICD_PRODUCTION_PLAN.md` already pins the current production definition of done as
  `/`, `/admin`, `/login`, `/oem`, `/portfolio`, `/headphones` -> 200 and `/overstock` -> 404, and
  classifies the earlier dual-404 record as superseded history (PD-1). It is consistent with the
  MIU 14 smoke and the MIU 15 documents, so the canonical plan will not instruct a future operator
  to re-retire Headphones.

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
