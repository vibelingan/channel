# Hermes Product Import Verification - 2026-07-29

Status: customer workflow verified usable.

Environment: `diversity-123-d9grnqfux221323bb`

Product:

- ID: `483207676a6829f2008b7cba2ca33a11`
- Name: `SY-T8 Wireless Headphone`
- Published: true
- Updated: `2026-07-29T07:56:31.272Z`

## Verified Outcomes

- Existing product was updated rather than duplicated.
- Product now references 18 new unique application image IDs.
- None of the old SY-T8 IDs remains projected by the live catalog.
- All 18 new `images` rows exist.
- All 18 rows have:
  - `purpose: catalog-image`;
  - `storageProvider: cloudbase-storage`;
  - canonical `catalog/2026/07/<uuid>/original-*` paths;
  - `status: active`;
  - measured byte size;
  - SHA-256 checksum;
  - `publishedRefCount: 1`.
- All 18 public image URLs returned HTTP 200, `image/jpeg`, and non-zero bytes.
- Anonymous catalog returns the product with 18 projected image URLs and no `vipPrice`, `imageIds`,
  storage ID, or refcount fields.
- Live card cover decoded at 800x800.
- Product detail opened and returned to the matrix successfully.

## Gallery Note

The current detail view renders one main image plus 18 thumbnail images. Thumbnails are lazy, so
not every thumbnail has a non-zero `naturalWidth` immediately after opening detail. Independent
HTTP verification proved all 18 resources valid. The already-planned page optimization will limit
initial thumbnail discovery and add `View All`; this is a performance/UX follow-up, not an import
failure.

## Current Workflow Contract

Hermes may process an authorized one-product ZIP and publish through the portal sequence:

```text
parse package
  -> createUploadIntent per image
  -> direct COS POST
  -> completeUpload per image
  -> product create/update with ordered new image IDs
  -> public product/image verification
  -> return product URL
```

The workflow must fail visibly instead of silently dropping a file that affects the product:

- corrupt/unsupported image: identify filename and reject/ask for replacement;
- unsupported CSV/Word/PDF/PPTX: preserve as non-publishable attachment or report it as ignored
  with reason; never treat it as a product image or silently discard it without the result report;
- missing required product fields: list exact missing fields;
- any upload/finalize/public-image failure: do not report final success.

CloudRun quarantine/import jobs remain an optional future hardening path, not a prerequisite for
continued customer use.
