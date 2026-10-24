# Requirement-to-code matrix

Every numbered requirement in `APPROVED_DESIGN_SPEC.md`, with its status and
where it lives. Status is one of **implemented**, **partial**, **not
implemented**, or **superseded** (a repository fact changed; see
`DESIGN-AMENDMENTS.md`).

Nothing below is marked implemented on the strength of a synthetic fixture
alone: every row touching parsing, grouping, inventory or description was
re-verified against the real customer workbook on 2026-08-27.

## §2 Goals

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Accept this workbook format and compatible future versions | implemented | `providers/dianxiaomi/headers.ts`, `workbook.ts`; `real-template.test.ts` pins all 44 real columns |
| 2 | Every valid exported product eligible regardless of published/draft | implemented | `readListingStatus`; draft rows import and publish |
| 3 | Preserve parent, variant, store listing, price, stock, media, identity | implemented | `grouping.ts` → `StoreListingRecord`; `catalogSourceLinks` |
| 4 | Operator preview plus one bulk publish action | **partial** | preview: `islands/admin/catalog-import/`. Bulk action exists as `publishImportedSample` but is CLI-invoked — see amendment A3 |
| 5 | Reject only invalid items; one bad row must not block the rest | implemented | row-level findings; `workbook.ts` continues past every recoverable failure |
| 6 | Idempotent repeat imports with a field-level delta before apply | implemented | `catalog-import-store.ts` deterministic ids; `computeImportDelta` |
| 7 | Preserve Alibaba collections, fields, protocol, ownership, storefront | implemented | `assertNoAlibabaFields`; no Alibaba file in the diff; byte-identical projection tests |
| 8 | Reuse the existing environment, database, media registry, storage | implemented | same `DbAdapter` and `MediaStorageAdapter`; no new service |
| 9 | Provider-neutral adapter boundary for a future API transport | implemented | `contracts.ts`, `CatalogSourceAdapter`; only `providers/dianxiaomi/*` is provider-specific |

## §5 Source identity and grouping

| Requirement | Status | Where |
|---|---|---|
| Normalize identifiers as trimmed strings; never parse SKUs as numbers | implemented | `identity.ts` (NFKC, no `Number()`); tested on `1e5`, `0012300` |
| Deterministic identities for job, channel product/variant, candidates | implemented | `importJobId`, `sourceProductKey`, `sourceVariantKey`, `candidateGroupKey`, `candidateSkuKey` |
| Media identity: source URL, then content SHA-256 after download | implemented | `dedupeImageUrls`; `migrateImageLocally` dedupes on content hash |
| Same parent SKU across stores → one product candidate | implemented | `groupListings`; real file: 100 store listings → 77 products |
| Same SKU across stores → one variant candidate | implemented | real file: 312 store lines → 289 variants, 23 SKUs in 2+ stores |
| Store price/stock/status/id/timestamps stay separate records | implemented | `StoreListingRecord`, `linkKind: 'store'` |
| Conflicting identity quarantined, not silently merged | implemented | `VARIANT_PARENT_CONFLICT`, `VARIANT_BRAND_CONFLICT` |

## §6 Adapter contract

| Requirement | Status | Where |
|---|---|---|
| Address columns by normalized header name, never position | implemented | `mapHeaders`; reorder test |
| Versioned alias table with known aliases | implemented | `HEADER_ALIASES`; `templateId` is a digest of the recognised set |
| Tolerate reordered and additional columns | implemented | `headers.test.ts` |
| Optional columns absent rather than failed | implemented | "imports when every optional column is absent" |
| Fail the job when required identity headers are missing | implemented | `WORKBOOK_MISSING_REQUIRED_HEADERS`, naming what was missing and present |
| Reject only affected items on row-level failures | implemented | per-row findings |
| Record unknown headers in the report | implemented | `ignoredHeaders` + `recognisedUnusedHeaders` (deliberately separate) |
| Preserve the original workbook unchanged | implemented | read-only; only the SHA-256 is stored |
| Required identity fields: parent SKU, SKU, 产品标题, 店铺 | implemented | verified against the real file at columns 1, 6, 3, 40 |
| Output carries template signature, mapping, candidates, listings, source category, price+currency, stock, ordered media, raw+parsed timestamps, warnings/errors/ignored | implemented | `CatalogImportDetail` |

## §7 Persistence

| Requirement | Status | Where |
|---|---|---|
| `catalogImportJobs`, `catalogImportItems`, `productVariants`, `catalogSourceLinks`, `sourceCategoryMappings` | implemented | `packages/shared/src/collections.ts` |
| Original workbook and reports in private storage; DB holds metadata only | **partial** | local phase stores only the digest and normalized records; CloudBase storage is production work (A2) |
| `products` remains the curated website product | implemented | untouched shape; only operator-owned fields written |
| Existing `images` and media rules remain authoritative | implemented | migration creates ordinary `images` rows via the existing adapter |
| Every `alibaba*` collection and field unchanged | implemented | guard + tests |
| Category compatibility | superseded | see amendment A1 |

## §8 Field ownership

| Field class | Status | Where |
|---|---|---|
| Operator-owned website content never overwritten after edit | implemented | `OPERATOR_OWNED_PRODUCT_FIELDS`; "operator edits survive a repeat import" |
| Publication state not changed by source status | implemented | publication is a separate decision; imports land unpublished |
| USD price recomputed by a versioned policy, never relabelled | **not implemented, deliberately blocked** | no USD field is written; blocked on the four §19 confirmations |
| Source fields refreshed each import | implemented | `recordStoreLink` refreshes source-owned fields only |
| Dianxiaomi path must not write Alibaba fields | implemented | `assertNoAlibabaFields` at one seam |
| Public image choice/order operator-owned after first import | implemented | `imageIds` is operator-owned; source changes surface as diffs |

## §9 Publication and source status

| Requirement | Status | Where |
|---|---|---|
| Three independent state machines | implemented | `sourceListingStatus`, item `status`, `products.published` |
| Marketplace id + platform-published timestamp ⇒ source published | implemented | requires both; verified 129/183 split on the real file (A5) |
| Source status does not exclude website import | implemented | draft rows publish |
| One bulk action for the job | **partial** | A3 |
| Rejected items stay unpublished and appear in the report | implemented | item status `rejected`; preview filter |
| Warnings do not block unless unsafe/identity/category | implemented | only errors block; unmapped category blocks via publication rules |

## §10 Price and inventory

| Requirement | Status | Where |
|---|---|---|
| `sourceCurrency = CNY`; never inferred from the `_MY` suffix | implemented | `SOURCE_CURRENCY`; tested explicitly |
| Versioned USD policy storing source amount, policy version, FX snapshot, timestamps, unrounded and rounded | **not implemented, deliberately blocked** | §19 confirmations outstanding |
| Regular and promotion price preserved separately | implemented | `sourceRegularPrice`, `sourcePromotionPrice` |
| `2101-12-31 23:59:59` is an open-ended sentinel | implemented | `PROMOTION_DATE_OPEN_ENDED`; 126 rows on the real file |
| No promotion display without currency and interval policy | implemented | nothing promotional is published |
| Inventory stored per (provider, store, SKU) | implemented | `inventorySnapshots` with `storeKey` |
| Never sum repeated store rows | implemented | `reconcileInventory`; real file: 289 exact, 0 conflicting |
| Four-way reconciliation rule | implemented | `known` / `conflict` / `unknown`; conflict and unknown emit no number |
| Conflicts exposed in the admin report | implemented | red, worded, never a number |

## §11 Description normalization

| Requirement | Status | Where |
|---|---|---|
| `1`, `<p>1</p>`, `<br>` treated as absent | implemented | `descriptions.ts` |
| HTML sanitized through an allowlist before display or storage | implemented | re-emitting sanitizer; preview renders text only |
| Fallback 1 → 2 → 3 → 4 | implemented | `description-fallback.ts`. Real file: 130 rows used the short description, 71 used structured copy |
| No LLM; generated copy restates supplied fields only | implemented | pure string assembly; a test asserts every word comes from the title, a label, or a supplied value |

## §12 Images

| Requirement | Status | Where |
|---|---|---|
| Treat URLs as valid transport references | implemented | real file: 452 unique across 1,549 references |
| Preserve source URLs for audit | implemented | on the candidate; never public |
| Dedupe URLs before download | implemented | `dedupeImageUrls` |
| Remote URLs only in authenticated preview | implemented | admin only, `referrerPolicy="no-referrer"` |
| Download after item validation | implemented | publish-time, bounded |
| Byte ceilings and magic-byte MIME detection | implemented | 10 MiB; sniffing proved decisive on real files (PNG/WebP behind other extensions) |
| Reject active content and disallowed formats | implemented | JPEG/PNG/WebP only; SVG rejected |
| Content SHA-256, reuse existing bytes | implemented | dedupe by hash |
| Store originals through the existing private media lifecycle | **partial** | local disk in this phase; CloudBase is production work (A2) |
| Publish only existing media IDs under the visibility gate | implemented | `imageIds` + existing refcount gate |
| Gallery limited to the catalog image maximum | implemented | `MAX_PRODUCT_GALLERY_IMAGES`; `GALLERY_TRUNCATED` |
| One migrated primary image required before public publication | implemented | via `validateProductPublication` |
| Media failures exposed and retryable without duplicate objects | implemented | per-image failure; content-hash dedupe on retry |

## §14 Repeat imports and deletion

| Requirement | Status | Where |
|---|---|---|
| Refresh source-owned fields only | implemented | delta over `SOURCE_OWNED_LINK_FIELDS` |
| Preserve operator content and image selection | implemented | tested |
| Mark absent rows `sourceMissing`; never auto-delete or unpublish | implemented | `sourceMissingSince`; nothing is removed |
| Never infer missing records from a partial or invalid export | implemented | `completeSource === false` ⇒ empty `sourceMissing` |
| Keep file hash and source timestamps for replay | implemented | job id is the digest |
| Byte-identical workbook is a no-op unless replay requested | implemented | verified on the real file |

## §15 Security and public projection

| Requirement | Status | Where |
|---|---|---|
| Imports and reports admin-only | implemented | admin collections are `readOnly`/`none` |
| Workbooks and pre-publication media private | implemented | workbook never stored; media behind the refcount gate |
| File size, structure, rows, images, concurrency bounded | implemented | ZIP + sheet limits; bounded image budget |
| HTTPS, redirect limits, private-address rejection, timeouts, size limits | implemented | `catalog-import-media.ts`; 16 policy tests |
| Public APIs project approved fields only | implemented | 4-field variant allowlist; leak test on the real payload found nothing |
| Public media keeps the published-reference gate | implemented | unchanged |

## §17 Validation and tests

| Requirement | Status | Where |
|---|---|---|
| Adapter fixtures (12 listed cases) | implemented | `headers.test.ts`, `workbook.test.ts`, `real-template.test.ts`, `xlsx-sheet.test.ts` |
| All 11 listed invariants | implemented | see the individual rows above |
| CloudBase contract gates (`pnpm verify:cloudbase-sdk`) | **not implemented — out of scope** | that gate contacts CloudBase; this phase is local-only by instruction. Required before production |

## §18 Rollout

| Stage | Status |
|---|---|
| 1. Dry run: parse, validate, group, report, no writes | implemented and executed on the real workbook |
| 2. Staging apply: links and private media, no publication | implemented |
| 3. Test publish: bounded sample plus Alibaba regression | implemented and executed (3 products, 5 variants, 12 real images) |
| 4. Full job approval | **partial** — the bulk action exists; no admin button (A3) |
| 5. Repeat import: delta-only updates and missing-source | implemented and executed |
| 6. Optional API transport | not implemented, by design |
