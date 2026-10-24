# WeCom ZIP Product Import MVP

Status: deferred hardening/scale-up proposal. The current Hermes -> portal API workflow has been
verified usable for customer imports; this CloudRun design is not required for current rollout.

## Problem Statement

For a future higher-assurance rollout, authorized customer employees need to send one product ZIP
in a designated WeCom group and have
the Hermes assistant complete the operational workflow: acknowledge intake, safely process the
package, create an unpublished product draft, request Portal admin approval, publish once, verify
the public product/images, and reply with the product URL.

The existing supervised Hermes workflow can process supported files released by the approved
inspection/extraction boundary and call portal upload/finalize/product actions; a successful
18-image publication was verified on 2026-07-29. That evidence does not prove general raw-ZIP
inspection or arbitrary document parsing. The repository still has no application-owned ZIP
processor, import-job state, or import-only service identity. This proposal adds those controls
later without blocking the approved-package workflow.

## Proposed Solution

### Trust boundary

- WeCom supplies immutable `corpId`, `userId`, message ID, conversation ID, and attachment ID.
- An employee may submit only when `corpId + userId` is in an application-managed active allowlist.
  Group membership, display name, email, phone, and message text are not authorization.
- Portal admins manage the allowlist through an audited UI/API. Each entry records corporation,
  user ID, status, creator, reason, created/updated/revoked times. Contributors and Hermes cannot
  grant or reactivate access.
- Hermes remains a channel adapter. It verifies the WeCom callback/event, downloads the attachment,
  and calls the application import API using a short-lived, revocable, import-only identity.
- An application-owned CloudRun container is the ZIP quarantine and processing boundary. ZIP bytes
  are never interpreted by Hermes prompts/tools and never sent through the current Event Function
  body.
- Existing Portal admins are the only approvers. Contributors and Hermes cannot approve/publish an
  imported draft or bypass approval through generic CRUD.

### MVP happy path

1. An allowlisted employee sends one ZIP in the designated WeCom group.
2. Hermes verifies sender/event identity, then requests an import job with stable source IDs and an
   idempotency key.
3. G2 selects the package byte path from two fail-closed options: if the installed COS grant's
  effective expiry and one-key write scope are proven sufficiently narrow, the application
  returns that scoped credential; otherwise Hermes streams the unchanged ZIP through the
  authenticated, size-bounded CloudRun upload endpoint. The application then finalizes package
  receipt. A credential is never called short-lived without verified expiry evidence.
4. Admission responds within five seconds with one stable `jobId`; repeated delivery returns the
   same job.
5. A CloudRun worker reads the ZIP from private quarantine using `yauzl` lazy Central Directory
   parsing and processes entries one at a time.
6. It validates archive limits and paths, parses `manifest.json`, decodes images with `sharp`,
   applies resource limits, auto-orients, strips metadata, and re-encodes deterministic canonical
   images.
7. Each image is finalized through application-owned media logic with measured byte size,
   SHA-256, detected MIME/dimensions, active status, and public refcount zero.
8. The import job stores the product draft snapshot and ordered image IDs. No ordinary product row
   exists yet, so generic CRUD cannot publish it.
9. Hermes replies in the originating conversation and mentions only the submitter: draft ready or
   actionable rejection/failure with `jobId`.
10. A Portal admin reviews parsed fields, warnings, image previews/order, and source identity. Edits
    change the draft revision and invalidate prior approval.
11. Admin approval records actor, timestamp, current revision, manifest hash, and complete draft
    snapshot hash.
12. An idempotent worker materializes one product using unique `importJobId`, publishes it once,
    verifies refcounts/public APIs/images/browser rendering, then marks the job terminal.
13. Hermes receives a signed state callback and posts the verified product URL in the originating
    conversation, mentioning the submitter.

## Locked MVP Defaults

These defaults are proposed as one approval package:

| Decision | MVP default |
|---|---|
| ZIP contract | One product; root `manifest.json`; images under `images/`; undeclared/extra entries rejected. |
| Compressed/expanded limits | 100 MiB compressed, 100 MiB actual expanded. This aligns with and supersedes no existing runbook value. |
| Entries/images | 50 total entries, 30 images, 10 MiB per image/entry. |
| Bomb controls | 100:1 per-entry and aggregate ratio, 120-second worker deadline, bounded memory/CPU. |
| Image limits | JPEG/PNG/WebP only; no animation; <=40 MP each and <=200 MP aggregate. |
| Canonicalization | Auto-orient, strip EXIF/GPS/comments/thumbnails, preserve input format, deterministic quality/compression. |
| ZIP parser | `yauzl@3.4.0`, lazy entries, decoded/strict filenames, entry-size validation; reject encryption, Zip64, split archives, unsupported compression, links/devices/nested archives. |
| Image decoder | `sharp@0.35.3` in a resource-limited CloudRun container. |
| Admin edits | Product fields and image order may be edited; each edit increments revision and invalidates approval. Image replacement requires a new finalized image. |
| Rejection | `REJECTED_BY_ADMIN` is terminal for that job/revision; corrected package creates a new job using a new ZIP hash. |
| Hermes status | Signed callbacks plus authenticated status query fallback. |
| WeCom destination | Originating conversation/thread; mention only submitting employee. |
| Notifications | Accepted, draft ready, rejected/failed, published. Avoid noisy per-file messages. |
| Retention | Delete successful source ZIP/original extracted bytes after canonicalization verification; rejected bytes immediately; retain audit/job metadata 180 days; rejected draft metadata 30 days. |
| SLO | Acknowledge <=5s; valid in-limit draft <=5min; publish verification <=2min after approval; terminal WeCom notification <=1min. |

SLOs are p95 under two concurrent maximum-size jobs in the test environment after warm-up:

- acknowledgement: verified Hermes request received -> HTTP 202/job ID returned, <=5 seconds;
- draft readiness: package receipt finalized -> `DRAFT_READY` committed, <=5 minutes;
- publication: admin approval committed -> `PUBLISHED_VERIFIED` committed, <=2 minutes;
- terminal notification: terminal job state committed -> Hermes callback acknowledged, <=1 minute.

Cold-start and single-job measurements are recorded separately and cannot replace the p95 test.
The acceptance command will be `pnpm test:import-slo:test` and will execute 30 measured jobs after
2 warm-up jobs on the deployed test CloudRun resource profile. Percentiles use nearest-rank over
successful end-to-end durations. A failed/timed-out job is counted as an SLO failure, never omitted;
the gate requires zero failed jobs and each named p95 threshold. Test evidence records commit,
environment, CloudRun revision/resources/concurrency, start/end timestamps, and all raw durations.

### Manifest v1 contract

The normative MVP manifest and field contract is the `manifest.json` shape in
`docs/home-form-headphones-ui-fix/CUSTOMER-ZIP-PRODUCT-IMPORT-RUNBOOK.md` Sections 3.1-3.4:

- `schemaVersion` is exactly `1`;
- one non-empty customer reference, one product object, one ordered image array;
- writable product fields only: `name`, `category`, `series`, `modName`, `modType`,
  `description`, `moq`, `unitPrice`, `wholesalePrice`, `vipPrice`;
- category exactly `wired | office | bluetooth`;
- unknown keys rejected; `_id`, `imageIds`, `published`, storage/lifecycle fields forbidden;
- image role exactly `cover | gallery`, exactly one cover and first in order;
- all strings trimmed/NFC, required values non-empty, no C0/DEL; limits: customer reference/name
  200, model fields 100, description 5,000, path 300, alt 500 code points;
- USD prices finite/non-negative, <=1,000,000,000 and <=4 decimals; MOQ integer 1-1,000,000;
- JPEG/PNG/WebP, no animation, each dimension integer 1-10,000, <=40 MP each and <=200 MP
  aggregate;
- every accepted file declared exactly once; undeclared/extra files rejected.

This SPEC is canonical if a prior narrative mentions higher archive/entry limits.

### Durable dispatch and recovery

- `importJobs` in CloudBase NoSQL is the durable workflow source of truth.
- `finalizeProductImportPackage` verifies package receipt, writes `PACKAGE_UPLOADED`, and returns
  HTTP 202; it does not rely on an in-memory task.
- A one-minute Cloud Function timer dispatcher invokes a signed internal CloudRun `process-next`
  endpoint. CloudRun claims one eligible job using expected state + revision CAS.
- Every invocation also scans stale claimed/retryable jobs by state and lease expiry, so lost
  requests/container restarts recover without a separate queue.
- The worker renews a bounded lease while processing; another worker may reclaim only after expiry.
- Queue depth, oldest job age, lease expiry, retry count, and terminal failures are monitored.

This is a Scheduler Agent Supervisor plus Competing Consumers design. It is acceptable for the MVP
volume and five-minute SLO; a managed queue is a later scaling option, not an unstated dependency.

### ZIP package upload credential

- The application reuses the installed and verified `@cloudbase/node-sdk@2.10.0`
  `getUploadMetadata({ cloudPath })` contract already used for catalog images.
- The server chooses `imports/<jobId>/<generation>/source.zip`; Hermes cannot choose a path.
- Credential is multipart POST for the one server-chosen key and contains no application-issued
  read/list/delete operation. The installed wrapper returns `url`, `authorization`, `token`,
  `fileId`, `cosFileId`, and `download_url`; it does **not** expose `expiresAt` or a verified API to
  shorten credential lifetime.
- G2 must inspect the signed COS authorization/token contract and prove its effective expiry and
  object scope against official COS docs plus a live package probe. A server-generated timestamp
  is not treated as revocation or expiry. If expiry/scope cannot be proven sufficiently narrow,
  Hermes uploads the ZIP through an authenticated, size-bounded CloudRun streaming proxy instead
  of receiving a storage credential.
- One generation CAS may issue one credential. Reissue is allowed only before receipt, increments
  generation, and uses a fresh key; old keys are no longer accepted by finalize.
- Finalize requires the current generation, exact storage ID, measured compressed byte size, and
  SHA-256 to match the intent. A landed mismatch is rejected/quarantined and never processed.
- If installed CloudBase credential behavior cannot enforce no-overwrite at COS, application
  generation/key uniqueness plus finalize-once CAS is the mandatory fallback; no key is reused.

## Required States

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

Pre-publication -> CANCEL_REQUESTED -> COMPENSATING -> CANCELLED
Validation/draft failures -> FAILED_RETRYABLE | FAILED_TERMINAL
Publication failures -> RECONCILIATION_REQUIRED
DRAFT_READY -> REJECTED_BY_ADMIN
```

Terminal states are immutable. Every transition uses a persisted revision/expected-state CAS.
Terminal states are `PUBLISHED_VERIFIED`, `CANCELLED`, `FAILED_TERMINAL`, and
`REJECTED_BY_ADMIN`. Admin rejection stores actor/reason/time, compensates private staged media
according to retention policy, and cannot be reopened.

## Security And Reliability Requirements

- Service credentials are separate from Portal JWTs, hashed at rest, short-lived, scoped,
  revocable, rate-limited, and never logged.
- Hermes requests bind method, path, timestamp, nonce, body digest, principal, corp/user, message,
  conversation, and attachment IDs; replay window is bounded.
- Request idempotency is unique by `(principalId, idempotencyKey)` and payload hash. Business
  deduplication separately binds source attachment identity + ZIP hash.
- ZIP parsing trusts the Central Directory, processes one entry at a time, validates actual expanded
  byte counts, and never extracts paths supplied by the archive.
- Worker has no shell execution and no general outbound network access during parsing.
- Product/image/archive content never becomes public before admin approval and verified publication.
- Imported drafts cannot be published through current generic toggle/batch CRUD.
- After an import-owned product is materialized with server-managed `importJobId`, every backend
  generic create/update/remove/batch-update/batch-remove and publish-toggle path must reject any
  mutation targeting that row. Hiding/disabling Portal controls is UX only, not authorization.
  Only the import publication worker and an admin-only reconciliation command may mutate it.
- Per-image finalize and job workers use single-winner CAS with race/crash-injection tests.
- Publication produces at most one product through unique `products.importJobId` create-or-read.
- Compensation and catalog reference admission share one atomic reservation/exclusion protocol.
- WeCom notification failure never republishes or rolls back a product; it retries notification
  independently.
- Every terminal outcome has a sanitized audit trail and correlation ID.

## UI Surfaces

### WeCom

- unauthorized/expired identity;
- accepted with job ID;
- validation in progress;
- rejected with actionable file/manifest errors;
- draft ready awaiting Portal admin;
- publication failed/reconciliation required;
- published with verified URL.

### Portal Admin

- Product Imports queue with processing, review-ready, rejected, failed, published filters;
- import review showing submitter/source, ZIP hash/limits, parsed product, warnings/errors, image
  previews/order, draft revision, and audit timeline;
- approve, reject, and publish states with stale-revision/conflict handling;
- generic product controls disabled for import-owned products.

No public-site upload surface is added in MVP.

## Non-Goals

- Automatic publication without Portal admin approval.
- Authorization based on WeCom group membership alone.
- Multiple products per ZIP.
- PDF/Office/spreadsheet parsing, OCR, remote image URLs, nested archives, video, SVG, executable
  content, or fuzzy product deduplication.
- Building or redeploying Hermes itself in this repository.
- Replacing the existing public catalog or manual Admin image upload workflow.
- General bulk catalog sync.

## Acceptance Criteria

1. Non-allowlisted sender and unknown sender receive the same HTTP status, normalized body, headers,
   and error code; neither creates a job/object/draft. Controlled tests compare median and p95
   latency distributions under the same load and fail if the p95 delta exceeds 100 ms.
2. Duplicate WeCom delivery creates one job, one canonical image set, and one product.
3. Traversal, links, encrypted/Zip64/split/nested archives, malformed headers, undeclared files,
   zip bombs, over-budget images, or mismatched bytes are rejected inside quarantine.
4. Canonical images contain no prohibited metadata and satisfy measured size/hash/MIME/dimensions.
5. Valid ZIP creates exactly one unpublished reviewable draft; public APIs return neither product
   nor images before approval.
6. Contributor/Hermes/generic CRUD cannot approve or publish import-owned drafts.
  Server-side negative tests cover update, remove, batch update/remove, direct publish toggle, and
  attempts to set/clear/forge `importJobId`.
7. Admin approval is revision-bound; an edit makes it stale.
8. Repeated publication work publishes at most once and cannot double-count image references.
9. Terminal success requires product readback, correct refcounts, all public images 200, and browser
   card/detail verification.
10. Hermes reports only verified state; notification retry does not republish.
11. Crash-injection tests terminate the worker after: job acceptance, package receipt, claim, each
  image finalize, draft persistence, approval CAS, product materialization, publish write,
  refcount reconciliation, public verification, and notification enqueue. Each resumes without
  duplicate product/image/object or false terminal success.
12. Named regression suites remain green: shared/media, db adapter, admin handler, media-storage,
  public-api projection/delivery, site unit/contract, public E2E, media-upload E2E, and new import
  integration/race/deployed smoke suites.

## Environment Prerequisites

- New CloudRun container service. Fresh read-only CloudBase MCP inspection on 2026-07-29 returned
  zero CloudRun services in `diversity-123-d9grnqfux221323bb`; sanitized evidence is recorded in
  `ENVIRONMENT-EVIDENCE-2026-07-29.md`.
- Enable CloudRun/CLS structured logs and alerts. Fresh read-only MCP inspection on 2026-07-29
  returned `enabled: false` for CLS in that environment; see the same evidence record.
- New private package storage namespace and lifecycle rules.
- New import-job/allowlist/service-credential/audit persistence plus required unique indexes.
- New Portal Admin import queue/review UI.
- Hermes gateway adapter change in its separate deployment/repository.
- GitHub test/prod environment variables and secrets for CloudRun/import identities.

## Future Hardening Gate

This package is retained for future architecture approval when usage, customer count, compliance,
or failure rate justifies CloudRun/import-job hardening. It does not block current Hermes operation
and does not authorize CloudRun creation, secret generation, deployment, or production mutation.
