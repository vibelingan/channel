# OEM Development Content Sync Correction

Date: 2026-08-18

Branch: `fix/oem-independent-content-page`

## Root Cause

The user requested that the newer homepage information be synchronized into the older OEM Development page. Planning commit `f00465d` incorrectly expanded that request into a full page-composition replacement:

- it declared homepage content the only narrative source of truth;
- it required the exact nine homepage sections on `/oem`;
- it instructed implementation to remove the independent OEM hero, capability, process, and Why Us content.

The implementation agent followed those MIUs in `e03fce6` and `c24e136`; it did not independently broaden the scope. The design error was in the planning decision.

## Evidence

Both endpoints were built and their rendered `<main>` content was parsed:

- Before sync (`993c7c3`): homepage vs `/oem` word-set overlap was 43.7%.
- Mirrored implementation (`9728247`): homepage vs `/oem` overlap was 99.8%.
- Corrected branch: homepage vs `/oem` overlap is 49.8%.

The measurement is a Jaccard overlap over unique visible word tokens:

1. build each revision with Astro;
2. extract only `<main>`, excluding `<script>`, `<style>`, and HTML tags;
3. lowercase and tokenize with `[a-z0-9+]+`;
4. calculate `|home ∩ oem| / |home ∪ oem|`.

Observed counts were `245/561` before sync, `438/439` for the mirrored implementation, and
`267/536` after correction. This is a diagnostic for accidental duplication, not a product KPI.

Before the incorrect sync, `/oem` used `PageHero`, `CardGrid`, `MediaVideo`, `ProcessTimeline`, `ReasonList`, `ProjectForm`, and framed `Section` components. Only the Traditional-versus-AI workflow was shared with home.

## Correct Product Contract

- Keep `/oem` as an independent page with its original structure, visual rhythm, and components.
- Synchronize current public facts and service language, not the homepage page composition.
- Continue sharing only the existing Traditional-versus-AI workflow comparison.
- Keep the OEM-specific factory video, poster, inquiry form, upload API, result route, and deep links.
- Do not restore unsupported legacy claims: `100+ Supply Chain Partners`, Flexible MOQ, Dedicated Project Manager, agreed AQL, RoHS, or the six-primary-product-families statement.
- Do not change homepage content, layout, components, anchors, or default factory media.

## Restored Structure With Updated Information

1. OEM-specific `PageHero` and local `#submit` / `#process` actions.
2. Shared Traditional-versus-AI workflow comparison at `#what-we-do`.
3. Independent capability grid with six delivery disciplines:
   - Product Incubation
   - Industrial & Mechanical Design
   - Electronics Engineering
   - Prototyping & Validation
   - Tooling & Mass Production
   - Quality & Global Delivery
4. OEM-specific factory video inside the capability section.
5. Independent six-stage owner-facing process, summarizing rather than copying the homepage ten-step execution gallery.
6. Independent Why Us block using current homepage facts: 20+ years, 40+ engineers, 5000+ m² facility, 40+ countries, Pre-QC, and one accountable team.
7. Existing OEM inquiry form and response-time contract.

## Preserved Work

This is not a repository rollback. It preserves:

- homepage content and all homepage components;
- shared-component optional anchor/media improvements;
- OEM media intrinsic-dimension guards;
- no-JavaScript and horizontal-overflow test hardening;
- the 320 px Portfolio wrapping fix;
- metadata/social/SEO work and all unrelated main changes;
- form fields, category taxonomy, upload behavior, `/api/admin`, and `/oem_submit_result`.

Only the OEM route composition, OEM content model/content, and tests that enforced the incorrect mirror design are corrected.

Existing shared-component accessibility debt in `MediaVideo` and `ProjectForm` is intentionally not
changed here: altering those shared components would change the homepage and violate this correction's
explicit UI-preservation boundary. Handle those concerns in a separate reviewed accessibility task.

## Acceptance Criteria

- `/oem` renders the restored independent components and does not render the homepage-only section components.
- Homepage and `/oem` are no longer near-duplicate pages.
- `/oem#what-we-do`, `/oem#capabilities`, `/oem#process`, `/oem#why-us`, and `/oem#submit` resolve.
- OEM video/poster and inquiry form remain functional.
- Unsupported legacy claims remain absent.
- Homepage source files have zero diff.
- Site tests, workspace/E2E typechecks, lint, production build, responsive browser acceptance, and craft gates pass.
