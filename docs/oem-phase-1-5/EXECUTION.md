# OEM Phase 1.5 — Execution Plan & Living Log

Status: In progress
Branch: `dev/albertli/oem-phase1-5-adjustments`
Base: `origin/dev/albertli/oem-phase1@3d57384`
Requirements: `channel-oem-review/client-revision-2026-07-15/06-CLIENT-REVISION-DETAILED-ANALYSIS.md`
AI customer service: Deferred; not part of this branch.

## Scope lock

- Restore the historical CHANNEL wordmark from `6f73bfc`; remove company name and MOQ from the header.
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
- Pins the approved historical CHANNEL asset by hash and renders only that wordmark in the header.
- Removes company-name/MOQ presentation while retaining a compatibility-only `showName?` prop for hidden legacy route files.
- Adds a full-width brand-blue lower border; uses larger/semibold nav text; orders OEM Development first without mutating content data.

Build/Deploy/Runtime impact:
- Static asset content changes at an existing URL. The CloudBase prune list must continue to exclude this path.
- No new dependency or backend change. Astro site build and hosting upload are affected.

Test plan (TDD — write first):
- Fails until `logo-channel.svg` hashes to the verified historical CHANNEL wordmark.
- Fails while header source renders `brand.name` or `brand.minOrder`.
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

### Phase 6 — Canonical portfolio content and redirect

- Keep the portfolio UI; migrate corrected Sleep Clock + Disc Repair content/images, replace TWS, add the 50+/30+/100+ stats strip, update nav/canonical/sitemap/E2E, and redirect `/success-stories`.

### Phase 7 — Certificates/logos responsive presentation

- Process every source asset, classify compliance/design-patent/patent-record documents accurately, normalize logos, and implement small/medium automatic carousel plus large-screen grid/lightbox.

### Phase 8 — Listing cleanup and global claim parity

- Remove Teardown/Blue Ocean listing stats, normalize 20+ years and 24-hour SLA across all source consumers and email templates, rebuild function artifacts, and update tests.

### Phase 9 — Full validation, review, delivery, deploy

- Lint, all package/function/site typechecks, unit tests, site build, function package smoke, CloudBase SDK contract gate if touched, Playwright local E2E, responsive screenshot review, diff review, blessing, branch push, fast-forward/merge to `test`, monitor CI + Deploy Test, and verify live URLs/assets/routes.

## Deviations

- Phase 1 test refinement: the legal company name remains as the logo `alt` text for accessibility, while all visual company/MOQ text is removed. This is the conservative interpretation of “logo only.”
- The CHANNEL asset test pins semantic identity (historical dimensions, brand colors, two-path shape, no Diversity orange) rather than whitespace-sensitive SVG bytes, so harmless XML formatting cannot create a false failure.
- Phase 3 was split into 3A–3D because the combined work exceeded the five-file phase rule; the approved scope and behavior did not expand.
- Phase 5 was split into verified 5A, 5B, 5C1, and 5C2 subphases because the combined form and routing work exceeded the five-file phase rule; the approved scope and behavior did not expand, and no subphase had a material deviation.
- A presentation-only source line break was normalized to `faster—from concept`; the confirmed wording was unchanged.

## Lessons

- Product Capability and teaser dead-code candidates were traced through history and consumers before removal. Independent OEM capability content and Teardown/Blue Ocean route data and navigation were preserved.

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
