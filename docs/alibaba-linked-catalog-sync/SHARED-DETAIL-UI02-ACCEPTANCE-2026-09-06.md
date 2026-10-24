# UI-02 — local canonical data and real detail API

Date: 2026-09-06 (Asia/Tokyo). Base: `4cd6344` on
`fix/alibaba-sync-storage-wiring`.

## Outcome and boundary

Implemented the UI-02 local backend slice from
`SHARED-PRODUCT-UI-FINAL-SCOPE-2026-09-05.md`. Three previously synced, real Alibaba
headphone observations now have persisted local canonical products and variants,
local media objects, and responses from the actual public-api HTTP handler.

**This was not a new Alibaba sync run.** No OAuth credentials were read or
exported; no Alibaba API call, cloud write, cloud publication, category mapping,
worker activation, deployment, or RFQ submission occurred. The source images
were fetched from their supplier URLs using the existing SSRF-safe image fetcher.

The new route is opt-in through `PublicHttpConfig.enableCatalogDetail`; the
cloud entry point does not enable it. This deliberately does not claim that
production sync now materializes the new canonical detail model automatically.

## Local execution evidence

Input is the private UI-01 snapshot at
`apps/local-server/data/shared-ui/observations.local.json`, digest:
`995d66769b1beeca24799e9f06969ef6a62ae69f7419a5b801c53a5c87617110`.

Output DB/media: `apps/local-server/data/shared-ui/ui02/` (Git-ignored).
Existing dev data and the Excel prototype worktree were not modified.

| Local clone | Variants | Images | Price states |
| --- | ---: | ---: | --- |
| `24ee8f21-1cac-49f0-93a2-30ba1746289f` | 3 | 6 | tiered |
| `c1cdd2d8-4141-4a5a-8c90-7dc11a163df0` | 6 | 6 | unavailable |
| `227c01eb-b155-4e4a-b78a-8be6d12e3823` | 4 | 6 | unavailable |

- Prepared and explicitly approved these **local clones** twice. Canonical product
  IDs remained unchanged; persisted totals stayed **3 products / 13 variants /
  18 images**. Second run reused migrated images; no failed media entries.
- Started the dedicated loopback API on `127.0.0.1:3012`.
- Real HTTP GETs returned 200 and passed the shared detail decoder for all three.
- All 18 image endpoints returned 200. Their response-byte SHA-256 values matched
  the persisted image checksums; total verified bytes: **1,073,012**.
  Each response carried `X-Content-Type-Options: nosniff`.
- Unknown product returned 404.
- The in-app browser refused the localhost navigation with
  `net::ERR_BLOCKED_BY_CLIENT`. Its supported troubleshooting documentation did
  not provide a remedy. No browser protection was disabled. Browser rendering
  remains unverified; the HTTP/byte checks above were executed independently.

## Implementation seams

### Source candidate versus approved detail

`catalog-detail-workspace.ts` wires **only** `JsonFileAdapter` and
`LocalDiskMediaStorage`. It reuses `bindProduct`, `bindVariant`, `writeVariant`,
identity-reserving product saves, and the existing media/ref-count lifecycle.
The only existing import-store change narrows the binding function's input to
the three fields it actually reads; runtime behavior is unchanged.

Local clones use a separate `ui02:` source-binding namespace and UUID canonical
IDs. Source identifiers and SKUs are not global product identities. Different
providers with identical keys/SKUs cannot accidentally adopt one another's clone.
Existing rows with another owner are rejected rather than overwritten.

- Products and variants first receive `detailSourceCandidate` data.
- Manual product title/description, family/category, publication and review/NEW
  fields are preserved on replay. An untouched **draft** gallery can be repaired
  after an earlier missing-media import; published galleries are not replaced.
- Canonical variant fields use a three-way update against their previous source
  values, preserving operator edits. Candidate changes do not replace the
  approved detail snapshot.
- A complete source product can mark only its own missing variants. Nothing is
  physically deleted or spuriously archived. Partial observations are rejected
  at this seam, not treated as evidence of source removal.
- Explicit `approveLocalDetail` validates all rows/media, writes a revision to
  approved variant snapshots, then writes the product's approval pointer and
  runs the existing published-image ref-count backfill.
- Approval is a local rehearsal function, not a newly exposed admin/cloud action.
  No candidate becomes publicly readable merely because it passes Zod.

The Excel integration test uses the real workbook parser and the adapter's
existing **grouped-candidate** projection. Store-scoped observations remain
`partial-product`; we did not relabel one store as a complete product or add
inventory from several stores. That test uses a generated workbook and an
explicit synthetic test image, not the client's real Excel file.

### Detail API

`GET /api/products/{canonicalId}/detail?page=1&pageSize=50`

- Existing publication/archival gates apply before reading detail data.
- A strict approval snapshot must exist; legacy products without one return 404
  on this new route. Their existing detail/list routes remain unchanged.
- Reads approved `productVariants` by product/revision, ordered by approved
  position then canonical `_id`. No source observation/evidence read occurs.
- Returns `variants.items`, `total`, `page`, `pageSize`, `hasMore` and `revision`.
  Subsequent UI requests should send `revision=...`; mismatch returns 409 so the
  UI reloads page 1 rather than combining two approval versions.
- Rechecks publication and revision after the variant query; inconsistent counts,
  corrupt identities, or concurrent unpublication fail closed.
- Returns `Cache-Control: no-store`; malformed pagination returns 400.
- Local Express routing delegates to this same HTTP adapter, not a mock endpoint.

## Reproduce

From the repo root, with the private UI-01 snapshot present:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/local-server exec tsx src/catalog-detail-cli.ts --fetch-images --approve-local
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/local-server exec tsx src/catalog-detail-cli.ts --serve
```

Stop the server before preparing again. `JsonFileAdapter` already provides
cross-process ownership and stale-owner recovery; no second lock implementation
was added. Preparation while the server owns the DB is rejected, not allowed to
silently overwrite its cached state. `--serve` alone performs no preparation or
approval. The Node option is local runner compatibility, not remote runtime
configuration. The service binds loopback only and is not tunneled.

Example response:
`http://127.0.0.1:3012/api/products/24ee8f21-1cac-49f0-93a2-30ba1746289f/detail`.

## Verification and review

- 12 new local integration tests: replay/disk reopen, both providers through real
  HTTP, 51-variant pagination/revision changes, manual edits, NEW/review flags,
  source removals, unknown/archived products, corrupt approval and variant IDs,
  unpublish during read, draft/public media bytes, actual Excel adapter grouping,
  image repair, incomplete-source rejection, published-title/gallery preservation.
- Full workspace typecheck passed (seven existing Astro hints, no errors).
- Full workspace test command passed; focused integration tests rerun after final
  review. CloudBase SDK contract verification passed; public-api build passed.
- Biome and whitespace checks are part of the final closeout.

Review was local, against `4cd6344` and UI-02 requirements, with separate standards
and scope checks; no agents were delegated. The CloudBase review matrix adds no
new auth/SQL/Web-SDK rules to this local-only slice. Existing SDK/media contracts
were left intact and the repo's executable SDK gate passed.

Review corrections: kept the existing image publication requirement; used grouped
Excel data rather than a partial store observation; prevented published gallery
replacement; rejected corrupt archived states and canonical IDs; reused the
adapter's existing process lock instead of a redundant CLI lock; preserved the
existing `/api/products/slug/detail` route instead of shadowing it with the new
`/{id}/detail` pattern. That route is covered by the real HTTP integration test.

## Next: UI-03, not a cloud migration

Connect the approved prototype layout to the new detail route, including revision
handling and variant/gallery/quantity state. The old list still carries legacy
variants; the new selection UI must **not** use that truncated list field. This
slice does not replace old public consumers or enable production source replay.

Before any future cloud enablement: implement and authorize the production
approval/materialization action; provision/verify the product + revision + sort
query indexes; reconcile variant-only media with the public image reference
lifecycle; verify all old/new public consumers; and test migration/replay under
real concurrent sync. The local approval helper deliberately rejects variant
images outside the approved product gallery until that lifecycle is defined.

No new product/RFQ UI, responsive screenshots, focus/dialog acceptance, or visual
completion is claimed here. Those remain UI-03 through UI-05.
