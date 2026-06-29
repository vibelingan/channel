# Image Upload And Storage — Execution & Validation Log

Status: implementation in progress on branch `fix/image-upload-storage-design`.
Companion to the design: `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` (design + MIU plan).

This document holds **execution and live-env validation** — what was built, how
it was tested, and the evidence each MIU passed against. The design doc stays
design-only; validation results and capability probes live here.

## MIU Progress Ledger

| MIU | Scope | Status | Commit(s) | Validation |
| --- | --- | --- | --- | --- |
| MIU-01 | Media data contract + safe write surface | ✅ done; Codex review resolved | `8c94d25` (+review fixes) | 12 unit tests + 18 existing pass; tsc + biome clean; Codex review §2026-06-29 resolved |
| MIU-00 | CloudBase storage + transport readiness | ✅ validated | `051d510`,`335d4eb` (now moved here) | live-env probe (§MIU-00 below); CORS/origin proof reassigned to MIU-Upload preconditions |
| MIU-02 | Media storage adapter (local-disk + typings) | pending | — | — |
| MIU-04 | Public delivery + visibility index (logic) | pending | — | — |
| MIU-05 | Admin UI uploader (FormData) | pending | — | — |
| MIU-Upload (was 03+07) | Admin-brokered direct upload (intent → pre-signed PUT → complete) | pending | — | env-gated; CORS/origin proof is a hard precondition (see Disposition) |
| MIU-06 | Legacy migration + orphan cleanup | pending | — | env-gated |
| MIU-08 | OEM files follow-up | pending | — | env-gated |
| MIU-09 | Deploy, smoke, review hardening | pending | — | env-gated |

Decision summary (binds the plan; evidence below):
- P0 byte transport = **admin-brokered direct-storage-upload** (browser PUTs to
  COS with a server-minted pre-signed credential; custom JWT stays the only
  browser credential). Server-side upload is shelved (100 KiB route cap).
- The old MIU-03 + MIU-07 fold into one admin-brokered direct-upload MIU.
- Env is classic NoSQL; bucket is private (proxy/temp-URL delivery); functions
  remain Event-behind-HTTP-access.

---

## MIU-01 — Media data contract + safe write surface (done)

- Added `packages/shared/src/media.ts` (purposes/providers/modes/statuses/variant
  roles, catalog upload policy, `ImageMetadataDoc`/`ImageVariantMetadata`,
  `catalogImageUploadSchema`).
- Extended the `images` collection with server-managed storage fields, all
  `readOnly`, and flipped legacy `data` to `readOnly` — generic CRUD can no longer
  forge `storageFileId` or write base64 bytes.
- Validation: 12 unit tests (generic create AND `.partial()` update reject every
  storage/lifecycle field + `data`; only `name`+`mimeType` writable; upload schema
  accepts valid / rejects SVG + non-allowlisted MIME (whitelist, not SVG-blocklist)
  + oversize + empty + `byteSize` bounds). 18 existing suites still pass. `tsc`
  clean across 7 backend packages + `astro check` 0 errors; biome clean.
- Self-review (4 parallel reviewers, 0 P1): fixed the `stringEnum` cast that
  widened `mimeType` to `string` (now preserves the literal union), and added the
  whitelist + `.partial()`-update + `byteSize`-bound tests above.

> **Known intermediate state (by design):** flipping `data` to `readOnly` means the
> legacy admin uploader (`apps/site/src/islands/admin/api.ts` `uploadImage` →
> `ImageManager.tsx`) now fails **loudly** with `VALIDATION_ERROR` — generic CRUD
> can no longer write base64 bytes. This is intentional; the replacement is the
> admin-brokered direct-upload MIU (was MIU-03/05). **Do not ship to an
> environment that expects working admin image upload until that MIU lands.** The
> branch is a feature branch, not deployed.

> **Follow-up (out of MIU-01 scope, pre-existing):** the admin `redact()` only
> strips `users.passwordHash`; `images` `list`/`get` responses return the full
> base64 `data` blob + storage identifiers to any read-authorized role. Tracked
> separately (multi-MB payloads + internal paths in admin list responses).

---

## MIU-00 — CloudBase storage + transport readiness (validated 2026-06-29)

Executed against the live deployed test env `diversity-123-d9grnqfux221323bb` via
the CloudBase MCP (device-authed) plus direct HTTPS probes. This is the committed
`MediaCapabilityReport` (the design §20.2 exit-criteria artifact) and the
evidence-backed transport decision.

```ts
const mediaCapabilityReport = {
  envId: 'diversity-123-d9grnqfux221323bb',
  alias: 'diversity-123',
  region: 'ap-shanghai',
  runtimeMode: 'nosql',          // classic NoSQL (MongoDB-style); PG NOT provisioned
  package: 'baas_trial',         // trial tier — quotas/limits may be lower than paid
  bucketReady: true,
  bucket: '6469-diversity-123-d9grnqfux221323bb-1443560658',
  bucketAcl: 'PRIVATE',          // public URLs 403; delivery must proxy or sign
  cdnDomain: '6469-diversity-123-d9grnqfux221323bb-1443560658.tcb.qcloud.la',
  fileIdFormat: 'cloud://<envId>.<bucket>/<path>',
  serverSdkStorageReady: true,   // upload/tempUrl/download/delete proven (round-trip)
  tempUrlReady: true,
  deleteReady: true,
  functions: {
    admin: { route: '/api/admin', type: 'Event', runtime: 'Nodejs20.19', enableAuth: false },
    publicApi: { route: '/api', type: 'Event', runtime: 'Nodejs20.19', enableAuth: false },
  },
  httpAccessHost: 'diversity-123-d9grnqfux221323bb.service.tcloudbase.com',
  adminJsonLimitBytes: 102400,       // 100 KiB — gateway 413 EXCEED_MAX_PAYLOAD_SIZE above this
  adminMultipartLimitBytes: 102400,  // same gateway cap (content-type independent, pre-handler)
  chosenCatalogImageMaxBytes: 10 * 1024 * 1024, // 10 MiB target
  recommendedTransport: 'direct-storage-upload', // server-upload FAILS the capacity gate
  checkedAt: '2026-06-29',
};
```

### How each field was validated (evidence)

| Claim | Method | Result |
| --- | --- | --- |
| Env is classic NoSQL, PG not provisioned | `envQuery(action=info)` -> `RuntimeMode`/`RuntimeBackends` | `nosql`; `{postgresql:false, nosql:true, mysql:false}` |
| Bucket exists, region, CDN | `envQuery info` `Storages[0]` | `6469-…-1443560658`, ap-shanghai, Status NORMAL |
| Bucket is private | `queryPermissions(getResourcePermission, storage)` | `aclTag: PRIVATE` |
| Storage upload works | `manageStorage(upload)` of `media-smoke/<uuid>.txt` | success + signed temp URL |
| Temp URL serves bytes intact | HTTPS GET of signed URL | HTTP 200, **sha256 matched** original |
| Private bucket blocks anon read | HTTPS GET of bare public URL | **HTTP 403** |
| Temp-URL resolution + durable fileID | `queryStorage(action=url)` | returned `cloud://env.bucket/path` fileID |
| Delete works | `manageStorage(delete force)` then `queryStorage(list)` | `deleted:true`; prefix lists 0 files |
| (caveat) CDN caches deleted object | GET temp URL after delete | still 200 from CDN edge — cache TTL ≠ deletion |
| Functions are Event behind HTTP access | `queryFunctions(listFunctions)` | `admin`,`public-api`, `Type:Event`, Nodejs20.19 |
| Routes | `queryGateway(getAccess)` | `/api/admin`, `/api` under one host |
| **Body-size cap** | HTTPS POST of increasing JSON to `/api/admin` | <=102400 B -> handler (401); >102400 B -> **413 EXCEED_MAX_PAYLOAD_SIZE** |

### Transport decision (resolves the design §19 P1 / §22.3-2 gate)

The route-capacity gate is **failed by design's worst case**: the CloudBase HTTP
access layer rejects any request body over **100 KiB (102400 bytes)** with a
platform-level `413` *before* the function handler runs. Product images
(100 KB–10 MB) therefore **cannot** be carried by server-side upload through the
existing `admin` Event Function.

Walking the design §20.2 / C4 four-branch fallback against this evidence:

1. `server-upload` (Option C / MIU-03 as written) — **REJECTED.** 100 KiB cap.
2. `native-http-function-upload` — untested; *could* bypass the access-layer cap
   but adds an `scf_bootstrap`/port-9000 runtime. Reserve as a fallback only if
   server-side byte handling becomes a hard requirement.
3. `direct-storage-upload` — **SELECTED P0.** Bytes go browser -> CloudBase
   Storage directly, bypassing the 100 KiB function cap entirely. The `admin`
   function only brokers a short-lived upload credential and writes metadata — all
   small JSON, far under 100 KiB.
4. `cloudrun-media-gateway` — reserve for large/private OEM files + scanning
   (MIU-08), not needed for catalog images.

**Consequence — MIU reordering:** the browser-direct/admin-brokered path
(previously isolated as the MIU-07 *spike*) is **promoted to the P0 byte
transport**, folded with MIU-03 into one admin-brokered direct-upload MIU. The
metadata/delivery architecture (MIU-01, MIU-02 adapter, MIU-04 visibility + proxy
delivery) is **unchanged** — it was always transport-agnostic. Proxy delivery
(MIU-04) is reinforced by the CDN-cache caveat above: proxying private bytes
through the function avoids leaving signed-URL content in the CDN edge cache
after unpublish/delete.

### Upload-credential mechanism (resolved): admin-brokered pre-signed PUT

The P0 transport needs the browser to write image bytes straight to the PRIVATE
bucket — without a function carrying them (100 KiB cap) and without a browser
CloudBase identity. Two candidates were evaluated against the live env.

**Mechanism B — CloudBase Web SDK `app.uploadFile()` — REJECTED (proven):**
- `queryAppAuth getPublishableKey` -> `publishableKey: null`.
- `queryAppAuth getLoginConfig` -> `{ usernamePassword: true, anonymous: false,
  email: false, phone: false }`.
- `app.uploadFile()` requires the browser `@cloudbase/js-sdk` to hold an
  authenticated CloudBase Auth session. This env has no publishable key, anonymous
  login is OFF, and the app authenticates with its own custom JWT (not CloudBase
  Auth) — so the browser has no CloudBase identity to authorize an upload.
  Enabling B = provision a publishable key + enable anonymous login + adopt
  CloudBase Auth in the browser, a new auth surface the design forbids. This is
  the empirical confirmation of design §19 finding 1.

**Mechanism A — admin-brokered pre-signed upload — SELECTED:**
- Primitive (classic/"传统模式" storage HTTP API, matches this NoSQL env):
  `POST /v1/storages/get-objects-upload-info`, also wrapped by the bundled
  `@cloudbase/node-sdk@2.10.0` as `cloud.getUploadMetadata({ cloudPath })`. The
  call is permission-gated: the admin function (server identity) is authorized to
  mint it; the browser is not.
- Returns per object: `{ uploadUrl, authorization, token, cloudObjectMeta,
  cloudObjectId, downloadUrl }`, where `cloudObjectId = cloud://env.bucket/path`
  (the durable storageFileId to persist).
- Flow:
  1. Browser (custom JWT) -> `POST /api/admin { action: createUploadIntent, … }`
     (tiny JSON, far under 100 KiB). Function validates JWT+role, picks a
     server-controlled `cloudPath`
     (`catalog/<yyyy>/<mm>/<imageId>/original-<safeName>`), writes a `pending`
     image doc, calls `getUploadMetadata`, and returns
     `{ imageId, uploadUrl, authorization, token, cloudObjectMeta, cloudObjectId }`.
  2. Browser does a raw `PUT uploadUrl` with headers `Authorization:
     <authorization>`, `X-Cos-Security-Token: <token>`, `X-Cos-Meta-Fileid:
     <cloudObjectMeta>`, body = file bytes. Bytes go browser -> COS directly; the
     100 KiB function cap is never on the path.
  3. Browser -> `POST /api/admin { action: completeUpload, imageId,
     cloudObjectId }`. Function verifies the object exists + size, computes
     SHA-256 server-side (download or `get-objects-download-info`; design §22.3-6),
     flips the doc to `active` with `storageFileId = cloudObjectId`. On failure ->
     `failed` / delete the object.
- Browser credential: ONLY the custom JWT. The COS signature is minted
  server-side, single-object and short-lived. No publishable key, no CloudBase
  Auth, no broadened bucket permissions — satisfies the design §13
  storage-permission and custom-JWT gates.

**CORS / upload-origin gate — a HARD MIU-Upload precondition (not a "later"
note).** For browser→COS bytes this is a readiness gate, not a build-time
afterthought: a correct app implementation still fails in-browser if the bucket
CORS does not allow `PUT` + the required headers from the site origin. Promoted
to a MIU-Upload precondition + first exit criterion — see "Codex Review
Disposition → MIU-Upload preconditions" below.

---

## Codex Review — 2026-06-29

Review base: `f81b29fcc5f08f098410123e5050828f45f07c0c` on
`fix/image-upload-storage-design`.

Verdict: MIU-01's shared contract implementation is directionally correct and
passes its package checks, and MIU-00 records enough evidence to reject
server-side upload through the current Event Function route. The branch is still
not implementation-ready for the upload MIU until the findings below are
resolved or explicitly accepted as blockers.

### Findings

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P1 | The implementation-grade MIU plan is split-brained after MIU-00 selected admin-brokered pre-signed PUT. The execution log says old MIU-03 + MIU-07 fold into one direct-upload MIU, but the low-level design still tells the implementer to build server-side multipart upload first and keep browser-direct upload as a later spike. Following the stale section would re-enter the 100 KiB route-cap failure that MIU-00 just proved. | Execution decision: `docs/IMAGE_UPLOAD_EXECUTION.md` §MIU Progress Ledger and §Upload-credential mechanism. Stale plan: `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.5 still specifies `POST /api/admin` multipart/server upload, §20.7 still treats browser-direct as a spike, and §20.7 exit criteria still says there is no P0 dependency on that spike. | Rewrite the low-level MIU section before Claude implements MIU-Upload: replace old MIU-03 + MIU-07 with one admin-brokered direct-upload MIU (`createUploadIntent` -> raw COS `PUT` -> `completeUpload`), and update MIU-05 to call that flow rather than multipart/FormData through `/api/admin`. |
| P2 | The enabled mutation E2E flow still creates image bytes through generic `createRecord('images', { data })`, which MIU-01 now intentionally rejects. Shared unit tests prove the reject path, so any `E2E_ALLOW_MUTATION=1` run will fail before product/public image assertions. | `tests/e2e/mutation.spec.ts` creates linked/unlinked images with `data` on lines 34-44 and 49-59. `packages/shared/src/media.test.ts` asserts generic image writes reject `data` on lines 36-39 and partial updates reject it on lines 90-96. | Gate or rewrite the mutation image setup in the same execution plan. Options: skip only that media-dependent assertion until MIU-Upload lands, create legacy images through a trusted test fixture/backfill helper, or move the mutation test to the new upload-intent flow when implemented. |
| P2 | The selected direct PUT transport still lacks a proved bucket CORS/upload-origin gate. The execution doc records it as a later build-time check, but for browser-to-COS bytes it is a hard readiness gate: a correct app implementation can still fail in the browser if deployed/local origins and PUT headers are not allowed. | `docs/IMAGE_UPLOAD_EXECUTION.md` §Build-time gate says CORS must allow `PUT` from deployed and local origins but has no live proof. The CloudBase design/security-domain checklist already treats origin readiness as a storage boundary item. | Promote CORS/origin proof into MIU-Upload preconditions or first exit criteria. Record the allowed origins and required headers (`Authorization`, `X-Cos-Security-Token`, `X-Cos-Meta-Fileid`, content headers), then smoke a real browser-origin PUT before wiring admin UI completion. |
| P2 | `ImageMetadataDoc` models legacy images as if migration/backfill fields already exist, while actual legacy records only contain `_id`, `name`, `mimeType`, and `data`. Future MIU-04 code that trusts the required type can accidentally treat old images as non-active/non-public even though legacy reads must continue until migration completes. | `packages/shared/src/media.ts` requires `purpose`, `storageProvider`, `status`, and `publishedRefCount` on `ImageMetadataDoc`. `apps/local-server/src/seed.ts` still seeds legacy images with only `_id`, `name`, `mimeType`, and `data`, matching the current production shape. | Model pre-migration legacy rows explicitly: either use a discriminated union where those fields may be absent for `legacy-base64`, or add a backfill/defaulting helper that normalizes DB rows before public delivery and migration code consume them. |

### Verification

- `CI=true pnpm install --ignore-scripts --frozen-lockfile` in an extracted copy of
  the latest remote branch: passed.
- `pnpm --filter @vibelingan-channel/shared test`: passed, 12 tests.
- `pnpm --filter @vibelingan-channel/shared typecheck`: passed.
- `pnpm exec biome check packages/shared/src/media.ts packages/shared/src/media.test.ts packages/shared/src/collections.ts`: passed.

Git transport note: local Git HTTPS/SSH fetch to GitHub was unavailable from this
workspace, so this review was based on the GitHub API branch snapshot and pushed
back through the GitHub contents API without rewriting branch history.

### Codex Review Disposition (addressed 2026-06-29)

All four findings accepted as valid and resolved/assigned (commit on top of the
Codex doc commit):

- **P1 (split-brain plan) — FIXED.** Added SUPERSEDED/UPDATED banners to design
  §20.5 (MIU-03), §20.7 (MIU-05), and §20.9 (MIU-07) pointing to the
  admin-brokered direct-upload mechanism here. The low-level sections no longer
  read as "build server multipart first / browser-direct is a later spike."
- **P2 (E2E mutation) — FIXED.** `tests/e2e/mutation.spec.ts` Test 1 (image-create
  + visibility flow) is now `test.skip` with a reason — its renderable-image
  precondition is intentionally gone until MIU-Upload restores a byte-backed
  create path. The OEM test (Test 2) still runs under `E2E_ALLOW_MUTATION=1`.
- **P2 (ImageMetadataDoc legacy modeling) — FIXED.** `purpose`, `storageProvider`,
  `status`, `publishedRefCount` are now OPTIONAL on `ImageMetadataDoc` (the honest
  at-rest shape — legacy rows lack them); the doc comment directs consumers to
  default and assigns the normalizer/`publishedRefCount` backfill to MIU-04. Test
  now constructs a minimal real legacy row (`_id`/`name`/`mimeType`/`data` only).
  (Chose the optional-fields fix over a full normalizer now — the normalizer is
  MIU-04 scope.)
- **P2 (CORS gate) — PROMOTED** from a build-time note to a hard precondition
  (below).

#### MIU-Upload preconditions (hard gates — verify FIRST, before any UI wiring)

1. **COS bucket CORS / upload-origin proof.** Prove a real browser-origin `PUT`
   to the COS `uploadUrl` succeeds from (a) the deployed site origin and (b) the
   local dev origin. Configure bucket CORS to allow `PUT` + the required headers:
   `Authorization`, `X-Cos-Security-Token`, `X-Cos-Meta-Fileid`, and content
   headers (`Content-Type`, `Content-Length`). Record the proven origins +
   headers here. A correct implementation still fails in-browser without this.
2. **Server-side checksum on `completeUpload`** (design §22.3-6): recompute the
   SHA-256 from the stored object; never trust a client-supplied value.
3. **Single CloudBase init** (design §22.3-3): reuse the idempotent
   `initCloudBase`; do not re-init per function.
