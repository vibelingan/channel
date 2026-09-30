# Admin classification and navigation — technical MIUs

Status: **UI-only release: MIU 1 cancelled; MIUs 2-5 implemented and locally verified after the user's authorization to finish the remaining phases. Not deployed.** Keep the current <=20 selection and existing revision-checked sequential publication; no server batch, SDK upgrade or per-product live progress. The approved [SPEC](SPEC.md) intent and [UI design](ui-design.md) layout/palette remain. See the current [architecture](ARCHITECTURE.md) and [ADR](../../.claude/docs/adr-hld-admin-assign-publish.md).

The backend batch investigation and its separate test-environment gate remain in [SDK-PROBE.md](SDK-PROBE.md). Do not slip a server loop or a blind `published:true` update into this release. The site consumes existing `assignmentCall` and `publishConfirmedClassification` receipts, distinguishes partial/unknown outcomes, and makes no atomicity or speed claim. Existing role, approval and image visibility behavior remains unchanged.

The verified selection cap is 20, not 100. A future 150-record selection or atomic batch needs its own requirements, architecture and G3/G4 approval; it is not a dependency of MIUs 2–5. Preserve named final product outcomes without introducing a per-product progress callback.

Product tasks: make save-versus-publish explicit and recover ambiguous outcomes (MIUs 2, 4); keep product actions/roles usable (MIU 3); fix narrow-screen navigation and bounded scrolling (MIU 5). No current product task requires MIU 1.

## Cancelled MIU 1: Sequential publication progress callback (historical; DO NOT IMPLEMENT)

- **Block:** FRONTEND
- **Files:** `apps/site/src/islands/admin/api.ts`; `apps/site/src/islands/admin/catalog-taxonomy-ui.test.ts`
- **Type:** modify-existing
- **Depends on:** none
- **What it does:**
  - Introduce an optional local callback `{processed: number, total: number, confirmedPublished: number}` to `batchUpdateRecords` and thread it through `publishConfirmedClassification`. The request/result contracts remain in `apps/site/src/islands/admin/api.ts`; no Admin wire DTO or new endpoint.
  - Call it only after a validated per-product response or recorded attempted-item failure, never for a not-attempted item; retain sequential order, expected revisions and stop-on-unknown semantics. Progress means processed, not guaranteed published.
- **Build/Deploy/Runtime impact:** Site bundle only. No dependency, function artifact, SDK, schema, secret or CI config change. Runtime emits local progress notifications without extra network requests; existing CI site build and disposable browser lane exercise the bundle.
- **Test plan (TDD, write first):**
  - With two confirmed revisioned products, assert exactly two sequential `update` requests, correct expected revisions, callbacks `(1,2,1)` then `(2,2,2)`, and `result.updated === 2`.
  - With the first response unconfirmed, assert the callback never claims publication, the second product is `not-attempted`, no second update fires and no automatic retry occurs; malformed/partial assignment yields `null` and zero update/progress calls.
- **Done when:** Progress never overstates confirmed publication and existing partial-result behavior stays intact; focused unit test and site/test TypeScript pass, with site build green.

## MIU 2: ProductClassificationEditor intent and readback state

- **Block:** FRONTEND
- **Files:** `apps/site/src/islands/admin/ProductClassificationEditor.tsx`; `apps/site/src/islands/admin/catalog-taxonomy-ui.test.ts`; `tests/e2e/admin-subcategory-visibility.spec.ts`
- **Type:** modify-existing
- **Depends on:** none (consumes existing `apps/site/src/islands/admin/api.ts` contracts)
- **What it does:**
  - Make the editor the sole owner of `ready → confirm → assigning → publishing → refreshing → result/needs-review`, with two distinct intent-named actions and confirmation, compact selection summary and explicit current-public/draft counts. Consume the existing `BatchUpdateResult`/`assignmentCall` contracts from `apps/site/src/islands/admin/api.ts` and `classificationRequest` from `taxonomy-ui-state.ts` without adding a callback or redefining a DTO.
  - Save classification omits `includeSavedRevision` and never calls publish; Save and publish requests saved revisions and requires all assignments confirmed. Block publish for public/mixed selections, warn that same-family save on public rows may change storefront filtering, and preserve assignment/publication receipts when active list readback fails. Expose an `onUnresolved` callback with submitted IDs, confirmed IDs and unresolved IDs to the parent before Check later closes; use query refetch error evidence rather than assuming awaited invalidation proves a successful read.
- **Build/Deploy/Runtime impact:** Existing Astro site bundle and Admin list/taxonomy queries only. No server deployment or dependency; active readback may extend the visible refreshing stage but must not mask confirmed write results. Built-site Playwright must exercise interaction beyond SSR.
- **Test plan (TDD, write first):**
  - Assert both actions render and the default save sends assignment without saved-revision intent and **zero** publish updates; draft Save and publish sends intent and revisioned updates only after every assignment is saved.
  - Assert public/mixed selection cannot send a publish request; same-family public Save shows its live-filtering warning. Hold assignment and early/late publish responses: assert a delayed single waiting state without live item counts, final confirmed/rejected/unknown/not-attempted summary and zero duplicate writes.
  - After confirmed writes, fail the list refetch: assert receipts remain visible, Done does not falsely clear context, Refresh statuses issues reads only (zero assignment/update retries), and successful readback then enables Done. When readback remains unavailable, Check later emits the submitted/confirmed/unresolved ID snapshot and never emits a success acknowledgement.
- **Done when:** Draft save, confirmed publication, partial rejection, conflict, unknown outcome and failed readback are visibly distinct; focused unit/built-site browser tests and site/test TypeScript compile pass, with built site green.

## MIU 3: CollectionView product controls and family filter

- **Block:** FRONTEND
- **Files:** `apps/site/src/islands/admin/CollectionView.tsx`; `tests/e2e/admin-subcategory-visibility.spec.ts`
- **Type:** modify-existing
- **Depends on:** MIU 2
- **What it does:**
  - Open the same default-Save editor from row and bulk entry. Hide the disallowed bulk Assign category action for non-admin roles; consume MIU 2's `onUnresolved` snapshot in parent state so Check later retains the selected IDs, confirmed receipts and a visible list warning until verified or explicitly cleared. Keep standalone Publish/Disable as visibility-only commands with their existing semantic colors; do not pass them through assignment.
  - Below 1280px use the existing family `Select` instead of a second scrolling tab rail. Keep the wide table's own horizontal scroll and put secondary bulk commands in an accessible Actions menu; preserve current `productFamily`/subcategory URL and query behavior.
- **Build/Deploy/Runtime impact:** Site-only rendering and event wiring, existing Admin actions unchanged. No dependency or function artifact. Measure the actual escaping element before changing overflow classes; CI site build and desktop/mobile browser lanes matter.
- **Test plan (TDD, write first):**
  - Assert row and selected-row entry both default to Save without a publish request; non-admin sees no bulk Assign category and cannot issue an assignment. Assert Check later persists selected IDs and a warning after close, without clearing confirmed receipts or issuing another write; only verified readback or explicit Clear selection removes the warning.
  - At 390/768/1024px assert the family selector updates the same URL/query filter; table scroll stays inside its region. Actions-menu Publish/Disable issue the corresponding update action and **no** classification command; Clear selection alone sends no write.
- **Done when:** Role-gated controls, result retention, narrow family filtering and independent visibility actions pass the browser spec; site/test TypeScript and site build pass with original button colors.

## MIU 4: ClassificationDialog close and focus lifecycle

- **Block:** FRONTEND
- **Files:** `apps/site/src/islands/admin/ClassificationDialog.tsx`; `apps/site/src/islands/admin/ProductClassificationEditor.tsx`; `tests/e2e/admin-subcategory-visibility.spec.ts`
- **Type:** modify-existing
- **Depends on:** MIUs 2 and 3
- **What it does:**
  - Retain `publishOnSave` only as a compatibility adapter for existing callers; the editor owns explicit save/publish intent and passes one busy signal to the native dialog. Keep Escape/Close available before writing and visibly explain blocked close while a write/readback is pending.
  - Preserve focus within the dialog and return it to the initiating row or bulk control after Cancel/Done/Check later. While a request is in flight Close/Escape remain blocked; after it settles with an unknown outcome, Close/Escape use MIU 2's unresolved callback and MIU 3's retained warning before dismissing, not Done-as-success. No new modal primitive is introduced.
- **Build/Deploy/Runtime impact:** Site-only dialog lifecycle; no API/dependency/deploy change. Must verify hydrated browser focus and keyboard handling, not only static HTML.
- **Test plan (TDD, write first):**
  - Before confirmation, Escape and Close return focus to the opener and send **zero** assignment/publish requests.
  - With assignment, publication or readback held, Escape/Close cannot dismiss the dialog, a visible reason is present and repeated Confirm sends no second write. Once readback settles unresolved, Check later/Close/Escape retain the list warning and return focus; none calls Done, clears selection or retries publication.
- **Done when:** Busy/close and focus behavior hold for success, failure and unknown results; focused browser test, site/test TypeScript and site build pass.

## MIU 5: DashboardShell narrow section navigation

- **Block:** FRONTEND
- **Files:** `apps/site/src/islands/admin/DashboardShell.tsx`; `tests/e2e/admin-product-family-tabs.spec.ts`
- **Type:** modify-existing
- **Depends on:** none
- **What it does:**
  - Retain the desktop rail at >=1280px and use the existing labeled `Select` for current section below it, preserving role-visible section membership, active section state and original Admin colors. Never substitute a gesture-only horizontal menu.
  - At the failing width measure `innerWidth`, document/shell/nav/table client and scroll widths and overflowing element bounds before adjusting CSS. Correct only the evidenced leak; keep horizontal scrolling inside the product table.
- **Build/Deploy/Runtime impact:** Site-only CSS/component layout; no endpoint/dependency/deploy change. Built-site screenshots at approved widths are required; do not claim the right blank region has a known root yet.
- **Test plan (TDD, write first):**
  - At 375/390, 734/768, 1024 and 1440px plus 200% zoom, assert the selected section matches the view, buttons fit, document has no horizontal overflow, nav/family require no horizontal scrolling, table scroll remains local, and capture screenshots/DOM geometry.
  - Assert keyboard section switching changes view without a write request and role-hidden sections do not appear as selector options; desktop retains its active rail.
- **Done when:** Screenshots and measured bounds identify and resolve the culprit without hiding scrollbars; focused browser tests, site/test TypeScript and site build pass.

## Dependency and gate checks

DAG: `MIU 2 → MIU 3 → MIU 4`; MIU 5 is independent; MIU 1 is permanently cancelled for this release. MIU 2 consumes the existing result/assignment contract in `apps/site/src/islands/admin/api.ts`; no new first-party DTO or cross-boundary server contract was needed. Every active entry lists 1–3 exact files with a happy path and negative assertion. The compatibility-only `publishOnSave` prop remains for existing callers, without restoring a default-on publish path. The user authorized UI-only implementation, not production data writes.

Verification used the pinned package manager rather than the root `npx pnpm` wrapper: `corepack pnpm --filter @vibelingan-channel/site test`, workspace and E2E typechecks, and `corepack pnpm exec biome check .`. `node scripts/run-catalog-admin-local-e2e.mjs` built the site and passed 157 browser tests on an owned disposable database, then removed it. No production writes. A local build is not a deployment; deployment and read-only live acceptance need their own separate approval/gates. Production request timing remains unverified; the local blank-space culprit was identified and contained.