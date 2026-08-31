# What is still needed before the XLSX import runs in production

Nothing in this branch deploys or authorizes production infrastructure. The
current implementation proves the parser/domain pipeline locally; production
requires the private async architecture in
[`PRODUCTION-INFRASTRUCTURE.md`](PRODUCTION-INFRASTRUCTURE.md).

## What is already proven, and what is not

Current repository/local evidence includes:

- the supplied workbook digest and normalized 312-row / 77-product /
  289-variant result;
- deterministic job/item/source-link identities and staged read models;
- hostile-XLSX preflight before the SheetJS adapter;
- provider-neutral grouping, inventory reconciliation, draft/apply services;
- supplier-image SSRF, byte, MIME, dimension, redirect, timeout, and hash policy;
- private/public image metadata and `publishedRefCount` delivery boundary;
- CI wiring for `pnpm verify:cloudbase-sdk`, function packaging, and cold-start
  smoke.

This does **not** prove a production workbook upload, CloudBase Run worker,
private dispatch, CloudBase media ingestion, deployed preview, NoSQL indexes,
live auth/CORS, observability, cost, custom domain, ICP, SSL, rollback, or any
test/prod environment state. Older CloudBase snapshots are historical only.

## P0 — decisions that code must not guess

### 1. USD pricing stays off

Source amounts remain CNY and no website USD field may be populated until all
four answers are approved and versioned:

1. markup on cost or target gross margin, and the percentage;
2. regular price or promotion price as input;
3. CNY-per-USD source and refresh cadence;
4. rounding rule (cents, whole dollars, `.99`, or another named rule).

The stored policy must retain source amount/currency, policy version, margin
mode/value, FX snapshot/source/time, calculation time, and unrounded/rounded USD.

### 2. Category mappings require an operator

Unmapped source categories remain unpublished. Approve the provider/category ->
Channel family mappings; do not file toys/phones under a guessed category.

### 3. Source-missing retirement requires policy

The importer marks records missing only from a complete source file; it never
deletes/unpublishes them. Approve the threshold, evidence, reviewer, notification,
and reversible retirement action before automating anything further.

### 4. Import authority and retention require policy

Confirm who may upload/preview (recommended: admin, optionally contributor), who
may approve/apply/retry/cancel (recommended: admin only), and how long successful,
failed, rejected, and abandoned original workbooks/private media are retained.

## P0 — infrastructure confirmations before any mutation

The exact confirmation matrix is in
[`PRODUCTION-INFRASTRUCTURE.md` §12](PRODUCTION-INFRASTRUCTURE.md#12-exact-confirmations-required-before-future-deployment).
At minimum, record all of these values together:

- production owner/account, canonical separate test/prod EnvIds and region;
- GitHub `TCB_ENV_ID` -> runtime `TCB_ENV` mapping for every service;
- exact private CloudBase Run service name, container registry/image, access
  type, dispatcher identity/audience, timeout, CPU/memory/scratch, concurrency,
  `MinNum`, `MaxNum`, retry/deadline;
- exact private storage bucket/region/namespaces, raw-PUT CORS origins/headers,
  encryption and lifecycle/retention;
- NoSQL collections, additive fields, indexes, ACLs, backup/restore point;
- site/API origins, one-domain versus split-domain routing, DNS owner;
- current ICP requirement/filing status for the selected mainland-China domain;
- SSL certificate SANs/owner/validation/renewal/expiry alert;
- worker/service identity or approved HMAC fallback, secret names, storage,
  rotation and revocation owner;
- CLS/log retention, alert destinations/on-call/runbooks;
- monthly ceilings and alerts for CloudRun, minimum instances, logs, NoSQL,
  storage operations/capacity, bandwidth/CDN/egress;
- protected GitHub test/prod Environments, reviewers, least-privilege deploy
  identity, immutable artifact promotion, rollback owner/window;
- explicit final authority to mutate the named EnvId/resources and accept the
  reviewed estimated cost.

Prepared values, enabled controls, older screenshots, and a passing local test
are not deployment authorization.

## P1 — implementation still required

### 1. Add the private upload/admission flow

- Admin-only `createCatalogImportUploadIntent` and
  `completeCatalogImportUpload` actions.
- Server-chosen immutable `imports/xlsx/{intent}/{generation}/source.xlsx` key.
- Verified node-sdk 3.x raw `PUT` credential, exact-object finalize, measured
  size/SHA-256, single-winner claim, pending caps/TTL/rate limits, cleanup.
- Never send XLSX bytes through the Event Function body.

### 2. Add the private CloudBase Run worker and dispatcher

- Container mode, Node 22-compatible pinned image, non-root/stateless/bounded
  scratch, immutable release digest.
- `PUBLIC` access off; platform-authenticated private invocation proven.
- Durable one-minute dispatcher, CAS lease/heartbeat/expiry/retry, concurrency 1
  initially, unknown states fail closed.
- Worker owns preflight -> SheetJS -> stage -> media -> reconciliation; parser
  phase has no general outbound access.

### 3. Extend durable job/approval state

- Add upload receipt/generation/object metadata, integer revision, attempt,
  lease, retry, parser/worker release, per-phase timestamps, sanitized failures.
- Bind approval to actor/time/job revision/source/settings/preview digests; edits
  invalidate approval.
- Add exact dispatch/lease/item paging/unique-source indexes and deny browser
  writes. Keep generic writes to jobs/items/links/variants denied.

### 4. Move import media into the CloudBase lifecycle

- Inject `createCloudBaseMediaStorage(...)` in the worker.
- Preserve current HTTPS/redirect/DNS/connect-time/stream/type/dimension limits.
- Store originals privately, content-hash dedupe, compensate object-without-row,
  start `publishedRefCount` at zero.
- Import preview uses authenticated app bytes -> browser `Blob` object URL ->
  `URL.revokeObjectURL`; no supplier/COS URL in the DOM.
- Public `/api/images/:id` remains active/publish/refcount gated.

### 5. Add approval/apply and reconciliation actions

- Admin approve/apply/retry/cancel actions; apply runs asynchronously.
- Revision CAS and idempotent canonical link/product/variant writes.
- Dry-run-first reconciliation for uploads/objects/jobs/items/links/products/
  variants/images/refcounts/public verification; no blanket prefix delete.
- Ambiguous partial publication becomes `reconciliationRequired`, never success.

### 6. Add worker CI/CD and observability

- Container tests, crash injection, image/SBOM/vulnerability/license and secret
  scans, release-digest readback, no rebuild between approved test/prod artifact.
- Structured redacted logs and metrics for queue age, leases, phase latency,
  parser/SSRF failure codes, storage compensation, OOM/timeouts/retries,
  reconciliation/refcount/public verification, and spend.
- Feature flag admission/dispatch off until schema, worker, functions, and UI
  versions report compatible health.

## P2 — test-environment acceptance before production

Run against the exact candidate release and exact test EnvId:

1. Fresh read-only resource/config/cost inventory and private-access negative
   probe.
2. Upload/finalize race, abandonment, TTL/pending caps and object compensation.
3. Adversarial XLSX corpus fails before SheetJS under container limits.
4. The real workbook reproduces 312/77/289 through the deployed worker; no
   customer workbook enters git/CI artifacts/logs.
5. Supplier SSRF/DNS-rebinding/redirect/stream/MIME/dimension controls pass from
   the worker network.
6. Private preview succeeds; public product/image controls remain absent/404
   before approval.
7. Bounded admin approval produces expected catalog/variant/link/refcount state,
   public image 200 responses, and browser card/detail rendering.
8. Crash injection at every durable boundary resumes without duplicate object,
   media, product, link, variant, refcount, or false terminal success.
9. Reconciliation dry run is empty or every finding has an approved disposition.
10. Alerts fire in test, rollback drill restores the prior release, and measured
    cost remains inside the approved ceiling.

`pnpm verify:cloudbase-sdk` is now a standing CI gate, not a one-time checkbox.
It must pass again on the exact release lockfile and be paired with a deployed
raw-PUT upload smoke; local package inspection cannot prove live bucket CORS or
the selected environment.

## P3 — production go-live gate

Deploy only after the user explicitly confirms the completed matrix, exact
resources, release SHA/image digests, estimated cost, maintenance/rollback owner,
and production mutation. Production rollout is additive and reversible:

1. schema/index/rules with async import disabled;
2. private worker and dispatcher disabled;
3. admin actions/UI;
4. no-publication import smoke;
5. dispatch enable and bounded approved publish;
6. readback/browser/alert/cost evidence;
7. admission remains disabled on any ambiguity.

Rollback disables admission/dispatch first, preserves original/private objects
and additive fields through the retention window, restores prior immutable
artifacts, and reconciles. It never deletes/recreates a live service on an
ambiguous tool response and never “rolls back” committed catalog writes by
blind deletion.

## Known production risks until these steps close

- **Alias/template drift:** unknown columns are visible, but still require human
  review.
- **Inventory staleness:** an export is a snapshot, not real-time stock.
- **Applied-state delta:** staged-but-unapplied candidates remain additions until
  approved apply.
- **Supplier dependency:** source images can disappear or change; private copied
  media is mandatory before publication.
- **Derived counter drift:** `publishedRefCount` needs ongoing absolute
  reconciliation.
- **Historical CloudBase evidence:** prior EnvId/service/log/bucket observations
  may be stale and must be refreshed before action.
