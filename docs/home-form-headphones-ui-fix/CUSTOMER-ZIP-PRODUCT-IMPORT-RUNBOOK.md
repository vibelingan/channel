# Customer ZIP -> Agent -> Product Publication Runbook

Status: interim operating restriction and implementation plan. The human-operated Admin product
and image UI exists; safe Agent-side ZIP inspection and the dedicated import API do not yet exist.

Branch: `fix/home-form-headphones-ui`

Related incident SOP: `SY-T8-MEDIA-RECOVERY-SOP.md`

## 1. Decision

An Agent must never publish a customer product by independently writing:

1. CloudBase Storage objects;
2. `images` metadata rows; and
3. `products.imageIds`.

Those writes form one application lifecycle. Performing them as unrelated MCP/database
operations can create real storage bytes with missing metadata, dangling product references,
or missing publication counters, as observed in the SY-T8 incident.

There are two permitted modes:

- **Part A - current guarded mode:** the Agent records and quarantines the ZIP but does not extract
  it. A security-approved human process must supply already-inspected images and an approved
  manifest before the Agent may assist an authenticated Admin session. ImageManager performs the
  existing upload/finalize flow. A human explicitly approves publication.
- **Part B - future automated mode:** Hermes calls a dedicated application-owned import-job API
  with a short-lived, import-only service identity. The Agent can create and validate a draft;
  publication occurs only after an admin approval recorded by the application.

Until Part B is implemented, contract-tested, and deployed, Part A is the only permitted route.
If no approved archive-inspection process is available, stop after quarantine and ask the customer
for individual JPEG/PNG/WebP files plus the manifest. Direct TCB MCP storage/NoSQL publication is
prohibited.

### 1.1 Immediate Agent response today

When a customer sends a ZIP, the Agent records the intake and replies internally:

```text
IMPORT_MODE=HUMAN_ADMIN
ZIP_STATUS=AWAITING_APPROVED_TRANSFER
AUTOMATIC_PUBLISH=DISABLED
NEXT_ACTION=DEFINE_APPROVED_PRIVATE_CHANNEL_OR_REQUEST_INDIVIDUAL_IMAGES_LATER
```

The current repository has no approved ZIP quarantine/transfer system. The Agent must not download,
hash, relocate, extract, or re-upload the attachment. Leave it in WeCom and record only the message
ID, media ID if already present in message metadata, sender, filename, customer reference, and UTC
receipt time. It must not say the ZIP/images are valid, create metadata, create a product, or publish
anything. An authorized operator must first record the chosen private transfer system, responsible
operator, retention period, and ledger ID. After security-approved individual images/manifest are
available, the Agent may assist Part A through Admin under human supervision.

Customer-ready response today:

> 已收到您发送的产品资料 ZIP。当前网站尚未开放自动 ZIP 导入和自动发布，我们会先登记该消息，
> 暂不下载或处理压缩包，也不会直接发布产品。待我们确认并提供指定的私密文件通道后，请通过该通道
> 提供独立的 JPEG/PNG/WebP 图片及产品清单。收到文件不代表已通过验证，图片仍需完成安全检查、
> 商品预览和人工发布确认。

## 2. Current Repository Capabilities

### Available now

- Admin/contributor product CRUD through `/api/admin`.
- Product schema validation from the shared collection registry.
- Image upload through:
  `createUploadIntent -> direct multipart POST to COS -> completeUpload`.
- Server-side finalize checks for measured byte size, SHA-256, and image magic bytes.
- Admin-authenticated previews for active images even before publication.
- Image ordering/removal in ImageManager.
- Product `published` toggle and public refcount maintenance.
- Dry-run-capable absolute refcount reconciliation.

### Not available now

- No ZIP parser or archive extraction library is installed.
- No product ZIP import endpoint or import-job collection exists.
- No Hermes/WeCom service identity or import-only authorization scope exists.
- No atomic multi-image + product publish transaction exists.
- No dedicated compensation action safely deletes an `active`, unreferenced image row and its
  storage object. Generic image removal is not a storage cleanup operation.
- No automated customer manifest parser or review queue exists.

Therefore, an Agent must not treat the generic Admin actions as a finished batch-import API.

## 3. Customer ZIP Contract

Use one product per ZIP. The archive root must contain `manifest.json` and an `images/`
directory:

```text
customer-product.zip
├── manifest.json
└── images/
    ├── 01-cover.jpg
    ├── 02-side.jpg
    └── 03-packaging.png
```

### 3.1 Manifest v1

```json
{
  "schemaVersion": 1,
  "customerReference": "CUSTOMER-PO-OR-MESSAGE-ID",
  "product": {
    "name": "Example Wireless Headphone",
    "category": "bluetooth",
    "series": "Example Series",
    "modName": "EX-100",
    "modType": "Over-ear · Foldable",
    "description": "Approved customer-facing description",
    "moq": 500,
    "unitPrice": 12.5,
    "wholesalePrice": 9.8,
    "vipPrice": 8.8
  },
  "images": [
    {
      "file": "images/01-cover.jpg",
      "role": "cover",
      "alt": "Example wireless headphone front view"
    },
    {
      "file": "images/02-side.jpg",
      "role": "gallery",
      "alt": "Example wireless headphone side view"
    }
  ],
  "publishRequested": true
}
```

`publishRequested` records customer/operator intent only. It is not authorization and never
maps directly to `products.published: true`.

### 3.2 Allowed product fields

The import accepts only current writable product fields:

```text
name, category, series, modName, modType, description,
moq, unitPrice, wholesalePrice, vipPrice
```

Current categories are exactly:

```text
wired, office, bluetooth
```

Reject unknown keys. The package must not set `_id`, `imageIds`, `published`, timestamps,
storage IDs/paths, image status, checksum, MIME, or `publishedRefCount`.

### 3.3 Archive and image limits

These are the proposed server-enforced import-policy limits for Part B. Under Part A, the
security-approved archive inspection must attest that the same limits were applied before any
file reaches Admin:

- ZIP compressed size: at most 100 MiB.
- Total uncompressed size: at most 100 MiB.
- At most 50 archive entries and 30 image entries.
- Each image: at most the existing catalog limit of 10 MiB.
- Accepted image formats: JPEG, PNG, WebP.
- Maximum decoded image area: 40 megapixels.
- Maximum per-entry and total compression ratio: 100:1.
- No encrypted entries, Zip64, split/spanned archives, inconsistent local/central headers,
  symlinks, hard links, devices, nested archives, executables, SVG, HTML, scripts, or unsupported
  media.
- No absolute paths, drive prefixes, backslashes, `..`, empty path segments, duplicate
  case-folded paths, or filenames that normalize to the same Unicode NFC value.
- Every manifest image path must exist exactly once; every accepted image entry must appear in
  the manifest. Extra files are rejected rather than silently ignored.
- Exactly one image has `role: cover`, and it must be first in the manifest order.

Archive parsing must use one pinned, maintained ZIP library for both inspection and extraction,
with streamed actual-byte counters and entry-by-entry bounded extraction into a disposable
sandbox. This is the Zip Slip and zip-bomb boundary. Do not use different tools for preflight and
extraction, ad hoc string parsing, bulk extraction before limits, or shell `unzip` on an untrusted
archive. Image dimensions must be decoded in a resource-limited worker after compressed and
uncompressed byte limits pass.

### 3.4 Field semantics and limits

- `role` is exactly `cover | gallery`. `role` and `alt` are audit/approval fields in manifest v1;
  the current product model persists
  only ordered `imageIds`. Part B must either add ordered per-image metadata or keep these fields
  only in the import ledger without claiming storefront persistence.
- Every string is trimmed, normalized to Unicode NFC, non-empty when required, and contains no C0
  controls or DEL. Limits: customer reference 200, product name 200, series/model fields 100,
  description 5,000, manifest image path 300, alt text 500 Unicode code points.
- Currency for `unitPrice`, `wholesalePrice`, and `vipPrice` is USD.
- `moq` must be a positive integer no greater than 1,000,000.
- Prices must be finite, non-negative, no greater than 1,000,000,000, and have at most four
  decimal places.
- Decoded width and height must each be integers from 1 through 10,000, and
  `width * height <= 40,000,000`.
- Current generic product validation does not enforce these numeric/string limits, and current
  image finalization does not enforce pixel area. Part A requires human attestation; Part B must
  enforce them server-side.

## 4. Part A - Current Safe Operating Procedure

### A0. Intake and quarantine

1. Receive the ZIP from the customer/WeCom message.
2. Record the WeCom message/media ID, customer reference, original filename, sender, and UTC
   receipt time.
3. Do not download, hash, relocate, or store the attachment with current repository tooling.
4. Mark the ledger `AWAITING_APPROVED_TRANSFER` and leave the bytes in WeCom.
5. An authorized operator must name and record an approved private transfer/quarantine system,
  responsible operator, retention period, and ledger ID before any transfer.
6. If no approved system exists, stop. When a channel is approved, ask for individual images plus
  the manifest through that named channel; receipt still requires security attestation before A1.

### A1. Obtain an approved extracted package

The Agent must not inspect or extract the ZIP with current repository tooling. Choose one:

- a security-approved human archive process uses a single pinned inspector/extractor satisfying
  Sections 3.3/3.4 and provides a signed/recorded attestation; or
- ask the customer to resend individual JPEG/PNG/WebP files plus `manifest.json`.

Only after that boundary completes may the operator:

1. validate `manifest.json` against Sections 3.1-3.4;
2. for each approved image, independently record:
   - byte size;
   - SHA-256;
   - detected magic-byte MIME;
   - width and height;
   - manifest order/role.
3. record `sourceKind: zip | individual-files` in the ledger;
4. produce a sanitized import ledger. Do not include session tokens, upload credentials, signed
   URLs, or customer secrets.

Evidence binding depends on `sourceKind`:

- `zip`: require ZIP SHA-256, manifest SHA-256, and every per-image SHA-256;
- `individual-files`: no ZIP hash exists. Require manifest SHA-256 plus an ordered canonical
  file-set digest over each normalized manifest path, measured byte size, and per-file SHA-256.

If the ZIP lacks a manifest, the Agent may draft one from the files and customer message, but a
human must approve every product field, image mapping, cover, and order before upload.

### A2. Authenticate through Admin

1. Open the site Admin UI and sign in as `admin`. Contributor upload/edit capability exists, but
  the required refcount dry-run is admin-only.
2. The Agent may drive the already-authenticated browser UI after explicit operator approval.
3. The Agent must not read, print, copy, persist, or transmit `channel.token`.
4. Do not call `/api/admin` from a model-visible terminal with a long-lived human JWT.

### A3. Create an empty unpublished product shell

In Admin -> Headphones -> Create:

1. Enter only approved manifest product fields.
2. Keep `Published` disabled.
3. Do not upload images in the create dialog.
4. Save exactly once.
5. If the response is ambiguous or lost, do not click Save again. Search/read the collection and
  determine whether the shell exists. Generic create has no idempotency key.
6. Record the returned/resolved product ID in the import ledger. If uniqueness cannot be proven,
  stop.

Then edit that known product ID:

1. Upload images one at a time in manifest order through ImageManager.
2. Wait for each image to leave `Uploading...` before choosing the next file.
3. If any upload reports failure or loses its response, do not click `Failed - retry`. The current
  retry creates a new intent and can duplicate an ambiguous upload. Stop and reconcile the first
  intent/object with an engineer.
4. Verify each thumbnail appears in Admin preview and that the cover badge is on the intended
   first image.
5. Current UI does not display image IDs, hashes, storage paths, or refcounts. An engineer may use
  read-only CloudBase queries to record/verify them without exposing the Admin JWT. If that audit
  is unavailable, stop; do not claim A5 complete.
6. Save the edit once with the complete ordered images and `published: false`.

ImageManager already performs the canonical lifecycle for each image. Never upload the same file
again merely because the product save failed.

### A4. Product-save failure handling

If image uploads finalized but the product update fails:

1. Keep the Admin page open.
2. Record the finalized image IDs and error text.
3. If failure is explicit and the browser retains the same shell/edit state, retry only the update
  to the known product ID; never create a second product and never re-upload bytes.
4. If the response is ambiguous, first read the known product ID to determine whether the update
  committed. If the browser state or image-ID ledger is lost, stop and escalate.
5. Do not use generic image remove as cleanup: it does not provide a verified storage-object
   compensation path for active unreferenced images.
6. Do not run `cleanupOrphanImages`; it intentionally ignores active images.

The future Part B importer must add phase-aware upload retries, a finalize CAS, and a dedicated
compensation action for this state. Current `completeUpload` has no single-winner finalize claim;
Part A therefore stops on every ambiguous upload result.

### A4b. Existing product replacement

When the customer package intentionally replaces media for one known existing product, do not
create a shell or duplicate product. Follow `SY-T8-REUPLOAD-RUNBOOK.md` as the concrete pattern:

1. record the known product ID and old reference snapshot;
2. open a product-specific quiescent window and unpublish/read back the known product;
3. canonically upload and bind the complete new image set to approved source hashes;
4. while unpublished, submit one standard update replacing `imageIds` on that known product;
5. obtain final approval and publish through a separate standard update;
6. verify every new URL and browser interaction; on any failure, immediately unpublish while
  retaining the new IDs;
7. quarantine old objects/counter drift for a separately approved exact-list cleanup.

Do not repair or adopt the old batch merely because its bytes exist in storage.

### A5. Draft verification

Before publication:

- product is present exactly once and remains unpublished;
- all intended image IDs are present exactly once and in approved order;
- no dangling ID exists;
- every image row is `active` with recognized provider, storage ID/path, measured byte size,
  checksum, and `publishedRefCount: 0`;
- Admin preview decodes every image with non-zero dimensions;
- product fields and pricing match the approved manifest;
- import ledger contains `sourceKind`, manifest hash, product ID, image IDs, per-image hashes, and
  either ZIP hash or ordered canonical file-set digest as defined in A1.

Any mismatch returns to A3/A4. Do not publish a partial gallery.

### A6. Human publish approval

Show the operator:

- rendered Admin preview;
- full product fields and prices;
- image count, order, cover, dimensions, and hashes;
- customer reference, source kind, manifest hash, and the source-kind-specific ZIP hash or
  canonical file-set digest;
- draft product ID;
- any warnings or deviations.

The operator records `APPROVE <product-id> <manifest-sha256>` in the import ledger. The Agent may
then toggle `Published` once through Admin. A customer chat message alone is not publish approval.

### A7. Post-publish verification

1. Read the product back and require `published: true`.
2. Require every image row's `publishedRefCount` to equal the number of distinct published catalog
   documents referencing it; normally `1` for a newly imported product.
3. Run the refcount dry-run. It must have zero changes. If not, stop and follow the reviewed
   refcount recovery gate; do not silently apply a global backfill.
4. Request every projected `/api/images/:id` URL and require 200, `image/*`, and non-zero bytes.
5. Open `/headphones`; require the new card, cover `naturalWidth > 0`, detail open/return, and all
   gallery images in approved order.
6. Verify anonymous and viewer product fields are identical; VIP price remains role-gated.
7. Record UTC verification time, release ID, product ID, image IDs, HTTP results, and operator.

Only after all checks pass may the import ledger be marked `PUBLISHED_VERIFIED`.

## 5. Part B - Required Agent Import API

Part B is target architecture, not an instruction to call nonexistent endpoints.

### 5.1 Trust boundary

- Hermes receives a short-lived opaque random service token with an identifiable prefix. Persist
  only its SHA-256 hash plus `principalId`, scopes, `expiresAt`, and `revokedAt`; compare hashes in
  constant time. Scope it only to product-import job creation, package upload, status read, and
  validation start.
- The service identity cannot call generic CRUD, manage users, access unrelated collections, or
  publish a product.
- Store only a credential hash/identifier server-side; support rotation and revocation.
- Browser/admin JWTs are never given to Hermes.
- Human admin approval is required before the application transitions a job to publish.
- Rate-limit per principal and globally; log principal/job/action/result but never token values.

### 5.2 Proposed endpoints/actions

Names are provisional and must be implemented and contract-tested before use:

```text
createProductImportIntent
  input: customerReference, zipName, compressedBytes, zipSha256, idempotencyKey
  output: jobId, private single-object upload credential

finalizeProductImportPackage
  input: jobId
  behavior: verify ZIP landed; enqueue bounded validation/extraction

getProductImportStatus
  input: jobId
  output: safe state, validation report, draft preview; no secrets/signed URLs

approveProductImport
  auth: human admin
  input: jobId, expectedRevision, manifestSha256

publishProductImport
  internal worker only after approval
  behavior: commit draft, reconcile refs, verify public URLs, mark verified

cancelProductImport
  auth: human admin
  behavior: state-gated compensation before publication
```

The archive should be uploaded directly to a private import namespace with a server-minted,
single-object credential. Do not send ZIP bytes through an Event Function body.

The package credential contract must include:

- exact immutable server-chosen object key bound to `jobId`;
- allowed method and required form fields;
- `expiresAt` with short TTL;
- write-only scope for that one key: no read/list/delete;
- create-if-absent/no-overwrite policy, or an explicit one-time generation CAS;
- replay behavior: an identical completed upload returns the existing package; different bytes
  conflict;
- reissue only while no object has landed, invalidating the prior generation atomically;
- finalize re-reads the object and requires measured compressed byte size and SHA-256 to equal the
  intent before transitioning to `PACKAGE_UPLOADED`.

### 5.3 Worker placement

Use a bounded CloudRun worker or another reviewed job runtime for archive inspection/extraction.
Do not extract a customer ZIP synchronously inside the current Event Function request. The worker
must use a maintained ZIP parser, stream entries, enforce Section 3.3 before writing output, and
run with no public filesystem/storage access beyond its import job scope.

### 5.4 Import state machine

```text
RECEIVED
  -> PACKAGE_UPLOADED
  -> VALIDATING
  -> VALIDATED
  -> DRAFTING
  -> DRAFT_READY
  -> APPROVED
  -> PUBLISHING
  -> PUBLISHED_VERIFYING
  -> PUBLISHED_VERIFIED

RECEIVED/PACKAGE_UPLOADED/VALIDATING/VALIDATED/DRAFTING/DRAFT_READY/APPROVED
  -> CANCEL_REQUESTED -> COMPENSATING -> CANCELLED

RECEIVED/PACKAGE_UPLOADED/VALIDATING/VALIDATED/DRAFTING/DRAFT_READY/APPROVED
  -> FAILED_RETRYABLE or FAILED_TERMINAL
PUBLISHING/PUBLISHED_VERIFYING failure -> RECONCILIATION_REQUIRED
COMPENSATING failure -> COMPENSATING (retry same recorded compensation phase)
CANCEL_REQUESTED may transition only to COMPENSATING
```

Validate both stored current state and target state against the canonical state set before any
same-state idempotency shortcut. Every transition uses a storage-layer compare-and-set on
`jobId + revision + expectedState`.

Terminal states are immutable:

```text
PUBLISHED_VERIFIED, CANCELLED, FAILED_TERMINAL
```

`RECONCILIATION_REQUIRED` can transition only through an admin-approved reconciliation command;
it cannot return to DRAFTING or create another product. `FAILED_RETRYABLE` can resume only the
recorded failed phase through CAS `FAILED_RETRYABLE -> recordedPhase`, and only while its
package/manifest hashes still match. Publication phases never transition to a generic failed state.

### 5.5 Idempotency

Request idempotency and business deduplication are separate contracts.

Request idempotency uses a unique record:

```text
principalId + idempotencyKey -> canonicalRequestSha256 + jobId
```

The canonical request hash includes normalized customer reference, ZIP filename, compressed byte
size, ZIP SHA-256, and schema version. It excludes the idempotency key, credentials, timestamps,
and signed/upload fields. Reusing `(principalId, idempotencyKey)` with the same hash returns the
existing job; a different hash returns conflict.

Business deduplication separately enforces uniqueness or operator review over:

```text
principalId + normalizedCustomerReference + zipSha256 + canonicalRequestSha256
```

An existing business composite returns/references the existing job even if a caller generated a
new idempotency key. It never creates another import silently.

Per-file identity is `jobId + normalized manifest path + SHA-256`. A retry reuses already finalized
image IDs; it never creates duplicate storage objects or metadata rows.

Exactly one worker may claim each validation, per-image finalize, drafting, compensation, or
publication step. Per-image finalize uses a storage-layer `finalizeClaim` compare-and-set before
any large storage read; retries reuse the same intent/image ID. Race tests must prove one fulfilled
claimant, at most one storage read, and one resulting metadata row under concurrent requests.

### 5.6 Draft saga

1. Validate the complete package before creating any product row.
2. For each image, call an application-owned internal media service that reuses the existing
  size/checksum/magic-byte validation, adds dimension/resource-limit enforcement, records
  `importJobId`, and writes a complete active metadata row with refcount 0.
3. Persist each resulting image ID to the import job immediately.
4. Keep product fields, image IDs/order, `role`/`alt` approval data, and rendered preview inside the
  import-job record. Do not create an ordinary product yet; this prevents generic CRUD/publish
  controls from bypassing job revision approval.
5. Render the draft preview from the import-job snapshot.
6. A failure resumes from the recorded step and IDs; it never repeats successful uploads.

Do not hand-create image metadata around arbitrary pre-existing storage objects.

### 5.7 Publication saga

1. Require recorded human approval bound to `jobId`, current revision, manifest SHA-256, product
  fields, image IDs/order, and a canonical SHA-256 of the complete approved draft snapshot.
2. CAS `APPROVED -> PUBLISHING`; one worker wins.
3. Recompute the current import-job snapshot hash and require exact equality with approval.
4. Materialize one product with a server-managed `importJobId`, initially `published: false`.
  `products.importJobId` has a unique index. Materialization is create-if-absent/read-existing by
  that value, and records `productId` plus phase durably in the job.
5. Generic product CRUD must reject updates/removal/publish for any row with `importJobId`; only the
  import worker and admin reconciliation command may mutate it.
6. Publish that known product ID once through the import worker.
7. Re-read product and image rows.
8. Run a job-scoped reference verification and the global refcount dry-run.
9. Verify every public image and the rendered product page.
10. Mark `PUBLISHED_VERIFIED` only after all checks pass.

Current product-write/refcount maintenance is non-transactional. If publication commits but a
counter update fails, set `RECONCILIATION_REQUIRED`; do not report success or publish another copy.
A retry from `PUBLISHING` or `RECONCILIATION_REQUIRED` first reads by unique `importJobId` and reuses
the existing product. Crash-injection tests must cover failure immediately after product creation
and before job `productId` persistence.

### 5.8 Compensation

Part B must implement a dedicated, idempotent compensation action because current generic removal
does not safely own active storage-backed image cleanup.

Compensation is permitted only before product materialization. Once publication enters
`PUBLISHING`, every failure routes exclusively to `RECONCILIATION_REQUIRED`; it must reuse or
disable the unique import-owned product and must not delete media.

Pre-materialization compensation:

1. CASes the job to `COMPENSATING`; only one compensation worker wins.
2. Uses one storage-layer exclusion protocol shared by compensation and every catalog
  create/update/batch path. Catalog admission atomically reserves a reference only when the image
  is `active` at the expected revision. Compensation atomically transitions `active ->
  compensating` only when both reservation count and committed reference count are zero.
3. Every catalog write path must acquire the reservation before committing its product mutation;
  it cannot rely on a pre-read status check. The reservation is finalized into the committed
  reference or released on product-write failure.
4. After winning the image transition, rechecks import-job ownership and zero references.
5. Deletes the private storage object first.
6. Checks the per-object delete result.
7. Deletes metadata only after storage success.
8. Records every outcome and leaves failed compensations retryable in `COMPENSATING`.

Interleaving race tests must prove exactly one outcome: catalog admission succeeds and compensation
aborts, or compensation wins and catalog admission fails. There must be no schedule where product
commit succeeds after object deletion.

After publication, rollback first disables the product and reconciles counters. Storage deletion
requires a separate reviewed retention decision; do not immediately destroy customer media.

## 6. Agent Execution Protocol

### Before Part B exists

The Agent response to a customer ZIP request must be:

```text
IMPORT_MODE=HUMAN_ADMIN
AUTOMATIC_PUBLISH=DISABLED
```

Before archive inspection, the Agent may record only intake metadata and draft questions from the
customer message. It must not claim file/hash/content validation. After a security-approved
extracted package is supplied, it may prepare the manifest ledger, hashes, validation report, and
draft field mapping. It may operate the authenticated Admin UI after explicit approval, but may
not access/export the JWT or use TCB MCP to write product/image/storage state.

### After Part B is deployed

The Agent:

1. computes package metadata and calls `createProductImportIntent` with idempotency key;
2. uploads the unchanged ZIP using the scoped credential;
3. calls finalize and monitors safe status;
4. presents the validated draft report to the operator;
5. waits for application-recorded approval;
6. observes publication; it does not bypass approval by calling generic update;
7. returns product URL and verification report only after `PUBLISHED_VERIFIED`.

Every Agent response includes `jobId`, state, customer reference, ZIP hash prefix, draft/product ID
when assigned, and the next permitted action. It never includes credentials or signed URLs.

## 7. Verification Matrix

| Surface | Required proof |
|---|---|
| ZIP | Hash, bounded entries/sizes/ratio, no unsafe paths/links/encryption/nested archives. |
| Manifest | Schema v1, strict keys, allowed category, exactly one cover, every file accounted for. |
| Images | Real MIME/dimensions/size/checksum measured; all metadata complete and active. |
| Draft | Unpublished, unique product, exact approved fields, image IDs/order match manifest. |
| Approval | Human identity, timestamp, job revision, manifest hash, exact draft snapshot. |
| Publication | One state-machine winner; product published once; no duplicate import. |
| Refcounts | Correct aggregate counts and zero-change reconciliation dry-run. |
| Public delivery | Every image 200 `image/*`; private/unreferenced control remains 404. |
| Browser | Card cover loaded, detail/gallery usable, no broken image, mobile/desktop visible. |
| Authorization | Anonymous projection excludes VIP fields; service identity cannot generic-CRUD/publish. |
| Audit | Job timeline and sanitized manifest retained; no token, credential, or signed URL logged. |

## 8. Stop Conditions

Stop rather than publish if:

- no human approval is recorded;
- Part B is not deployed but an Agent attempts automatic publication;
- no security-approved ZIP inspector/extractor is available and the customer has not supplied
  approved individual images;
- ZIP/manifest violates any Section 3 rule;
- a product field is unknown, ambiguous, or outside the registry schema;
- any image fails upload/finalize/preview or lacks complete metadata;
- an image upload or finalize result is ambiguous, or an operator proposes clicking UI Retry
  without reconciling the original intent;
- product save fails after image finalization and the image-ID ledger is incomplete;
- draft fields/order differ from approval;
- refcount dry-run is non-zero or contains unrelated drift;
- any projected image is not 200 `image/*` with non-zero bytes;
- an operation needs a browser JWT in Agent logs, public bucket access, direct MCP writes, or manual
  metadata/refcount repair;
- compensation cannot prove job ownership and zero references.

## 9. Implementation Work Required For Part B

This runbook is not authorization to start coding without the normal architecture/test gates.
Implementation must add, at minimum:

- strict manifest schema and normalized path model;
- pinned maintained streaming ZIP parser used for both inspection/extraction, disposable sandbox,
  actual decompressed-byte counters, local/central header consistency checks, and archive-security
  tests;
- resource-limited image decoder and server-enforced dimensions/field/price/MOQ limits;
- import-job persistence/state machine/revision CAS;
- hashed opaque import-only service authentication, expiry/revocation, and rate limits;
- private package upload intent;
- CloudRun validation/extraction worker;
- internal reusable media-finalization service;
- per-image finalize CAS, phase-aware retry, and race tests;
- import-job-owned draft snapshot and preview (not generic product CRUD);
- human approval UI/API;
- idempotent publication worker;
- server-managed `importJobId` plus generic CRUD/publish guards;
- `compensating` image state and dedicated CAS compensation action;
- job/refcount/public-route/browser E2E and race tests;
- deploy env/secrets, observability, retention policy, and operator dashboard.

Until these are implemented, the standard remains Part A.
