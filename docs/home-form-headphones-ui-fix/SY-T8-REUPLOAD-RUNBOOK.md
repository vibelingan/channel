# SY-T8 Canonical Re-upload Runbook

Status: approved recovery method; no re-upload or data mutation has been executed by this document.

Branch: `fix/home-form-headphones-ui`

Environment: `diversity-123-d9grnqfux221323bb`

Existing product:

- ID: `483207676a6829f2008b7cba2ca33a11`
- Name: `SY-T8 Wireless Headphone`

## 1. Decision

Abandon the old image batch as application data. Do not repair its refcounts or metadata.

Upload a fresh, approved set of 18 images through the existing portal workflow:

```text
createUploadIntent
  -> direct multipart POST to CloudBase Storage
  -> completeUpload
  -> new active image ID with measured metadata
```

After all 18 new images are verified, update the existing SY-T8 product once, replacing the old
`imageIds` array with the new ordered IDs. Do not create a second SY-T8 product.

The old objects/metadata are not deleted during display recovery. They become an exact quarantined
cleanup set after the product no longer references them.

## 2. Why This Is Not A Hack

This uses the application's intended interfaces and invariants:

- server creates the storage key and upload credential;
- browser sends bytes directly to private CloudBase Storage;
- server re-reads and verifies size, SHA-256, and image magic bytes;
- server activates complete metadata;
- standard product update maintains references for the new IDs;
- public delivery still requires active metadata and positive publication count.

Rejected shortcuts:

- global or scoped refcount patching;
- direct TCB MCP writes to storage/NoSQL;
- manually creating `images` rows around old objects;
- making the bucket public;
- directly embedding temporary signed URLs;
- creating a duplicate product and switching traffic manually.

## 3. Inputs And Approval

Preferred source: the original customer ZIP through the approved archive-inspection process in
`CUSTOMER-ZIP-PRODUCT-IMPORT-RUNBOOK.md`.

Fallback source: the 18 existing private storage objects may be downloaded by an authorized
operator, independently verified, then treated as local source files for a new canonical upload.
This does not adopt their old metadata or IDs.

Before upload, record and approve:

- exactly 18 filenames;
- ordered gallery list;
- exactly one cover, first in order;
- per-file byte size, SHA-256, detected JPEG MIME, width, and height;
- product fields/prices to retain;
- source package/file-set digest;
- operator and UTC approval time.

Create an ordered source manifest with exactly one row per approved position:

```text
position -> filename -> byteSize -> sha256 -> MIME -> width -> height
```

Identical approved files may legitimately share a SHA-256, but every position must be present
exactly once. The recovery later binds each position to one unique new application image ID.

Observed old storage filenames, to be confirmed rather than blindly reused:

```text
Main-01.jpg through Main-06.jpg
Detail-02.jpg through Detail-07.jpg
SKU-01-White.jpg
SKU-02-Sky Blue.jpg
SKU-03-Black.jpg
SKU-04-White.jpg
SKU-05-Sky Blue.jpg
SKU-06-Black.jpg
```

Stop if the owner cannot confirm that all 18 belong to SY-T8 or cannot confirm cover/order.

## 4. Quarantine The Old Batch

Start a product-specific quiescent window: no other operator or Agent may edit SY-T8 until the
new batch is published and verified or the maintenance attempt is stopped.

Before upload, read the known product and persist an evidence ledger containing:

- old product ID;
- complete writable product field snapshot, including prices and `published`;
- current `updatedAt` as the optimistic snapshot marker;
- old ordered `imageIds` array;
- old 18 storage keys;
- old metadata IDs that exist;
- dangling IDs;
- UTC snapshot time.

Do not modify or delete the old batch yet. Quarantine means:

- no new product may reference an old ID;
- no old ID may be reused as a new upload result;
- old storage URLs remain private;
- cleanup waits until the new product display is verified and a retention period is approved.

Then perform one standard update on the known product setting only `published: false`. Read it back
and require `published: false` before uploading any new image. If the update response is ambiguous,
read before retrying. Do not proceed while the old gallery remains published.

Expected old-counter behavior: the unpublish path attempts `-1` for each existing old metadata ID;
an absent counter may become `-1`, while a dangling ID with no row is a no-op. Capture a read-only
post-unpublish snapshot of every old metadata ID and the dangling ID. Treat absent, `-1`, or other
observed old corruption only as quarantined evidence. Do not repair it in this recovery.

## 5. Canonical Upload

Use Admin -> Headphones -> edit the existing SY-T8 product.

1. Keep the existing product ID and fields.
2. Upload approved images one at a time through ImageManager.
3. Wait for each upload to finish before choosing the next image.
4. If an upload result is ambiguous or reports failure, stop. Do not click `Failed - retry` and do
   not re-upload that file until an engineer reconciles the first intent/object.
5. Verify the new thumbnail appears before continuing.
6. Arrange the 18 new thumbnails into the approved order; the cover must be first.
7. Use read-only CloudBase queries to record each new image ID and verify:
   - `status: active`;
   - `storageProvider: cloudbase-storage`;
   - canonical `catalog/YYYY/MM/...` storage path;
   - measured byte size equals the approved source position;
   - `checksumSha256` equals the approved source SHA-256 for that position;
   - `publishedRefCount: 0` before the product update.

Build and approve the final ordered mapping:

```text
position -> filename -> approved SHA-256 -> unique new imageId -> measured metadata SHA-256
```

Require exactly 18 positions and 18 unique new image IDs, with no missing or extra mapping row.
Compare the ordered source SHA-256 multiset to the ordered measured SHA-256 multiset; legitimate
duplicate source bytes are allowed only when they occur at the same approved positions.

Do not remove the old image IDs from the form until all 18 new IDs have been recorded and audited.

## 6. Replace Product References Once

Prepare one exact update to product `483207676a6829f2008b7cba2ca33a11`:

- keep `published: false`;
- preserve every approved writable non-image field from the quiescent snapshot;
- set `imageIds` to exactly the ordered 18 new IDs;
- include no old IDs, dangling IDs, duplicates, storage paths, or URLs.

Create and approve the exact normalized payload that the current form will submit. It contains
these writable fields only:

```text
name, category, series, modName, modType, description,
moq, unitPrice, wholesalePrice, vipPrice, imageIds, published
```

Match `RecordForm` coercion exactly: trim strings, omit empty optional fields, convert numeric
fields to numbers, parse `imageIds` as JSON, and always include boolean `published`. Canonicalize
the payload keys, persist the complete JSON plus SHA-256 in the maintenance ledger, and bind final
approval to that hash.

Immediately before Save, re-read the known product in a separate read-only query. Require
`published: false`, the same `updatedAt` expected after the maintenance unpublish, and exact equality
for every writable non-image field against the approved snapshot. If any value differs, stop
without saving; leave the new active images unreferenced and quarantined for a later reviewed
attempt.

Also inspect every current form control and build its normalized would-submit payload using the
same coercion rules above. Require exact deep equality with the approved payload, including all
non-image fields, `published: false`, and the ordered 18 IDs. This checks the actual browser payload,
not only the database snapshot. On any difference, stop and correct/reapprove the payload before
Save.

Save once through the standard Admin product update while the product is unpublished.

If the update response is lost or ambiguous:

1. do not save again immediately;
2. read the known product ID;
3. compare its exact `imageIds` with the intended new array;
4. retry only if the read proves the update did not commit.

Because both before and after snapshots are unpublished, replacing `imageIds` should not adjust
public refcounts. Read the product back and normalize the stored writable fields with the same
rules. Require exact deep equality with the approved full payload, not only the new image array and
`published: false`.

After the replacement read-back and new metadata audit pass, obtain final human approval and perform
one separate standard update setting only `published: true`. This publish transition is the only
step expected to increment the 18 new rows from `0 -> 1`.

## 7. Required Verification

Immediately after publication:

1. Read the product by ID and require exactly the 18 new IDs in approved order.
2. Require every new image metadata row to be active and have finite numeric
   `publishedRefCount: 1` when this is its only published catalog reference.
3. Request every projected image URL and require HTTP 200, `image/*`, and non-zero bytes.
4. Open `/headphones` at 390px and 1440px.
5. Require the SY-T8 card cover to decode with `naturalWidth > 0`.
6. Open product detail, inspect all 18 images/order, return to the matrix, and require the card to
   remain visible.
7. Confirm anonymous/viewer projections do not expose `vipPrice`; entitled roles still do.
8. Confirm a known unreferenced control image remains 404.
9. Record release ID, product ID, source-to-image mapping, new image IDs, URL statuses, browser
   results, operator, and UTC.

Do not run the global backfill as an acceptance step. If any new image count is not `1`, stop and
investigate the standard update path for only the new IDs before publication is considered valid.

## 8. Rollback

Before old-batch cleanup, containment is reference-only:

- if the product update did not commit, no rollback is needed;
- if reference replacement committed but publication did not, keep `published: false` and diagnose;
- if publication committed but any counter, URL, projection, or browser check fails, immediately
   perform a standard update setting only `published: false` while retaining the 18 new IDs;
- read back and require `published: false`; if the containment response is ambiguous, read before
   retrying;
- record any new-counter drift as quarantined evidence; do not repair it during this recovery;
- do not restore the old broken IDs as the public gallery;
- do not delete either batch.

## 9. Old-Batch Cleanup Is Separate

After the new batch has remained verified for the approved retention period:

1. Re-read all products/overstock and prove no old ID is referenced.
2. Match only the exact 18 old `products/sy-t8/` storage keys and their old metadata IDs.
3. Produce a cleanup dry-run/report.
4. Obtain explicit deletion approval.
5. Delete storage object first and verify each per-object result.
6. Delete matching metadata only after storage success.
7. Leave unrelated Portal, product, overstock, and catalog images untouched.
8. Re-run reference and storage inventory to prove no dangling cleanup state remains.

The current generic image remove and `cleanupOrphanImages` are not sufficient for active old rows.
If no dedicated exact-list cleanup action exists, retain the quarantined old batch rather than
deleting it manually.

## 10. Stop Conditions

Stop instead of saving/publishing if:

- source set is not exactly the approved 18 files;
- cover/order is unapproved;
- any upload/finalize is ambiguous;
- any new metadata row is incomplete or non-active;
- any old/dangling ID remains in the replacement array;
- product update would create a duplicate product;
- product read-back differs from the intended update;
- normalized browser form payload or normalized full writable-field read-back differs from the
   approved payload hash;
- any non-image product field or `updatedAt` drifts during the quiescent window;
- the 18-position source-to-new-ID mapping is incomplete, has duplicate new IDs, or any measured
   checksum/size differs from its approved source position;
- any new public image URL is not 200 `image/*`;
- an operation requires direct MCP writes, manual metadata/refcount patches, public bucket access,
  or a global backfill.
