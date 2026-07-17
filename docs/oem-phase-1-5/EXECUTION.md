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

### Phase 4 — Five AI visual stories

- Replace current Why Choose Us with five responsive visual stories using the exact client scenarios/selling points and unified concept visuals.
- No live-system affordances; visuals remain clearly illustrative.

### Phase 5 — Homepage inquiry form + CTA routing

- Embed the existing full `ProjectForm` at `#oem-inquiry`, preserve secure direct-upload behavior, keep `/oem#submit`, and route confirmed OEM-intent CTAs to the homepage form.
- TDD/E2E covers validation, upload behavior, anchors, and URL targets.

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
