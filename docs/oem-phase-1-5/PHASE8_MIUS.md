# OEM Phase 8 — Implementation Tasks (MIUs)

Status: completed and delivered; route contract superseded 2026-07-27 by `90bd06e`
Architecture: `docs/oem-phase-1-5/PHASE8_ARCHITECTURE.md`

The MIUs below preserve the approved Phase 8 implementation history. Their
Headphones/Overstock no-route-restoration boundary was later superseded only for
`/headphones`: it is now public and HTTP 200; `/overstock` remains retired/404.

## Plain-language order

1. Remove the Teardown listing stats and prove its cards/details remain.
2. Remove the Blue Ocean listing stats and prove its cards/details remain.
3. Change the OEM `15+` and shared form-success copy.
4. Change the submission-result copy.
5. Keep hidden content sources consistent without restoring their routes.
6. Change confirmation-email text/HTML and prove the packaged admin artifact contains it.

Each MIU is implemented separately: write its failing assertions, run the red check, make the smallest source edit, validate, review, and commit only its listed files.

MIU 1: Teardown listing aggregate-band removal

Block: FRONTEND

Files: apps/site/src/i18n/brand-logo.test.ts, apps/site/src/pages/teardown-lab/index.astro, tests/e2e/public.spec.ts

Type: modify-existing

Depends on: none

What it does:

- Uses `docs/oem-phase-1-5/PHASE8_ARCHITECTURE.md` as the removal contract and preserves `apps/site/src/data/teardownReports.ts` as the card/detail data source.
- Deletes only `avgMargin`, `totalReports`, and the listing stats section; retains `reports`, the intro, `reports.map`, `TeardownCard`, navigation, and CTA.
- Adds source/browser assertions for three cards, retained detail links, the 390/768/1024/1440 column layout, heading order, and no horizontal overflow.

Build/Deploy/Runtime impact:

- Changes only generated `/teardown-lab/index.html`; no route, dataset, API, dependency, environment, function, or CloudBase configuration changes.
- The Astro static build and overwrite of the existing CloudBase listing path are affected. No remote prune is required.

Test plan:

- Red: assert the listing source no longer contains `<!-- Stats strip -->`, `avgMargin`, or `totalReports`.
- Red: at 390/768/1024/1440 assert `Teardown Reports`, `Avg. Hardware Margin`, and `Years Supply Chain Data` are absent while exactly three report cards remain.
- Guard: collect all three card detail hrefs, require HTTP 200, and assert retained BOM, margin, MOQ, CTA, heading flow, and no horizontal overflow.

Done when:

- `pnpm --filter @vibelingan-channel/site test` and `pnpm --filter @vibelingan-channel/site typecheck` pass.
- The site build with the intended `SITE_URL` emits `/teardown-lab/` plus all three Teardown details.
- The focused Phase 8 Playwright test passes for Teardown at all four widths.

MIU 2: Blue Ocean listing aggregate-band removal

Block: FRONTEND

Files: apps/site/src/i18n/brand-logo.test.ts, apps/site/src/pages/blue-ocean/index.astro, tests/e2e/public.spec.ts

Type: modify-existing

Depends on: MIU 1

What it does:

- Uses the Phase 8 architecture as the removal contract and preserves `apps/site/src/data/blueOceanProducts.ts` as the card/detail data source.
- Deletes only `avgMargin`, `totalProducts`, `minMoq`, and the listing stats section; retains `products`, intro, `products.map`, `ProductConceptCard`, partnership content, navigation, and CTA.
- Adds source/browser assertions for three cards, retained detail links, the 390/768/1024/1440 column layout, heading order, and no horizontal overflow.

Build/Deploy/Runtime impact:

- Changes only generated `/blue-ocean/index.html`; no route, data, API, schema, dependency, environment, or function change.
- The Astro static build and overwrite of the existing CloudBase listing path are affected. No remote prune is required.

Test plan:

- Red: assert the listing source no longer contains `avgMargin`, `totalProducts`, `minMoq`, or the stats section signature.
- Red: at 390/768/1024/1440 assert `Concept Products`, `Avg. Gross Margin`, and `Starting MOQ` are absent while exactly three concept cards remain.
- Guard: collect all three card detail hrefs, require HTTP 200, and assert retained BOM, margin, MOQ, partnership tiers, CTA, heading flow, and no horizontal overflow.

Done when:

- Focused site tests and site typecheck pass after the Blue Ocean removal.
- The intended-origin site build emits `/blue-ocean/` plus all three Blue Ocean details.
- The focused Phase 8 Playwright test passes for both listings at all four widths.

MIU 3: Active OEM experience and shared form-success normalization

Block: FRONTEND

Files: apps/site/src/i18n/brand-logo.test.ts, apps/site/src/i18n/content/oem/en-US.md, tests/e2e/public.spec.ts

Type: modify-existing

Depends on: MIU 2

What it does:

- Treats `apps/site/src/i18n/content/oem/en-US.md` as the `OemContent` contract consumed unchanged by `ReasonList`, `CTASection`, and both existing `ProjectForm` instances.
- Changes only `15+` to exact `20+` and the shared form-success promise to exact lowercase `within 24 hours`.
- Preserves form fields, upload behavior, `/api/admin`, result path, disclaimer, and success-state reveal logic.

Build/Deploy/Runtime impact:

- Changes generated homepage and `/oem/` content only; no client logic, endpoint, schema, auth, SDK, dependency, or environment change.
- Both forms inherit one changed Markdown producer; no consumer file is modified.

Test plan:

- Red: source contract requires exact `stat: '20+'` for Years of Experience and rejects `15+`.
- Red: source contract requires the exact shared success sentence with `within 24 hours` and rejects case-insensitive `business day`.
- Red: browser asserts `/oem/` visibly renders `20+`; homepage and OEM `[data-success]` DOM both contain the approved promise without submitting a real inquiry.

Done when:

- Focused site tests and site typecheck pass with both ProjectForm consumers still wired to `submit.successBody`.
- The intended-origin site build contains `20+` and the approved success copy in homepage/OEM output, with no stale phrase.
- Focused Playwright verifies both rendered carriers without an API mutation.

MIU 4: Submission-result response-time normalization

Block: FRONTEND

Files: apps/site/src/lib/oem-inquiry-routing.test.ts, apps/site/src/pages/oem_submit_result.astro, tests/e2e/public.spec.ts

Type: modify-existing

Depends on: MIU 3

What it does:

- Uses the approved `within 24 hours` claim from `docs/oem-phase-1-5/PHASE8_ARCHITECTURE.md` and keeps the existing result-page route and `OEM_INQUIRY_HREF` consumer unchanged.
- Replaces only the stale response-time phrase; preserves the project-id display, “Submit another request” link, layout, and result-page semantics.
- Adds source/browser assertions for exact copy and retained inquiry routing.

Build/Deploy/Runtime impact:

- Changes only generated `/oem_submit_result/index.html`; no API response, form redirect, route topology, dependency, or function change.
- The Astro static build and existing hosting path overwrite are affected.

Test plan:

- Red: source contract requires the result page to contain `get back to you within 24 hours.` and rejects `/business day/i`.
- Red: browser visits `/oem_submit_result?id=phase8-check`, requires visible `within 24 hours`, and rejects the old phrase.
- Guard: the project id and canonical `OEM_INQUIRY_HREF` link remain present and functional.

Done when:

- Focused routing/site tests and site typecheck pass.
- The intended-origin site build contains the new result copy and no stale phrase.
- Focused Playwright verifies result copy, id rendering, and retained CTA target.

MIU 5: Dormant storefront response-time source parity

Block: FRONTEND

Files: apps/site/src/i18n/hidden-sections.test.ts, apps/site/src/i18n/content/headphones/en-US.md, apps/site/src/i18n/content/overstock/en-US.md

Type: modify-existing

Depends on: MIU 4

What it does:

- Treats the two Markdown files as retained source contracts consumed by the existing typed loaders without restoring their underscore-prefixed routes.
- Replaces only each inquiry intro’s stale response promise with exact lowercase `within 24 hours`.
- Extends the existing hidden-section guard so source parity cannot reintroduce public navigation or routes.

Build/Deploy/Runtime impact:

- No public route or visible runtime output is introduced; Astro/Vite still parses the retained Markdown sources during site checks/builds.
- No API catalog, DTO, schema, island, navigation, or deployment topology change.

Test plan:

- Red: headphones content must contain `typically replies within 24 hours.` and no case-insensitive `business day`.
- Red: overstock content must contain `reply within 24 hours.` and no case-insensitive `business day`.
- Guard: main site content still has no `/headphones` or `/overstock` link, and the static build emits neither public route.

Done when:

- Focused hidden-section/site tests and site typecheck pass.
- The intended-origin site build succeeds and emits neither hidden storefront route.
- A source-wide claim scan finds no stale response-time phrase in site content.

MIU 6: OEM confirmation-email SLA and packaged admin artifact

Block: INTEGRATION

Files: packages/email/src/index.ts, apps/functions/admin/src/oem-email-content.test.ts

Type: modify-existing

Depends on: MIU 5

What it does:

- Treats `packages/email/src/index.ts` as the existing email contract consumed unchanged by `apps/functions/admin/src/handler.ts` and bundled by the existing admin `tsup.config.ts` `noExternal` rule.
- Changes both OEM plain-text and HTML confirmation templates to `respond within 24 hours.` without changing SMTP, escaping, environment, delivery, or best-effort failure behavior.
- Adds an admin-owned source contract before the existing build/package pipeline proves the final artifact bytes.

Build/Deploy/Runtime impact:

- Changes bytes in the existing admin CloudBase function artifact only; public API behavior, routes, dependencies, SDK surface, and environment remain unchanged.
- Function builds and `scripts/package-functions.mjs` regenerate ignored `dist/` and `.cloudbase-artifacts/`; generated files are inspected and never committed.

Test plan:

- Red: source contract requires the OEM plain-text template to include `respond within 24 hours.`.
- Red: source contract requires the OEM HTML template to include `respond within 24 hours.</p>`.
- Guard: the OEM email function contains exactly two approved occurrences, no case-insensitive `business day`, and the existing handler still calls `sendOemConfirmationEmail` with the same payload.

Done when:

- Email/admin typechecks and the admin test suite pass.
- Both function builds, `node scripts/package-functions.mjs`, and `node scripts/smoke-function-artifacts.mjs` pass.
- The packaged admin artifact contains `within 24 hours`, excludes `business day`, cold-starts in the bare temporary directory, and no generated output is staged.

## Dependency graph

```text
1 → 2 → 3 → 4 → 5 → 6
```

## File-count check

| MIU | Block | Files | Result |
|---:|---|---:|---|
| 1 | FRONTEND | 3 | PASS |
| 2 | FRONTEND | 3 | PASS |
| 3 | FRONTEND | 3 | PASS |
| 4 | FRONTEND | 3 | PASS |
| 5 | FRONTEND | 3 | PASS |
| 6 | INTEGRATION | 2 | PASS |

## Phase 7.5 API contract check

N/A. No endpoint, action, request/response shape, status code, schema, auth rule, SDK surface, upload flow, environment variable, or client/server contract changes.

## Open questions

None. G4 was approved; MIUs 1–6 and local G5 are complete. Exact-SHA review and delivery remain.