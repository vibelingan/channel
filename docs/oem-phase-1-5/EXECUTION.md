# OEM Phase 1.5 — Execution Plan & Living Log

Status: Complete — Slides 2–16 are delivered to the CloudBase test environment; Slide 1 AI customer service remains deferred.
Branch: `dev/albertli/oem-phase1-5-adjustments`
Base: `origin/dev/albertli/oem-phase1@3d57384`
Requirements: `channel-oem-review/client-revision-2026-07-15/06-CLIENT-REVISION-DETAILED-ANALYSIS.md`
AI customer service: Deferred; not part of this branch.

## Scope lock

- Restore the historical CHANNEL wordmark from `6f73bfc`; retain `Diversity Technology Limited` beside it and remove only the MOQ from the header.
- Keep the existing hero background, colors, and visual content; make the hero fill the viewport below the fixed header.
- Put OEM Development first and route it to `/oem#what-we-do`.
- Replace the old What We Do/One-Stop content with one shared Traditional-vs-AI workflow component on homepage and OEM page; retain the separate 10-step process.
- Apply the confirmed Factory, Our People, Why Choose Us, and Quality copy; remove homepage Product Capability and Teardown/Blue Ocean teasers.
- Embed the full existing `ProjectForm` on the homepage at `#oem-inquiry`; route confirmed OEM-intent CTAs there. Keep `/oem#submit` for the OEM page's own submit action.
- Canonicalize Success Stories on `/portfolio`: migrate corrected Sleep Clock + Disc Repair content and images, add 50+/30+/100+ stats, process all supplied certificate/patent/logo source assets, and redirect `/success-stories` to `/portfolio`.
- Small/medium certificate/logo presentation: accessible automatic carousel with pause and reduced-motion handling. Large screen: existing portfolio grid/lightbox.
- Remove listing stats strips from Teardown and Blue Ocean.
- Normalize experience to 20+ and response SLA to `within 24 hours` across UI, email, hidden storefront source copy, tests, and packaged artifacts.

## Deliberate non-goals

- No AI customer-service implementation.
- No real AI estimator; the AI quotation path is static marketing content.
- No database schema or CloudBase SDK contract changes.
- No production/main deployment; deploy only to the existing test environment after full validation.

## Phase boundaries

Each phase touches no more than five files. A phase is verified and presented before the next phase begins.

### Phase 1 — Header brand and viewport hero (complete)

#### MIU 1: Header brand contract + CHANNEL wordmark

- Block: FRONTEND
- Files:
  - `apps/site/src/i18n/brand-logo.test.ts`
  - `apps/site/src/components/SiteHeader.astro`
  - `apps/site/public/media/logo-channel.svg`
- Type: modify-existing
- Depends on: none

What it does:
- Pins the approved historical CHANNEL asset by hash and renders it with the legal company name in the desktop header.
- Removes the MOQ presentation while retaining a compatibility-only `showName?` prop for hidden legacy route files.
- Adds a full-width brand-blue lower border; uses larger/semibold nav text; orders OEM Development first without mutating content data.

Build/Deploy/Runtime impact:
- Static asset content changes at an existing URL. The CloudBase prune list must continue to exclude this path.
- No new dependency or backend change. Astro site build and hosting upload are affected.

Test plan (TDD — write first):
- Fails until `logo-channel.svg` hashes to the verified historical CHANNEL wordmark.
- Fails until the desktop header renders `brand.name`; fails while it renders `brand.minOrder`.
- Fails until the header uses the brand-blue border and OEM-first ordering logic.

Done when:
- Focused site unit tests pass.
- Astro typecheck/build pass and header renders correctly at mobile, transition, and wide desktop widths.

#### MIU 2: Fullscreen AIHero layout contract

- Block: FRONTEND
- Files:
  - `apps/site/src/i18n/brand-logo.test.ts`
  - `apps/site/src/components/AIHero.astro`
- Type: modify-existing
- Depends on: none

What it does:
- Keeps every existing visual background layer unchanged.
- Makes the hero occupy the viewport height remaining below the fixed header and vertically centers existing content.

Build/Deploy/Runtime impact:
- Static CSS utility change only; no dependency/runtime configuration impact.

Test plan (TDD — write first):
- Fails until the hero contains the `100svh - header` minimum-height contract.
- Asserts the existing dark/grid/glow visual signatures remain present.

Done when:
- Focused tests, Astro check/build, and browser viewport measurements pass.
- Hero has no horizontal overflow and respects mobile viewport sizing.

### Phase 2 — Shared What We Do + OEM anchor (complete)

- Define the shared workflow contract/content, implement a responsive comparison component, render it on homepage and OEM page, rename the OEM anchor to `what-we-do`, change nav to `/oem#what-we-do`, and keep the 10-step process.
- TDD covers exact client copy, shared source consumption, anchor existence, and nav target.
- Commit: `c1fdc1c` (`feat(site): add shared AI OEM workflow comparison`); five files.
- Result: one typed workflow source and one semantic comparison component now serve both pages, while the separate 10-step process remains intact.
- Assumption audit: **WARN, non-blocking** — exact-contract and rendered-copy warnings were fixed; dormant, unrendered legacy `oneStop` source remained outside the five-file Phase 2 boundary.

### Phase 3 — Homepage reductions and exact copy (complete)

- Apply Factory and Our People exact copy, order factory media, remove Product Capability and homepage teasers, apply Quality exact copy, and keep the 10-step process.
- TDD covers removed sections and exact-copy contracts.

#### Phase 3A — Factory and Our People copy + typed content (complete)

- Commit: `fabdf47`; five files: `OurTeamSection.astro`, `brand-logo.test.ts`, `en-US.md`, `site.ts`, and `index.astro`.
- Result: exact confirmed Factory and Our People copy is held in typed shared content; the Our People section consumes it and retains all six photos.
- Tests/validation: exact-copy, typed-consumer, four-stat, and six-photo contracts joined the final 21/21 site test run. Assumption audit: **PASS**.
- Engineering rationale: shared typed content prevents component-local copy drift.

#### Phase 3B — Quality copy + homepage-only removals (complete)

- Commit: `c18075e`; five files: `QualityTestingSection.astro`, `brand-logo.test.ts`, `en-US.md`, `site.ts`, and `index.astro`.
- Result: exact confirmed Quality copy is typed and rendered with all eight lab photos; Product Capability and both teasers were removed only from the homepage, with the required homepage flow retained.
- Tests/validation: exact-copy, typed-consumer, photo-count, removal, and retained-section contracts joined the final 21/21 site test run. Assumption audit: **PASS**.
- Engineering rationale: consumer removal was isolated from code deletion so independent surfaces could be proven before cleanup.

#### Phase 3C — Product Capability cleanup + Factory gallery (complete)

- Commit: `83d03a0`; five files: `FactorySection.astro`, deleted `ProductCapabilitySection.astro`, `brand-logo.test.ts`, `en-US.md`, and `site.ts`.
- Result: history- and consumer-traced Product Capability dead code was removed; Factory photos now follow the development-to-dispatch narrative with accurate alt text, and the gallery is a named, keyboard-focusable region.
- Tests/validation: dead-code, retained OEM-capability, exact photo-order/alt, and gallery semantics contracts joined the final 21/21 site test run. Assumption audit: **PASS**.
- Engineering rationale: only the retired homepage capability surface was deleted; independent OEM capability content remains.

#### Phase 3D — Retired teaser cleanup (complete)

- Commit: `ea1cb70`; five files: deleted `BlueOceanTeaser.astro` and `TeardownTeaser.astro`, plus `brand-logo.test.ts`, `en-US.md`, and `site.ts`.
- Result: history- and consumer-traced teaser dead code was removed while Teardown and Blue Ocean routes, data, and navigation remained.
- Tests/validation: deleted-component/type/content and retained-route/data/nav contracts joined the final 21/21 site test run. Assumption audit: **PASS**.
- Engineering rationale: homepage teaser ownership was removed without coupling it to the independent listing/detail products.

Final Phase 3 verification:
- Site tests 21/21; Biome clean; Astro check 0 errors with 6 pre-existing hints across 92 files; build 18 routes; root `tsc` and `git diff --check` green.
- Browser checks at CSS widths 390 / 768 / 1440: homepage has 9 sections and no horizontal overflow.
- Teardown and Blue Ocean listing/detail routes returned HTTP 200.
- Factory gallery accepted keyboard focus; `ArrowRight` scrolled it horizontally.

### Phase 4 — Five AI visual stories (complete)

- Commit: `49a6b5c` (`feat(site): add five AI advantage visual stories`); exactly five files: `WhyChooseUsSection.astro`, `brand-logo.test.ts`, `en-US.md`, `media-assets.test.ts`, and `site.ts`.
- Result: five typed stories render in client order with five unified CHANNEL navy/amber static concept visuals. The old three-reason/team-photo presentation was removed; the separate Our People section retains all six photos.
- Safety/UX: an explicit disclaimer identifies every visual as illustrative, non-live, and not a guarantee. The stories contain no buttons, inputs, or live affordances.
- Responsive behavior: mobile is text-first; desktop alternates, with stories 1/3/5 text-left and 2/4 visual-left.
- Tests/validation: site tests 23/23; Biome clean; Astro check 0 errors with 6 pre-existing hints across 92 files; build 18 routes; root `tsc` and `git diff --check` green.
- Browser validation at CSS widths 390 / 768 / 1440: all five figures were accessible and named, with no clipping or horizontal overflow and `controls=0`; screenshots reviewed.
- Runtime correction: browser inspection caught both desktop elements receiving `order: 2`. Mutually exclusive parity classes fixed the conflict; revalidation confirmed 1/3/5 text-left and 2/4 visual-left.
- Assumption audit: **PASS**.
- Engineering rationale: typed shared content locks client order and wording, while static, non-interactive concept art communicates the scenarios without implying a live product or guaranteed output.

### Phase 5 — Homepage inquiry form + CTA routing (complete)

- Embed the existing full `ProjectForm` at `#oem-inquiry`, preserve secure direct-upload behavior, keep `/oem#submit`, and route confirmed OEM-intent CTAs to the homepage form.
- TDD/E2E covers validation, upload behavior, anchors, and URL targets.

#### Phase 5A — Homepage inquiry form (complete)

- Commit: `cf13702` (`feat(site): embed homepage OEM inquiry form`); four files.
- Files: `CTASection.astro`, `brand-logo.test.ts`, `index.astro`, and `public.spec.ts`.
- Result: the existing CTA heading and description remain, the former buttons were removed, and the existing full `ProjectForm` is reused at the unique `#oem-inquiry` anchor. It retains the same `/api/admin` endpoint and `/oem_submit_result` result target, while the independent OEM-page action at `/oem#submit` remains intact.
- Build/Deploy/Runtime impact: homepage static output and browser form placement changed; no backend endpoint, dependency, or deployment configuration changed.
- Tests/validation: site tests, Biome, Astro check/build, responsive browser checks, and focused E2E all passed; consolidated final evidence is below.
- Assumption audit: **PASS**.
- Deviations: none.
- Engineering rationale: reusing the production form preserves one validation/upload/submission contract instead of creating a homepage-specific copy that could drift or weaken secure direct-upload behavior.

#### Phase 5B — Primary OEM inquiry CTA routing (complete)

- Commit: `eee2c46` (`feat(site): route primary OEM inquiry CTAs`); five files.
- Files: `content/en-US.md`, `content/portfolio/en-US.md`, `oem-inquiry-routing.test.ts`, `site-navigation.ts`, and `oem_submit_result.astro`.
- Result: `OEM_INQUIRY_HREF` establishes the canonical `/#oem-inquiry` target for the homepage Hero, Portfolio Hero, and result-page “Submit another request” action.
- Preserved navigation: the Header continues to use `/oem#what-we-do`, the footer continues to use `/oem`, and the OEM page's `#submit` and `#process` anchors remain unchanged.
- Build/Deploy/Runtime impact: generated site links changed; no dependency, backend, or deployment configuration changed.
- Tests/validation: focused routing contracts and real browser clicks passed; consolidated final evidence is below.
- Assumption audit: **PASS**.
- Deviations: none.
- Engineering rationale: one canonical constant prevents OEM-intent CTA drift without flattening page-navigation links and OEM-local anchors into a single destination.

#### Phase 5C1 — Product CTA routing (complete)

- Commit: `d812149` (`feat(site): route product CTAs to inquiry form`); five files.
- Files: `oem-inquiry-routing.test.ts`, Blue Ocean listing/detail pages, and Teardown listing/detail pages.
- Result: Blue Ocean listing/detail and Teardown listing/detail CTAs all route to `/#oem-inquiry`; each Blue Ocean detail renders one “Start” link plus three “Choose model” links.
- Build/Deploy/Runtime impact: generated product-route links changed; no dependency, backend, or deployment configuration changed.
- Tests/validation: focused source/routing contracts and real browser clicks passed; consolidated final evidence is below.
- Assumption audit: **PASS**.
- Deviations: none.
- Engineering rationale: routing every product-level inquiry affordance through the shared target removes inconsistent dead ends while preserving the listing/detail information architecture.

#### Phase 5C2 — Remaining CTA routing and cleanup (complete)

- Commit: `07b1fba` (`feat(site): complete OEM inquiry CTA routing`); five files.
- Files: `content/en-US.md`, `site.ts`, `oem-inquiry-routing.test.ts`, the Success Stories index page, and `public.spec.ts`.
- Result: the Success Stories CTA routes to `/#oem-inquiry`, and retired CTA link fields were removed from the site type and frontmatter after their consumers migrated.
- Build/Deploy/Runtime impact: generated Success Stories routing and the static content contract changed; no dependency, backend, or deployment configuration changed.
- Tests/validation: the E2E suite now clicks the Success Stories CTA and confirms arrival at the form; consolidated final evidence is below.
- Assumption audit: **PASS**.
- Deviations: none.
- Engineering rationale: removing the retired link fields closes the alternate-source path after migration, so future content edits cannot silently restore stale CTA destinations.

Final Phase 5 verification:
- Site tests 27/27; Biome clean; Astro check 0 errors with 6 existing hints across 92 files; build 18 routes; root and E2E TypeScript checks plus `git diff --check` green; focused Phase 5 E2E 2/2.
- Browser checks at CSS widths 390 / 768 / 1440 confirmed one unique `#oem-inquiry`, all seven fields, secure endpoint/result attributes, required-field behavior, the full upload `accept` contract and hint, no clipping or horizontal overflow, and fixed-header clearance.
- Real clicks from Home, Portfolio, the submission result page, Blue Ocean, Teardown, and Success Stories all reached the homepage form.
- A production-source sweep found the footer page-navigation link as the only remaining bare `/oem`; built output contains 14 footer `/oem` links and 21 canonical inquiry links.
- Phase 5A, 5B, 5C1, and 5C2 assumption audits all **PASS**.
- The global `within 24 hours` SLA parity remains Phase 8 scope and was not partially changed in Phase 5.

### Phase 6 — Canonical portfolio content and redirect (complete — Slides 14–15)

- `/portfolio` is now the single Success Stories destination for Slides 14–15. It retains the portfolio UI, presents the corrected Sleep Clock and Disc Repair cases with real images, renders the 50+/30+/100+ cumulative stats, and removes the retired TWS story.
- `/success-stories` now builds only as a static redirect artifact to `/portfolio`; it is excluded from the sitemap, while `/portfolio/` owns the canonical URL.
- The work was divided into the following independently verified subphases and follow-up contracts so every commit remained within the five-file limit.

#### Phase 6A — Real case-study content, schema, and media (complete)

- Commit: `6de3f38` (`feat(site): migrate real portfolio case studies`); five files.
- Files: `disc-repair.jpg`, `CaseShowcase.astro`, `content/portfolio/en-US.md`, `portfolio-content.test.ts`, and `portfolio.ts`.
- Result: corrected Children's Sleep Training Clock and Disc Repair System content replaced the placeholder TWS case. The typed case schema now owns image URL, alt text, intrinsic dimensions, and the cumulative-stats contract; `CaseShowcase` renders those real image fields without changing the established STAR layout.
- Tests written: content contracts pin the two case titles and order, approved source data, image paths and intrinsic dimensions, schema consumption, and absence of TWS from the active cases.
- Build/Deploy/Runtime impact: one new portfolio image entered the static hosting artifact and the portfolio frontmatter/schema changed; no dependency, API, or backend contract changed.
- Deviations: none.
- Engineering rationale: keeping copy, media metadata, and stats in typed portfolio content avoids hard-coded component variants and reserves image layout space without duplicating case data in the view.

#### Phase 6B1 — Portfolio stats and navigation (complete)

- Commit: `f4b82da` (`feat(site): add portfolio cumulative stats`); three files.
- Files: `content/en-US.md`, `portfolio-content.test.ts`, and `portfolio.astro`.
- Result: the portfolio renders 50+ Case Studies, 30+ Trusted Clients, and 100+ Certifications from the typed stats contract; Success Stories links in both navigation surfaces now target `/portfolio`.
- Tests written: exact value/label pairs, rendered stats consumption, and nav/footer `/portfolio` routing are contract-checked.
- Build/Deploy/Runtime impact: generated portfolio markup and static navigation links changed; no runtime service or dependency changed.
- Deviations: none.
- Engineering rationale: the cumulative claims remain content-owned while one semantic `<dl>` renders them, preventing display copy from drifting away from its testable source.

#### Phase 6B2a — Static legacy-route redirect (complete)

- Commit: `f8b24de` (`feat(site): redirect legacy success stories`); four files.
- Files: `astro.config.ts`, `oem-inquiry-routing.test.ts`, deleted `pages/success-stories/index.astro`, and `public.spec.ts`.
- Result: the duplicate Success Stories page was deleted, Astro emits `/success-stories` as a static redirect to `/portfolio`, the legacy URL is explicitly filtered from the sitemap, and source/E2E contracts follow the new route topology.
- Tests written: routing tests require the redirect declaration, deleted page, `/portfolio` navigation target, and sitemap exclusion; E2E begins at the legacy URL and follows it to the portfolio.
- Build/Deploy/Runtime impact: static route generation and sitemap output changed. The generated redirect is an HTTP 200 meta-refresh artifact, not an origin-level 301.
- Deviations: none.
- Engineering rationale: deleting the duplicate page makes `/portfolio` the only maintainable content implementation; the static redirect preserves the legacy entry point within the current hosting model.

#### Phase 6B2b — Opt-in portfolio canonical (complete)

- Commit: `daec7ce` (`feat(site): canonicalize portfolio success stories`); three files.
- Files: `BaseLayout.astro`, `portfolio.astro`, and `public.spec.ts`.
- Result: `BaseLayout` accepts an optional canonical path and `/portfolio` opts into `/portfolio/`; pages that do not provide the prop remain unchanged.
- Tests written: E2E requires the redirected destination to emit the portfolio canonical.
- Build/Deploy/Runtime impact: portfolio `<head>` output changed; no route, API, dependency, or backend changed.
- Deviations: none.
- Engineering rationale: an optional layout contract avoids an unreviewed site-wide canonical rollout while allowing the one consolidated route to declare ownership.

#### Phase 6C — Duplicate-code, data, and TWS retirement (complete)

- Commit: `2c3ccdd` (`refactor(site): retire duplicate success story code`); five files.
- Files: deleted `tws-speaker-1.webp`, deleted `CaseStudyCard.astro`, deleted `successStories.ts`, `portfolio-content.test.ts`, and `deploy-cloudbase-test.mjs`.
- Result: the obsolete component, duplicate data source, and final retired TWS source asset were removed. The test deployment now explicitly prunes the retired TWS object so additive hosting cannot leave it publicly reachable.
- Tests written: source contracts require the duplicate component/data and TWS asset to remain absent and pin the exact targeted hosting-prune entry.
- Build/Deploy/Runtime impact: the site bundle loses dead code/data/media, and test-hosting cleanup gains one exact object deletion; no broad portfolio-directory prune was introduced.
- Deviations: the initial source deletion did not cover additive hosting's retained object. The conservative correction prunes only the retired TWS path; a broad directory wipe was rejected because it could remove retained portfolio media.
- Engineering rationale: source deletion and targeted remote cleanup are both necessary for retirement on additive static hosting, while path-level pruning limits blast radius.

#### Phase 6 acceptance contract (complete)

- Commit: `4f48db3` (`test(site): cover canonical success stories`); one file, `public.spec.ts`.
- Result: one focused browser journey covers legacy redirect, canonical URL, sitemap inclusion/exclusion, all three stats, both real case images, TWS absence, and the surviving inquiry CTA through to the homepage form.
- Engineering rationale: one end-to-end acceptance path verifies the route, metadata, content, media, removal, and conversion seams together without duplicating implementation assertions.

#### Phase 6 canonical-origin blocker fix (complete)

- Commit: `fc98d38` (`fix(site): derive canonical origin from SITE_URL`); four files.
- Files: `.env.example`, `astro.config.ts`, `portfolio-content.test.ts`, and `public.spec.ts`.
- Result: the placeholder `channel.example.com` origin was removed. Astro now derives canonical and sitemap origins from the build-time `SITE_URL` contract, with `http://localhost:4321` as the documented local fallback, and E2E asserts against its configured site URL.
- Tests written: source contracts pin `SITE_URL` loading, documentation, and test-deploy parity; E2E rejects a hard-coded placeholder by deriving the expected canonical from the running test origin.
- Build/Deploy/Runtime impact: site builds now have an explicit public-origin input. The existing test deployment already supplies `SITE_URL`; a future production workflow must require it when that workflow is added.
- Deviations: the first canonical implementation exposed a placeholder origin. The conservative correction introduced one build-time origin contract and retained opt-in page canonicals; a speculative all-page canonical rollout was not taken.
- Engineering rationale: a statically generated canonical must use the deployment's public origin at build time; a checked environment contract is reliable across local and hosted builds without coupling markup to a placeholder hostname.

Final Phase 6 verification:
- Site tests 32/32; Biome clean; root and E2E TypeScript checks green; `node --check scripts/deploy-cloudbase-test.mjs` green.
- Astro check: 0 errors, 6 existing hints, 89 files. Astro build: 17 content pages plus the static `/success-stories` redirect artifact.
- Final focused E2E: 1/1, covering redirect, canonical, sitemap, 50+/30+/100+ stats, both case images, no TWS content, and the inquiry journey.
- Browser review at CSS widths 390 and 1440 confirmed the retained layout, reviewed screenshots, and no horizontal overflow. The rendered source images resolve at 800×800 for Sleep Clock and 825×776 for Disc Repair.
- Assumption audits: **PASS** after resolving both blockers—the missing additive-hosting TWS prune and the placeholder `channel.example.com` canonical origin.
- Explicit caveats: the static redirect returns HTTP 200 with meta-refresh rather than 301; Phase 9 must verify the retired TWS live URL returns 404; any future production workflow must require `SITE_URL` when introduced, while the existing test deployment already supplies it.
- Delivery state: no push or deployment is claimed for Phase 6.

#### Phase 6/Phase 9 pre-delivery review blocker and deployment-guard resolution (implemented locally; live verification pending)

- Date: 2026-07-20.
- Blocker evidence: before deploying this fix, the live baseline for `/media/portfolio/cases/tws-speaker-1.webp` still returned HTTP 200. This confirms that the retired object remained publicly reachable on additive hosting; it does not indicate that the current local fix has been deployed.
- Independent assumption review: **BLOCKED**. The targeted prune could fail while deployment continued because its tool failure was tolerated, and the post-deploy smoke enforced neither retirement of the TWS object nor availability and media type of the two active portfolio images. A stale retired object or missing/non-image active asset could therefore survive a superficially green deployment.
- Conservative fix implemented in `scripts/deploy-cloudbase-test.mjs`, `scripts/smoke-cloudbase-deploy.mjs`, and `apps/site/src/i18n/portfolio-content.test.ts`:
  - Static-hosting upload and website-document configuration tool failures now block the deployment through explicit success assertions.
  - Post-deploy smoke now requires `/media/portfolio/cases/sleep-clock.webp` and `/media/portfolio/cases/disc-repair.jpg` to return HTTP 200 with a `Content-Type` beginning with `image/`.
  - Post-deploy smoke now requires the exact retired `/media/portfolio/cases/tws-speaker-1.webp` asset URL to return HTTP 404. Release-ID query strings bypass stale CDN cache entries for these checks.
  - The portfolio source contract pins the upload guard and all three smoke paths, including the retired-asset HTTP 404 expectation.
- Route contract clarification: `/success-stories` is not expected to return HTTP 404. It deliberately remains a static HTTP 200 meta-refresh compatibility route to canonical `/portfolio`; only the retired TWS media object must return HTTP 404.
- Build/Deploy/Runtime impact: test-environment hosting deployment now fails closed for upload/configuration tool failures, and post-deploy acceptance fails unless active and retired portfolio media match the public HTTP contract. No application API, dependency, database, or production deployment contract changed.
- Local validation after the fix:
  - Site tests: 32/32.
  - All workspace package tests passed: media-storage 26, shared 70, site 32, auth 2, public-api 37, and admin 135.
  - Root and E2E TypeScript checks passed.
  - Biome passed across 182 files.
  - Astro check passed with 0 errors and 6 hints across 89 files.
  - Astro build emitted 17 pages plus the static `/success-stories` redirect artifact.
  - Playwright E2E discovery passed.
  - `node --check` passed for both deployment scripts.
  - `git diff --check` passed.
- Deviations: the earlier Phase 6C contract assumed that listing an exact prune path was sufficient even though the delete tool result could be tolerated and no external HTTP outcome was enforced. The conservative correction retains the narrow path-level prune, makes must-succeed hosting operations fatal, and verifies the public result after deployment; a blanket portfolio-directory deletion was rejected because it could remove active media.
- Engineering rationale: externally observed HTTP state is the authoritative retirement signal. Tool success alone cannot prove CDN state, while a broad cleanup increases blast radius; the narrow prune plus cache-busted active-media and retired-media smoke checks closes the silent-failure path without expanding deletion scope.
- Delivery state: the Phase 1–6 test release was subsequently pushed and deployed. Reviewed application commit `e55b4a1` is live in the CloudBase test environment; CI run `29801125280` and Deploy Test run `29801125323` passed, including the post-deploy smoke and public browser E2E. The retired TWS URL is independently verified live at HTTP 404. Overall Phase 1.5 status remains **In progress** only because approved Phases 7–8 are outside this partial release.
- Final pre-push review on 2026-07-21 found one diff-induced documentation gap: the manual CloudBase setup/build path omitted `SITE_URL`, so following it could emit localhost canonical and sitemap URLs even though the automated test workflow was correctly wired. A red contract test first proved the omission; `docs/CLOUDBASE_DEPLOYMENT_EXECUTION.md` now sets `SITE_URL` for test/prod environment setup and the manual static build.
- Review disposition: the deploy script's full-replacement function-env behavior is unchanged from `origin/test`, is documented as a test-only accepted limitation with a complete authoritative manifest, and has a separately implemented/live-verified read-merge hardening branch for production reuse. It is not folded into this OEM test delivery; no production/main deployment is in scope.

#### Phase 6 test delivery and smoke-lifecycle resolution (complete)

- The reviewed Phase 1–6 release first reached feature and `test` at `e1425ac`. CI run `29761704375` passed and CloudBase deployment run `29761700772` successfully deployed the site and functions.
- Run `29761700772` logged every post-deploy assertion as passed—including both active case images, the retired TWS HTTP 404, and both function release IDs—but the Node smoke process stayed alive after its success message. Its sole deploy job was canceled after 27m50s to finalize diagnostic logs; this cancellation did not roll back the already-healthy test deployment.
- An incident-time local Node 24.14.1 A/B probe spawned separate child processes against the deployed 53,420-byte Disc Repair image with a five-second watchdog. The status-only child reported `200` but had not exited at the deadline; the child that awaited `response.arrayBuffer()` reported `200` and exited with code 0 in 2,965ms. This timing-sensitive observation, together with the canceled runner log and subsequent green drain fix, isolated the lifecycle defect to the unread successful image responses rather than the image/status contract.
- Commit `e55b4a1` (`fix(deploy): drain smoke response bodies`) routes every deployment-smoke HTTP call through one helper that drains the full body, bounds headers and body reads to 15 seconds, caps responses at 5 MiB, cancels oversized streams, and preserves BOM-tolerant JSON decoding. The three control-plane calls are bounded to 90 seconds each, and the workflow step has a 12-minute outer limit.
- Five lifecycle regressions cover full body drain, pre-header timeout, stalled-body timeout, oversized-stream transport cancellation, and UTF-8 BOM decoding. They are part of the root unit-test command. All 307 tests passed locally after the fix, along with Biome, syntax checks, all workspace/E2E typechecks, Astro check, Playwright discovery, and `git diff --check`.
- Pre-push exact-SHA review of `e55b4a1` found no P1/P2/P3 issues. Both the feature branch and `test` advanced by guarded fast-forward from `e1425ac` to `e55b4a1`; no production/main branch was changed.
- CI run `29801125280` passed. The sole job in Deploy Test run `29801125323` passed in 4m44s: CloudBase deploy passed, deployment smoke exited naturally in 23 seconds, and public browser E2E completed with 8 passed, 2 skipped, and 0 failed in 31.1 seconds.
- Independent post-workflow verification confirmed `/portfolio` HTTP 200; the intentional `/success-stories` compatibility artifact HTTP 200; retired `/headphones`, `/overstock`, and TWS media HTTP 404; active Sleep Clock and Disc Repair media HTTP 200 with `image/*`; and both live functions reporting release `e55b4a1`.
- HTTP 404 meaning remains deliberate: retired pages and the retired TWS object must return 404 because they are no longer published. `/success-stories` must not return 404; it remains a static HTTP 200 meta-refresh compatibility route to canonical `/portfolio`.

### Phase 7 — Certificates/logos responsive presentation

- Status: **Complete and delivered to the CloudBase test environment**.
- Seven commits, each touching no more than five files, implement the approved Slide 9 scope: `3951362`, `c2944a9`, `8ee8e2a`, `b6ae36a`, `bf104cf`, `347c26d`, and `56893ed`.
- All eight supplied documents are classified by their actual role: four compliance/test reports, three design patents, and one patent record. Published patent derivatives redact designer/agent contact details, personal rights-holder fields, and QR codes while retaining patent identity, company ownership, and document context; source tests pin the reviewed SHA-256 hashes.
- All 13 supplied customer marks are published as unique transparent 600×240 WebP canvases with optically normalized content. The two education clients use generic `Education Partner` derivatives and identity-free filenames; public content, alternative text, URLs, and image pixels do not expose the school names.
- Customer logos and each certificate group use a shared small/medium snap carousel with automatic five-second rotation, previous/next and pause/resume controls, 44×44 touch targets, Arrow/Home/End keyboard navigation, interaction pause, visibility gating, and `prefers-reduced-motion` autoplay suppression. At the large breakpoint, controls are hidden and the existing four-column logo/certificate grids remain; certificate thumbnails retain the native dialog lightbox and Escape/backdrop close behavior.
- Focused Playwright validation passed 5/5 scenarios: 390/768 carousel controls and no horizontal overflow, real autoplay followed by keyboard pause, reduced-motion disabling, 1440 multi-row logo grid, all eight certificate triggers, and the desktop lightbox. Exact Chromium screenshots at 390, 768, 1024, and 1440 confirmed complete logos, readable labels, stable controls, no overlap, and no horizontal overflow.
- Full validation passed after implementation: Biome checked 185 files; all nine workspace typechecks and the E2E TypeScript project passed; the complete test suite passed (including site 37, admin 135, public API 37, shared 70, media storage 26, auth 2, and deploy smoke 5); Astro check reported 0 errors and 6 existing hints; and the final static build emitted 17 pages.
- Independent exact-SHA assumption review passed at `56893edba2fa854cf56b6c8a04bb31fab7615114` with no blocking findings. Phase 8 listing/stat/SLA changes remained untouched at that checkpoint. Phase 7 was subsequently included in the reviewed and live-accepted Phase 9 release recorded below.

### Phase 8 — Listing cleanup and global claim parity

- Remove Teardown/Blue Ocean listing stats, normalize 20+ years and 24-hour SLA across all source consumers and email templates, rebuild function artifacts, and update tests.

#### Phase 8 MIU 1 — Teardown listing aggregate-band removal (complete)

- Commit: `586899b` (`fix(site): remove teardown listing stats`); exactly three files.
- Removed only the Teardown listing’s `avgMargin`, `totalReports`, and PPT-marked stats section. The reports data source, three cards, methodology, navigation, CTA, and all three generated detail routes remain unchanged.
- TDD evidence: the new source contract first failed on the existing `<!-- Stats strip -->`; the pre-change browser test then failed on one visible `Teardown Reports` label. After implementation, the focused source contract passed 22/22.
- Browser evidence: the focused Playwright contract passed at 390 / 768 / 1024 / 1440 with 1 / 2 / 3 / 3 rendered columns, three cards, direct PageHero-to-cards adjacency, no horizontal overflow, and all three detail routes returning HTTP 200 with BOM, margin, MOQ, CTA, and back links retained.
- Build/quality evidence: Astro emitted 17 pages including all three Teardown details; Astro check reported 0 errors and 6 existing hints; touched-file Biome and `git diff --check` passed; pre-commit TypeScript passed.
- Independent assumption audit and validator verdicts: **PASS**. No Blue Ocean, claim, email, API, data, route, or deployment change entered MIU 1.

#### Phase 8 MIU 2 — Blue Ocean listing aggregate-band removal (complete)

- Commit: `118e2bd` (`fix(site): remove blue ocean listing stats`); exactly three files.
- Removed only the Blue Ocean listing’s `avgMargin`, `totalProducts`, `minMoq`, and PPT-marked stats section. The product data source, three concept cards, partnership section, navigation, CTA, and all three generated detail routes remain unchanged.
- TDD evidence: source/browser assertions first failed on the existing stats section and visible `Concept Products` label. After implementation, the focused source contract passed 23/23.
- Browser evidence: the focused Playwright contract passed at 390 / 768 / 1024 / 1440 with 1 / 2 / 3 / 3 rendered columns, three cards, direct PageHero-to-cards adjacency, no horizontal overflow, and all three details returning HTTP 200 with BOM, margin, MOQ, three partnership tiers, CTA, and back links retained.
- Build/quality evidence: Astro emitted 17 pages including all three Blue Ocean details; Astro check reported 0 errors and 6 existing hints; touched-file Biome, editor diagnostics, and pre-commit TypeScript passed.
- Independent assumption audit: **PASS**. No claim, email, API, dataset, route, or deployment change entered MIU 2.

#### Phase 8 MIU 3 — Active OEM claim normalization (complete)

- Commit: `fb9b5a3` (`fix(site): normalize active OEM claims`); exactly three files.
- Changed the one remaining OEM experience card from `15+` to PPT-approved `20+` and changed the shared ProjectForm success producer from `within one business day` to exact lowercase `within 24 hours`.
- The homepage and OEM page continue consuming the same `submit.successBody`; no form field, upload, `/api/admin`, redirect, result page, email, hidden source, API, schema, auth, SDK, or environment behavior changed.
- TDD evidence: source/browser tests first failed on the missing `20+`. After implementation, the focused source contract passed 24/24.
- Browser evidence: the non-mutating Playwright contract verified visible `20+`, exact success copy in both hidden success DOMs, absence of stale variants, and zero POST requests to `/api/admin`.
- Build/quality evidence: Astro emitted 17 pages; Astro check reported 0 errors and 6 existing hints; touched-file Biome, editor diagnostics, pre-commit TypeScript, and `git diff --check` passed.
- Independent assumption audit: **PASS**. The change is directly supported by PPT Slides 4–5 and 11.

#### Phase 8 MIU 4 — Submission-result claim normalization (complete)

- Commit: `254d841` (`fix(site): normalize submission result claim`); exactly three files.
- Changed only the visible result-page response promise from `within one business day` to exact `within 24 hours`.
- TDD evidence: focused source/browser assertions first failed on the missing approved sentence; the final routing source suite passed 4/4.
- Browser evidence: the non-mutating result-page contract verified the exact full paragraph, visible `#phase8-check` reference card, retained “Submit another request” navigation to `/#oem-inquiry`, and zero POST requests to `/api/admin`.
- Build/quality evidence: Astro emitted the result route within 17 pages; Astro check reported 0 errors and 6 existing hints; touched-file Biome, editor diagnostics, pre-commit TypeScript, and `git diff --check` passed.
- Independent assumption audit: **PASS**. No email, hidden source, API, form, route-topology, dependency, or backend behavior entered MIU 4.

#### Phase 8 MIU 5 — Hidden storefront source parity (complete)

- Commit: `10de195` (`fix(site): normalize hidden inquiry claims`); exactly three files.
- Changed only the retained Headphones and Overstock Markdown response promises to exact `within 24 hours`.
- TDD evidence: the new hidden-source contract first failed on the old Headphones phrase; after implementation it passed 3/3 while existing no-link/nav guards stayed green.
- Retention hardening: tests now require all four underscore-prefixed storefront/item source pages to exist and reject both flat and directory-style public route counterparts. Stale-copy detection accepts whitespace/hyphen variants.
- Build/quality evidence: Astro check reported 0 errors and 6 existing hints; the canonical-origin build emitted 17 pages, no Headphones/Overstock route directory, and no sitemap entry; touched-file Biome, editor diagnostics, pre-commit TypeScript, and `git diff --check` passed.
- Independent assumption audit: **PASS**. No public route, navigation, API, catalog, loader, island, function, schema, environment, deployment, or runtime behavior changed.

#### Phase 8 MIU 6 — OEM confirmation-email claim and packaged artifact (complete)

- Commit: `e127071` (`fix(email): normalize OEM confirmation claim`); exactly two files.
- Changed only the OEM confirmation email’s plain-text and HTML response promises to exact `within 24 hours`; SMTP, environment, Nodemailer, send behavior, and handler payload remain unchanged.
- TDD evidence: the new admin-owned source contract first found zero approved occurrences while the best-effort handler payload guard was green. After implementation, both focused tests passed.
- Artifact evidence: email/admin typechecks, the full 137-test admin suite, both CloudBase function builds, `package-functions.mjs`, packaged admin copy scan, and bare-directory cold-start smoke for admin/public-api passed. The admin artifact contains the approved phrase and no stale business-day variant.
- Git hygiene: generated `dist/` and `.cloudbase-artifacts/` paths are ignored, untracked, and unstaged. A zsh loop variable named `path` briefly shadowed command lookup during this check; rerunning with `artifact_path` passed.
- Independent assumption audit: **PASS**. No result-page, hidden source, API, dependency, SDK, environment, or deployment-topology change entered MIU 6.

#### Phase 8 implementation boundary

- MIUs 1–6 are complete. Phase 7.5 API contract verification is N/A because no endpoint, action, payload, response, status, schema, auth rule, SDK surface, upload flow, environment variable, or client/server contract changed.
- At this implementation checkpoint, full G5 validation, visual review, exact-SHA review, OEM-first delivery, and live acceptance remained pending. All five were subsequently completed under Phase 9 below.

#### Phase 8 local G5 validation (complete)

- Repository-wide Biome passed across 188 files.
- All nine workspace typechecks plus the E2E TypeScript project passed. Astro check reported 0 errors and 6 existing hints.
- Full tests passed: deploy-smoke 5, media-storage 26, shared 70, site 42, auth 2, admin 137, and public-api 37.
- Canonical `SITE_URL=https://supplychainsai.com` Astro build emitted 17 pages. Both function builds, packaging, packaged admin SLA scan, and bare-directory admin/public-api cold starts passed. Generated output remained ignored, untracked, and unstaged.
- Final local Phase 8 Playwright contract passed 4/4 without mutation flags or a real inquiry submission.
- Exact independent Chromium validation passed eight responsive states across Teardown and Blue Ocean at 390 / 768 / 1024 / 1440: zero horizontal overflow, three cards, direct PageHero-to-cards adjacency, no removed stats labels, and 1 / 2 / 3 / 3 columns. All eight screenshots passed visual review for clipping, overlap, spacing, card metrics, and CTA alignment.
- Requirements traceability and blast-radius audits found no implementation scope drift. At this checkpoint, the remaining checks were delivery-only; the exact-SHA review/blessing, OEM-first push, guarded `test` fast-forward, workflow completion, and canonical-domain live acceptance are now complete under Phase 9.
- Validation-script correction: a combined heredoc command initially masked a failed over-broad text scan behind later successful commands. The result was rejected. Page-specific built-output scans and whitespace-normalized per-carrier source counts were then rerun as independent commands and passed.

#### Phase 8 review fix — truthful confirmation-email status (complete)

- Review finding: the result page unconditionally said `A confirmation email is on its way`, while email delivery is intentionally best-effort and `sendMail` may return `false` when SMTP is absent or delivery fails. The submission still succeeds, so the unconditional statement could be false.
- Commit: `5dc2191` (`review-fix: make email status truthful`); exactly three files.
- Conservative fix: keep the approved `within 24 hours` response promise and all submission/API behavior unchanged, but replace the email-delivery guarantee with `We’ll also attempt to send a confirmation email to the address you provided.`
- TDD evidence: the source contract first failed on the new truthful wording. Final routing tests passed 4/4; site/E2E typechecks, touched-file Biome, 17-page build, focused browser result-page test, and pre-commit TypeScript passed.
- No API response shape or email-delivery behavior was changed; the result copy now matches the existing best-effort runtime contract.

#### Post-delivery Slide 2/4 correction — header identity and factory sequence

- Latest client clarification supersedes the earlier interpretation that the Slide 2 `删除` annotation removed both company name and MOQ. The CHANNEL wordmark remains; `Diversity Technology Limited` is restored as visible responsive header text; only `Minimum Order Amount: $500` stays removed. Small screens use a compact wordmark and wrapping company label to preserve menu space.
- The Factory gallery no longer follows the earlier Agent-selected design-to-dispatch order. The client-approved narrative is now exterior context first, then production lines, then product/design/tooling details: `f03 → f10 → f07 → f08 → f04 → f09 → f05 → f01 → f02 → f06`.
- Source and browser contracts cover company-name visibility at 390/1024/1280/1440, mobile menu open/close state and links, desktop brand/nav/account non-overlap, absence of MOQ at every width, no horizontal overflow, and the exact ten-image DOM order with successful image loading.
- Scope is presentation-only: no content claim, route, API, authentication, data model, SDK, environment, or deployment topology changes.

### Phase 9 — Full validation, review, delivery, deploy (complete)

- Final exact-SHA review passed at application commit `7024e33f49b66f53b1ad2857e86d7285b71dc6e0` with 0 P1, 0 P2, and 0 P3 findings. The review fix for the result page's unconditional email-delivery promise was included, re-reviewed, and the exact SHA was blessed before either push.
- Fresh pre-push validation at that SHA passed Biome across 188 files, all workspace and E2E TypeScript checks, all workspace tests, the five deployment-smoke lifecycle tests, generated/staged-output hygiene, and editor diagnostics. The accepted application source tree remains exactly `7024e33`; this final execution-log close-out changes documentation only. Its required `test`-branch workflow may advance release metadata to the docs-only branch tip, but it does not introduce another application-code revision.
- Delivery followed the required topology: `7024e33` was pushed first to `dev/albertli/oem-phase1-5-adjustments`; the remote OEM SHA was verified while `test` and `main` remained unchanged; then the same reviewed SHA was fast-forwarded to `test` after a fresh ancestor guard. `main` remained unchanged at `a9bedae2a7be3634427515e8d06d64080b24830d`.
- Exact-commit GitHub Actions passed: CI run `29997899953` (`Build and smoke`) and Deploy Test run `29997899997` (`Build, deploy, and smoke test`) both completed successfully for `test@7024e33`.
- Deploy Test's canonical-domain smoke passed for `https://supplychainsai.com`. It verified the active site routes, active portfolio media, retired storefront and TWS paths, read-only API boundaries, and both function health endpoints. The live `admin` and `public-api` services each reported release `7024e33f49b66f53b1ad2857e86d7285b71dc6e0` with build time `2026-07-23T10:05:19Z`.
- Focused canonical-domain Playwright acceptance passed 4/4 without submitting an inquiry: Teardown and Blue Ocean had no aggregate stats at 390 / 768 / 1024 / 1440, retained three cards and all six HTTP-200 details, `/oem` rendered `20+` and the shared `within 24 hours` claim, and the result page rendered the approved response promise plus truthful best-effort confirmation-email wording.
- Independent HTTP acceptance confirmed `/`, `/oem`, `/teardown-lab`, `/blue-ocean`, and `/oem_submit_result` returned 200; `/headphones` and `/overstock` returned 404; catalog reads returned 200; a missing private file returned 404; and an unauthenticated admin request returned 401.
- Deployment scope remained the existing CloudBase test environment. No `main` or production-branch update occurred. Slides 2–16 are complete; Slide 1 AI customer service remains the sole deferred feature.

### Post-delivery legacy-review reconciliation (2026-07-24)

Two earlier Agent reviews were re-audited against the current branch, the client revision PPT, its extracted source materials, and the live-accepted implementation. Their severity labels were not treated as requirements.

| Item | Disposition | Evidence / action |
|---|---|---|
| B1 — Blue Ocean teaser price badge overlaps title | **Reject as stale** | Slide 10 explicitly deletes the homepage Blue Ocean teaser. `BlueOceanTeaser.astro` is retired; the retained listing uses `ProductConceptCard` with economics in normal flow and no absolute price badge. Restoring `pr-16` to deleted UI would be dead work. |
| B2 — homepage Teardown teaser says 78% instead of the 67% average | **Reject as stale** | Slide 10 deletes the homepage teaser, and Slide 16 deletes the listing aggregate band. No public aggregate margin claim remains; cards/details and their per-product values remain. |
| B3 — BOM detail rows were reconstructed rather than transcribed | **Accepted and fixed** | The client teardown source proves that ClicBot and Lofree categories/cost allocations had been regrouped, while Oladance descriptions had been abbreviated. A tracked, human-reviewed snapshot records every Chinese source row, its reviewed English transcription, external-source provenance SHA-256 `6a06040b079ff8df6f4190a3f025ab7148b4a59a01a5738beccf3df89e522414`, and independent pre-fix hashes for non-BOM report fields. Because the external source is not tracked in this repository, automated tests validate production and rendered DOM against the snapshot; they pin every row/sum and non-BOM hash, and E2E deep-compares every rendered table row and total. The Oladance MCU remains generic (`Cmsemicon MCU`) because the source BOM does not confirm the narrative's example model. |
| B5 — Sign In destination inconsistency | **Already resolved** | Content nav and the guest `AccountMenu` both use `/login`; registration remains `/register`, and `/admin` is an authenticated/admin destination. |
| B7 — 171 MB factory video | **Already resolved** | The active client-derived encodes are H.264: homepage `/media/oem/factory-video.mp4` is 10,523,748 bytes and `/oem` `/media/oem-factory.mp4` is 7,201,197 bytes; the 171 MB source is not shipped. The earlier `<10 MB` number was an internal recommendation, not a PPT acceptance criterion. The separate static-hosting-versus-CloudBase-Storage policy question remains documented as OR-4, not conflated with this compression bug. |
| B8 / A2 — supplied media not mapped into `public/media` | **Current PPT scope resolved; old all-materials goal not complete** | The tracked tree contains 48 OEM media files and 23 portfolio media files, covering the current PPT's homepage, customer-logo, certificate/patent, and two-case requirements. Teardown and Blue Ocean do not currently publish their supplied/third-party document images, so the older handoff's broader “every source asset has a home” goal must not be called complete. The later 16-slide revision does not ask to add those images to Slides 10 or 16, and the source review flags their copyright/IP risk; they remain excluded unless the client explicitly approves publication or supplies cleared derivatives. |
| A1 / B6 — restore missing homepage sections | **Partly obsolete; current PPT wins** | The homepage now contains the OEM hero, shared Traditional-vs-AI What We Do, 10-step process, Factory, Our People, five-story Why Choose Us, Quality, certificates/clients, and inquiry form. Slide 6 explicitly deletes homepage Product Capability; Slide 10 deletes homepage Teardown/Blue Ocean teasers. Those sections must not be restored from the older review. |
| A3 — Success Stories correction | **Already resolved; broad de-anonymisation rejected** | `/portfolio` uses the client-supplied Sleep Clock and Disc Repair cases, no invented case metrics, 13 processed customer marks, and accurately classified compliance/patent documents. Public brands are named; the two education clients remain identity-free because the approved privacy contract requires it. |
| D1 — AI customer service | **Deferred as approved** | Slide 1 remains a separate feature and is not silently bundled into this branch. |
| D2 — literal “only retain OEM Development button” | **Closed by cross-slide evidence** | Slide 2 shows the full nav and asks for OEM-first ordering; Slides 10 and 16 retain and modify the Teardown/Blue Ocean routes. The supported interpretation is OEM first at `/oem#what-we-do`, with the other nav items retained. |
| D3 — Product Capability renamed on `/oem` | **Closed; no client question needed** | Slide 6 removes Product Capability from the homepage only. The client analysis explicitly preserves the independent `/oem` capabilities section and form categories. |
| D4 — `/oem` 15+ and old Why format | **Partly resolved; unsupported remainder rejected** | `15+` is now `20+`. Slide 7 replaces the homepage Why Choose Us presentation; it does not instruct a redesign of the independent `/oem` Why section. |
| D5 — homepage 10-step vs `/oem` 6-step | **Not a PPT defect** | The PPT requires retaining the detailed 10-step homepage execution process and replacing the shared What We Do content. It does not require every independent process summary to use the same granularity. No unification is made without a client instruction. |
| Slide 16 listing stats | **Already resolved** | Both listing aggregate bands are removed; all six cards/details and detail-level BOM/margin/MOQ remain. |

Browser verification of the accepted B3 fix exposed one adjacent rendering defect: the BOM table's `min-w-[34rem]` expanded its CSS Grid item to 545 px on a 390 px viewport, widening the whole document instead of scrolling locally. The main content grid item now has `min-w-0`; the focused E2E requires the document to fit the viewport while the BOM wrapper itself remains horizontally scrollable. The change does not alter desktop table structure or any report value.

The phrase “the last two optimisations are in progress” could not be traced to an earlier assistant status claim in the mechanically searched conversation history. The closest historical “two” referred to the Our Team and In-House Quality & Testing sections, both completed before this review. It is therefore not retained as a delivery-status assertion.

## Deviations

- Phase 1 initially treated the Slide 2 deletion annotation as removing both visual company name and MOQ. The client later clarified that the company name should remain, so the responsive header now shows it beside the CHANNEL wordmark at all widths while MOQ remains removed.
- The CHANNEL asset test pins semantic identity (historical dimensions, brand colors, two-path shape, no Diversity orange) rather than whitespace-sensitive SVG bytes, so harmless XML formatting cannot create a false failure.
- Phase 3 was split into 3A–3D because the combined work exceeded the five-file phase rule; the approved scope and behavior did not expand.
- Phase 5 was split into verified 5A, 5B, 5C1, and 5C2 subphases because the combined form and routing work exceeded the five-file phase rule; the approved scope and behavior did not expand, and no subphase had a material deviation.
- Phase 6 was split into verified 6A, 6B1, 6B2a, 6B2b, and 6C subphases, followed by one-file acceptance hardening and a four-file canonical-origin fix. Every commit touched no more than five files; the approved Slides 14–15 scope did not expand.
- Phase 6C corrected an additive-hosting assumption: deleting the local TWS asset would not delete an already-hosted object. The conservative choice was one exact prune entry; a broad portfolio-directory prune was not taken.
- The Phase 6 canonical audit rejected the placeholder `channel.example.com` origin. The conservative choice was a documented build-time `SITE_URL` contract with a local fallback and an opt-in portfolio canonical; a broader site-wide canonical change was not taken.
- The Phase 6/Phase 9 pre-delivery review corrected a second hosting-retirement assumption: an exact prune entry was not sufficient while prune failure was tolerated and smoke omitted the public media outcomes. The conservative choice was to fail closed on hosting upload/configuration errors and make cache-busted HTTP checks enforce both active media and the exact retired TWS 404; a broad directory prune remained rejected.
- The final Phase 9 review corrected manual-runbook parity for `SITE_URL`. The conservative choice was to wire the same public-origin input into documented GitHub variables and the manual build, backed by a source contract; no unrelated canonical rollout was added.
- A presentation-only source line break was normalized to `faster—from concept`; the confirmed wording was unchanged.

## Lessons

- Product Capability and teaser dead-code candidates were traced through history and consumers before removal. Independent OEM capability content and Teardown/Blue Ocean route data and navigation were preserved.
- Static source deletion is insufficient on additive hosting: retired public assets need a narrow deployment prune, and static canonical URLs need an explicit build-time public origin.
- A deployment cleanup is not proven by configuration or a tolerated tool result: smoke the cache-busted public URL for the retired object's HTTP 404 and simultaneously prove that active replacement media return HTTP 200 with an image content type.
- Build-time URL inputs must stay aligned across automated workflows and manual runbooks; a green CI producer does not protect an operator following stale manual commands.

## Execution log

- 2026-07-16: Branch created from `origin/dev/albertli/oem-phase1@3d57384`.
- 2026-07-16: Phase 1 red run — 3 expected failures: historical logo, logo-only/OEM-first header, viewport-height hero.
- 2026-07-16: Phase 1 green run — site tests 9/9, Biome clean, Astro check 0 errors (6 existing hints), Astro build 18 pages.
- 2026-07-16: Browser verification at CSS widths 390 / 1280 / 1600: CHANNEL asset `226×30`, company/MOQ absent, OEM first, mobile menu complete, hero height exactly `viewport − 72px`, no horizontal overflow.
- 2026-07-16: Cross-file logo trace passed; `scripts/deploy-cloudbase-test.mjs` explicitly keeps `media/logo-channel.svg` out of the legacy prune list.
- 2026-07-16: Tooling errors encountered and resolved: corrected the local UI-design helper path; replaced same-path SVG via separate delete/create operations after the patch tool rejected a combined replacement.
- 2026-07-16: First commit attempt was correctly blocked by `git diff --check` on Markdown trailing spaces; removed them and re-ran the gate rather than bypassing it.
- 2026-07-16: Pre-push assumption review blocked exact `/oem` coupling in the OEM-first sort (Phase 2 will add `#what-we-do`). Added a pure `orderPrimaryNavItems()` helper and a red→green test against `/oem#what-we-do`; final Phase 1 test count 10/10, Astro check/build green.
- 2026-07-17: Phase 2 completed in `c1fdc1c`; its assumption audit had no blockers after actionable warnings were fixed, with dormant unrendered `oneStop` source explicitly deferred.
- 2026-07-17: Phase 3 completed in four verified five-file subphases: 3A `fabdf47`, 3B `c18075e`, 3C `83d03a0`, and 3D `ea1cb70`; all four assumption audits passed.
- 2026-07-17: Final Phase 3 gates passed — site tests 21/21, Biome clean, Astro check 0 errors with 6 pre-existing hints across 92 files, build 18 routes, root `tsc` green, and `git diff --check` green.
- 2026-07-17: Browser verification at CSS widths 390 / 768 / 1440 found 9 homepage sections and no horizontal overflow; Teardown and Blue Ocean listing/detail routes returned HTTP 200; the Factory gallery accepted keyboard focus and scrolled on `ArrowRight`.
- 2026-07-17: Phase 4 completed in `49a6b5c` (`feat(site): add five AI advantage visual stories`), exactly five files; site tests 23/23 and all static/browser gates passed. The assumption audit passed.
- 2026-07-18: Phase 5A completed in `cf13702` (`feat(site): embed homepage OEM inquiry form`), four files; the full existing form now replaces the old homepage CTA buttons at the unique `#oem-inquiry` anchor while preserving its secure submission contract and `/oem#submit`.
- 2026-07-18: Phase 5B completed in `eee2c46` (`feat(site): route primary OEM inquiry CTAs`), five files; primary OEM-intent actions now share canonical `/#oem-inquiry` routing while Header, footer, and OEM-local navigation remain distinct.
- 2026-07-18: Phase 5C1 completed in `d812149` (`feat(site): route product CTAs to inquiry form`), five files; all Blue Ocean and Teardown listing/detail inquiry links now reach the homepage form.
- 2026-07-18: Phase 5C2 completed in `07b1fba` (`feat(site): complete OEM inquiry CTA routing`), five files; Success Stories routing, retired-field cleanup, and its E2E click contract completed the CTA migration. All four Phase 5 assumption audits passed.
- 2026-07-18: Final Phase 5 gates passed — site tests 27/27, Biome clean, Astro check 0 errors with 6 existing hints across 92 files, build 18 routes, root/E2E TypeScript and `git diff --check` green, and focused E2E 2/2.
- 2026-07-18: Browser verification at CSS widths 390 / 768 / 1440 confirmed the unique seven-field form, secure and required-field contracts, complete upload accept/hint content, fixed-header clearance, and no clipping or overflow; real clicks from every migrated CTA family reached it. The source/build sweep found only footer page-navigation uses of bare `/oem` (14 built links) alongside 21 canonical inquiry links.
- 2026-07-18: Phase 5 intentionally left the global `within 24 hours` SLA parity untouched for Phase 8.
- 2026-07-19: Phase 6A completed in `6de3f38` (five files), replacing the placeholder TWS case with corrected Sleep Clock and Disc Repair content, typed image/stats contracts, real media, and `CaseShowcase` consumption. Phase 6B1 completed in `f4b82da` (three files), rendering 50+/30+/100+ and routing nav/footer Success Stories links to `/portfolio`.
- 2026-07-20: Phase 6B2a completed in `f8b24de` (four files), deleting the duplicate page and adding the static legacy redirect plus sitemap/E2E contracts. Phase 6B2b completed in `daec7ce` (three files), adding the opt-in portfolio canonical.
- 2026-07-20: Phase 6C completed in `2c3ccdd` (five files), deleting duplicate component/data/TWS sources and adding the exact additive-hosting prune. Acceptance coverage landed in `4f48db3` (one file).
- 2026-07-20: The canonical-origin audit blocked the placeholder `channel.example.com`; `fc98d38` (four files) established the `SITE_URL` build contract and environment/E2E parity. Both Phase 6 blocker audits then passed.
- 2026-07-20: Final Phase 6 gates passed — site tests 32/32, Biome clean, root/E2E TypeScript green, deploy script syntax green, Astro check 0 errors with 6 existing hints across 89 files, build 17 content pages plus the static redirect artifact, and focused E2E 1/1.
- 2026-07-20: Browser verification at CSS widths 390 / 1440 reviewed screenshots, found no horizontal overflow, and confirmed 800×800 Sleep Clock plus 825×776 Disc Repair images. No push or deployment was performed; Phase 9 retains live TWS 404 verification.
- 2026-07-20: Phase 6/Phase 9 pre-delivery live-baseline review found the retired `/media/portfolio/cases/tws-speaker-1.webp` still returning HTTP 200 before deployment. Independent assumption review **BLOCKED** because targeted prune failure was tolerated and post-deploy smoke enforced neither retired-media removal nor active portfolio media.
- 2026-07-20: The conservative local resolution added fatal hosting upload/website-configuration result checks, cache-busted smoke requirements for HTTP 200 plus `image/*` on Sleep Clock and Disc Repair, an exact retired-TWS HTTP 404 check, and source-contract coverage for those guards. `/success-stories` remains intentionally HTTP 200 as a static meta-refresh compatibility route to canonical `/portfolio`.
- 2026-07-20: Post-fix local gates passed — site tests 32/32; all workspace package tests (media-storage 26, shared 70, site 32, auth 2, public-api 37, admin 135); root/E2E typecheck; Biome across 182 files; Astro check with 0 errors, 6 hints, and 89 files; build with 17 pages plus redirect; E2E discovery; `node --check` for both deployment scripts; and `git diff --check`.
- 2026-07-20: No push, deployment, or post-fix live TWS HTTP 404 is claimed. Status remains in progress because Phases 7–9 remain.
- 2026-07-21: Final pre-push review found the manual `SITE_URL` producer gap. The new source contract failed red, the CloudBase execution guide was corrected for test/prod variables and manual build input, and the focused portfolio contract passed 5/5 with `git diff --check` green.
- 2026-07-21: Reviewed `e1425ac` was pushed to the feature and `test` branches. CI `29761704375` passed; Deploy Test `29761700772` deployed successfully and all smoke assertions passed, but the smoke process retained unread image response bodies and did not exit. Its sole deploy job was canceled after 27m50s for diagnosis; live deployment health and expected 404s were independently confirmed.
- 2026-07-21: `e55b4a1` added complete response draining, bounded HTTP/control-plane/step timeouts, a 5 MiB cap with stream cancellation, and five lifecycle regressions. Pre-push exact-SHA review found no P1/P2/P3 issues, and guarded fast-forwards advanced both remote branches.
- 2026-07-21: CI `29801125280` and Deploy Test `29801125323` passed. The fixed smoke exited naturally in 23 seconds; public browser E2E completed with 8 passed, 2 skipped, and 0 failed; active portfolio media returned HTTP 200 with image MIME types; retired storefront/TWS paths returned HTTP 404; and both live functions reported `e55b4a1`. No production/main deployment occurred.
- 2026-07-23: Phase 8 implementation, validation, HLD/LLD artifacts, and the truthful-email review fix completed across 23 commits from `586899b` through reviewed application SHA `7024e33`. Final review and assumption audits reported no open findings.
- 2026-07-23: The reviewed SHA was pushed to the OEM branch first, independently verified, then fast-forwarded to `test` under an ancestor and blessing guard. `main` remained unchanged at `a9bedae2a7be3634427515e8d06d64080b24830d`.
- 2026-07-23: CI `29997899953` and Deploy Test `29997899997` passed for `test@7024e33`. Canonical `https://supplychainsai.com` acceptance passed 4/4 Phase 8 browser scenarios plus route/API/release smoke; both functions reported exact release `7024e33`, retired `/headphones` and `/overstock` returned 404, and no real inquiry was submitted.
- 2026-07-23: This documentation-only close-out reconciled the durable execution log with the verified delivery. It does not change the accepted application/runtime tree. Slides 2–16 are complete; Slide 1 AI customer service remains deferred.
