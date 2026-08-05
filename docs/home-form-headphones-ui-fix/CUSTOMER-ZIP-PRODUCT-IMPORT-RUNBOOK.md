# Customer ZIP -> Agent -> Product Publication Runbook

Status: current supervised Hermes-assisted publication workflow verified usable on 2026-07-29 for
one-product packages whose approved extracted content resolves to JPEG/PNG/WebP images and current
product fields. Raw arbitrary-ZIP inspection and arbitrary document parsing are not independently
verified repository capabilities. CloudRun/import-job automation is optional future hardening, not
a prerequisite for the approved-package workflow.

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

There are two modes:

- **Part A - current verified mode:** after the ZIP crosses the approved inspection/extraction
  boundary in A0/A1, Hermes parses supported approved files, calls the portal's existing
  upload/finalize actions for every accepted image, and updates the known/new product through
  standard Admin actions. Publication remains an explicit workflow step, and post-publish
  verification is mandatory.
- **Part B - optional hardened mode:** Hermes calls a dedicated application-owned import-job API
  with a short-lived, import-only service identity. The Agent can create and validate a draft;
  publication occurs only after an admin approval recorded by the application.

Part A is customer-usable now. Part B is retained for higher assurance, larger customer rollout,
stronger service isolation, durable jobs, and automated approval/audit. The current workflow must
still use portal interfaces; direct independent writes to Storage/`images`/`products` are prohibited.

### 1.1 Capability self-test versus live import

These are different commands and must not share the same output:

- **Capability self-test:** answers whether the Agent can complete the workflow. It does not
  require a current customer attachment, WeCom message IDs, or live publish approval. Use a small
  synthetic package created for testing plus existing successful-run evidence. Do not output an
  identity table or mark the test `BLOCKED` merely because no customer ZIP is attached.
- **Live import preflight:** runs only when processing a specific customer package. This is where
  the Agent validates attachment identity, approved package handling, product fields, files, and
  publish approval. Sections A0-A7 apply to that run.

The capability self-test must exercise or cite evidence for these six interfaces:

1. receive/read a representative ZIP in the Agent's actual runtime;
2. enumerate and extract a synthetic safe ZIP without using customer data;
3. decode UTF-8 `.txt` into draft product fields and clearly reject an unsupported text format;
4. detect and decode representative JPEG, PNG, and WebP images;
5. invoke or prove the standard Portal image lifecycle and product create/update path;
6. prove public product/image readback and browser gallery verification.

Default capability output is concise:

```text
CAPABILITY_SELF_TEST
ZIP receive/extract: VERIFIED | NOT_VERIFIED
TXT field extraction: VERIFIED | NOT_VERIFIED
JPEG/PNG/WebP handling: VERIFIED | PARTIAL | NOT_VERIFIED
Portal upload + product create/update: VERIFIED | NOT_VERIFIED
Publish + public/browser verification: VERIFIED | NOT_VERIFIED
OVERALL: READY | PARTIAL | NOT_READY
GAPS: none | <only concrete missing capability>
```

`VERIFIED` requires an executed synthetic test in the current Agent runtime or named evidence from
a prior successful production-like run. `PARTIAL` is allowed when only some declared formats were
executed. Do not replace a missing test with a page of `UNVERIFIED` identity and attachment fields.
Do not expose credentials or publish a new live product merely to run this self-test.

If `OVERALL=READY`, the human-facing answer should be one sentence: the Agent can accept the
supported package, extract product text/images, use the standard Portal path, and verify the live
result. If `PARTIAL` or `NOT_READY`, show only the missing capability and the next test needed.

Use this prompt for a capability check:

```text
Run CAPABILITY_SELF_TEST, not a live customer IMPORT_PREFLIGHT.

Goal: prove whether you can complete the supported product-package workflow end to end.
No customer attachment is required. Do not output corpId/userId/messageId/attachmentId,
UNVERIFIED tables, approval gates, or security narration unless a concrete test fails.

Use a small synthetic test package in your own safe test workspace. Do not publish a new live
product solely for this check. You may cite the verified SY-T8 run for Portal upload, product
update, publication, 18/18 public-image checks, and 18/18 gallery checks.

Test and report only:
1. Can you receive/read and safely enumerate/extract a representative ZIP?
2. Can you decode UTF-8 TXT and map product name/category/description fields?
3. Can you detect/decode JPEG, PNG, and WebP by content rather than extension?
4. Can you use the standard createUploadIntent -> COS -> completeUpload path?
5. Can you create/update through Portal and verify public product/images/browser output?

Return at most 10 lines in exactly this shape:
CAPABILITY_SELF_TEST
ZIP receive/extract: VERIFIED | NOT_VERIFIED
TXT field extraction: VERIFIED | NOT_VERIFIED
JPEG/PNG/WebP handling: VERIFIED | PARTIAL | NOT_VERIFIED
Portal upload + product create/update: VERIFIED | NOT_VERIFIED
Publish + public/browser verification: VERIFIED | NOT_VERIFIED
OVERALL: READY | PARTIAL | NOT_READY
GAPS: none | <only concrete gaps>
NEXT: none | <one next test>

Do not return BLOCKED because this message has no customer attachment. BLOCKED belongs to a live
import attempt, not this capability self-test.
```

### 1.2 Live import response today

Before an approved A0/A1 extraction attestation exists, the Agent records intake only:

```text
IMPORT_MODE=HUMAN_ADMIN
ZIP_STATUS=AWAITING_APPROVED_TRANSFER
PUBLISH_MODE=EXPLICIT
AUTOMATIC_PUBLISH=DISABLED
NEXT_ACTION=OBTAIN_ATTACHMENT_METADATA_AND_APPROVED_EXTRACTION
```

Only after the approved A0/A1 boundary releases an attested extracted package may the Agent change
the internal state to:

```text
IMPORT_MODE=HERMES_PORTAL_APIS
ZIP_STATUS=APPROVED_PACKAGE_READY
PUBLISH_MODE=EXPLICIT
AUTOMATIC_PUBLISH=DISABLED
NEXT_ACTION=VALIDATE_UPLOAD_DRAFT_REVIEW_PUBLISH_VERIFY
```

Hermes may process only files released by that boundary. It must treat every file as untrusted
input, accept only supported product/image content, use the portal's standard image
upload/finalize and product create/update actions, and verify the resulting public product. It
must not claim raw-ZIP inspection, unsupported document parsing, or final success until the
applicable checks and every projected image pass readback.

Customer-ready response after intake but before approved extraction:

> 已收到您发送的产品资料 ZIP。文件需要先完成安全检查；检查通过后，助手会整理商品信息和图片，
> 由管理员确认后上架并逐张验证。若文件损坏、格式不支持或缺少必要信息，我们会返回具体文件名和
> 补充要求。只有完成发布和页面验证后，助手才会返回最终商品链接。

For a **live import only**, if no attachment bytes or stable message/attachment metadata are present
in the Agent context, the result is `BLOCKED`. This rule does not apply to `CAPABILITY_SELF_TEST`.
The Agent may say that no live attachment is available, but it cannot make claims about that
customer ZIP's readability, entries, hashes, path safety, compression ratios, or file contents.

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

### Optional hardening not available now

- No ZIP parser or archive extraction library is installed.
- No product ZIP import endpoint or import-job collection exists.
- No Hermes/WeCom service identity or import-only authorization scope exists.
- No atomic multi-image + product publish transaction exists.
- No dedicated compensation action safely deletes an `active`, unreferenced image row and its
  storage object. Generic image removal is not a storage cleanup operation.
- No automated customer manifest parser or review queue exists.

The current workflow can use the existing actions as an orchestrated sequence, but must preserve
their order and verify every step. It must not recreate the old behavior of independent MCP writes.

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

### 3.5 File capability and non-silent result contract

Current verified publishable media are JPEG, PNG, and WebP after magic-byte and decode validation.
Plain `.txt` may supply draft product text only when the Agent has actually decoded its character
encoding and a human maps the extracted text to current product fields. The successful SY-T8 run
did not prove an arbitrary-document parser.

CSV, PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, OCR, SVG, GIF, audio, and video are unsupported unless a
pinned parser/decoder for that exact type is separately implemented, tested, and approved. A file
being present in a ZIP or having a familiar extension is not evidence that Hermes parsed it.

Every archive entry must appear exactly once in the import report with one status:

```text
USED
IGNORED_WITH_REASON
UNSUPPORTED
CORRUPT
MISSING_REQUIRED_DATA
```

For every non-`USED` file, report `filename`, detected type, and `ignored: reason` or blocking
reason. Never silently drop a file. If an unreadable/unsupported file might change product name,
model, category, description, price, MOQ, cover, image order, or another published field, mark the
import `BLOCKED` and request a supported replacement. A clearly unrelated attachment may be
preserved or marked `IGNORED_WITH_REASON`, but must still be listed in the final report.

Before any **live customer upload**, the Agent performs these checks internally and receives human
approval. Do not print the full checklist when every check passes; return the concise result and
expand only failed or ambiguous items:

```text
IMPORT_PREFLIGHT
- authorized sender/operator: PASS | BLOCKED
- approved A0/A1 extraction attestation: PASS | BLOCKED
- archive limits/path safety: PASS | BLOCKED
- file-by-file capability report complete: PASS | BLOCKED
- required product fields supported and evidenced: PASS | BLOCKED
- image magic bytes/decode/hash/dimensions/order: PASS | BLOCKED
- unsupported product-affecting files: NONE | BLOCKED
- publication mode: EXPLICIT
- conclusion: READY_FOR_DRAFT | BLOCKED
```

Only `READY_FOR_DRAFT` may continue to A2. Only A7 may produce `PUBLISHED_VERIFIED`.

This `IMPORT_PREFLIGHT` is not the capability self-test in Section 1.1. A request such as “test
whether you can perform the workflow” must return `CAPABILITY_SELF_TEST`, not an empty live-import
form populated with `UNVERIFIED` values.

The availability of Python stdlib `zipfile`, shell `unzip`, or another generic archive utility is
not a passing capability result. No parser is approved until the exact pinned implementation and
execution boundary prove every Section 3.3 control, including streamed actual-byte limits,
local/central-header consistency, normalized-path collisions, links, encryption, Zip64, split
archives, nested archives, and bounded extraction. Current Part A therefore records those raw-ZIP
checks as `NOT_EXECUTED_AWAITING_APPROVED_BOUNDARY`, not `PASS`.

### 3.6 Current and future state vocabularies

Do not mix current Part A report fields with undeployed Part B job states:

| Scope | Valid current values |
|---|---|
| Part A intake | `AWAITING_APPROVED_TRANSFER`, `BLOCKED` |
| Part A approved package | `APPROVED_PACKAGE_READY`, `READY_FOR_DRAFT` |
| Part A terminal report | `PUBLISHED_VERIFIED`, `FAILED`, `BLOCKED` |
| File result | `USED`, `IGNORED_WITH_REASON`, `UNSUPPORTED`, `CORRUPT`, `MISSING_REQUIRED_DATA` |
| Part B persisted job | States in Section 5.4 only; unavailable until Part B is deployed |

`PROCESSING`, `RECEIVED`, `VALIDATING`, `DRAFT_READY`, and `APPROVED` must not be reported as a
persisted current job state. Part A may describe an operator action in prose, but its machine-like
report must use the values above.

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

Do not infer authorization from a display name such as `sean`. Missing `corpId`, `userId`,
`messageId`, or `attachmentId` stays `UNVERIFIED`; never invent or normalize a value. The Part B
application-managed `corpId + userId` allowlist is not deployed and cannot be used as current Part A
authorization evidence.

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

The preflight must report `ADMIN_BROWSER_SESSION=AVAILABLE | UNAVAILABLE | UNVERIFIED`, never
`session token held`, `token acquired`, or a token value. `AVAILABLE` means only that an operator
confirmed an already-authenticated browser and explicitly approved browser automation for this
run; it does not mean the Agent possesses the credential.

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
3. Run a product-scoped read-only reference check and require zero discrepancy for every image
  referenced by this product. Record any pre-existing unrelated global dry-run changes as a
  quarantined baseline; the import must add no new discrepancy. Do not block a healthy product on
  known unrelated historical drift, and do not silently apply a global backfill during import.
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
DRAFT_READY -> REJECTED_BY_ADMIN
PUBLISHING/PUBLISHED_VERIFYING failure -> RECONCILIATION_REQUIRED
COMPENSATING failure -> COMPENSATING (retry same recorded compensation phase)
CANCEL_REQUESTED may transition only to COMPENSATING
```

Validate both stored current state and target state against the canonical state set before any
same-state idempotency shortcut. Every transition uses a storage-layer compare-and-set on
`jobId + revision + expectedState`.

Terminal states are immutable:

```text
PUBLISHED_VERIFIED, CANCELLED, FAILED_TERMINAL, REJECTED_BY_ADMIN
```

`REJECTED_BY_ADMIN` records the admin actor, reason, time, and approved compensation/retention
outcome. It cannot return to `DRAFT_READY`; a corrected package creates a new job.

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
ZIP_STATUS=AWAITING_APPROVED_TRANSFER
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
- the product-scoped reference check has any discrepancy, or the import adds new global refcount
  drift beyond the recorded unrelated baseline;
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
