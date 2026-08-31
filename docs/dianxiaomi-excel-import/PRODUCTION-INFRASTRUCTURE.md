# Dianxiaomi XLSX import: production infrastructure design

Status: **target design only; no CloudBase, DNS, certificate, secret, or billable
resource was created or changed by this work.**

Date: 2026-09-01

This document separates three kinds of statements:

- **Current (observed in this branch):** implemented repository behavior.
- **Target:** the production architecture to implement later.
- **Gate:** a value or platform capability that must be confirmed before any
  deployment or resource mutation.

The topology source is
[`diagrams/channel-production-import-topology.excalidraw`](diagrams/channel-production-import-topology.excalidraw).

## 1. Decision and non-negotiable boundaries

The current import remains useful local proof, but it is not a production job
system. Production must keep request-time admission small and move workbook
preflight, SheetJS parsing, catalog staging, supplier-image retrieval, and
reconciliation into a **private, stateless CloudBase Run container worker**.

The following boundaries are non-negotiable:

1. The browser never sends XLSX bytes through the admin Event Function body.
2. Original workbooks, unpublished media, and supplier URLs remain private.
3. The admin Function authenticates, authorizes, mints one-object upload
   credentials, finalizes upload claims, creates approval records, and reports
   status. It does not parse or fetch media in the request lifetime.
4. Only the private worker runs Channel's XLSX preflight and the SheetJS adapter.
   The parser library is not a security boundary.
5. Worker-created catalog content is staged and unpublished. A fresh,
   revision-bound admin approval is required before apply/publication.
6. Public media remains behind the existing `images.publishedRefCount` gate and
   `/api/images/:id`; a durable `catalogMediaReferences` relation separately
   protects staged, draft, and public uses. Storage privacy is never weakened to
   make preview easier.
7. Durable work is represented in NoSQL before dispatch. In-memory promises or
   a successful HTTP response are not job state.
8. Every storage/database saga has compensation plus a dry-run reconciliation
   path. Cleanup never guesses that an unreferenced object is safe to delete.

## 2. Current implementation versus production target

| Concern | Current implementation (observed) | Target production architecture |
| --- | --- | --- |
| Invocation | `apps/local-server/src/dianxiaomi-import-cli.ts` reads a local file and invokes the import in the CLI process. | Authenticated admin direct-to-private-storage upload, durable NoSQL job, then private worker dispatch. |
| Heavy work | `runCatalogImport` and publish-time media fetching execute in the caller process. The current service parses before `startImportJob` is called. | Admin request returns after upload finalization/job creation; worker claims a persisted job before preflight, parsing, media ingestion, or apply. |
| Admin surface | Catalog Import is read-only. It uses generic authenticated `list` on `catalogImportJobs` and `catalogImportItems`; no workbook upload, retry, approval, or bulk-publish action exists. | Dedicated admin actions for upload, retry/cancel, revision-bound approval, and apply; list/read can continue to use the existing read-only collections. |
| Workbook storage | The CLI keeps the source outside the repository and persists only normalized data plus digest metadata. | Immutable original stored in a private import namespace; NoSQL stores only object identity, digest, byte size, generation, retention, and audit metadata. |
| XLSX boundary | Channel preflight/parser runs in-process. | The same Channel preflight runs before SheetJS inside a bounded CloudBase Run container. |
| Import state | `catalogImportJobs` and `catalogImportItems` exist; job IDs and item IDs are deterministic. The current status set has no durable lease/heartbeat/approval/dispatch fields. | Preserve deterministic idempotence and add upload receipt, revision, claim lease, retry, approval, worker release, and reconciliation metadata. |
| Catalog state | `productVariants`, `catalogSourceLinks`, and `sourceCategoryMappings` exist. Links are deterministic and provider-neutral. | Reuse these collections and the existing write services; add required indexes/guards before the worker is enabled. |
| Supplier media | Current fetch policy is HTTPS-only, redirect-bounded, DNS/private-range checked at resolution and connect time, streamed/size-bounded, magic-byte checked, dimension-bounded, and SHA-256 deduplicated. Import storage is wired to local disk by the CLI. | Run the same policy only in the worker, inject `createCloudBaseMediaStorage(...)`, persist private `active` image rows with refcount zero, and make outbound capacity explicit. |
| Import preview | Current Catalog Import preview renders supplier URLs directly with `referrerPolicy="no-referrer"`. The generic image manager has a separate authenticated `getImagePreview` action returning base64. | Do not put supplier/COS URLs in the import DOM. Fetch authorized preview bytes through the app, create a browser `Blob` URL, and revoke it on replacement/removal/unmount. |
| Public delivery | `/api/images/:id` serves only recognized, active storage records that pass the canonical publication/refcount checks; corrupt counters fail closed. | Keep this route and gate unchanged. Publication is the only operation that can make imported media public. |
| CloudBase Run | No worker service, Dockerfile, manifest, dispatcher, or worker deploy workflow exists in this branch. | One private container service plus one bounded timer dispatcher/internal invocation contract. |
| Live CloudBase facts | The last repository evidence is historical: on 2026-07-29 the selected test EnvId had zero CloudRun services and CLS was disabled. This task did not re-inspect live state. | Re-read the exact test/prod EnvId immediately before planning or deployment; historical evidence is not current authorization. |

Local real-workbook evidence (312 rows, 77 products, 289 variants) proves the
domain pipeline and parser result. It does not prove CloudBase storage, private
worker dispatch, deployed auth, networking, cost, or operational recovery.

## 3. Trust zones and allowed flows

### Zone 0 — untrusted browser and workbook

- The workbook, filename, MIME, declared size/digest, supplier URLs, and every
  cell/ZIP/XML value are untrusted.
- The browser holds the existing Portal session token and a short-lived,
  one-object storage write credential. Neither grants storage list/read/delete.
- The browser never chooses the storage key, worker endpoint, EnvId, service
  identity, job owner, approval revision, or publication state.

### Zone 1 — public/static and authenticated application edge

- Static site: CloudBase Web App/static hosting.
- Public API: existing read-only catalog/health/image routes.
- Admin API: existing `POST /api/admin` action envelope, current custom JWT
  verification, and live-user-row revalidation.
- Only `admin` and, if explicitly confirmed, `contributor` may submit and preview
  imports. The recommended default is **admin-only approval/apply**.
- CORS is an allowlist of exact site origins. `OPTIONS` is supported; credentials
  and authorization-varying responses are never publicly cached.

### Zone 2 — private durable CloudBase services

- CloudBase NoSQL is the workflow source of truth.
- The CloudBase Storage bucket remains private. Original XLSX files and staged
  media use application-generated paths and immutable generations.
- A timer dispatcher reads only eligible jobs and invokes the worker through a
  platform-authenticated private route. It does not carry workbook bytes.
- Browser clients have no direct NoSQL read/write permission.

### Zone 3 — private CloudBase Run worker

- Container mode, pinned by immutable image digest and release SHA.
- `PUBLIC` access is disabled. Prefer `VPC`; the exact supported
  Function-to-CloudBase-Run private invocation path is a deployment gate.
- Stateless: durable state lives in NoSQL/storage; local disk is bounded scratch
  space only.
- Concurrency starts at one job per instance. CPU, memory, request deadline,
  `MinNum`, and `MaxNum` are selected only after test-environment measurements
  and budget approval.
- The container runs as non-root with a read-only root filesystem where the
  platform permits it, no shell invocation from input, no committed `.env`, and
  no build-time runtime secrets.

### Zone 4 — untrusted supplier image origins

- The worker may make outbound HTTPS requests only during the media phase.
- Parsing/preflight has no general outbound access.
- Supplier origins can redirect, rebind DNS, lie about size/type, stall, or serve
  active content. Every redirect and connection is checked by Channel policy.

Allowed high-level flows:

```text
Browser/Admin UI -> Admin Function (session, intent, finalize, preview)
Browser/Admin UI -> private Storage (short-lived one-object raw PUT only)
Admin Function -> private Storage + NoSQL (object verification and metadata only)
Timer Dispatcher/Event Function -> NoSQL (eligible-job scan)
Timer Dispatcher/Event Function -> Worker (platform-authenticated private invocation)
Worker <-> private Storage + NoSQL
Worker -> validated HTTPS supplier image origin
NoSQL/private Storage -> Public API -> Browser, only after publish/refcount eligibility
Private Storage -> authenticated Admin Function -> Browser-local Blob URL
```

No flow permits browser -> worker, supplier -> application callback, public API
-> original workbook, or raw storage URL -> public DOM.

## 4. Route and identity contracts

### 4.1 Existing routes that remain authoritative

| Route | Auth | Purpose |
| --- | --- | --- |
| Static `/*` | Public | Astro site/admin shell; no runtime secrets. |
| `POST /api/admin` | Action-dependent; import reads require a revalidated Portal session | Existing action protocol `{ action, data, token }`. |
| `GET /api/health` | Public | Release-aware synthetic health. |
| `GET /api/products*`, `GET /api/overstock*` | Public projection | Published catalog only. |
| `GET /api/images/:id` | Public, fail-closed visibility gate | Recognized/active image bytes only when publication/refcount allows. |

There is no public workbook route and no public `/api/files/:id` import route.

### 4.2 Target admin actions (not implemented yet)

All target actions stay inside `POST /api/admin`; they are action names, not new
internet paths.

| Target action | Recommended role | Contract |
| --- | --- | --- |
| `createCatalogImportUploadIntent` | `admin` (optionally `contributor` after confirmation) | Validate metadata/admission caps, reserve a generation, choose a private key, mint one-object raw `PUT` credential. |
| `completeCatalogImportUpload` | Same actor as intent | Consume once; verify intent/generation/object identity, measure bytes and server-side SHA-256, then mark the immutable upload received and create/reuse the deterministic job. No parse. |
| `retryCatalogImportJob` | `admin` | Retry the same logical job by incrementing `processingAttempt` and revision after checking failure disposition. It does not allocate a replay job or overwrite the original object/audit. |
| `cancelCatalogImportJob` | `admin` | Persist cancellation request; worker compensates only pre-publication owned resources. |
| `approveCatalogImportJob` | `admin` | Bind actor/time/job revision/source digest/settings digest/preview digest. Any staged edit invalidates approval. |
| `applyCatalogImportJob` | `admin` | CAS the approved revision to `applying`; dispatch worker apply. It does not apply synchronously. |
| `getCatalogImportMediaPreview` | `admin`/confirmed reviewer | Authorize job/item/image, return bytes with private/no-store headers; never return raw COS URL. |
| Existing `list`/`get` | `admin`/`contributor` per current collection policy | Read `catalogImportJobs` and `catalogImportItems`; generic writes remain denied. |

The target must add server-side negative tests proving viewer/member/blank roles,
stale/suspended sessions, generic CRUD, replayed intents, stale approvals, and
forged job revisions cannot upload, approve, apply, or preview private bytes.

### 4.3 Internal worker route

The recommended contract is a private `POST /internal/catalog-import/process-next`
that accepts **no job-selected data** beyond a dispatcher request/correlation ID.
The worker queries and CAS-claims the next eligible NoSQL job itself. This prevents
the dispatcher from authorizing an arbitrary object/path/job.

Requirements:

- CloudBase Run `PUBLIC` access off.
- Platform service identity/audience authentication preferred.
- If the platform cannot provide that exact private authenticated path, stop and
  design a reviewed alternative; do not silently expose a bearer-secret endpoint.
- If an application HMAC is temporarily approved, bind method, path, timestamp,
  nonce, body digest, caller, audience, and short replay window; store only the
  secret in runtime secret configuration and rotate it.
- A one-minute timer is the initial dispatch cadence. Each run also scans expired
  leases. A managed queue is a later scale option, not an unstated dependency.

## 5. Upload, processing, review, and publish sequence

### 5.1 Admission and private upload

1. Admin Function revalidates the Portal session against the current user row.
2. Validate provider, `.xlsx` extension, allowlisted declared MIME aliases,
   declared compressed size, pending-intent cap, actor rate limit, and selected
   environment.
3. Reserve an upload generation before minting. The server chooses
   `imports/xlsx/{uploadIntentId}/{generation}/source.xlsx`; every retry uses a
   fresh generation/key.
4. Mint the credential through the verified `@cloudbase/node-sdk` 3.x contract:
   raw `PUT`, signed headers, one server-chosen key. Do not copy the obsolete
   multipart-POST contract from older repository notes.
5. Browser uploads directly to private storage, then calls completion with the
   intent ID and generation. A failed browser upload leaves only a bounded,
   expiring pending intent for cleanup.
6. Completion uses a single-winner claim before any expensive storage read.
   Losers read/delete/mutate nothing. The winner verifies the exact object,
   recomputes actual byte size and SHA-256 server-side, and rejects mismatch.
7. Persist the immutable upload receipt and create/reuse the import job before
   dispatch. Without an explicit replay request, byte-identical input returns
   the existing base job and the redundant upload generation becomes bounded
   cleanup work. An explicit replay allocates the next create-if-absent `:rN`
   job described in section 6.3. The source object remains private even after
   job completion.

**Gate:** choose the original XLSX compressed-byte cap and intent TTL from real
workbook sizes and platform request/memory limits. The ZIP expansion/entry/XML
caps remain separate preflight controls and cannot be inferred from upload size.

### 5.2 Durable claim and parse

1. Dispatcher invokes the private worker.
2. Worker finds one `status=created`, `uploadStatus=received` job or one expired
   retryable lease and CASes `revision`, `leaseOwner`, `leaseExpiresAt`,
   `workerReleaseId`, and `processingAttempt`.
3. Worker reads the original from private storage and reruns digest/size checks.
4. Channel preflight examines **every archive entry**, including unreferenced
   parts, and fails closed on the limits/forbidden features in
   `specs/xlsx-core-production-readiness/requirements.md`.
5. Only after preflight succeeds does `xlsx-sheetjs.ts` receive bytes and emit the
   stable `SourceSheet`/`SourceCell` contract.
6. Worker groups/validates/reconciles and writes deterministic staged items.
7. Worker writes final counts/findings and CASes the same job revision to
   `previewReady`. Unknown status or lost lease fails closed.

The lease is renewed at bounded checkpoints. Work stops if renewal loses the
lease. A retry adopts deterministic records instead of inventing new IDs.

### 5.3 Supplier media ingestion

- Runs only for structurally valid, eligible staged items and under an explicit
  per-job URL/image/byte/time/concurrency budget.
- Reuses the current SSRF controls: HTTPS only; at most three redirects; every
  redirect and all DNS results checked; connect-time validating lookup; private,
  loopback, link-local, metadata, multicast, reserved, and IPv4-mapped IPv6
  addresses denied; 10-second request timeout; streamed 10 MiB image cap;
  JPEG/PNG/WebP magic bytes; dimension caps; SHA-256 deduplication.
- Parsing phase network access stays disabled. Media phase egress is additionally
  restricted by platform network policy where supported; code checks remain
  mandatory because host allowlists alone do not stop DNS rebinding/redirects.
- Source URLs, query strings, COS credentials, and resolved IPs are not logged.
  Metrics use job ID plus sanitized failure code/host label.
- One failed image costs that image, not unrelated items. Publication still
  requires the existing minimum-image rule.
- Before an imported image is previewable, the worker idempotently creates its
  deterministic live `catalogMediaReferences` row for the staged item/slot.
  Hash deduplication may reuse an image object, but it never reuses or omits the
  importing job's reference row.

### 5.4 Private preview

1. Admin requests preview by job/item/image ID through the authenticated app.
2. Backend verifies current role and job scope, then requires a live
   `catalogMediaReferences` row whose `jobId`, `itemId`, slot, job revision, and
   `imageId` match the request. It also verifies the image's recognized storage
   provider, `active` state, and byte-size/MIME allowlist. Knowing an image ID
   alone never authorizes preview.
3. Backend returns bytes with `Cache-Control: private, no-store`,
   `X-Content-Type-Options: nosniff`, and exact allowlisted content type.
4. Browser builds `Blob` + `URL.createObjectURL(blob)` and revokes the URL when
   replaced, removed, or unmounted.

Do not persist `blob:` URLs. Do not return or embed raw COS/supplier URLs. The
current direct supplier-URL import preview is explicitly a local-proof behavior,
not the production contract.

### 5.5 Approval and public apply

1. Operator resolves category mappings and other blockers.
2. Admin reviews counts, ignored headers, row findings, diff, private media,
   inventory conflicts, source-missing results, and settings.
3. Approval records current job revision and digests. Editing staged/operator
   inputs increments revision and invalidates approval.
4. Apply action CASes the approved revision. Worker re-reads approval and job
   state, then uses existing idempotent canonical link/product/variant services.
5. Apply creates live deterministic draft/public reference rows before releasing
   the staged rows, so there is no liveness gap. Media rows remain
   `publishedRefCount: 0` until
   an actually published catalog relation references them. The counter is an
   eligibility cache derived only from live public reference rows; private
   staged/draft liveness comes from the relation, not from this counter.
6. Terminal success requires NoSQL readback, expected product/variant/link counts,
   refcount reconciliation, public API readback, every selected public image
   returning 200 with an allowed type, and browser card/detail verification.
7. Any ambiguous partial apply enters `reconciliationRequired`; it never reports
   success and is never blindly retried as a fresh publish.

## 6. Durable NoSQL model

### 6.1 Existing collections to retain

| Collection | Production role |
| --- | --- |
| `catalogImportJobs` | Workflow source of truth and operator summary. Read-only through generic admin. |
| `catalogImportItems` | Staged candidate/findings/apply state. Read-only through generic admin. |
| `catalogMediaReferences` (new) | Authoritative staged/draft/public image-use relation and safe-cleanup input. No browser writes. |
| `productVariants` | Canonical variant/inventory projection. Generic admin hidden. |
| `catalogSourceLinks` | Deterministic group/variant/store bindings and source provenance. Generic admin hidden. |
| `sourceCategoryMappings` | Operator-owned provider category mapping. |
| `products`, `images` | Curated catalog and authoritative private/public media lifecycle. |

### 6.2 Target additive job fields

The implementation task must add and runtime-validate fields equivalent to:

- upload: `uploadIntentId`, `uploadGeneration`, `uploadStatus`,
  `sourceStorageFileId`, `sourceStoragePath`, measured `sourceByteSize`,
  `sourceFileSha256`, `sourceReceivedAt`, `sourceRetentionUntil`;
- identity/concurrency: integer `replayOrdinal`, `revision`,
  `processingAttempt`, `leaseOwner`, `leaseStartedAt`,
  `leaseExpiresAt`, `lastHeartbeatAt`, `nextAttemptAt`;
- provenance: `appReleaseId`, `workerReleaseId`, `parserPolicyVersion`,
  `settingsDigest`, `previewDigest`;
- approval: `approvalStatus`, `approvedRevision`, `approvedByUserId`,
  `approvedAt`, `rejectedByUserId`, `rejectedAt`, sanitized reason;
- recovery: `failureCode`, `failureDisposition` (`retryable`, `terminal`,
  `reconciliationRequired`, `cancelled`), `errorSummary`, `reconciledAt`;
- observability: correlation/request IDs and per-phase timestamps/durations.

Unknown runtime state, non-integer counters/revisions, malformed timestamps, or a
missing object identity fail closed. Secret values and raw supplier URLs do not
belong in these documents.

### 6.3 Source identity, replay identity, and processing retries

The current implementation already defines the contract to preserve:

- stable source identity is `sourceKey = {provider}:{sourceFileSha256}`;
- the first/base job ID is exactly `{provider}:{sourceFileSha256}` with
  `replayOrdinal=0`;
- byte-identical completion without explicit replay returns that base job
  untouched;
- explicit replay creates a new audit job with ID
  `{provider}:{sourceFileSha256}:r{N}`, `replayOrdinal=N`, and
  `replayOfJobId={provider}:{sourceFileSha256}`;
- concurrent replays allocate `N=1..100` by create-if-absent in ascending order,
  so only one caller wins each ID. Exhaustion fails closed.

Therefore `catalogImportJobs` must **not** have a unique compound index on
`(provider, sourceFileSha256)`: valid replay jobs intentionally repeat those
fields. Document `_id` uniqueness is the source/attempt uniqueness boundary. A
non-unique source-history index supports lookup. `uploadGeneration` identifies
an immutable browser-upload object, `replayOrdinal` identifies a logical replay
job, `processingAttempt` counts retries of that same job, and `revision` guards
state changes; none may substitute for another.

### 6.4 Media reference identity and concurrency

`catalogMediaReferences` is the authoritative relation for every imported image
use, including private staged items, canonical drafts, and published products.
Each row contains fields equivalent to:

- deterministic `_id = sha256("catalog-media-ref:v1\0" + subjectType + "\0" +
  subjectId + "\0" + subjectRevision + "\0" + slot)`, where `subjectType` is
  `importItem`, `productDraft`, or `productPublic`;
- `imageId`, `subjectType`, `subjectId`, integer `subjectRevision`, `slot`,
  `visibility` (`private` or `public`), `state` (`reserved`, `live`, or
  `released`), integer `revision`, and `reservationExpiresAt`;
- for imports: `jobId`, `itemId`, `jobRevision`, and `createdByJobId`;
- timestamps plus release reason/actor when released.

The image row may record `ingestOwnerJobId` while an object is `pending`, but
that is creation/compensation provenance, not permanent exclusive ownership.
Once active/deduplicated, liveness is owned by non-released reference rows.
Writers create the deterministic `reserved` row before touching/reusing the
object, then verify an `active` image and CAS the row to `live`; a retry adopts
the exact row. Replacing a slot requires a new subject/job revision, creates the
new reservation/live row first, then releases the prior row. Cancellation or
rejection releases only rows for the expected job revision.

Because image metadata, relation, and object writes may not share one atomic
transaction, cleanup is a two-phase saga. A candidate image is CASed to
`gcPending` only after an absolute query finds zero `reserved` or `live` media
references and `publishedRefCount=0`. A writer that reserved while GC raced must
restore/retry a `gcPending` image before activating the relation. After a grace
interval, the collector rechecks the same image revision and zero-non-released-
reference condition, deletes the object, then retires metadata. Any race, stale
reservation, failed delete, or uncertain read leaves the object and records
reconciliation work.

### 6.5 Required indexes and uniqueness

Exact CloudBase index syntax must be verified before creation. The logical gates
are:

- job identity by unique document `_id` using the base/`:rN` contract above;
- source history by non-unique `(provider, sourceFileSha256, replayOrdinal, _id)`;
- eligible dispatch by `(status, uploadStatus, nextAttemptAt)`;
- expired lease scan by `(status, leaseExpiresAt)`;
- item paging by `(jobId, parentSku, _id)` with a unique tiebreaker;
- current source links by `(provider, linkKind, sourceVariantKey)` and existing
  deterministic IDs;
- approval/reconciliation queries by `(approvalStatus, status, updatedAt)`.
- unique media-reference document `_id` derived from
  `(subjectType, subjectId, subjectRevision, slot)`;
- media liveness/GC by `(imageId, state, visibility, _id)`;
- import release/preview by `(jobId, itemId, state, _id)` and canonical subject
  replacement by `(subjectType, subjectId, state, _id)`.

Creation is additive. A same-name index with different key order/direction/
uniqueness blocks deployment; no workflow drops/recreates it automatically.

## 7. Private/public media lifecycle and retention

### Original workbook

```text
pending intent -> received/private -> processing/private
               -> retained for audit window -> object-first deletion -> retired metadata
               -> rejected/private -> object-first deletion -> retired metadata
```

- Paths are immutable by generation; never overwrite an accepted source object.
- The user must confirm success/failure retention periods and legal/audit needs.
- Object deletion happens before retiring the pointer. Delete failure leaves a
  retryable row. Confirmed-absent is idempotent success.

### Imported images

```text
source URL -> worker fetch/validate/hash
  -> pending image row + private object
  -> active image + deterministic live staged reference, publishedRefCount=0
  -> authenticated preview only
  -> approved apply creates draft/public references and releases staged reference
  -> public-reference count fills publishedRefCount
  -> /api/images/:id public only while active + eligible + refcount > 0
  -> zero reserved/live references -> gcPending grace/recheck -> delete -> retired
```

- If object upload succeeds but metadata activation fails, keep the image
  `pending`, release only the creator's expected reservation, and compensate
  only after CAS plus an absolute zero-`reserved`/`live` reference check. Delete
  the object before retiring metadata. Another claim, a failed delete, or an
  uncertain result leaves reconciliation work and alerts; never report success.
- Content hash deduplication must verify the existing row/object is active and
  compatible before reuse, then create the caller's own deterministic live
  reference. `ingestOwnerJobId` never proves exclusive ownership after activation.
- Cancellation/rejection releases only the expected job revision's staged
  references. It may not delete a deduplicated object referenced by another
  staged job, draft, or public catalog row.
- Deletion requires the two-phase `gcPending` protocol in section 6.4. A zero
  `publishedRefCount` alone is never deletion evidence because private relations
  intentionally do not contribute to it.
- `publishedRefCount` is derived, non-transactional public-reference state.
  Hot-path failures are logged; an idempotent, dry-run absolute recomputation
  from live public relation rows owns drift repair.

## 8. Reconciliation and crash recovery

Reconciliation is part of the design, not a post-incident script.

### Bounded automatic checks

- Each dispatcher run scans a small, oldest-first batch of expired leases and
  retryable jobs.
- Worker checkpoints are idempotent and revision guarded.
- The worker never continues after losing its lease.
- Retry uses exponential backoff plus a hard attempt/deadline ceiling; malformed
  input and policy rejections are terminal, not retried.

### Scheduled/operator reconciliation

Provide a dry-run-first admin/CLI command that reports:

1. received upload rows whose object is absent/mismatched;
2. private source objects with no live upload/job pointer;
3. jobs stuck past lease/deadline or with unknown states;
4. staged items/counts inconsistent with the job summary;
5. canonical links missing products/variants or pointing to mismatched identities;
6. staged item or canonical draft/public image slots missing their deterministic
   live `catalogMediaReferences` row, plus stale reservations and non-released
   rows whose subject/job revision is absent, released, or superseded;
7. active imported images with missing objects, orphan objects, checksum/size
   mismatch, invalid ingest ownership, or stale `gcPending` state;
8. per-image live private/public relation counts and expected public-relation
   count versus stored `publishedRefCount`;
9. objects selected for deletion that gained a live reference or changed image
   revision during the grace window;
10. `applied` jobs whose public catalog/media/browser verification is incomplete.

Repair mode requires an admin, the exact EnvId, a captured dry-run artifact, and
an explicit confirmation of the selected rows. It uses absolute-set repair where
possible, operates in a quiescent window for refcounts, checks per-object delete
results, and writes an audit record. No blanket storage prefix delete exists.

## 9. Observability and operational ownership

### Structured logs

Every admin/dispatcher/worker event includes:

- `appEnv`, exact EnvId alias-safe label, service, immutable release ID;
- correlation/request ID, job ID, replay ordinal, job revision,
  processing attempt, phase;
- action/state transition, duration, bounded counts, result/failure code;
- lease owner hash and CloudBase request/build ID where available.

Never log JWTs, upload credentials/headers, CAM credentials, runtime secrets,
workbook cells, password data, raw supplier/COS URLs, full object bytes, or
customer filenames unless an approved sanitized form is defined.

### Metrics and alerts

Minimum signals:

- queue depth and oldest eligible job age;
- claim/lease renewal/lost-lease/expired-lease counts;
- phase latency, worker cold starts, CPU/memory/OOM/timeouts, retry attempts;
- preflight/parser rejection by stable code, never raw workbook text;
- supplier fetch success/failure/SSRF blocks/bytes and per-job budget exhaustion;
- storage upload/delete/compensation leaks and NoSQL errors;
- preview authorization/reference failures and stale-approval conflicts;
- jobs in `reconciliationRequired`, missing/dangling media references,
  `gcPending` age, refcount drift, public verification failures;
- CloudRun instances/compute, storage growth/egress, function invocations, and
  CLS ingestion/retention against budget.

Alert destinations, severity, on-call owner, acknowledgement time, and runbook
links are deployment gates. Enabling CLS/log retention may be billable and needs
explicit approval.

Health is layered:

- public health proves public API release identity;
- admin health proves admin release identity without secrets;
- private worker health/readiness proves image digest/release and NoSQL/storage
  dependency readiness;
- synthetic import smoke in **test only** proves upload -> private worker ->
  preview -> approved bounded publish -> public image -> cleanup.

## 10. Secrets and environment configuration

### Non-secret, environment-scoped values

- GitHub: `TCB_ENV_ID`, `APP_ENV`, `CLOUDBASE_REGION`, `SITE_URL`,
  `PUBLIC_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`, exact worker service name,
  worker access/audience/timeout/resource settings, retention and import budgets.
- Runtime: map GitHub `TCB_ENV_ID` to **`TCB_ENV`** on admin, public API,
  dispatcher, and worker. Always use the canonical full EnvId explicitly.

### Secrets

- Deployment-only CAM credentials live in protected GitHub Environments, not app
  runtime or static build.
- Existing `JWT_SECRET` remains admin runtime only.
- Prefer platform service identity for dispatcher -> worker. If a reviewed HMAC
  fallback is approved, use a distinct `IMPORT_WORKER_HMAC_SECRET`; never reuse
  `JWT_SECRET` or a CAM key.
- Secret manager/function/CloudRun runtime configuration is the runtime source of
  truth. No secret in `PUBLIC_*`, Docker build args, layers, repository files,
  artifacts, logs, deployment summaries, or health endpoints.
- Rotation owner, cadence, overlap/revocation procedure, and emergency disable
  switch are required before production.

Runtime configuration updates must preserve unmanaged keys and intentionally own
a declared managed-key allowlist; CloudBase function configuration replacement
must not silently erase console-managed values.

## 11. CI/CD, rollout, and rollback

### 11.1 CI before any deploy

PRs remain secret-free and must add to the current gates:

- Node 22 parser/preflight/adversarial/real-workbook acceptance;
- typecheck, lint, all package tests, site build;
- function package, unresolved-import scan, and bare-directory cold-start smoke;
- `pnpm verify:cloudbase-sdk` on the exact lockfile;
- worker container unit/integration/crash-injection tests;
- non-root/read-only/scratch-path tests, image vulnerability/license/SBOM scan,
  secret-name/layer/history scan, and image digest output;
- Excalidraw/JSON/doc-link validation;
- no deployment on PR/fork and no customer workbook in source/artifacts.

### 11.2 Deployment order

1. Read-only preflight exact account/EnvId/region/current resources/cost.
2. Backup/export required NoSQL metadata and record current release/resources.
3. Add/verify NoSQL fields/indexes/rules with async feature flag off.
4. Deploy private worker image by digest with dispatcher disabled; prove private
   access and health in test.
5. Deploy dispatcher disabled, then admin upload/actions, then admin UI.
6. Run test synthetic and real-workbook acceptance without publication.
7. Enable dispatch in test; run bounded approved publish/public/browser smoke.
8. Record release SHA/digests, exact EnvId/services/domains/checks/cost sample.
9. Only after production approval, repeat against separate prod with required
   GitHub Environment reviewer. Do not rebuild between approved artifact and prod.

All writers to one EnvId serialize on the target identity, not git ref. Worker,
functions, indexes, and site have a compatibility matrix so partial deploys fail
closed. Admin admission is behind `CATALOG_IMPORT_ASYNC_ENABLED=0` until the
worker, dispatcher, storage, and schema versions report compatible health.

### 11.3 Rollback

Rollback is non-destructive:

1. Set import admission/dispatch off; leave public catalog serving the last good
   state.
2. Stop new claims, allow a bounded grace for healthy leases, then mark remaining
   work retryable/reconciliation-required. Do not kill and re-enqueue as new jobs.
3. Route the worker to the previously verified image digest and restore compatible
   admin/function artifacts. Never delete/recreate a live service on ambiguous
   deploy output.
4. Keep additive NoSQL fields/indexes and original/private objects through the
   rollback retention window. Old code must ignore new fields.
5. Run job/object/link/refcount reconciliation and public smoke.
6. Resume only after release readback and exact artifact SHA/digest match.

An apply that already committed catalog writes is not rolled back by deleting
products. It enters reconciliation and uses recorded before/after/audit state plus
operator-approved compensating actions. The operator must confirm the rollback
owner, data restore point, retention window, and maintenance window beforehand.

## 12. Exact confirmations required before future deployment

No value in this table is authorization merely because it is prepared or appears
in an older document.

| Gate | Exact confirmation required | Evidence to record |
| --- | --- | --- |
| Account/ownership | Tencent Cloud owner account/UIN and who may approve billable production resources. | Account label/UIN (sanitized where needed), named owner/approver. |
| Environment | Canonical full **test and prod EnvIds**, aliases, `APP_ENV`, and confirmation that prod is separate from test. | Fresh read-only environment query; GitHub Environment mapping. |
| Region | Exact CloudBase/CloudRun/storage region and co-location requirement; currently referenced `ap-shanghai` is historical, not assumed. | Fresh resource detail from each target. |
| `TCB_ENV` | Confirm every runtime receives canonical `TCB_ENV`; GitHub `TCB_ENV_ID -> TCB_ENV` mapping is intentional. | Redacted manifest plus post-deploy config key-name readback. |
| Worker service | Exact service name, container mode, image registry/repository, private access type (`VPC`/approved equivalent), internal audience/identity, dispatcher mechanism, request timeout. | Tool schema + service detail + negative public-access probe. |
| Worker resources | CPU/memory ratio, scratch limit, concurrency, `MinNum`, `MaxNum`, per-job deadline and retry cap. Recommended test start is concurrency 1; all numeric production values need benchmark/cost approval. | 30-run test profile including cold/warm, failures, p95, resource/cost sample. |
| Cost | Monthly ceiling and alerts for CloudRun compute/min instances, CLS ingestion/retention, NoSQL, storage capacity/operations, CDN/bandwidth and supplier egress. | Pricing snapshot/date, budget owner, thresholds and notification target. |
| Storage | Exact private bucket/EnvId/region, `imports/xlsx/` and catalog namespaces, server-generated key policy, CORS for exact browser origins/raw PUT headers, encryption, lifecycle and success/failure retention. | ACL/CORS/lifecycle readback plus upload/finalize/private-read/public-403 probes. |
| Upload policy | Maximum compressed XLSX bytes, pending cap per actor/global, intent TTL, replay/generation policy, accepted MIME aliases, server-side digest behavior. | Contract tests and deployed test smoke. |
| Database | Collection/index/ACL plan including `catalogMediaReferences`, replay-safe job identity, reference reservation/GC indexes, additive migration, backup/restore point, retention/audit policy, and who can run repair mode. | Exact schema/index/rule readback and dry-run reconciliation artifact. |
| Auth roles | Confirm whether contributors may upload/preview. Recommended: only admins approve/apply/retry/cancel; viewers/members/blank denied. | Server negative authorization tests and named business approver. |
| Worker identity/secrets | Platform identity preferred; otherwise exact HMAC scheme/name, storage mechanism, rotation/revocation owner. Confirm no JWT/CAM reuse. | IAM/runtime config key names and redacted rotation drill. |
| Domain topology | Exact site and API origins; choose default CloudBase domains, one custom domain, or split `www`/`api`; exact DNS zone owner and CORS allowlist. | DNS/route plan and HTTP/CORS smoke. |
| ICP | Whether mainland-China custom-domain service requires ICP for the selected domain/account/region and whether filing is complete. | Current Tencent/registrar confirmation and filing identifier/status. |
| SSL | Exact certificate SANs, owner/issuer, validation method, deployment target, renewal/expiry alert owner. | Certificate detail and TLS smoke after approved binding. |
| Logging | Approve CLS/billable logging, retention days, redaction rules, alert thresholds/destinations, on-call and runbooks. | Fresh log-service state and test alert. |
| CI/CD | Protected `test`/`prod` GitHub Environments, required reviewers, branch authority, least-privilege deploy identity, EnvId-scoped serialization, immutable artifact promotion. | Environment/rule screenshots or API readback and dry-run workflow. |
| Rollback | Previous artifact retention, feature-disable owner, maintenance window, database/object restore point, max tolerated queue age/data loss. | Signed runbook exercise in test. |
| Business policy | Category mappings; USD margin/input/FX/rounding; source-missing retirement; publication authority; retention of customer workbooks. | Recorded decisions and versioned settings; no guessed defaults. |
| Go-live | Explicit instruction to mutate the named resources and accept the reviewed estimated cost. | Final change record naming EnvId, services, domains, budget, release SHA/digests. |

## 13. Production acceptance evidence

Production readiness requires all of the following at the exact release:

- Fresh read-only CloudBase resource inventory and exact IDs/regions/access modes.
- Private worker public-negative probe plus authenticated internal invocation.
- Upload/finalize races prove one storage read and one job receipt; abandoned
  intents clean up without over-delete.
- Real workbook reproduces 312/77/289 in test through the deployed worker; source
  digest and provenance recorded without committing customer bytes.
- Adversarial ZIP/XML corpus fails before SheetJS; parser/resource/IPC outputs stay
  bounded under worker limits.
- Supplier SSRF/redirect/DNS-rebinding/stream/type/dimension policies pass in the
  worker and platform egress assumptions are verified.
- Preview uses authenticated bytes + revoked Blob URLs; raw supplier/COS URLs are
  absent from the DOM/network contract.
- Before approval, product/media public controls are 404/absent. After a bounded
  approval, catalog, refcounts, all selected images, and browser card/detail pass.
- Crash injection at claim, parse, each media reservation/activation/release/GC
  stage, draft persistence, approval, product/link/variant writes, refcount
  maintenance, and public verification recovers without duplicate, unsafe
  deletion, or false success.
- Reconciliation dry-run is empty or every finding has an approved disposition.
- Observability/alerts and rollback drill pass; recorded spend stays within the
  approved budget.

## 14. Repository and official references

Repository sources of truth:

- [`specs/xlsx-core-production-readiness/requirements.md`](../../specs/xlsx-core-production-readiness/requirements.md)
- [`specs/xlsx-core-production-readiness/design.md`](../../specs/xlsx-core-production-readiness/design.md)
- [`IMAGE-FETCH-POLICY.md`](IMAGE-FETCH-POLICY.md)
- [`../CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`](../CLOUDBASE_SDK_CONTRACT_VERIFICATION.md)
- [`../ENGINEERING_CRAFT.md`](../ENGINEERING_CRAFT.md)
- [`../CLOUDBASE_DEPLOYMENT_DESIGN.md`](../CLOUDBASE_DEPLOYMENT_DESIGN.md)
- [`../wecom-zip-product-import/SPEC.md`](../wecom-zip-product-import/SPEC.md)

Official CloudBase references already linked by the deployment design:

- [CloudBase HTTP function access](https://docs.cloudbase.net/en/service/access-cloud-function)
- [CloudBase HTTP service routes](https://docs.cloudbase.net/en/cli-v1/routes)
- [CloudBase custom domains](https://docs.cloudbase.net/en/cli-v1/domains)
- [CloudBase function environment variables](https://docs.cloudbase.net/en/cloud-function/function-configuration/env)
- [CloudBase MCP tools](https://docs.cloudbase.net/en/ai/cloudbase-ai-toolkit/mcp-tools)
- [CloudBase storage SDK file management](https://docs.cloudbase.net/en/storage/sdk)

These links describe capabilities, not the selected account's current state.
Before action, inspect the live tool schema and the exact target resources using
the canonical EnvId; then stop at the explicit confirmation/cost gate.
