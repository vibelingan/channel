# Shared detail UI-01 — implementation and acceptance

Date: 2026-09-06 (Asia/Tokyo)

Scope: the first independently checkable slice of
`SHARED-PRODUCT-UI-FINAL-SCOPE-2026-09-05.md`, not the complete new UI.
Base: `fix/alibaba-sync-storage-wiring@97c645a`.

## What is implemented

- The two existing source adapters still emit `CatalogSourceObservation`.
  `buildCatalogDetailCandidate` now converts one **explicitly bound** observation
  into the same validated detail candidate regardless of its provider.
- The browser-safe detail schema uses Zod and extends the refactor's existing
  public product identity schema. It does not import the source parser, workbook
  library, database, CloudBase SDK, or Node crypto into the browser contract.
- Source offer validation moved to `shared/catalog-pricing`. The old
  `catalogSourcePricingSchema` export remains an alias; existing source validation
  and price semantics are unchanged. No new third-party dependency was installed.
- Product/variant IDs must come from explicit bindings. The mapper does not create
  persisted IDs, merge stores, match titles/SKUs, publish products, or mutate data.
- Product-level offers remain product-level; SKU-scoped offers remain on that SKU.
  Offers are labeled `source-quote`, never implicitly website selling prices.
- Unknown stock, reported zero stock, and conflicting stock are different states.
  Reported stock retains its source semantics; observations are never summed.
- Description output is text, not supplier HTML. Images require an image-ID
  binding and produce only `/api/images/{id}` paths. This path restriction is not
  authorization: the existing media handler must still enforce publication and
  ref-count gates when UI-02 connects the route.
- Variant pagination includes total/page/pageSize/hasMore. All canonical bindings
  are checked, even outside the selected page. Galleries retain the existing
  nine-image maximum and report truncation/unbound media as warnings.

## Refactor reuse, without merging its workstream

Selectively copied from pinned refactor commit `03b5f17`:

| Module under `packages/shared/src/catalog/` | Purpose |
| --- | --- |
| `index.ts` and test | Existing strict catalog contract and page envelope |
| `alibaba-pricing-adapter.ts` and test | Existing Alibaba public pricing boundary |
| `resolve-pricing.ts` and test | Existing pricing precedence |

New detail and source-quote modules live alongside these modules. This does not
replace the legacy public API response contract yet. The existing API and UI do
not import the new detail candidate in this slice. Media/presentation modules
remain for their actual consumers in subsequent slices.

## Real Alibaba sample calibration

Read-only CloudBase query against `catalogSourceObservations`, provider `alibaba`,
source category `201745901`, limit 3. The read occurred on September 6 JST.
These are previously synced observations read from our database, **not three new
Alibaba product.get calls and not a whole-catalog acceptance**.

Private snapshot: `apps/local-server/data/shared-ui/observations.local.json`.
The directory is Git-ignored. No account IDs, raw bodies, source URLs, tokens, or
private sample data are included in this report or committed fixtures.

Snapshot SHA-256:
`995d66769b1beeca24799e9f06969ef6a62ae69f7419a5b801c53a5c87617110`.

| Snapshot ordinal | Variants | Offer result | Candidate validation |
| --- | ---: | --- | --- |
| 1 | 3 | 3 tiered offers | Passed |
| 2 | 6 | 6 unavailable offers | Passed |
| 3 | 4 | 4 unavailable offers | Passed |

Calibration used deterministic **local-only aliases**, not persistent binding
records: SHA-256 of `ui01-local-product:{sourceProductKey}` and
`ui01-local-variant:{sourceVariantKey}`. These are test identities, not the
production identity allocation policy. No database writes occurred.

All three have six source media entries but no local image binding in this slice.
Consequently all return zero projected images with `unbound-media`. This is an
explicit incomplete media setup, not a successful image-rendering test.

## Checks

- `detail-candidate.test.ts`: 12/12 passed, including the real Excel parser and
  observation adapter running a generated acceptance workbook. This is not a new
  run of the client's original XLSX file.
- `alibaba-observation-adapter.test.ts`: 3/3 passed, including Alibaba detail →
  actual Alibaba adapter → common candidate → detail decoder. Input for this
  automated test is synthetic; the separate three-row calibration above is real.
- Negative cases cover null/undefined/empty/malformed input, private extra fields,
  invalid/duplicate canonical IDs, unsafe media, malformed minor-unit prices,
  overlapping price tiers, inconsistent pagination, >50 variants, zero variants,
  unknown versus zero inventory, conflicting inventory, and product/SKU offer
  association.
- Full workspace typecheck passed, including E2E TypeScript. Astro reports seven
  hints in unchanged existing files; no type errors.
- Site build passed. This is a regression/build check, **not new UI rendering
  acceptance**: the new detail schema is not wired into the site yet.
- Biome on changed TypeScript/package files and `git diff --check` passed.
- Full workspace test suite passed both before and after final review:
  `NODE_OPTIONS=--no-experimental-webstorage pnpm test`, exit 0. The option is a
  local test-runner compatibility setting, not a remote runtime/config change.

## Review boundary

Reviewed locally against the base above and the UI-01 requirements, along separate
standards and specification checks. No sub-agents were used, per project rules.

Standards: explicit allowlist projection; existing Zod runtime; no SDK changes,
public permission changes, external calls in the mapper, dependency duplication,
new framework, or provider-specific renderer. Review caught and corrected a
canonical-ID gap: whitespace/overlong IDs could previously pass on an off-page
variant. Regression tests now cover that case.

Spec: UI-01's shared-contract/adapter/sample seam is implemented. This is not
canonical variant materialization, not cross-store reconciliation, and not an
approved public content projection. Those semantics must remain upstream of a
public detail response; the candidate must not be served directly from raw
observations simply because it passes validation.

## Remaining implementation, not blockers disguised as completion

1. **UI-02:** isolate local DB/media; reuse canonical source/variant bindings;
   materialize samples idempotently; preserve manual edits and publication state;
   connect explicit detail pagination through the real public handler and test
   draft/media privacy and removed variants.
2. **UI-03/04:** integrate the approved Excel worktree prototype layout into the
   existing site shell, using this common detail seam; implement actual variant,
   gallery, quantity, and local-only RFQ dialog state.
3. **UI-05:** run desktop/mobile browser interactions, screenshots, focus checks,
   console checks, and return-to-list acceptance against both sources.

The source prototype worktree and existing category audit files were not edited.
No categories were remapped, no cloud data was written, no product was published,
no import worker was enabled, no deployment occurred, and no RFQ was sent.
