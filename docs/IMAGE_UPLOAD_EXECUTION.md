# Image Upload And Storage — Execution & Validation Log

Status: implementation in progress on branch `fix/image-upload-storage-design`.
Companion to the design: `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` (design + MIU plan).

This document holds **execution and live-env validation** — what was built, how
it was tested, and the evidence each MIU passed against. The design doc stays
design-only; validation results and capability probes live here.

## MIU Progress Ledger

| MIU | Scope | Status | Commit(s) | Validation |
| --- | --- | --- | --- | --- |
| MIU-01 | Media data contract + safe write surface | ✅ done; Codex review + re-review resolved | `8c94d25` (+review fixes) | 13 unit tests + 18 existing pass; tsc + biome clean; Codex review + re-review §2026-06-29 resolved |
| MIU-00 | CloudBase storage + transport readiness | ✅ validated | `051d510`,`335d4eb` (now moved here) | live-env probe (§MIU-00 below); CORS/origin proof reassigned to MIU-Upload preconditions |
| MIU-02 | Media storage adapter (local-disk + typings) | ✅ done; all Codex reviews resolved | `308b917` (+review fixes) | 23 media-storage unit tests (incl. fake-SDK cloudbase suite w/ delete-failure + node-sdk shape cases); root+e2e tsc clean; biome clean; both functions build with media-storage bundled; pre-push review + Codex re-review (delete-result hardening) resolved |
| MIU-04 | Public delivery + visibility index (logic) | ✅ done (A+B+C+D); Codex A-review + post-D review + self-adversarial B/C/D reviews all resolved | `4823a12`+fixes, Phase B, C, D, post-D hardening | A: atomic `incrementField` + facade integer guard + `nextCounterValue`. B: `publishedRefCount` maintenance in admin mutations (catalog-gated), batch dedup, per-image error isolation, `batchRemove` returns removed ids; admin 8→26. C: `getCatalogImage` branches by provider+refCount (legacy scan only as pre-backfill fallback; storage proxy; fail-closed); O(catalog) scan gone from the new path; public-api 6→16. D: `backfillPublishedRefCounts` (registry-driven, dry-run, stable `_id` paging) + admin-only action + seed reuse; admin 26→32. Post-D: strict-number counter guard (reject numeric strings), present-but-corrupt fails closed (no scan), unknown provider fails closed; public-api 16→20. All suites pass; both functions build; root tsc + biome clean. Deployed smoke = MIU-09 |
| MIU-05 | Admin UI uploader (direct COS POST UI) | ✅ done; Codex final review passed; POST contract correction pending live smoke | Phase U2a, U2b-a, U2b-b (+Codex U2b-b fixes, final review `f2063de3`) | `uploadImage()` → createUploadIntent/COS multipart POST/completeUpload; `getImagePreview` admin-auth preview (active+recognized-provider). `ImageManager` per-file state/retry, jpeg/png/webp accept, object-URL + admin previews — now commits successes against the LATEST list (concurrent-edit safe) and revokes object URLs. local-server `/api/images/:id` **delegates to `getCatalogImage`** (full prod parity incl. legacy). final Codex review: local-server tsc, site astro check+build, public-api tests, Biome, and local route smoke all pass. Live browser→COS POST + CORS = MIU-09 |
| MIU-Upload (was 03+07) | Admin-brokered direct upload (intent → pre-signed COS POST form → complete) | U1 done + Codex review resolved; U2 (UI) + live mint/CORS env-gated; node-sdk contract correction pending live smoke | Phase U1 (+Codex-review fixes) | `createUploadIntent`/`completeUpload` + `getUploadCredential` DI; Codex U1 review (2 P1 + P2 + P3) resolved — see disposition below. **`pnpm typecheck` (per-package) now green across all packages.** Live credential mint + bucket CORS = MIU-09 |
| MIU-06 | Legacy migration + orphan cleanup | ✅ code done; live migration run pending | `c4aaa8d`,`e23b67b`,`e603f34` | `cleanupOrphanImages` admin-only action + tests; `migrateLegacyImages` staged legacy `images.data` -> storage action + compensation tests; live dry-run/live ops evidence pending |
| MIU-08 | OEM Cloud Storage upload + private delivery | in progress; **Increments 1, 2a, 2b, 4 done; Increment 3 implemented but Codex P1 open** (files schema + OEM contract, intent abuse-control groundwork, public `createOemFileUploadIntent`, admin delivery; `submitProject` finalization needs gate-order fix); frontend (Increment 5) + deployed ZIP smoke (6) next | design revision below + `ed8989a` review; sniffer `fde87ad`+`adae0d0`; rate helper `f84d6cc`+P2 fix `f23f56c`; foundation `140014a`; delivery `cb886b2`; 2a `1d91b41`; intent action `724d70c`; Codex 429 wire fix `66eaa69`; reserve-first P1 fix `d69eeab` + attach-rollback hardening `9cd7c81`; Increment 3 finalization `871adff` + Codex review below | Move public OEM attachments off `drawingData` base64 JSON. New flow: public intent -> browser COS POST -> `submitProject` finalization -> admin-only short-TTL delivery. **Increment 1 (`140014a`):** extended `files` collection with server-managed (readOnly) storage/lifecycle fields incl. `uploadSecretHash`; added `FileMetadataDoc`, OEM policy constants (10 MiB cap, 15 min intent TTL, 3 pending/source, 5/60s rate), `oemFileUploadSchema` (extension-allowlisted incl. CAD) + `fileExtension`/`isAllowedOemExtension`; 9 shared tests prove generic CRUD cannot forge storage/secret fields. **Increment 4:** `getOemFileDownloadUrl` admin-authed action — fails closed unless `oem-drawing`+`active`+recognized provider+`ownerProjectId`; returns a 60s temp URL (`OEM_DOWNLOAD_URL_TTL_SECONDS`, never persisted) + `sanitizeDownloadFilename` + forced `attachment` disposition; no base64 proxy; 6 handler tests (admin 76). **Finding:** CloudBase `getUploadMetadata` has no `content-length-range` param, so COS-policy size binding is not achievable via this SDK path — server-side size re-check in `submitProject` is the enforcement, but finalization must single-winner claim before any byte download/destructive validation. **Increment 2a (groundwork for the intent caps):** added readOnly `uploadSourceHash` field to `files` (+`FileMetadataDoc`) for per-source counting, and global emergency ceilings `OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL=30`/`OEM_MAX_PENDING_INTENTS_GLOBAL=50` (enforced alongside the per-source caps since CloudBase may not expose a trusted IP). Decision so far: source key = hybrid (per-source IP hash when available, else global emergency cap); counters are still query-based over `files` (no new collection). **Increment 2b (public `createOemFileUploadIntent`):** unauthenticated action mints a browser->COS credential + writes a `pending` files row bound to a one-time upload secret (only the SHA-256 hash stored; plaintext returned once) with a 15 min expiry. BEFORE minting it enforces fail-closed a fixed-window rate limit and a live pending-intent cap, each checked per-source (hashed IP via a new backward-compatible `RequestContext.sourceIp` threaded from the HTTP adapter's `x-forwarded-for`/`requestContext.sourceIp`) AND against the global ceiling. **Codex monitor follow-up:** limiter denials now return `RATE_LIMITED` -> HTTP `429` with `Retry-After`, including pending-cap denials and CORS exposure of the header. Reserve-first now keeps admitted reservations bounded under concurrency, and the post-mint `storageFileId` attach now rolls the reservation back if the DB update throws or the row vanishes. **Remaining implementation:** fix `submitProject` finalization gate ordering, then `ProjectForm` COS POST + deployed 9-10 MiB ZIP smoke with no `EXCEED_MAX_PAYLOAD_SIZE`. |
| MIU-09 | Deploy, smoke, review hardening | ✅ DONE — live run `28435302827` (205cd71) green incl. media-upload smoke: browser→COS POST + CORS proven | Codex browser-origin smoke harness + deploy wait hardening + release verification + node-sdk upload contract correction | Added deployed media-upload smoke: browser-origin admin login → createUploadIntent → browser-enforced COS POST → completeUpload → admin preview → public 404 before published link → published product link → public 200. Wired as opt-in `E2E_MEDIA_UPLOAD_SMOKE=1` / `pnpm test:e2e:media-upload` and deploy-test workflow input. Claude accepted the harness. Runs `28431709752` and `28433320633` exposed stale-code and Updating-state deploy defects; Codex fixed both. Run `28433688422` proved the deployed release SHA and then exposed the real upload SDK-contract mismatch (`createUploadIntent` 500), now corrected to node-sdk `getUploadMetadata` + COS POST form. |
| MIU-10 | Upload transport policy gate | pending implementation; design approved by Claude + Codex monitor | design revision below; Claude review `a017f5a` | Add shared purpose/type/size policy so base64 is eligible only for explicit `inline-small`/legacy paths. Product catalog images and OEM attachments stay CloudBase Storage-backed even when small; tests must prove no size-only base64 fallback. Implementation nits: public rate/pending counters must use atomic `incrementField`; 60s OEM URL TTL should be a named constant. |
| MIU-11 | Edge rate-limit + throttling | backlog; design-only, not a MIU-08 blocker | §20.13 / §27 audit | Later hardening to move OEM/public caps toward gateway/OPA where possible. MIU-08 still owns the P0 in-function shared-state caps and cleanup; do not defer those into MIU-11. |
| MIU-12 | Quarantine state machine | lifecycle groundwork accepted; content-sniffer fix accepted | `35c6400`, fix `f04cd2f`; sniffer `fde87ad`, fix `adae0d0`; review below | Shared lifecycle helper adds expired-pending selection and status transition validator. `f04cd2f` preserves doc/object pairing for partial delete handling and fails closed on corrupt runtime statuses. `fde87ad` adds magic-byte content sniffing; `adae0d0` resolves archive MIME aliases while keeping octet-stream gated outside the signature matcher. |
| MIU-13 | Async media processing | backlog; design-only | §20.13 / §27 audit | Queue-backed variants/scanning/bulk work when volume or scanning justifies it; not P0. |
| MIU-14 | Media observability | backlog; design-only | §20.13 / §27 audit | Add metrics for upload failures, pending/orphan counts, rate-limit rejections, CDN stale incidents, and migration progress. |
| MIU-15 | Public-CDN delivery | backlog; design-only | §20.13 / §27 audit | Optional public variant/CDN path with content-addressed keys or purge strategy; private proxy/temp-URL P0 remains unchanged. |

Decision summary (binds the plan; evidence below):
- P0 byte transport = **admin-brokered direct-storage-upload** (browser POSTs a
  multipart form to COS with a server-minted credential; custom JWT stays the only
  browser credential). Server-side upload is shelved (100 KiB route cap).
- The old MIU-03 + MIU-07 fold into one admin-brokered direct-upload MIU.
- Env is classic NoSQL; bucket is private (proxy/temp-URL delivery); functions
  remain Event-behind-HTTP-access.
- Upload transport is purpose/type/size gated: `catalog-image` and
  `oem-drawing` use storage for all new writes; base64 is only for explicit
  `inline-small` assets and legacy reads/migration.
- MIU-11..15 are operational-maturity backlog. They should not delay MIU-08 or
  dilute MIU-08's P0 public-intent safeguards.

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

## MIU-02 — Media storage adapter (done)

New standalone package **`@vibelingan-channel/media-storage`** (the design's
preferred home — extracted from the MIU-01 interim location):

- `src/index.ts` — `MediaStorageAdapter` interface, `setMediaStorage`/`mediaStorage()`
  globalThis-anchored singleton, and server-side path builders
  (`objectStoragePath`, `catalogStoragePath`, `safeFileName`). CloudBase-free.
- `src/local-disk.ts` — `LocalDiskMediaStorage` (fs-backed, base-dir confined,
  traversal-guarded, `file://` temp-URL stub).
- `src/cloudbase.ts` — `createCloudBaseMediaStorage(sdk)` + `deleteCloudBaseObjects`
  (50-file chunking, §23 C3). **Dependency-injected**: takes the SDK via a
  `CloudBaseStorageSdk` interface and never `import`s `wx-server-sdk`, so this
  package can't pull the CloudBase SDK into any bundle (exit criterion) and there
  is no duplicate SDK type-stub.

Supporting changes:
- `@vibelingan-channel/db` exposes the initialised storage SDK as
  `cloudStorageSdk()` (typed `@cloudbase/node-sdk` `CloudBase`) for injection.
  `wx-server-sdk` remains the DB adapter, but it does **not** expose
  `getUploadMetadata`; upload-credential minting uses node-sdk directly while
  keeping the same DI boundary.
- Wired `setMediaStorage` into `admin` + `public-api`
  (`createCloudBaseMediaStorage(cloudStorageSdk())`) and `local-server`
  (`LocalDiskMediaStorage(./data/media)`).
- Added `@vibelingan-channel/media-storage` to the three consumers' deps **and to
  both functions' tsup `noExternal`** so it bundles into the deployed artifact
  (verified: `createCloudBaseMediaStorage` present in both `dist/index.js`).

Validation: 7 unit tests (unconfigured-throws, singleton, `safeFileName`
sanitization, path partitioning, local-disk round-trip, traversal rejection);
root + e2e `tsc` clean; biome clean; both functions build successfully with
media-storage bundled. CloudBase backend is exercised by the local-disk tests +
type-checked against the verified SDK signatures; its live round-trip rides the
MIU-00 storage proof. (No HTTP/UI behavior changes yet — no handler calls
`mediaStorage()` until MIU-04/Upload — so E2E behavior is unchanged.)

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

### Upload-credential mechanism (resolved): admin-brokered direct COS POST form

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

**Mechanism A — admin-brokered direct COS POST form — SELECTED:**
- Primitive (classic/"传统模式" storage HTTP API, matches this NoSQL env):
  `POST /v1/storages/get-objects-upload-info`, also wrapped by the bundled
  `@cloudbase/node-sdk@2.10.0` as `app.getUploadMetadata({ cloudPath })`. The
  call is permission-gated: the admin function (server identity) is authorized to
  mint it; the browser is not. Important runtime correction from MIU-09:
  `wx-server-sdk@3.0.4` does not expose `getUploadMetadata`, even though it bundles
  node-sdk internally for `uploadFile`; media-storage must be injected with an
  explicit node-sdk `CloudBase` instance.
- Returns per object as `{ data: { url, authorization, token, fileId, cosFileId,
  download_url } }`. `fileId = cloud://env.bucket/path` is the durable
  `storageFileId` to persist. `authorization`, `token`, `cosFileId`, and
  `cloudPath` become multipart form fields, matching node-sdk's own `uploadFile`
  implementation.
- Flow:
  1. Browser (custom JWT) -> `POST /api/admin { action: createUploadIntent, … }`
     (tiny JSON, far under 100 KiB). Function validates JWT+role, picks a
     server-controlled `cloudPath`
     (`catalog/<yyyy>/<mm>/<uploadIntentId>/original-<safeName>`), calls
     `getUploadMetadata`, then writes a `pending` image doc and returns
     `{ imageId, uploadIntentId, storageFileId, upload: { method: "POST", url,
     fields } }`.
  2. Browser builds `FormData`, appends every returned field first
     (`Signature`, `x-cos-security-token`, `x-cos-meta-fileid`, `key`), appends
     `file`, and `POST`s to `upload.url`. Bytes go browser -> COS directly; the
     100 KiB function cap is never on the path.
  3. Browser -> `POST /api/admin { action: completeUpload, imageId }`. Function
     verifies the object exists + size, computes
     SHA-256 server-side (download or `get-objects-download-info`; design §22.3-6),
     flips the doc to `active` with `storageFileId = fileId`. On failure ->
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

1. **COS bucket CORS / upload-origin proof.** Prove a real browser-origin `POST`
   to the COS `uploadUrl` succeeds from (a) the deployed site origin and (b) the
   local dev origin. Configure bucket CORS to allow `POST`; the signature, token,
   file id, and object key are multipart form fields (`Signature`,
   `x-cos-security-token`, `x-cos-meta-fileid`, `key`), not custom request
   headers. Do NOT list `Content-Length` — it is forbidden/UA-managed. Record the
   proven origins + method here. A correct
   implementation still fails in-browser without this.
2. **Server-side checksum on `completeUpload`** (design §22.3-6): recompute the
   SHA-256 from the stored object; never trust a client-supplied value.
3. **Single CloudBase init** (design §22.3-3): reuse the idempotent
   `initCloudBase`; do not re-init per function.

---

## Codex Re-Review — 2026-06-29 after `a0be06f`

Review base: `a0be06f2f4b35c86370bf86e9cc7af2cce631ee9` on
`fix/image-upload-storage-design`, pulled via SSH (`git@github.com`) into a clean
review clone.

Verdict: `a0be06f` improves the branch and the touched TypeScript still passes
local checks, but it does not fully close the implementation-risk findings. The
main remaining problem is that the low-level design still contains obsolete
server-multipart/FormData code blocks underneath warning banners. Claude should
not implement MIU-Upload until those sections are replaced, not merely labeled.

### Findings

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P1 | The split-brain MIU handoff is not actually fixed; it is only bannered. The design now warns "do not implement as written," but the stale executable-looking steps, request shape, code translation, and tests still describe the rejected server-side multipart path and FormData UI path. This is still implementation-grade misleading: the next agent can copy the wrong code directly from the LLD. | `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.5 lines 1314-1428 still includes `POST /api/admin`, `Content-Type: multipart/form-data`, `uploadImageAction(input.content)`, and `mediaStorage().putObject(...)`. §20.7 lines 1562-1633 still says `uploadImage()` sends `FormData` and tests for FormData. §20.9 lines 1701-1740 still frames the P0 transport as a Web SDK/publishable-key spike below the banner. | Replace those sections with a single authoritative MIU-Upload LLD: `createUploadIntent` small JSON, server-generated `cloudPath`, pending image doc, `getUploadMetadata`, browser raw COS `PUT`, `completeUpload` verify+activate, compensation/orphan handling, tests, and UI sequence. Remove or archive the old multipart/FormData snippets so no implementation path still points at the 100 KiB-capped route. |
| P2 | `ImageMetadataDoc` is now honest for raw legacy rows, but it is too weak as the only shared contract for new storage-backed rows. By making `purpose`, `storageProvider`, `status`, and `publishedRefCount` optional on the sole exported image type, future MIU code can accidentally create or consume incomplete storage-backed records without TypeScript pushing back. | `packages/shared/src/media.ts` lines 88-108 make all lifecycle/storage fields optional. `packages/shared/src/media.test.ts` verifies a full storage example type-checks, but there is no exported `StorageBackedImageMetadataDoc`, `LegacyImageMetadataDoc`, normalizer return type, or Zod schema that requires the active/pending storage-backed invariants. | Split the types: keep a raw at-rest type for pre-migration reads, but add a discriminated/normalized contract for media actions and public delivery. Storage-backed rows should require `storageProvider`, `purpose`, `status`, `publishedRefCount`, and the appropriate `storageFileId`/`storagePath` once activated. MIU-Upload should write through that stricter schema. |
| P2 | The CORS precondition lists `Content-Length` as a required browser/CORS header. Browser code cannot set `Content-Length`; it is a forbidden request header managed by the user agent. Telling the implementer to configure or send it as a required header can create false CORS/debugging work. | `docs/IMAGE_UPLOAD_EXECUTION.md` §MIU-Upload preconditions lines 262-267 lists content headers as `Content-Type`, `Content-Length` together with client-set COS headers. | Reword the gate to record actual browser preflight headers. Require `Authorization`, `X-Cos-Security-Token`, `X-Cos-Meta-Fileid`, and `Content-Type` if used; explicitly say `Content-Length` is browser-managed and must not be set by frontend code. |

### Verification

- `CI=true pnpm install --ignore-scripts --frozen-lockfile`: passed.
- `pnpm --filter @vibelingan-channel/shared test`: passed, 12 tests.
- `pnpm --filter @vibelingan-channel/shared typecheck`: passed.
- `pnpm typecheck:e2e`: passed.
- `pnpm exec biome check docs/IMAGE_UPLOAD_EXECUTION.md docs/IMAGE_UPLOAD_STORAGE_DESIGN.md packages/shared/src/media.ts packages/shared/src/media.test.ts tests/e2e/mutation.spec.ts`: passed for the non-ignored touched files (Biome reported 3 checked files).

SSH note: normal DNS resolution for `github.com` was failing through the current
resolver, so the pull/push used SSH with the Macmini key and `HostKeyAlias=github.com`
against GitHub's SSH endpoint IP. No HTTPS Git transport was used.

### Re-Review Disposition (addressed 2026-06-29)

Critically evaluated; all three accepted (one remedy adjusted):

- **P1 (banners over stale code) — FIXED (remedy adjusted).** Agreed the hazard
  was real: a "do not implement" banner over copy-pasteable server-multipart /
  FormData / Web-SDK-spike code is still a trap. **Removed** those executable
  snippets from design §20.5 / §20.7 / §20.9 (the doc shrank ~240 lines); each is
  now a banner + the carry-over policy + a pointer to the authoritative flow here.
  Pushed back on "author a full MIU-Upload LLD now" — that LLD is written when
  MIU-Upload is actually planned; the authoritative flow already lives in
  §"Upload-credential mechanism".
- **P2 (ImageMetadataDoc too weak) — FIXED.** Added `StorageBackedImageMetadataDoc`
  (required `purpose`/`storageProvider`/`storageFileId`/`storagePath`/`status`/
  `publishedRefCount`, provider excludes `legacy-base64`) + the `isStorageBackedImage()`
  narrowing guard in `packages/shared/src/media.ts`, with a test. The raw
  `ImageMetadataDoc` stays optional for legacy reads; media actions + delivery use
  the strict type. (Reconciles with the first review, which wanted optional for
  legacy.)
- **P2 (Content-Length is a forbidden header) — FIXED.** Sharp and correct — JS
  cannot set `Content-Length`. Reworded the MIU-Upload CORS precondition to list
  only frontend-settable headers and to state `Content-Length` is UA-managed.

### MIU-02 pre-push review disposition (2026-06-29)

4 parallel reviewers (assumption/docs, deep correctness+cross-file, TypeScript,
test). **0 logic P1** — deep review independently verified the adapter against the
installed SDK (DI typing sound, traversal guard layered, bundles clean, lazy
singleton). Findings addressed:

- **P1 (test) — FIXED.** `cloudbase.ts` (production backend) had zero tests despite
  being fake-SDK testable. Added `packages/media-storage/src/cloudbase.test.ts`
  (7 tests): putObject Buffer+stream, getTempUrl union call-shape/default/throw,
  getObjectAsBase64, deleteObject, and the 50-file `deleteCloudBaseObjects`
  chunking boundary (51→[50,1], 50→[50], 0→[]).
- **P2 (docs drift) — FIXED.** The forward-looking artifacts that still pushed the
  rejected paths — §16 option matrix, §18 plan steps, §20.1 execution-order table —
  now carry SUPERSEDED-by-§24 redirects (the same trap the re-review killed in
  §20.5/20.7/20.9, one layer up).
- **P2 (TS contract duplication) — ACKNOWLEDGED, not coupled.** The
  `CloudBaseStorageSdk` ↔ db `Cloud` assignability is already enforced at the
  injection call site (`createCloudBaseMediaStorage(cloudStorageSdk)` fails `tsc`
  if they drift); adding a redundant assertion would re-couple media-storage to
  `wx-server-sdk`, which the DI design exists to avoid.
- **P3s — FIXED.** `isStorageBackedImage` now checks enum MEMBERSHIP (not bare
  `typeof string`); `getObjectAsBase64` guards an empty download; `safeFileName`
  truncates before the trailing-trim; error namespace `db:`→`media-storage:`; added
  marketing-path, smoke-sanitize, stream-putObject, and delete/tempUrl-traversal
  tests. (LOW: §20.4 oem/smoke path examples still show the pre-implementation
  shape — reconciled when MIU-06/08 define those namespaces.)

### Codex Re-Review After Claude Update (2026-06-29)

Review base: `c709b04` (`fix(media): address MIU-02 pre-push review findings`).
Scope: confirm Claude's fixes, then re-review MIU-02 against the current design,
CloudBase storage rules, bundling, and implementation-grade readiness.

**What Claude fixed correctly**

- **Prior P1 stale LLD path — FIXED.** The copy-pasteable server-multipart,
  `FormData`, and Web-SDK/browser-credential snippets have been removed from the
  superseded design sections. They now redirect to the admin-brokered direct-upload
  path instead of leaving contradictory implementation code under warning banners.
- **Prior P2 weak storage-backed type — FIXED.** `StorageBackedImageMetadataDoc`
  and `isStorageBackedImage()` now provide a strict contract for new/storage-backed
  rows while preserving the optional raw `ImageMetadataDoc` shape needed for legacy
  reads.
- **Prior P2 forbidden `Content-Length` header — FIXED.** The MIU-Upload CORS gate
  now names only frontend-settable request headers (`Authorization`,
  `X-Cos-Security-Token`, `X-Cos-Meta-Fileid`, optional `Content-Type`) and
  explicitly states `Content-Length` is browser-managed.
- **MIU-02 adapter readiness — MOSTLY SOUND.** The package is CloudBase-SDK-free at
  import time, dependency-injects the initialized SDK, has local-disk traversal
  guards, includes fake-SDK coverage for upload/temp URL/download/delete chunking,
  and is bundled into both cloud functions via `noExternal`.

**New findings**

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P2 | CloudBase delete wrappers do not inspect per-file delete results, so cleanup code can report success while CloudBase rejected one or more objects. This matters most for MIU-Upload compensation and MIU-06 orphan cleanup: a failed object delete would leave private storage garbage behind with no retry signal. | `packages/media-storage/src/cloudbase.ts` declares `deleteFile(...): Promise<{ fileList: unknown[] }>` but `deleteObject()` just awaits the SDK call, and `deleteCloudBaseObjects()` only chunks calls at 50. `packages/media-storage/src/cloudbase.test.ts` asserts call shape/chunking but has no fake-SDK failure case. CloudBase storage review rule STO-004 requires per-file delete-result inspection for reliable cleanup. | Define a small typed delete-result normalizer for CloudBase's per-file entries (`fileID`/`fileId`, `status`/`code`, `errMsg`/`message` as available from the installed SDK response shape). `deleteObject()` should throw a clear `media-storage(cloudbase): delete failed...` error when its file entry fails or is missing. `deleteCloudBaseObjects()` should aggregate failures across chunks and throw/report all failed IDs. Add fake-SDK tests for single delete failure, missing result, and multi-chunk partial failure. |

**Notes for the next MIU**

- The current generic `objectStoragePath()` is acceptable for MIU-02, but MIU-Upload
  should use the catalog-specific path helper (or an explicit role-bearing filename)
  so original/derived variants cannot collide under the same logical ID.
- Keep the upload flow server-brokered: intent JSON through the admin API, browser
  raw `PUT` to COS using the minted credential, then server-side complete/verify.
  Do not reintroduce base64 JSON or multipart bytes through `/api/admin`.

**Verification run during this re-review**

- `pnpm --filter @vibelingan-channel/media-storage test`: passed, 17 tests.
- `pnpm --filter @vibelingan-channel/media-storage typecheck`: passed.
- `pnpm --filter @vibelingan-channel/shared test`: passed, 13 tests.
- `pnpm --filter @vibelingan-channel/shared typecheck`: passed.
- `pnpm typecheck`: passed.
- `pnpm build:functions`: passed.
- `pnpm package:functions && pnpm smoke:functions`: passed.
- `pnpm exec biome check ...`: passed for the implementation/design files reviewed.

Operational note: `pnpm smoke:functions` by itself expects packaged function
artifacts and fails when `.cloudbase-artifacts/functions/*/index.js` is absent.
Running `pnpm package:functions` first produces the artifacts and the smoke check
passes.

### Re-review disposition (delete-result hardening, 2026-06-29)

P2 accepted as valid — a delete that ignores CloudBase's per-file results can
report success while an object was rejected, leaking private bytes with no retry
signal (matters for MIU-Upload compensation + MIU-06 orphan cleanup; rule
STO-004). Verified the real result shapes against the installed SDK before
fixing: `@cloudbase/node-sdk` returns `{ fileID, code }` (ok = `code:'SUCCESS'`),
the `wx-server-sdk` wrapper returns `{ fileID, status, errMsg }` (ok =
`status:0`). Fix in `packages/media-storage/src/cloudbase.ts`:

- Added `inspectDeleteEntry(entry)` — a defensive per-file normalizer covering
  BOTH shapes; anything not positively confirmed as success counts as a failure.
- `deleteObject()` now throws `media-storage(cloudbase): delete failed for <id>…`
  on a failed or missing result entry, and rejects a success entry whose returned
  `fileID`/`fileId` does not match the requested id.
- `deleteCloudBaseObjects()` aggregates failures + silently-dropped ids across
  all chunks and throws once with every failed id (so cleanup callers can retry).
- Tests (`cloudbase.test.ts`, +6): single delete failure, missing result entry,
  raw node-sdk `code:'SUCCESS'` entry, mismatched success `fileID`, multi-chunk
  partial failure (one rejected + one dropped), and the all-success path.
  media-storage suite 17 → 23.

Verify: media-storage 23 + shared 13 unit tests; root + e2e `tsc` clean; biome
clean; both functions build with the hardening bundled.

### MIU-04 Phase A Review — Atomic Refcount Primitive (2026-06-30)

Review base: `4823a12` (`feat(db): atomic incrementField primitive (MIU-04
phase A)`). Scope: adapter contract, CloudBase `db.command.inc` implementation,
local JSON parity, test adapters, and alignment with design §20.6.

**What is sound**

- The phase matches design §20.6 steps 1-3: `DbAdapter.incrementField(...)`,
  CloudBase `db.command.inc(delta)`, ambient `Command.inc`, and local JSON
  read-modify-write are present.
- The helper is exposed only as a trusted server-side facade; it intentionally
  bypasses the generic registry write schema, like `createDoc`/`updateDoc`.
- Existing focused checks pass: admin handler tests, public API tests, db
  typecheck, and Biome for the changed files.

**Findings**

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P2 | `incrementField` is a trusted write-schema bypass but accepts any JavaScript `number` delta, including `NaN`, `Infinity`, and fractional values. Because `publishedRefCount` becomes the canonical public-visibility gate, a bad delta can poison counters or diverge between CloudBase and local JSON behavior. | `packages/db/src/index.ts` forwards `delta` directly; `packages/db/src/cloudbase-adapter.ts` passes it to `db.command.inc(delta)`; local/test adapters compute `(Number.isFinite(current) ? current : 0) + delta`, so a non-finite delta can persist non-finite values locally. | At the facade boundary, reject non-finite and non-integer deltas with a clear error before calling the adapter. Add tests for `NaN`, `Infinity`, and fractional deltas. |
| P3 | Local/test adapters silently treat an existing non-numeric counter value as `0`, while CloudBase `inc` is intended for numeric fields. That can hide corrupted/backfilled data in local and unit tests, then fail or behave differently in CloudBase. | `JsonFileAdapter.incrementField` and both `MemoryAdapter.incrementField` implementations use `Number(existing[field] ?? 0)` and replace non-finite current values with `0`. | Only initialise absent/null fields from `0`; if the field exists and is not a finite number, throw a clear counter-corruption error. Add one local/test adapter coverage case so MIU-04 visibility code does not normalize bad data silently. |

**Verification run during this review**

- `pnpm --filter @vibelingan-channel/db typecheck`: passed.
- `pnpm --filter @vibelingan-channel/fn-admin test`: passed, 11 tests.
- `pnpm --filter @vibelingan-channel/fn-public-api test`: passed, 6 tests.
- `pnpm exec biome check packages/db/src/adapter.ts packages/db/src/index.ts packages/db/src/cloudbase-adapter.ts packages/db/src/wx-server-sdk.d.ts apps/local-server/src/json-adapter.ts apps/functions/admin/src/handler.test.ts apps/functions/public-api/src/http-adapter.test.ts`: passed.

**Disposition (fixed in the follow-up commit) — both accepted after critical review**

- **P2 (accepted).** `incrementField` feeds `db.command.inc` and the local
  read-modify-write directly, and `publishedRefCount` gates public visibility, so
  a non-finite/fractional delta would poison the counter (and `NaN > 0 === false`
  silently hides the image). Added an integer guard at the facade — the single
  choke point — that throws on `NaN`/`±Infinity`/fractional deltas
  (`Number.isInteger`). Tests added for all four.
- **P3 (accepted — it was a real CloudBase/local divergence).** MongoDB-style
  `$inc` (CloudBase) *errors* on a non-numeric field, but the local/test RMW
  silently coerced it to `0`, so local tests would pass while CloudBase throws.
  Extracted one shared `nextCounterValue(current, delta)` helper in `db`
  (absent/null → init 0; existing non-finite value → throw) and used it in the
  JSON adapter + both test fakes, so there is a single source of truth for RMW
  counter semantics that mirrors CloudBase. The CloudBase adapter relies on
  CloudBase's native numeric-field check (commented for parity). Coverage added
  for the corruption throw and the helper directly.
- Re-verify: root + e2e `tsc` clean; biome clean; admin handler tests 5 → 8;
  public-api tests 6; no regression.

## MIU-04 Phase B — publishedRefCount maintenance (done)

Wired `publishedRefCount` upkeep into the admin handler so the canonical
public-visibility gate stays in sync as catalog docs change:

- `tracksImageVisibility(collection)` gates the work to collections that have an
  `imageIds` field (products, overstock) via the registry — every other
  collection skips the extra before-state read.
- `publishedImageIdSet(doc)` = the images a doc makes public (published + an
  `imageIds` array; intra-array duplicates collapse). `applyImageVisibilityDelta`
  applies +1 for newly-public ids and −1 for no-longer-public ids on the
  before → after transition.
- Hooked into `create`/`update`/`remove`/`batchUpdate`/`batchRemove`. Batch paths
  dedupe ids; before-states captured per unique id.
- Validation: 11 transition tests (publish/unpublish, imageIds add/remove, remove,
  ref-count = #publishing-docs, batch publish/unpublish, batch remove, dangling
  image id, overstock). admin handler 8 → 19.

### MIU-04 Phase B Self-Review — adversarial workflow (2026-06-30)

Ran a 6-dimension adversarial review (transition-correctness, batch-semantics,
transactionality/parity, gating-coverage, test-completeness, visibility-security),
each finding verified by an independent skeptic prompted to refute. Result: the
core delta math (transition-correctness) returned **zero** findings; 12 P3 issues
confirmed, 1 dismissed (negative-clamp — the non-floor is intentional and already
test-pinned). All P3 (no P1/P2). Disposition:

- **Fixed — `batchRemove` asymmetry.** It was the lone mutation path applying
  deltas over the *pre-read* set rather than what was actually written (cf.
  `removeAction` gating on `deleted`, `batchUpdate` iterating `docs`). `batchRemove`
  now returns the ids it actually removed; `batchRemoveAction` decrements only
  those — closing a concurrent-delete double-decrement and unifying all three
  paths on "apply deltas only for writes that happened". HTTP response unchanged
  (`{ removed: <count> }`).
- **Fixed — per-image error isolation.** The delta loop ran AFTER the committed
  write with no error handling, so one image's counter error (e.g. a corrupted
  non-numeric counter) aborted the loop and left *other* images fail-open. Each
  per-image increment is now wrapped (log + continue), so a single bad counter
  cannot strand its siblings or mask the committed write as a 500. Drift is
  reconciled by the Phase-D backfill.
- **Fixed — comment.** Softened the "increments never contend" note: it holds
  within one call (disjoint id sets), not across concurrent calls.
- **Added 7 regression guards:** remove-unpublished no-op, imageIds change on an
  unpublished doc, same image twice in one array (count once), null/non-array/
  empty/empty-string imageIds, batchRemove duplicate ids, batch ops with a ghost
  id, and a corrupted-sibling resilience test. admin handler 19 → 26.
- **Deferred (correctly later-phase):** local-server seed never initialises
  `publishedRefCount` → folded into the Phase-D backfill (which must also cover
  the seed path). Stronger CAS/transactional concurrency is the design-accepted,
  backfill-reconciled drift (§20.6 step 5), out of Phase B scope.
- Re-verify: root tsc clean; biome clean; admin 26, public-api 6, shared 13,
  media-storage 23; both functions build with the maintenance bundled.

## MIU-04 Phase C — public delivery branching (done)

Rewrote `getCatalogImage` in the public-api handler so `publishedRefCount` is the
canonical public-visibility gate and the per-request O(catalog) scan is gone for
the new path:

- Branches by provider + state: placeholder (public by explicit id);
  legacy-base64 (trusts a present `publishedRefCount`, else the catalog-scan
  fallback for pre-backfill rows); storage-backed (cloudbase-storage / local-disk
  — requires `status === 'active'`, a positive finite refCount, and a string
  `storageFileId`, then proxies bytes via `mediaStorage().getObjectAsBase64`).
- Fail-closed throughout: a non-finite/corrupt refCount cannot render
  (`Number.isFinite(refCount) && refCount > 0`); an unfetchable storage object is
  logged and returned as 404, never a 500 / leaked bytes.
- The legacy scan (`legacyImageIsPublicFallback`) is reached ONLY for legacy rows
  with no refCount yet — satisfying the §20.6 exit criterion once backfill runs.
- Validation: 10 delivery tests (storage active renders via proxy, refCount 0 →
  404, pending → 404, unfetchable bytes → 404, corrupt refCount → 404, legacy
  refCount 0 → 404, legacy canonical refCount>0 renders without scan, legacy scan
  fallback still renders, placeholder by id, Phase B↔C contract: bumping
  publishedRefCount makes a storage image deliverable). public-api 6 → 16.

### MIU-04 Phase C Self-Review — adversarial workflow (2026-06-30)

5-dimension adversarial review (visibility-correctness, scan-exit-criterion,
security-leak, parity/errors, test-completeness), each finding verified by an
independent skeptic. **Zero correctness or security-leak findings** — the
security-leak and scan-exit dimensions came back clean. 4 raw, 2 confirmed (both
P3 test gaps), 2 dismissed:

- **Caught pre-review & fixed:** a corrupt/non-finite `publishedRefCount` could
  render on the storage path (`NaN <= 0` is `false`); changed the gate to
  `Number.isFinite(refCount) && refCount > 0` (fail-closed) + a regression test.
- **Added (P3 gaps):** a legacy row canonically visible via refCount>0 with an id
  in no catalog (proves the canonical path renders without the scan), and a Phase
  B↔C contract test (bump `publishedRefCount` via the same `incrementField`
  primitive → the image becomes deliverable).
- **Dismissed (correctly):** "legacy ignores `status`" contradicts the design's
  own reference impl (the status gate is storage-only, §20.6); "no local-disk
  provider test" is redundant — local-disk and cloudbase-storage take the
  identical `provider !== 'legacy-base64'` branch.
- Re-verify: root tsc clean; biome clean; public-api 16; both functions build
  with the storage proxy bundled.

## MIU-04 Phase D — publishedRefCount backfill (done)

The canonical reconciliation that closes MIU-04 (design §20.6 step 5):

- `backfillPublishedRefCounts({ dryRun })` in `@vibelingan-channel/db` — recompute
  every image's `publishedRefCount` as the number of PUBLISHED catalog docs that
  reference it. Catalog collections are derived from the registry (any with an
  `imageIds` field), so it tracks products/overstock without hardcoding;
  intra-doc duplicate ids count once; unreferenced images settle to 0. `dryRun`
  reports the changes without writing. Runs against whichever adapter is wired.
- **Admin-only action** `backfillImageRefCounts` (role === 'admin') invokes it in
  the deployed runtime; `{ dryRun: true }` supported.
- **Seed reuse**: the local-server seed calls it after seeding, so demo image rows
  get correct counters (closes the Phase-B deferred seed-init item). Idempotent.
- Validation: 6 tests (tally across published-only + dedupe + accumulation, sets
  unreferenced to 0, dryRun no-write, action admin-gating, dryRun-then-apply,
  >100-row paging, `_id`-sort assertion). admin 26 → 32.

### MIU-04 Phase D Self-Review — adversarial workflow (2026-06-30)

5-dimension review (backfill-correctness, registry-gating, action-security,
prod-parity/paging, test-completeness). 4 confirmed, 0 dismissed:

- **P2 (fixed) — unstable pagination on CloudBase.** The backfill paged via the
  facade `list()` → CloudBase `skip/limit` over `createdAt desc` with **no unique
  tiebreaker**, so rows tied on `createdAt` (common in bulk-seeded/migrated data)
  could be skipped or double-counted across a 100-row page boundary — corrupting
  the absolute counter. The in-memory test adapters sort stably, so it was
  invisible to tests (works-on-test-adapter-only). Fixed by paging with an `_id`
  tiebreaker (`STABLE_PAGE_SORT`) on both scans → total order → skip/duplicate-free.
  Added a test asserting every backfill page requests the `_id` sort, plus a
  >100-row paging test.
- **P3 (documented) — absolute-SET vs a concurrent live increment.** Running the
  backfill during live catalog mutation can transiently clobber a counter
  (inherent to the backfill-reconciled scheme). Documented it as a
  quiescent-window op; CAS is overkill for a one-shot admin maintenance call.
- **P3 (= the P2 root cause from another dimension)** and **P3 (the >100-row test
  gap)** — both addressed by the fix + tests above.
- Re-verify: root tsc clean; biome clean; admin 32, public-api 16, shared 13,
  media-storage 23; both functions build with the backfill bundled.

**MIU-04 complete (A+B+C+D).** Remaining MIU-04 work is the deployed smoke check,
which belongs to MIU-09.

### Codex MIU-04 Post-D Review - public route hardening (2026-06-30)

Review base: `fd7e62c` (`feat(media): MIU-04 phase D - publishedRefCount
backfill + admin action + seed reuse`) on `fix/image-upload-storage-design`.

What looks sound:

- Admin-side counter maintenance now applies deltas only after committed catalog
  writes, deduplicates batch paths, isolates per-image counter failures, and uses
  `batchRemove`'s actually-removed ids.
- `incrementField` now has the right trusted-boundary shape: finite integer
  deltas only, CloudBase `db.command.inc(delta)` parity, and local/test adapters
  surface non-numeric stored counters instead of coercing them.
- The Phase-D backfill is registry-driven, counts only published catalog docs,
  dedupes repeated image ids within one doc, sets unreferenced images to zero,
  supports dry run, and pages by stable `_id` ordering.

Findings to fix before MIU-05:

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P2 | Public delivery still coerces `publishedRefCount` with `Number(...)`, so numeric strings such as `"1"` are treated as valid positive counters. That conflicts with the writer/backfill contract, where `publishedRefCount` is a number and non-number stored values are corruption. It can fail open for both storage-backed and legacy rows if a bad string value lands in the image document. | `apps/functions/public-api/src/handler.ts` computes `const refCount = Number(doc.publishedRefCount ?? 0)` and then checks `Number.isFinite(refCount)`. `packages/db/src/index.ts` intentionally rejects non-number stored counter values via `nextCounterValue(...)`, and `packages/shared/src/media.ts` narrows storage-backed rows only when `typeof doc.publishedRefCount === 'number'`. Current tests cover `"oops"` but not `"1"`. | Use a strict counter guard: a present counter is usable only when `typeof doc.publishedRefCount === 'number' && Number.isFinite(doc.publishedRefCount)`. Add public-api tests for storage-backed `"1"` and legacy `"1"` counters returning 404. |
| P2 | Legacy fallback should run only when `publishedRefCount` is absent, not when it is present but malformed. Today a legacy row with `publishedRefCount: "oops"` and a published catalog reference is treated as "no valid refcount" and can render via the compatibility scan. Once the field exists, it is the canonical visibility signal and malformed values should fail closed. | `hasRefCount` is defined as "own property AND finite after coercion"; the legacy branch falls back to `legacyImageIsPublicFallback(...)` when that is false. The doc comment says the scan is only for rows that predate `publishedRefCount`. | Split the concepts: `hasRefCountField = Object.hasOwn(doc, 'publishedRefCount')`; `hasValidRefCount = typeof ... === 'number' && Number.isFinite(...)`. For legacy rows, call the catalog-scan fallback only when `!hasRefCountField`; if the field is present but invalid, return 404. Add a regression test for a legacy corrupt present counter with a catalog reference. |
| P3 | The storage-backed branch treats any provider string other than `legacy-base64` as storage-backed. That lets an unknown/corrupt `storageProvider` render if it also has `status: "active"`, a positive refcount, and a string `storageFileId`. | `apps/functions/public-api/src/handler.ts` defaults non-string providers to legacy but otherwise branches only on `provider === 'legacy-base64'`. The shared contract already has `isStorageBackedImage(...)`, which only narrows `cloudbase-storage` and `local-disk`. | Fail closed for unknown providers, or reuse/align with the `isStorageBackedImage(...)` guard before proxying object bytes. Add a provider-corruption public-api test. |

Verification run:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (38 tests)
- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (16 tests)
- `pnpm --filter @vibelingan-channel/shared test` - pass (13 tests)
- `pnpm --filter @vibelingan-channel/media-storage test` - pass (23 tests)
- `pnpm --filter @vibelingan-channel/db typecheck && pnpm --filter @vibelingan-channel/local-server typecheck` - pass
- `pnpm typecheck` - pass
- `pnpm exec biome check apps/functions/admin/src/handler.ts apps/functions/admin/src/handler.test.ts apps/functions/public-api/src/handler.ts apps/functions/public-api/src/http-adapter.test.ts apps/local-server/src/json-adapter.ts apps/local-server/src/seed.ts packages/db/src/index.ts packages/db/src/cloudbase-adapter.ts docs/IMAGE_UPLOAD_EXECUTION.md` - pass
- `pnpm build:functions` - pass
- `pnpm package:functions` - pass
- `pnpm smoke:functions` - pass

**Disposition — all three accepted after critical review (fixed in the follow-up commit)**

All three are real public-route fail-open gaps in `getCatalogImage` and consistent
with the writer/backfill contract (`publishedRefCount` is a number; once present
it is canonical) and the shared `isStorageBackedImage` set. Fixed:

- **P2 (numeric-string counter).** Phase C guarded `Number.isFinite` but computed
  via `Number(...)`, so `"1"` coerced to a valid positive count. Now a counter is
  usable only as `typeof === 'number' && Number.isFinite && > 0`; a numeric string
  (or any non-number) fails closed on BOTH the storage and legacy paths.
- **P2 (present-but-corrupt legacy → scan).** Split field-presence from validity:
  `hasRefCountField = Object.hasOwn(...)`. The legacy catalog-scan fallback now
  runs ONLY when the field is absent; a present-but-invalid counter is canonical
  corruption → 404, never scans (even with a published catalog reference).
- **P3 (unknown provider).** The storage branch now proxies only the recognised
  providers (`cloudbase-storage` / `local-disk`, matching `isStorageBackedImage`);
  an unknown/corrupt `storageProvider` fails closed.
- Tests (public-api 16 → 20): storage-backed `"1"` → 404, legacy `"1"` → 404,
  unknown provider → 404, and a legacy present-but-corrupt counter WITH a published
  catalog reference → 404 (proves the scan is not reached). root tsc + biome clean;
  public-api builds.

**MIU-04 fully resolved** (implementation + Codex A-review + post-D review + the
three self-adversarial reviews). Deployed smoke remains MIU-09.

### Codex MIU-04 Follow-Up Review - d82bc5e (2026-06-30)

Review base: `d82bc5e` (`fix(media): harden public image delivery (Codex MIU-04
post-D review)`).

Disposition: **no new blocking findings.** The follow-up commit resolves the three
Codex post-D public-route findings:

- Strict counter contract is now enforced in the reader: only finite numeric
  `publishedRefCount` values can make an image visible; numeric strings such as
  `"1"` fail closed.
- Legacy fallback now depends on field absence, not counter validity. A present
  malformed counter is canonical corruption and returns 404 even when a published
  catalog doc references the image.
- Public storage proxying now accepts only `cloudbase-storage` and `local-disk`;
  unknown provider strings fail closed.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (20 tests)
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck` - pass
- `pnpm exec biome check apps/functions/public-api/src/handler.ts apps/functions/public-api/src/http-adapter.test.ts docs/IMAGE_UPLOAD_EXECUTION.md` - pass for the two source files; Markdown path is ignored by this repo's Biome config
- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (38 tests)
- `pnpm --filter @vibelingan-channel/shared test` - pass (13 tests)
- `pnpm --filter @vibelingan-channel/media-storage test` - pass (23 tests)
- `pnpm typecheck` - pass
- `pnpm build:functions` - pass
- `pnpm package:functions` - pass
- `pnpm smoke:functions` - pass

Operational note: the local review monitor initially failed to launch `codex exec`
because the local Codex config had `service_tier = "default"` while the installed
CLI accepts only `fast`/`flex`, and the backend rejected `flex`. The local config
was backed up and changed to `service_tier = "fast"`; a direct `codex exec` smoke
then returned `OK`.

## MIU-Upload — U1 server contract (done)

The admin-brokered direct-upload server, built to the authoritative contract
(design §20.7, now rewritten as the as-built LLD). One upload path everywhere:
the browser POSTs bytes straight to CloudBase with a server-minted single-object
direct form credential; local-disk is delivery-only.

- `MediaStorageAdapter.getUploadCredential(cloudPath)` (DI): CloudBase wraps
  node-sdk `getUploadMetadata` and maps it to `{ uploadUrl, method: "POST",
  formFields, storageFileId }`; local-disk throws (uploads always route through
  CloudBase).
- `createUploadIntent` (admin/contributor): validate `catalogImageUploadSchema` →
  mint credential FIRST (no orphan on failure) → write a `pending` image doc →
  return `{ imageId, upload: { method: "POST", url, fields } }`.
- `completeUpload`: verify the object is retrievable, recompute size + SHA-256
  SERVER-side, re-enforce the size cap, then flip `pending → active`.
- Local wiring: `local-server` mints REAL CloudBase credentials when `TCB_ENV` is
  set (dynamic import keeps `wx-server-sdk` out of the default dev run); else
  local-disk delivery-only. DB stays file-backed.
- Validation: admin handler 32 → 45 (intent happy/validation/forbidden/mint-fail;
  complete verify→active, retrieval-miss stays pending, over-cap→failed, checksum
  mismatch→failed, server-measured size, byteSize fallback, BAD_REQUEST, double→
  CONFLICT, contributor positive auth) + media-storage 23→26. Both functions
  build with the upload actions bundled; root tsc + biome clean.

### MIU-Upload U1 Self-Review — adversarial workflow (2026-06-30)

6-dimension review (intent/complete correctness, security-auth, lifecycle/
compensation, wiring-parity, test-completeness), each finding verified by a
skeptic. 9 confirmed (1 P2 + 8 P3), 0 dismissed. Disposition:

- **P2 (fixed) — size cap not re-enforced.** The 10 MiB cap was checked only
  against the client-declared `byteSize` at intent; the pre-signed credential is
  unbounded, so an editor could declare small and PUT a huge object.
  `completeUpload` now re-checks the SERVER-measured size against
  `CATALOG_IMAGE_MAX_BYTES` and marks the doc `failed` over the cap. Regression
  test added.
- **P3 (fixed) — transient retrieval miss dead-ended the doc.** A failed
  `getObjectAsBase64` marked the doc `failed`. Now it leaves the doc `pending`
  (retryable; orphan cleanup reaps a truly abandoned intent) and only
  checksum/size failures mark `failed`.
- **P3 (fixed) — orphaned object on a failed completion.** The size/checksum
  failure paths now best-effort `deleteObject` the rejected bytes (compensation;
  MIU-06 also sweeps).
- **P3 (fixed) — 4 test gaps:** declared≠landed size, `byteSize` fallback,
  `completeUpload` BAD_REQUEST, contributor positive-auth. Added.
- **Deferred (noted):** (a) magic-byte content sniff (declared-vs-actual MIME) —
  P3 defense-in-depth, bounded (trusted editor; served as `image/*` so no XSS),
  deferred to a hardening pass; (b) local-server `/api/images/:id` storage-backed
  delivery (serves only legacy `data` today) — folded into **U2**, where the
  uploader UI + local view loop live.
- **Update (2026-07-01):** deferred item (a) magic-byte sniff is now implemented
  as pure shared groundwork — `sniffMagicBytes()` + `signatureMatchesMime()` in
  `packages/shared/src/media-content.ts` (PNG/JPEG/WebP/GIF/PDF/ZIP/RAR; CAD stays
  extension-gated, RIFF-non-WebP rejected, declared-MIME cross-check). 15 tests.
  MIU-08/MIU-12 wire it into upload verification (`pending→active` gate).
- Re-verify: root tsc + biome clean; admin 45, media-storage 26, public-api 20,
  shared 13; both functions build.

### Design doc updated

`docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.7 rewritten from a "SUPERSEDED" banner
into the authoritative **as-built MIU-Upload LLD** (server contract, credential
provider, local wiring, lifecycle, MIU-05 UI flow, env-gated CORS/mint); §6's
high-level mermaid aligned to the as-built flow (pending-at-intent,
`completeUpload(imageId)`, activate-at-complete, refCount delivery gate); the
§20.5/§20.9 banners now cross-reference §20.7 as authoritative. Closes the
long-standing "stale design LLD" Codex P1.

## Codex MIU-Upload U1 Review - 5a043e0 (2026-06-30)

Review base: `5a043e0df52b6d061baf6a67fca3a62af5da9329`
(`feat(media): MIU-Upload U1 — admin-brokered direct-upload server contract`) on
`fix/image-upload-storage-design`, fetched via SSH.

Verdict: **blocking findings.** The server flow is directionally aligned with
the direct-upload design, and the focused runtime tests pass, but the branch is
not ready for MIU-05/UI work because the new storage adapter contract breaks
typecheck in existing consumers and the CloudBase upload credential mapping is
not hardened enough for a hand-typed external SDK boundary.

### Findings

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P1 | Root typecheck is broken because `MediaStorageAdapter.getUploadCredential` became required but the public-api test fake still implements the old interface. This is a release/CI blocker even though the public-api runtime tests still pass under `tsx`. | `apps/functions/public-api/src/http-adapter.test.ts:27` defines `fakeMediaStorage: MediaStorageAdapter` with `putObject`, `getObjectAsBase64`, `getTempUrl`, and `deleteObject`, but no `getUploadCredential`. `pnpm --filter @vibelingan-channel/fn-public-api typecheck` fails with TS2741. `pnpm typecheck` fails on the same error before reaching all later packages. | Update every `MediaStorageAdapter` fake/test implementation to satisfy the new method (usually throw "not used" for public delivery), or split upload credential minting into a narrower upload-capable interface so read-only consumers are not forced to implement upload-only methods. Then rerun root typecheck. |
| P1 | The new local-server CloudBase upload wiring breaks `@vibelingan-channel/local-server` typecheck. The dynamic import of `@vibelingan-channel/db/cloudbase` causes TypeScript to compile `packages/db/src/cloudbase-adapter.ts`, but the package-local `wx-server-sdk.d.ts` declaration is not visible from the local-server program. This contradicts the U1 self-review claim that root tsc is clean. | `apps/local-server/src/main.ts:41-47` dynamically imports `@vibelingan-channel/db/cloudbase` when `TCB_ENV` is set. `pnpm --filter @vibelingan-channel/local-server typecheck` fails with TS7016 for `wx-server-sdk` imports in `packages/db/src/cloudbase-adapter.ts`. The previous head wired only `LocalDiskMediaStorage` in local-server, so this dependency edge is new. | Make the `wx-server-sdk` ambient declaration visible to cross-package consumers of `@vibelingan-channel/db/cloudbase` (for example by moving/exporting the declaration appropriately or adjusting the package type/include strategy), or isolate the local-server CloudBase wiring behind a typed boundary that does not pull undeclared SDK imports into the consumer typecheck. |
| P2 | CloudBase upload credential metadata is only partially validated at runtime. If the hand-typed SDK response omits `authorization`, `token`, or `cloudObjectMeta`, `createUploadIntent` can still persist a pending image doc and return unusable/undefined browser PUT headers. That turns an external contract mismatch into a broken upload plus orphan pending state instead of a clean mint failure. | `packages/media-storage/src/cloudbase.ts:142-154` throws only when `uploadUrl` or `cloudObjectId` is missing, but returns `authorization`, `token`, and `cloudObjectMeta` unchecked. `apps/functions/admin/src/handler.ts:807-814` forwards those values as required headers. The design says incomplete metadata should throw. Current tests cover missing `uploadUrl` only. | Treat every required credential field as an untrusted runtime value: assert non-empty strings for `uploadUrl`, `authorization`, `token`, `cloudObjectMeta`, and `cloudObjectId` before returning the credential, and add fake-SDK tests for each missing required field. |
| P3 | The U1 lifecycle contract is inconsistent about retrieval misses. The implemented behavior leaves the image doc `pending` when `completeUpload` cannot fetch the object, but the design doc and handler comment still say a missing object marks the doc `failed`. That can mislead MIU-05 into treating a retryable completion miss as terminal. | Implementation: `apps/functions/admin/src/handler.ts:847-857` catches fetch failure and returns `NOT_FOUND` while leaving `pending`; tests and the execution self-review also say "retrieval-miss stays pending". Conflicting text: `apps/functions/admin/src/handler.ts:820-823` and `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md:1494-1498`, `1518-1520`. | Align the docs/comments with the actual retryable behavior: missing/not-yet-retrievable object stays `pending`; size/checksum verification failures mark `failed` and best-effort delete. |

### Verification Run By Codex

- `git fetch origin fix/image-upload-storage-design` using the pinned SSH-only
  transport from the review prompt - passed;
  `origin/fix/image-upload-storage-design` =
  `5a043e0df52b6d061baf6a67fca3a62af5da9329`.
- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (51 tests).
- `pnpm --filter @vibelingan-channel/media-storage test` - pass (26 tests).
- `pnpm --filter @vibelingan-channel/shared test` - pass (13 tests).
- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (20 tests).
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass.
- `pnpm --filter @vibelingan-channel/media-storage typecheck` - pass.
- `pnpm --filter @vibelingan-channel/db typecheck` - pass.
- `pnpm --filter @vibelingan-channel/local-server typecheck` - **fail** (TS7016: missing declaration for `wx-server-sdk` from the new CloudBase dynamic import path).
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck` - **fail** (TS2741: public-api fake missing required `getUploadCredential`).
- `pnpm typecheck` - **fail** (same `fn-public-api` TS2741 blocks the root check).
- `pnpm build:functions` - pass.
- `pnpm exec biome check apps/functions/admin/src/handler.ts apps/functions/admin/src/handler.test.ts apps/local-server/src/main.ts packages/db/src/wx-server-sdk.d.ts packages/media-storage/src/index.ts packages/media-storage/src/local-disk.ts packages/media-storage/src/cloudbase.ts packages/media-storage/src/cloudbase.test.ts packages/media-storage/src/index.test.ts` - pass.

### Codex U1 Review — disposition (all 4 accepted & fixed)

Critically evaluated; all four are real. **Root cause of the two P1s: I had been
verifying with root `tsc --noEmit`, which is NOT the project's per-package
`pnpm typecheck` — the per-package programs caught what root tsc masked.** Now
verifying with the per-package check.

- **P1 (public-api fake missing `getUploadCredential`).** My fix WAS written but I
  never staged `apps/functions/public-api/src/http-adapter.test.ts` into `5a043e0`
  (staging miss) — so the pushed commit was broken. Committed the fake conformance.
- **P1 (local-server `wx-server-sdk` ambient not visible).** The env-gated dynamic
  import of `@vibelingan-channel/db/cloudbase` pulls `cloudbase-adapter.ts` into
  the local-server program, where db's package-local `wx-server-sdk.d.ts` is not
  in scope (TS7016). Fixed with a `/// <reference path="./wx-server-sdk.d.ts" />`
  in `cloudbase-adapter.ts` so the ambient declaration pins into any program that
  compiles that file. `local-server` typecheck now passes.
- **P2 (credential metadata only partially validated).** `getUploadCredential`
  now requires ALL of `uploadUrl`/`authorization`/`token`/`cloudObjectMeta`/
  `cloudObjectId` as non-empty strings (was: only `uploadUrl`+`cloudObjectId`),
  failing the mint cleanly instead of returning undefined PUT headers. Added a
  fake-SDK test asserting each missing field throws.
- **P3 (lifecycle doc mismatch).** Aligned design §20.7: a not-yet-retrievable
  object at `completeUpload` stays `pending` (retryable); only size/checksum
  verification failures mark `failed`. (The handler already behaved this way.)

Re-verify with the per-package check: `pnpm typecheck` (all packages) green; admin
45 / media-storage 26 / public-api 20 / shared 13; both functions build.

### MIU-05 (U2) — admin uploader UI, phase U2a (client flow + local delivery)

- `apps/site/src/islands/admin/api.ts` `uploadImage()` now drives the
  admin-brokered flow: `createUploadIntent({fileName, mimeType, byteSize})` → raw
  `PUT` the File to `upload.url` with the COS headers → `completeUpload({imageId})`.
  Removed the dead `fileToBase64` helper (only the old base64 path used it).
- `apps/local-server/src/main.ts` `/api/images/:id` now also proxies storage-backed
  rows (`status:'active'` + `storageFileId`, via `mediaStorage()`), closing the
  U1-deferred local upload→view gap. Gated on `active` (not refCount) so the admin
  can preview a freshly-uploaded, not-yet-linked image.
- Verify: root + per-package tsc clean; `astro check` 0 errors; biome clean. The
  live browser→COS PUT (CORS/signature) is exercised at MIU-09. U2b adds per-file
  upload state + retry in the UI.

### Codex MIU-05/U1 Fix Review — 2026-06-30

Review base: `ba27b60` (`fix(media): address Codex MIU-Upload U1 review
(typecheck P1s + credential validation + lifecycle doc)`), diffed against the
previous processed head `db335899`.

What is sound:

- The U1 fixes close the cross-package TypeScript contract break: public-api's
  fake storage adapter now implements `getUploadCredential`, and local-server can
  typecheck the env-gated CloudBase dynamic import.
- `getUploadCredential` now validates every required CloudBase upload metadata
  field as a non-empty string before returning browser PUT headers.
- The client upload sequence in `uploadImage()` is the intended small-JSON intent
  -> raw storage PUT -> small-JSON complete flow; no base64 or multipart bytes go
  through `/api/admin`.

Findings:

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P1 | MIU-05's admin preview path is still production-broken for new storage-backed images. `uploadImage()` returns only the image id, and `ImageManager` immediately previews that id through `imageUrl(id)` -> public `/api/images/:id`. The production public route intentionally requires `status === 'active'` AND a positive numeric `publishedRefCount`; a newly uploaded image is active but has `publishedRefCount: 0` until a catalog record is saved and published, so the admin preview returns 404 for freshly uploaded, unlinked, or unpublished storage images. The new local-server proxy bypasses `publishedRefCount`, which masks the production behavior instead of proving it. | `apps/site/src/islands/admin/api.ts:105-108`, `apps/site/src/islands/admin/ImageManager.tsx:51-56`, `apps/functions/public-api/src/handler.ts:198-204`, `apps/local-server/src/main.ts:97-124`. Design §20.7 says MIU-05 should keep image previews working, but the public delivery gate is not an admin preview route. | Do not weaken the public route. Add an admin-authenticated image preview/delivery path, or return/use local object URLs for just-uploaded files and add an authenticated route for persisted admin previews. Align local-server with that same contract so local dev does not hide the deployed behavior. |
| P2 | The uploader still invites formats the server now rejects. The file picker accepts SVG and GIF, and the helper copy says SVG is supported, but `catalogImageUploadSchema` only permits JPEG, PNG, and WebP. This makes the new direct-upload UI fail after selection with a server validation error; in a multi-file selection, any earlier successful uploads are already active but never added to the form because `onChange` happens only after the whole loop finishes. | `apps/site/src/islands/admin/ImageManager.tsx:99-109`; server allowlist in `packages/shared/src/media.ts` (`CATALOG_IMAGE_MIME_TYPES`). | Restrict `accept` and copy to JPEG/PNG/WebP, and add client-side filtering or per-file state so one rejected file does not hide earlier successful uploads. |
| P3 | The lifecycle documentation fix is incomplete in code comments. The design now correctly says a not-yet-retrievable object stays `pending`, but the `completeUploadAction` block comment still says a missing object marks the doc `failed`. The implementation and tests leave it pending. | `apps/functions/admin/src/handler.ts:819-824` conflicts with `apps/functions/admin/src/handler.ts:845-857` and design §20.7 lifecycle text. | Update the stale comment when Claude next touches the upload action so future MIU-06/MIU-09 work follows the retryable-miss contract. |

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (51 tests).
- `pnpm --filter @vibelingan-channel/media-storage test` - pass (26 tests).
- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (20 tests).
- `pnpm --filter @vibelingan-channel/local-server typecheck` - pass.
- `pnpm --filter @vibelingan-channel/site typecheck` - pass (`astro check`, 0 errors; existing FormEvent hints only).
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck` - pass.
- `pnpm --filter @vibelingan-channel/media-storage typecheck` - pass.
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass.
- `pnpm --filter @vibelingan-channel/db typecheck` - pass.
- `pnpm typecheck` - pass across packages/apps + e2e.
- `pnpm build:functions` - pass.
- `pnpm exec biome check apps/functions/public-api/src/http-adapter.test.ts apps/local-server/src/main.ts apps/site/src/islands/admin/api.ts packages/db/src/cloudbase-adapter.ts packages/media-storage/src/cloudbase.ts packages/media-storage/src/cloudbase.test.ts docs/IMAGE_UPLOAD_EXECUTION.md docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` - pass for the six non-ignored implementation files; Markdown docs are ignored by this repo's Biome config.

Disposition: U1 fixes are accepted, but MIU-05 is **not done**. The P1 preview
route blocker must be fixed before marking the admin uploader complete; U2b
per-file state/retry remains pending.

### Codex MIU-05 Review — disposition

Critically evaluated; all three valid. MIU-05 is correctly U2a-done / U2b-pending,
so P1+P2 are the remaining U2b scope (not regressions in shipped work).

- **P3 (fixed now).** The `completeUploadAction` doc comment still said "missing
  object marks failed"; the code + design already leave a not-yet-retrievable
  object `pending` (retryable). Comment aligned.
- **P1 (→ U2b).** Admin previews go through the public `/api/images/:id`, which
  correctly gates on `status==='active' && publishedRefCount>0` — so a freshly
  uploaded (active, refCount 0) or unpublished image 404s. My U2a local-server
  proxy gated on `active` only, which *masked* this. **Do not weaken the public
  route.** U2b plan: add an admin-authenticated preview (admin action returning the
  image bytes / a signed URL, auth = `canReadCollection('images')`, no refCount
  gate) and point `ImageManager` at it; revert local-server `/api/images/:id` to
  the public contract (delegate to `getCatalogImage`) so local dev no longer masks
  prod.
- **P2 (→ U2b).** `ImageManager` accept-list still allows SVG/GIF (server allows
  only jpeg/png/webp) and uses a single busy flag so a mid-batch rejection drops
  earlier successes. U2b plan: restrict accept + copy; per-file state
  (pending/uploading/succeeded/failed) with retry, committing each success as it
  lands.

Codex verification on `ba27b60`: all per-package typechecks pass, `pnpm typecheck`
green, both functions build, biome clean — confirming the U1 fixes landed.

### Codex MIU-05 Review — 2026-06-30 after `0480ef3`

Review base: `0480ef3` (`docs(media): MIU-05 Codex review disposition + fix
stale completeUpload comment (P3)`), diffed against the previous processed head
`0357cb85`.

What is sound:

- The admin handler comment now matches the implementation and tests:
  not-yet-retrievable objects stay `pending` and retryable; only size/checksum
  verification failures mark the doc `failed` and trigger best-effort delete.
- No TypeScript or CloudBase SDK contract regression was found in the
  comment-only handler delta.

Findings:

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P1 | MIU-05 is still blocked, but the new disposition softens the previous P1 into ordinary "U2b scope" while the authoritative design still points the next implementer at the broken preview path. `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.7 still says to keep `imageUrl(id)` previews via public `/api/images/:id`; the latest execution disposition correctly says U2b must add an admin-authenticated preview and stop local-server from masking production. Those two handoffs conflict. If Claude follows the design text, fresh storage-backed uploads still 404 in production admin preview because public delivery requires `publishedRefCount > 0`. | Current code: `ImageManager` previews with `imageUrl(id)`, `imageUrl` is public `/api/images/:id`, production public delivery gates storage-backed rows on `status === 'active' && publishedRefCount > 0`, and local-server still gates storage rows on `active` only. Docs conflict: design §20.7 says keep public previews; latest execution disposition says add admin preview and revert local-server masking. | Treat admin-auth preview + local-server parity as blocking MIU-05 completion, not a passed U2a footnote. Update design §20.7 to remove the public-preview instruction, make the admin-auth preview route the U2b exit criterion, and keep MIU-05 marked not done until that implementation and review land. |
| P3 | The P3 lifecycle comment fix is only partially reflected in the docs. The handler comment is now correct, but `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.7's detailed `completeUpload` step still says "A missing object ... marks the doc failed" before the later lifecycle paragraph says the opposite. That is a stale implementation contract for MIU-06/MIU-09. | Design §20.7 server-contract step 3 conflicts with the same section's lifecycle paragraph and with `completeUploadAction` tests (`completeUpload leaves the doc PENDING (retryable) when the object is not yet retrievable`). | Align the detailed design step with the actual contract: retrieval miss stays `pending` and retryable; size/checksum verification failures mark `failed`. |

Verification run by Codex on `0480ef3`:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (51 tests).
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass.
- `pnpm exec biome check apps/functions/admin/src/handler.ts docs/IMAGE_UPLOAD_EXECUTION.md` - pass for `handler.ts`; Markdown is ignored by this repo's Biome config.

Disposition: `0480ef3` closes the narrow P3 handler-comment issue, but MIU-05 is
still **not done**. The next Claude pass should implement U2b (admin-auth preview,
local-server parity, per-file upload state/retry, jpeg/png/webp accept-list) and
align the design handoff before MIU-05 can be marked reviewed/complete.

### Codex MIU-05 disposition re-review — disposition (U2b-a)

Both findings valid (doc-handoff consistency). Rather than ping-pong on docs, did
the substantive fix Codex pointed to — started U2b:

- **P1 (design handoff conflict).** Added the admin-authenticated `getImagePreview`
  action (the preview channel that bypasses the public `publishedRefCount` gate)
  and rewrote design §20.7's MIU-05 line to mandate it (no more "keep `imageUrl(id)`
  via the public route") + the local-server `getCatalogImage` delegation. Tests
  (admin 45→49): legacy bytes, an UNPUBLISHED storage image (refCount 0) served,
  a PENDING upload served, viewer-forbidden / unknown-id-404 / unfetchable-404.
- **P3 (stale §20.7 step-3 text).** Aligned §20.7 step 3 too (it still said "missing
  object marks failed"): retrieval miss → `pending` (retryable); size/checksum →
  `failed`.

Remaining for U2b-b (next): wire `ImageManager` to `getImagePreview` (+ object URLs
for the just-uploaded session), per-file upload state/retry, jpeg/png/webp accept,
and revert local-server `/api/images/:id` to delegate to `getCatalogImage`. MIU-05
stays **not done** until U2b-b lands + reviews.

### Codex MIU-05 U2b-a Review - 2026-06-30 after `5439334`

Review base: `54393344360712fe891de431d3b1ecf36b6049e5` (`feat(media): MIU-05
U2b-a - admin-authenticated getImagePreview + design handoff aligned`), diffed
against the previous processed head `27ab5bbd767cfd0ea459b408462ceda47f41d24a`.

What is sound:

- The action is behind the existing admin session gate and uses
  `canReadCollection(claims.role, 'images')`, so `viewer`/blank roles cannot use
  it.
- It correctly avoids the public `/api/images/:id` refcount gate for the intended
  admin preview case: active but unpublished/refCount-0 storage images can be
  previewed without weakening public delivery.
- The design handoff now tells U2b-b to stop using public image URLs for admin
  previews and to restore local-server parity with the production public route.

Finding:

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P2 | `getImagePreview` bypasses the storage-backed row contract and the upload verification lifecycle. Any readable `images` row with a string `storageFileId` is proxied, regardless of `storageProvider`, `storagePath`, or `status`, and with no size/checksum guard. That means a rejected `failed` upload whose best-effort delete did not remove bytes, a `deleted` row, an unknown-provider/corrupt row, or a pending object that has not passed `completeUpload` validation can still be served through the admin preview endpoint. Because the upload credential is explicitly unbounded until `completeUpload` re-checks real bytes, this also lets a contributor/admin force the admin function to download and JSON-base64 return oversized unverified objects. | `apps/functions/admin/src/handler.ts` `getImagePreviewAction` returns `mediaStorage().getObjectAsBase64(doc.storageFileId)` for any string `storageFileId`. `completeUploadAction` only marks size/checksum failures as `failed` after downloading and validating the object; delete is best-effort. The shared contract already requires recognized provider + storage path + lifecycle fields via `StorageBackedImageMetadataDoc` / `isStorageBackedImage()`, and the public route recently failed closed for unknown providers. Current tests cover legacy, active refCount-0, pending, viewer forbidden, missing object, but not failed/deleted/unknown-provider/oversized-pending rows. | In the storage preview branch, first narrow to the recognized storage-backed contract (or equivalent explicit provider/path checks), and refuse `failed`/`deleted` rows. Prefer serving only `active` storage rows through this server endpoint; for pre-activation UI previews, use `URL.createObjectURL(file)` client-side. If pending server preview remains a requirement, reapply the real-object size cap and declared checksum guard before returning bytes, and add tests for failed, deleted, unknown provider, and oversized/unverified pending objects. |

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (55 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm exec biome check apps/functions/admin/src/handler.ts apps/functions/admin/src/handler.test.ts docs/IMAGE_UPLOAD_STORAGE_DESIGN.md docs/IMAGE_UPLOAD_EXECUTION.md` - pass for the two TypeScript files; Markdown paths are ignored by this repo's Biome config
- `pnpm build:functions` - pass

Disposition: U2b-a is not accepted yet. Fix the preview storage-branch lifecycle
guard above, then continue U2b-b (`ImageManager` wiring, per-file state/retry,
jpeg/png/webp accept, and local-server public-route parity). MIU-05 remains **not
done** until U2b-a and U2b-b both land and review cleanly.

### Codex U2b-a Review — disposition (P2 fixed)

Valid (accept). `getImagePreview`'s storage branch served ANY row with a string
`storageFileId` — so a `failed`/`deleted`/unknown-provider row, or a `pending`
(unverified, possibly-oversized) object whose bytes never passed `completeUpload`,
could be downloaded + base64-returned through the admin function.

Fix: the storage branch now serves only a **recognized provider**
(`cloudbase-storage`/`local-disk`) with **`status === 'active'`** — active rows
have passed completeUpload's size/checksum verification, so the endpoint cannot
fetch unverified/oversized, rejected, or corrupt objects. Pre-activation (pending)
previews are the client's job (`URL.createObjectURL` on the just-uploaded File).
Legacy `data` rows are unaffected. Tests: the prior "serves pending" case is
replaced by a refusal test asserting pending/failed/deleted/unknown-provider all
404 (with FETCHABLE bytes, so the 404 proves a status/provider gate, not a fetch
miss). §20.7 preview note aligned. admin 55; fn-admin tsc + biome clean; builds.

### Codex MIU-05 U2b-a Re-Review - 2026-06-30 after `490459d`

Review base: `490459da5a93232332d37d6246e27e456b06e3a6`, diffed against
previous processed head `4c5f247e86f3825a3e9a7dd4637a62d32dc76d7f`.

Verdict: no blocking findings in the new implementation delta. The preview
storage branch now fail-closes unless the row has a recognized storage provider
and `status === 'active'`; the replacement test proves pending, failed, deleted,
and unknown-provider rows are refused even when their bytes are fetchable. This
resolves the prior P2 for U2b-a. Legacy inline previews and active unpublished
storage previews remain covered.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (55 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm --filter @vibelingan-channel/fn-admin build` - pass
- `pnpm exec biome check apps/functions/admin/src/handler.ts apps/functions/admin/src/handler.test.ts docs/IMAGE_UPLOAD_STORAGE_DESIGN.md docs/IMAGE_UPLOAD_EXECUTION.md` - pass for the two TypeScript files; Markdown paths are ignored by this repo's Biome config

Disposition: U2b-a is accepted. MIU-05 remains **not done** until U2b-b lands and
reviews cleanly (`ImageManager` wiring to admin preview + object URLs, per-file
state/retry, jpeg/png/webp accept-list, and local-server public-route parity).

### MIU-05 (U2) — admin uploader UI, phase U2b-b (feature-complete)

The remaining MIU-05 work; lands the three interdependent pieces together so local
preview never breaks in between:

- `api.ts`: `getImagePreview(id)` client → calls the admin action, returns a
  `data:` URL.
- `ImageManager.tsx` (rewrite): **per-file** upload state — each file shows
  uploading / failed-retry; a success is committed to `value` **cumulatively**
  (`[...baseValue, ...added]`) so a later rejection cannot drop earlier successes.
  `accept` restricted to jpeg/png/webp (matches the server allowlist). Previews use
  a local **object URL** for the just-uploaded session (instant, no round-trip) and
  `getImagePreview` for persisted ids (admin-auth, bypasses the public refCount
  gate). No CloudBase Web SDK.
- `local-server` `/api/images/:id`: storage delivery now requires recognized
  provider + `active` + `publishedRefCount > 0` (mirrors `getCatalogImage`) so local
  dev no longer masks the production public gate — closing the Codex masking note.
  (Inline mirror rather than importing `getCatalogImage`, to avoid adding an
  `fn-public-api` dep + pnpm install; behavior matches.)
- Verify: root tsc clean; `astro check` 0 errors; biome clean. The browser→COS PUT
  + bucket CORS are exercised at MIU-09; the React UI has no unit harness here, so
  end-to-end upload is a deployed/e2e check.

**MIU-05 is feature-complete** (U2a + U2b-a + U2b-b) pending the Codex U2b-b review.

### Codex MIU-05 U2b-b Review - 2026-06-30 after `6290326`

Review base: `62903269b9fdb959cf355d66e5bcbbf83cb85515`, diffed against the
previous processed head `31a355e92c38b0c8808c3e7422f0df56e5c9e1e1`.

What is sound:

- The client upload helper still follows the intended small-JSON intent → raw
  storage `PUT` → small-JSON complete flow; no base64 or multipart bytes go
  through `/api/admin`.
- `ImageManager` now uses `getImagePreview` for persisted admin previews and
  object URLs for just-uploaded files, and the picker is restricted to the server
  allowlist (`jpeg`/`png`/`webp`).
- The public/admin preview split remains intact: production public delivery stays
  `publishedRefCount`-gated, while admin preview uses the authenticated action.

Findings:

| Severity | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| P2 | `ImageManager` can overwrite concurrent image-list edits when an upload finishes. The new per-file loop captures `baseValue = value` once at file-selection time and each success calls `onChange([...baseValue, ...added])`. A COS upload can take long enough for an admin to remove/reorder existing images or for the parent form value to change; the later success then resurrects removed ids or discards the newer order. This is the same class of "late async write wins over user edits" data-loss bug the per-file state was meant to avoid. | `apps/site/src/islands/admin/ImageManager.tsx` lines 68-80 (`baseValue`, `added`, `succeed(... [...baseValue, ...added])`) and `RecordForm.tsx` passes only the concrete next array, not a functional updater. | Commit successes against the latest image list, not the render-time snapshot. For example, track latest `value` in a ref and append a successful id to that current list, preserving upload order without replaying stale base ids. Add a component/e2e regression for remove/reorder while a slow upload is pending. |
| P2 | The local-server public image route still does not mirror `getCatalogImage` for legacy/base64 rows, despite the U2b-b parity claim. It now gates storage-backed rows by recognized provider + `active` + positive numeric `publishedRefCount`, but any row with `doc.data` is returned immediately. Production public delivery hides legacy rows with a present `publishedRefCount: 0`, numeric-string/corrupt counters, or no published catalog reference (except the explicit placeholder / pre-backfill scan fallback). Local dev can therefore still show an unlinked or hidden legacy image that production would 404. | `apps/local-server/src/main.ts` lines 97-111 serve all legacy `doc.data`; production `apps/functions/public-api/src/handler.ts` uses `hasRefCountField`, strict numeric `visibleByRefCount`, placeholder special-case, and catalog-scan fallback only when the field is absent. Design §20.7 said local-server must mirror production by delegating `/api/images/:id` to `getCatalogImage`. | Reuse the public route logic or duplicate the full legacy semantics: placeholder by id, strict numeric refCount when present, fallback scan only when absent, and fail-closed for malformed present counters. Add a local-server route test or otherwise share the production helper so this parity cannot drift again. |
| P3 | Just-uploaded preview object URLs are never revoked. Each successful upload calls `URL.createObjectURL(file)` and stores the URL in component state, but removal/unmount does not call `URL.revokeObjectURL`. In a long admin session with large product images, this leaks browser memory until page teardown. | `apps/site/src/islands/admin/ImageManager.tsx` line 63 creates object URLs; there is no cleanup effect or revoke call when an image id is removed or the component unmounts. | Track created object URLs and revoke them when their image id leaves `value` and during unmount. Keep fetched `data:` previews unaffected. |

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/site typecheck` - pass (`astro check`, 0 errors; existing FormEvent deprecation hints only)
- `pnpm --filter @vibelingan-channel/site build` - pass
- `pnpm --filter @vibelingan-channel/local-server typecheck` - pass
- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (55 tests)
- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (20 tests)
- `pnpm typecheck` - pass across packages/apps + e2e
- `pnpm exec biome check apps/site/src/islands/admin/ImageManager.tsx apps/site/src/islands/admin/api.ts apps/local-server/src/main.ts docs/IMAGE_UPLOAD_EXECUTION.md docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` - pass for the three non-ignored implementation files; Markdown docs are ignored by this repo's Biome config

Disposition: U2b-b is not accepted yet. MIU-05 remains **not done** until the
stale UI commit path and local-server legacy parity are fixed and re-reviewed;
the object-URL cleanup should be handled in the same UI pass.

### Codex U2b-b Review — disposition (2 P2 + P3, all fixed)

- **P2 (stale UI value commit).** `ImageManager` committed `[...baseValue, ...added]`
  from the render-time snapshot, so a slow upload could clobber a concurrent
  remove/reorder. Now a `valueRef` tracks the latest committed list and every
  mutation goes through `commit()`; a success appends to `valueRef.current`
  (order preserved, concurrent edits respected).
- **P2 (local-server legacy parity).** The inline mirror gated only storage rows;
  legacy `data` rows were served unconditionally. Replaced the route with a direct
  **delegation to `getCatalogImage`** (added `@vibelingan-channel/fn-public-api` as
  a local-server dep) — local dev now shares the exact production gate (legacy
  strict-refCount / scan-fallback / placeholder / fail-closed), so parity can't
  drift again.
- **P3 (object-URL leak).** Object URLs are now revoked when their id leaves
  `value` and all are revoked on unmount.
- Verify: per-package `tsc` (incl. local-server) + `astro check` (0 errors) +
  biome clean; `pnpm-lock.yaml` updated for the new dep. UI has no unit harness
  here — end-to-end upload is the deployed/e2e check (MIU-09).

### Codex MIU-05 Final Review - 2026-06-30 after `f2063de3`

Review base: `f2063de369c635aab7341e144cc3c01b60323975`, diffed against the
previous processed head `73bde9b7f94fa9a9fbf3051262205afc37970ad7`.

Verdict: no blocking findings in the new implementation delta. The prior stale
UI commit path is fixed by appending successful uploads against `valueRef.current`
and routing local mutations through `commit()`. The object URL cleanup now revokes
removed ids and unmount leftovers. The local public image route now imports the
production `getCatalogImage` helper subpath, so it shares the strict legacy
refCount / fallback-scan / placeholder / storage-provider fail-closed behavior
without importing the production CloudBase entrypoint.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/local-server typecheck` - pass
- `pnpm --filter @vibelingan-channel/site typecheck` - pass (`astro check`, 0 errors; existing FormEvent deprecation hints only)
- `pnpm --filter @vibelingan-channel/site build` - pass
- `pnpm --filter @vibelingan-channel/fn-public-api test` - pass (20 tests)
- `pnpm exec biome check apps/site/src/islands/admin/ImageManager.tsx apps/local-server/src/main.ts apps/local-server/package.json pnpm-lock.yaml` - pass
- Local runtime smoke with throwaway DB: `PORT=3999 LOCAL_DB_FILE=/tmp/channel-review-db-f2063.json LOCAL_MEDIA_DIR=/tmp/channel-review-media-f2063 pnpm --filter @vibelingan-channel/local-server start`; `GET /api/health` returned 200, `GET /api/images/_placeholder` returned 200 `image/svg+xml`, and `GET /api/images/not-linked` returned 404.

Disposition: MIU-05 is accepted as done. Remaining live browser→COS PUT, bucket
CORS, and deployment smoke stay assigned to MIU-09 as planned.

---

## MIU-09 — Deploy, Browser-Origin Upload Smoke, Review Hardening

### Codex implementation pass — 2026-06-30

Scope implemented:

- Added `tests/e2e/media-upload.spec.ts`, a deployed smoke that runs from the
  configured site origin in a real Chromium page. It intentionally performs the
  storage `PUT` from browser JS instead of Node so bucket CORS/preflight failures
  are caught by the browser.
- The smoke flow:
  1. browser-origin admin `login`;
  2. browser-origin `createUploadIntent`;
  3. browser-origin raw COS `PUT` using the server-minted `Authorization`,
     `X-Cos-Security-Token`, and `X-Cos-Meta-Fileid` headers;
  4. browser-origin `completeUpload`;
  5. browser-origin `getImagePreview` for an unpublished active image;
  6. browser-origin public `/api/images/:id` returns `404` before catalog link;
  7. browser-origin admin creates a published product with that image;
  8. browser-origin public `/api/images/:id` becomes `200 image/png`.
- Cleanup removes the temporary product and image metadata. The underlying
  storage object may remain until MIU-06 orphan cleanup, which is acceptable for
  the test env and is visible by the `e2e-`/`miu09` naming convention.
- Wired `pnpm test:e2e:media-upload`.
- Added the manual E2E suite option `media-upload`.
- Added `Deploy Test` workflow input `run_media_upload_smoke`; when true, the
  workflow installs Chromium if needed and runs the smoke with
  `E2E_MEDIA_UPLOAD_SMOKE=1`, `E2E_ADMIN_EMAIL`, and `E2E_ADMIN_PASSWORD`.

Run contract:

```bash
E2E_MEDIA_UPLOAD_SMOKE=1 \
E2E_SITE_URL=https://channel-test-<env>.webapps.tcloudbase.com \
E2E_API_URL=https://<env>.service.tcloudbase.com \
E2E_ADMIN_EMAIL=<admin email> \
E2E_ADMIN_PASSWORD=<admin password> \
pnpm test:e2e:media-upload
```

GitHub Actions contract:

- Dispatch `Deploy Test` with `run_media_upload_smoke=true` after CloudBase test
  secrets include `E2E_ADMIN_PASSWORD`.
- Or dispatch `E2E` with suite `media-upload` against an already-deployed build.

Review status:

- Not yet accepted as MIU-09 done. Claude should first review this harness and
  workflow wiring.
- MIU-09 can be marked done only after a deployed run records the actual CloudBase
  test evidence: deployed URLs, workflow/run id or local command, browser-origin
  COS PUT success, admin preview success, public 404-before-link, and public
  200-after-published-link.

### Live deploy-smoke attempt — blocked by GitHub Environment policy

Codex attempted to dispatch `Deploy Test` on this branch after pushing the
implementation:

- Workflow run: `28422392812`
- Ref/SHA: `fix/image-upload-storage-design` /
  `92d8a1d7704a2b82b58bfb7fa0bbf209250d8e32`
- Inputs: `run_public_e2e=true`, `run_media_upload_smoke=true`
- Result: failed before any job step ran.
- GitHub annotation: branch `fix/image-upload-storage-design` is not allowed to
  deploy to the `test` environment due to environment protection rules; the
  deployment was rejected.

Disposition: this is an environment-policy gate, not an upload implementation
failure. The next live-evidence path is one of:

1. run the same workflow from an allowed deploy branch after Claude review; or
2. temporarily allow this feature branch to deploy to the `test` environment; or
3. run `pnpm test:e2e:media-upload` locally against an already-deployed build
   with `E2E_MEDIA_UPLOAD_SMOKE=1`, deployed URLs, and admin credentials.

Until one of those paths records a successful browser-origin upload, MIU-09
remains implemented-but-not-accepted.

### Claude review — MIU-09 smoke harness (round 1) — 2026-06-30

Reviewed commit `92d8a1d` (test-only). Method: deterministic gates + a
3-dimension adversarial review (contract parity / test quality / CI wiring) with
each finding verified against the actual code. (The adversarial workflow hit a
provider session limit mid-run after the CI-wiring dimension; the reviewer
completed the contract-parity and test-quality dimensions by hand and verified
both surviving CI findings directly against the code — see below.)

**Deterministic gates — PASS**

- `pnpm typecheck:e2e` (tsconfig.e2e.json) → exit 0
- `npx biome check tests/e2e/media-upload.spec.ts tests/e2e/helpers/env.ts` → exit 0
- `npx playwright test tests/e2e/media-upload.spec.ts --list` → registers exactly 1 test

**Contract parity — PASS (no mismatch)**

Every shape the spec assumes matches the real server/client contract:

- `createUploadIntent` → `{ imageId, uploadIntentId, storageFileId, upload: { url,
  headers: { Authorization, X-Cos-Security-Token, X-Cos-Meta-Fileid } } }`
  (`handler.ts:807-820`) ✔
- `completeUpload({ imageId })` ✔; `getImagePreview` → `{ id, mimeType, dataBase64 }`
  (`handler.ts:916-950`) ✔
- public `/api/images/:id`: `404` unpublished → `200 image/png` once published
  (public-api `getCatalogImage`) ✔
- the browser-PUT header names match the server-minted headers exactly; the
  `login` response `{ token, user: { role } }` it destructures is correct ✔

**Findings**

P2 — the `media-upload` smoke reports **GREEN having executed nothing** when
`secrets.E2E_ADMIN_PASSWORD` is unset in the `test` environment (both workflows).

- `tests/e2e/media-upload.spec.ts:134-137` self-skips via
  `test.skip(!e2e.mediaUploadSmoke || !hasAdminCredentials())`, and
  `hasAdminCredentials()` (`helpers/env.ts:28-30`) returns false when
  `E2E_ADMIN_PASSWORD` is empty. A fully-skipped Playwright run exits `0`, so the
  job is green. Neither `deploy-test.yml:119-125` nor `e2e.yml:76-78` asserts the
  secret is present before running. Because this smoke **is** MIU-09's acceptance
  evidence, a silent skip = false acceptance.
- (The adversarial reviewer proposed P1; the lead adjusted to **P2** — it needs a
  missing-secret misconfiguration to trigger and touches no production code, but
  the impact when it bites is high and the fix is cheap.)
- Fix: add a fail-fast guard before the run step (do **not** echo the value),
  in both `deploy-test.yml` (the smoke step) and `e2e.yml` (the `media-upload)`
  case):

  ```bash
  if [ -z "$E2E_ADMIN_PASSWORD" ]; then
    echo "E2E_ADMIN_PASSWORD secret is not set for the test environment" >&2
    exit 1
  fi
  ```

  The opt-in, default-off gating itself is correct — only the unguarded secret is
  the gap. (A spec-level alternative: when `E2E_MEDIA_UPLOAD_SMOKE=1` is set
  explicitly but creds are absent, `throw` instead of `test.skip`.)

P3 — the public-delivery `expect.poll(...).toBe(true)`
(`media-upload.spec.ts:218-228`) uses the 10s global expect timeout
(`playwright.config.ts:16`) with no explicit override. Against eventual
consistency (completeUpload → publish → public refCount propagation + a cold COS
fetch) 10s may flake. Recommend an explicit generous timeout, e.g.
`expect.poll(async () => …, { timeout: 30_000 }).toBe(true)`.

P3 (optional, belt-and-suspenders) — CI does not assert that ≥1 test actually
ran (skip is indistinguishable from pass). The P2 secret guard closes this for
the media-upload spec; a global "expected > 0 && skipped == 0" reporter check is
a nice-to-have but out of scope for this change.

**Test-quality notes (accepted, no change needed)**

- Cleanup runs in `finally` via the `request` fixture; `productId`/`imageId` are
  each guarded before the remove call, so no metadata leaks on a partial failure.
  The underlying COS object is intentionally left for MIU-06 orphan cleanup
  (documented; acceptable for the test env; the `e2e-…`/`miu09` naming makes it
  identifiable).
- The test briefly publishes a product on the test storefront and then removes
  it — acceptable blast radius for a dedicated `test` env.
- `mode: 'serial'` with a single test is fine.

**Disposition**

- The harness is correct and well-built; contract parity holds and the
  deterministic gates pass. One **P2** to fix (the secret fail-fast guard) before
  the smoke can be trusted as acceptance evidence, plus two **P3**s (explicit poll
  timeout; optional "a test actually ran" assertion).
- Separate, non-code blocker (Codex `8e72116`): the live deploy-smoke is blocked
  by GitHub Environment protection (this feature branch is not allowed to deploy
  to `test`). MIU-09 stays **implemented-but-not-accepted** until a live run
  records the browser→COS PUT + bucket-CORS evidence via one of the three unblock
  paths Codex listed — and that choice is a deploy-policy decision for the
  maintainer, not a code fix.
- Handing back to Codex: apply the **P2** guard (and ideally the **P3** poll
  timeout). The live-evidence unblock is gated on the maintainer's deploy-policy
  decision.

### Codex response to Claude MIU-09 review — 2026-06-30

Addressed in code:

- **P2 fixed.** The media-upload smoke no longer reports green while executing
  nothing when it is explicitly enabled but admin credentials are missing:
  - `tests/e2e/media-upload.spec.ts` now skips only when
    `E2E_MEDIA_UPLOAD_SMOKE` is not enabled. If enabled without
    `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD`, the test throws a clear error.
  - `.github/workflows/deploy-test.yml` fail-fast guards the media smoke step
    before running Playwright.
  - `.github/workflows/e2e.yml` fail-fast guards the `media-upload` suite case
    before running Playwright.
- **P3 fixed.** The public-delivery poll now uses an explicit `30_000 ms`
  timeout for CloudBase/COS/refCount propagation instead of relying on the global
  10s expectation timeout.
- **P3 optional left as future CI hardening.** A global "at least one test ran /
  zero skipped" reporter gate is not required for this media smoke after the
  explicit secret guard, but remains a useful broader E2E-hardening idea.

Verification run by Codex:

- `pnpm typecheck:e2e` - pass
- `pnpm exec biome check tests/e2e/media-upload.spec.ts tests/e2e/helpers/env.ts .github/workflows/e2e.yml .github/workflows/deploy-test.yml docs/IMAGE_UPLOAD_EXECUTION.md` - pass for the TypeScript/YAML files; Markdown docs are ignored by this repo's Biome config
- `pnpm test:e2e --list` - pass; media-upload spec registers exactly one test
- `pnpm test:e2e:media-upload` with default env - pass by skipping because the
  smoke is not enabled

Disposition: Claude's actionable harness findings are resolved. MIU-09 remains
implemented-but-not-accepted solely because live browser-origin evidence is still
blocked by the GitHub `test` environment branch policy (or by the maintainer
choosing an alternate allowed live-run path).

### Claude review — MIU-09 smoke harness (round 2, fix verification) — 2026-06-30

Reviewed commit `6f304df` against the round-1 findings. **All resolved.**

- **P2 (false-green on missing secret) — RESOLVED, verified empirically.** Codex
  applied defense-in-depth: the spec now `throw`s when the smoke is enabled but
  `hasAdminCredentials()` is false, and *both* workflows fail-fast guard
  `E2E_ADMIN_PASSWORD` before invoking Playwright. Proof:
  - `E2E_MEDIA_UPLOAD_SMOKE=1` with empty creds → `1 failed` (the throw fires) —
    the dangerous silent-skip path is now a loud red. ✔
  - default env (flag unset) → `1 skipped` cleanly, no creds required. ✔
  - The workflow guard keys on `E2E_ADMIN_PASSWORD`; email always defaults to a
    non-empty value, and the spec-level throw covers both fields and the local
    path too — combined coverage is complete.
- **P3 (poll timeout) — RESOLVED.** The public-delivery poll now passes
  `{ timeout: 30_000 }` instead of relying on the 10s global expect timeout.
- **P3 optional (ran-assert) — appropriately deferred.** With the secret guard +
  spec throw, the skip-as-green path is closed for this spec; a global
  "expected > 0 && skipped == 0" reporter gate stays a future broad-E2E idea.

Independent verification (this reviewer, not trusting Codex's claims):

- `pnpm typecheck:e2e` → exit 0
- `npx biome check tests/e2e/media-upload.spec.ts tests/e2e/helpers/env.ts` → exit 0
- `playwright --list` (flag on) → exactly 1 test; default env → `1 skipped`;
  flag-on + no-creds → `1 failed` (loud).

**Disposition — harness ACCEPTED (no remaining P1/P2/P3).** The MIU-09 test
harness and CI wiring are review-clean and there is no further code for Codex to
write or fix here. MIU-09 acceptance now hinges solely on a **live deployed run**
recording the browser→COS PUT + bucket-CORS evidence, which is gated on the
maintainer's deploy-policy decision (one of: deploy from an allowed branch;
temporarily allow this branch into the `test` environment; or run
`pnpm test:e2e:media-upload` locally against an already-deployed build with creds
+ `E2E_MEDIA_UPLOAD_SMOKE=1`). That is not a code task — the reversed
review→fix loop has converged.

### Live deploy-smoke attempt after harness acceptance — still policy-blocked

After Claude accepted the harness, another `Deploy Test` workflow was dispatched:

- Workflow run: `28424882618`
- Ref/SHA: `fix/image-upload-storage-design` /
  `dc956615b4a82d5b11140538a93c69e11e07d276`
- Result: failed before any job step ran.
- GitHub annotation: branch `fix/image-upload-storage-design` is not allowed to
  deploy to the `test` environment due to environment protection rules; the
  deployment was rejected.

Disposition: same blocker as the earlier `92d8a1d` attempt, now confirmed at the
review-clean harness head. No code change is indicated. MIU-09 still needs an
allowed live-run path to collect browser-origin COS PUT / CORS evidence.

### Live deploy-smoke attempt after environment gate opened — CloudBase activation timeout

A later `Deploy Test` workflow run used the accepted harness head and reached the
actual runner/deploy step:

- Workflow run: `28427449894`
- Ref/SHA: `fix/image-upload-storage-design` /
  `09b128f72a14e20d18808c90c28673b757795850`
- Inputs: `run_media_upload_smoke=true`
- Result: failed in `Deploy to CloudBase test`; all prior CI steps passed:
  checkout, install, lint, typecheck, function packaging, artifact smoke, site
  build, and public-secret scan.
- Failure line:
  `Error: admin did not become active.`
- Script location:
  `scripts/deploy-cloudbase-test.mjs` `waitForActive("admin")`
- CloudBase target:
  env `diversity-123-d9grnqfux221323bb`, runtime `Nodejs20.19`

Disposition: this is no longer the GitHub Environment branch-policy blocker.
The deploy proceeded far enough to update/query CloudBase, then timed out waiting
for the `admin` Event Function to report `Status: Active` or
`AvailableStatus: Available`. The first corrective action is deploy-script
hardening, not upload-flow code:

- increase the activation wait from 90 seconds to 300 seconds by default;
- make the timeout and poll interval configurable via
  `CLOUDBASE_FUNCTION_ACTIVE_TIMEOUT_MS` and
  `CLOUDBASE_FUNCTION_POLL_INTERVAL_MS`;
- log periodic function state while waiting;
- include the last observed CloudBase status/runtime/reason in the thrown error.

MIU-09 remains implemented-but-not-accepted until a rerun gets past deploy and
records the browser-origin COS PUT / CORS evidence from the media-upload smoke.

### Claude review — deploy hardening (67f2176) + true root cause found — 2026-06-30

**Codex fix `67f2176` reviewed: APPROVED.** The change raises `waitForActive`
from 90s to a configurable 300s, adds a poll-interval env, logs the live function
state every 30s, and embeds the last observed state in the thrown error.
`node --check` + `biome` clean. This is a strict improvement — and its new state
logging is exactly what surfaced the real root cause below. The longer wait is
not itself the fix, but the change is correct and worth keeping.

**TRUE ROOT CAUSE (from the hardened run `28428297514`): expired CloudBase
credentials in CI — not a code or timeout problem.** With state logging on, every
poll for 300s returned the same auth error, and it was the *sole* failure mode:

```
admin: waiting for active state; query failed:
  [DescribeEnvInfo] Token verification failed. Please check your Token is correct.
```

- The `test` environment's `TENCENTCLOUD_*` secrets are invalid/expired. The
  presence of `TENCENTCLOUD_SESSIONTOKEN` means these are **temporary STS
  credentials**, which are short-lived; the 2026-06-25 deploy succeeded because
  they were fresh then. Five days later they are expired, so `cloudbase.auth` /
  `getFunctionDetail` / `updateFunctionCode` all fail token verification.
- This explains every earlier symptom: `admin`/`public-api` `ModTime` stuck at
  `2026-06-25` (the code update never authenticated), and `waitForActive`
  timing out (status queries could never authenticate). The MIU upload code and
  the smoke harness are NOT implicated — local CloudBase MCP queries with valid
  creds work fine.

**Action required — maintainer/admin (NOT a code fix):** refresh the `test`
GitHub Environment secrets `TENCENTCLOUD_SECRETID`, `TENCENTCLOUD_SECRETKEY`,
`TENCENTCLOUD_SESSIONTOKEN` with current values — or, more robustly for CI,
switch to a **permanent** SecretId/SecretKey (no SessionToken) so deploys do not
expire between runs. Then re-dispatch `Deploy Test`.

**Follow-up finding for Codex (P2, deploy-script robustness):** `waitForActive`
treats an *authentication* failure (`Token verification failed`) from
`functionDetailResult` as a transient "not active yet" and polls for the full
timeout (5 wasted minutes + a misleading "did not become active" framing). It
should detect auth/token errors and **abort immediately** with a clear
"CloudBase credentials invalid or expired" message. That would have made the
root cause obvious on the very first run instead of after three.

Disposition: deploy hardening accepted; MIU-09 still implemented-but-not-accepted,
now blocked on refreshing the CloudBase CI credentials (maintainer action), after
which the media-upload smoke can finally record live browser→COS evidence.

### Codex response — deploy credential fail-fast (P2) — 2026-06-30

Claude's P2 is accepted. `waitForActive` should not spend the full activation
timeout polling when CloudBase returns a credential/auth failure. That class of
error is not eventual consistency; it is an operator/secret issue.

Implemented in `scripts/deploy-cloudbase-test.mjs`:

- Added `isCredentialFailure(...)` for CloudBase token/auth/unauthorized messages.
- `functionDetailResult(...)` now aborts immediately on credential failures even
  when the caller allowed ordinary lookup failure, preserving retry behavior for
  real "function not ready / not found yet" states.
- The next bad-token run should fail with:
  `CloudBase credentials are invalid or expired while querying admin: ...`
  instead of the misleading activation-timeout framing.

Validation:

- `node --check scripts/deploy-cloudbase-test.mjs`
- `pnpm exec biome check scripts/deploy-cloudbase-test.mjs`
- `git diff --check`

Disposition: P2 fixed. MIU-09 remains live-evidence blocked on refreshing/removing
the stale CI `TENCENTCLOUD_SESSIONTOKEN` path or replacing it with deploy-scoped
permanent CAM credentials, then rerunning `Deploy Test` with
`run_media_upload_smoke=true`.

### Claude review — fail-fast on auth errors (c3a8024) — 2026-06-30

**APPROVED — the P2 follow-up is correctly resolved.** `isCredentialFailure()`
matches the observed `[DescribeEnvInfo] Token verification failed` (verified) plus
`authfailure`/`unauthorized`/`invalid|expired token|credential`; `functionDetailResult`
now throws immediately on a credential failure, overriding `allowFailure`. Because
`deployFunction` opens with `functionDetail(name, true)` existence checks, a
bad-creds deploy now aborts in seconds at the first query with a clear "credentials
invalid or expired" message — instead of the previous 5-minute misleading
"did not become active" poll. Scoped correctly: only fires on `success === false`
*and* a credential-pattern message, so genuine "not found"/transient states still
flow normally. `node --check` + `biome` clean.

Deploy-script robustness is now fully addressed (wait hardening + state logging +
auth fail-fast). The remaining blocker is unchanged and non-code: the CI CloudBase
credentials must be refreshed (permanent CAM SecretId/SecretKey, drop the stale
SessionToken). Once that lands, `Deploy Test` with `run_media_upload_smoke=true`
should reach the smoke and record the live browser→COS evidence.

### Codex CI credential report + workflow hardening — 2026-06-30

Question answered: why did CI/deploy pass before, but fail now?

Evidence:

- GitHub Environment `test` secret metadata shows all Tencent credentials were
  created on `2026-06-25T09:02Z` and have not been updated:
  `TENCENTCLOUD_SECRETID`, `TENCENTCLOUD_SECRETKEY`,
  `TENCENTCLOUD_SESSIONTOKEN`.
- The successful `Deploy Test` run `28160182821` started at
  `2026-06-25T09:21:48Z`, about 19 minutes after those secrets were created.
  Its logs show `TENCENTCLOUD_SESSIONTOKEN` was present and the deploy succeeded:
  `admin` and `public-api` updated on `Nodejs20.19`, then deploy smoke and public
  browser E2E passed.
- The failed hardened run `28428297514` on `2026-06-30T07:38Z` used the same
  unchanged secret set, but every CloudBase detail poll returned:
  `[DescribeEnvInfo] Token verification failed. Please check your Token is correct.`
- Ordinary `CI` runs passed because `.github/workflows/ci.yml` does not deploy
  CloudBase and does not consume the Tencent credentials. `Deploy Test` is the
  workflow that exercises CloudBase auth.

Conclusion: the earlier deploy worked because the temporary STS credential set
was fresh. It now fails because the unchanged `TENCENTCLOUD_SESSIONTOKEN` path is
expired. This is not an MIU upload-code failure.

Workflow fix applied:

- Removed `TENCENTCLOUD_SESSIONTOKEN` from `.github/workflows/deploy-test.yml`.
  The durable path is now permanent CAM `TENCENTCLOUD_SECRETID` +
  `TENCENTCLOUD_SECRETKEY` only; a stale session-token secret can no longer poison
  this workflow after permanent keys are installed.
- Added a deploy credential guard before `pnpm deploy:cloudbase:test` so missing
  SecretId/SecretKey fails clearly before CloudBase calls.

Remaining maintainer action:

1. In Tencent CAM, create or reuse a deploy-only sub-user/API key with the minimum
   CloudBase/SCF/hosting/gateway permissions needed by `scripts/deploy-cloudbase-test.mjs`.
2. In GitHub Environment `test`, replace `TENCENTCLOUD_SECRETID` and
   `TENCENTCLOUD_SECRETKEY` with that permanent deploy key.
3. Delete the old `TENCENTCLOUD_SESSIONTOKEN` environment secret as cleanup.
4. Rerun `Deploy Test` with `run_media_upload_smoke=true`.

### Codex CAM setup helper — 2026-06-30

Clarification on what Codex can and cannot safely do:

- Codex should **not** mint or print a permanent Tencent CAM SecretKey through
  the chat/tool transcript. SecretKey material is live credential material and
  must not be routed through logs or docs.
- The CloudBase MCP/device-login path is useful for management inspection, but it
  produced temporary STS-style credentials for CI. Those expire and caused the
  current deploy failure.
- The safe durable path is still maintainer-created permanent CAM
  SecretId/SecretKey, written directly into GitHub Environment `test` without
  being pasted into chat.

Repo helper added:

```bash
pnpm secrets:cloudbase:test
```

Behavior:

- prompts locally for permanent `TENCENTCLOUD_SECRETID` and
  `TENCENTCLOUD_SECRETKEY` without echoing them;
- writes them directly to GitHub Environment `test` via `gh secret set`;
- deletes stale `TENCENTCLOUD_SESSIONTOKEN` from the same environment.

After that helper succeeds, rerun `Deploy Test` with
`run_media_upload_smoke=true` to collect MIU-09 live browser→COS evidence.

### Claude review — permanent-credential enforcement (8d4e998) + secret helper (47d7497) — 2026-06-30

**Both APPROVED.**

`8d4e998` (ci): drops the `TENCENTCLOUD_SESSIONTOKEN` mapping from the deploy job
env (so the Tencent SDK uses permanent SecretId/SecretKey auth instead of a stale
session token) and adds a fail-fast "Verify CloudBase deploy credentials" step
that aborts if either key is empty. Workflow YAML validated (Ruby `Psych`); the
only remaining `SESSIONTOKEN` mentions are in the built-site secret-leak scanner
allowlist (correct to keep). Combined with the runtime auth fail-fast (c3a8024),
a misconfigured-credential deploy now fails in seconds with a clear message.

`47d7497` (chore): `scripts/set-cloudbase-github-secrets.mjs` (+ `pnpm
secrets:cloudbase:test`). Securely sets the permanent creds — prompts with hidden
input, pipes values to `gh secret set` via **stdin** (never on the command line
or in logs), refuses empty input, warns against pasting STS/SessionToken, and
deletes the stale `TENCENTCLOUD_SESSIONTOKEN` secret (treats already-absent as
success). `node --check` + `biome` clean. Usage caveat: `gh secret set --env test`
needs an admin-scoped token, so run it as `GH_TOKEN=<admin-pat> pnpm
secrets:cloudbase:test` (the default `orocsy` login lacks repo-admin).

Disposition: the deploy/credentials toolchain is now complete and review-clean.
MIU-09's only remaining step is operational: create a permanent CAM key
(SecretId/SecretKey, CloudBase/SCF scope), run `pnpm secrets:cloudbase:test`
(or set the two secrets in the GitHub UI), then rerun `Deploy Test` with
`run_media_upload_smoke=true` — which should finally reach the smoke and record
the live browser→COS PUT + bucket-CORS evidence. The maintainer has chosen this
permanent-key path.

**Follow-up `ad0aec9` (secret-helper UX) — APPROVED.** `askHidden` now unmutes
before `rl.question(query)` so the prompt label renders, then re-mutes so only the
typed value is masked (previously the prompt itself collapsed to a single `*`).
Correct; `node --check` + `biome` clean. No behavioral change to what gets stored.

### Claude review — first full live run; deploy silently ships STALE code (P1) — 2026-06-30

With permanent CAM creds set, `Deploy Test` run `28431709752` (SHA `bdf745d`) finally
got past the credential gate: verify-creds ✅, **Deploy to CloudBase ✅**,
smoke-functions ✅, public-e2e ✅, then the media-upload smoke **ran** and failed.
(Note: my earlier "new bundle fails to provision on cold start" hypothesis was
**wrong** — it was the expired credentials all along; the functions provision fine.)

**Smoke failure — real finding:** `createUploadIntent failed: Unknown action:
createUploadIntent`. Login succeeded; the request reached the deployed `admin`
function; the function rejected the action — i.e. the **live code lacks the
MIU-Upload actions**. Confirmed it is running stale (pre-MIU) code.

**Root cause (P1): the deploy reports success but never updates the function code.**
Evidence:
- Deploy log: `admin: updated on Nodejs20.19; code request unknown; config request
  cfbbf61a-…` — and identically for `public-api`. The **`code request` is
  `unknown`** (no RequestId ⇒ `updateFunctionCode` did not succeed); the
  `config request` is a real UUID (`updateFunctionConfig` did succeed).
- Live `admin` detail: `ModTime` advanced to today (16:44:38 — from the config
  update) but **`CodeSize` is byte-identical to the pre-MIU build (2205829)** ⇒ the
  code bytes never changed.
- Source on `bdf745d` has the dispatch case (`handler.ts:302 case 'createUploadIntent'`),
  so the live function predates it.
- Mechanism: `updateFunction()` (scripts/deploy-cloudbase-test.mjs) calls
  `updateFunctionCode` then `updateFunctionConfig` but **does not check the code
  result** — `callTool` only throws on a hard mcporter failure, so a soft
  `{success:false}`/empty result is swallowed (hence `code request unknown`).
  `updateFunctionConfig` then succeeds (ModTime advances) and `waitForActive` sees
  the already-`Active` function → the deploy is declared green while the code is
  stale. This is the most dangerous deploy failure mode: a silent stale-code ship.

**Fix (Codex, deploy-script owner):**
1. **Assert `updateFunctionCode` succeeded** — fail the deploy if `codeResult.success
   === false` or no RequestId was returned (treat `code request unknown` as fatal),
   and log `codeResult.message` so the real error surfaces.
2. **Investigate why `updateFunctionCode` returns no RequestId on UPDATE** (create
   worked on 06-25). Likely the MCP `manageFunctions` update path needs a different
   arg/shape, or it errors; the now-surfaced message will show it. Consider `zipFile`
   vs `functionRootPath`, or the `incrementalDeployFunction` action.
3. **Add a post-deploy code-change assertion** (CodeSize/version delta, or a deployed
   version/health probe) so "deploy succeeded" provably implies "new code is live".

Disposition: the upload feature, the smoke harness, the credentials, and the
deploy-up-to-code-upload all work; MIU-09 is now blocked solely on the deploy
script actually shipping the new code (P1 above). Bucket CORS / browser→COS PUT
remain unverified — the smoke can't exercise them until the upload code is live.

### Codex fix — stale-code deploy hardening after Claude P1 — 2026-06-30

Accepted Claude's P1 as valid after independent checks:

- Source has `createUploadIntent`/`completeUpload`/`getImagePreview`.
- A freshly generated local artifact contains those actions.
- The stale local artifact from before packaging did not, matching the live
  symptom class.
- The prior deploy log had `code request unknown` while config requests had real
  ids, so the workflow could report "Deploy to CloudBase ✅" after only config
  changed.

Implemented hardening:

- `scripts/deploy-cloudbase-test.mjs` now inspects CloudBase MCP results instead
  of treating a parsed JSON object as success. `success:false` fails the deploy
  with a safe summarized message.
- `updateFunctionCode` without a RequestId is no longer a green update. In this
  **test-only** deploy script it triggers delete/recreate of that function so the
  branch can still collect MIU-09 evidence, and stale code cannot be reported as
  deployed. Production still needs the broader CICD release/alias plan before
  using this pattern.
- Deploy logs now include each packaged function artifact's byte size and SHA-256
  prefix, and function wait diagnostics include remote `CodeSize`.
- Both function bundles embed a build-time release marker through tsup
  `define` (`CHANNEL_BUILD_SHA || GITHUB_SHA || local`, plus build time).
- Public `/api/health` and admin `POST /api/admin {action:"health"}` return only
  safe release metadata. Because the release id is compiled into the bundle, a
  successful config update cannot fake a successful code update.
- `scripts/smoke-cloudbase-deploy.mjs` now asserts both public-api and admin
  report the expected release id before continuing to catalog/media smokes.

Validation:

- `pnpm --filter @vibelingan-channel/fn-admin test` — pass (56 tests).
- `pnpm --filter @vibelingan-channel/fn-public-api test` — pass (20 tests).
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` — pass.
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck` — pass.
- `pnpm --filter @vibelingan-channel/shared typecheck` — pass.
- `pnpm exec biome check ...` on the touched implementation files — pass.
- `pnpm package:functions && pnpm smoke:functions` — pass.
- Artifact inspection confirms `admin/index.js` contains the upload actions and
  both function artifacts contain an embedded release id/build time.

Remaining live step: push this fix, rerun `Deploy Test` with
`run_public_e2e=true` and `run_media_upload_smoke=true`, and require the workflow
to pass public/admin release-id checks before considering the browser→COS evidence
valid.

### Claude review — stale-code deploy fix (7f10674) — APPROVED — 2026-06-30

Reviewed Codex's P1 fix. It implements **all three** recommendations from the prior
finding and is correct:

1. **Tool failures no longer swallowed.** `assertToolSucceeded()` now guards
   `createFunction`/`updateFunctionCode`/`updateFunctionConfig`/`deleteFunction`;
   `updateFunctionCode` returns its real RequestId via `requestIdFrom()`.
2. **No-RequestId code update is handled, not ignored.** When `updateFunctionCode`
   returns no RequestId (the exact `code request unknown` symptom), `deployFunction`
   now logs the tool message and **deletes + recreates the function** "so stale code
   cannot be reported as deployed." Plus `artifactSummary()` logs the deployed
   artifact's size + sha256.
3. **Post-deploy code-change assertion.** New `packages/shared/src/release.ts`
   (`releaseInfo`), an unauthenticated `health` action (`ok(releaseInfo('admin'))`),
   and `smoke-cloudbase-deploy.mjs` `assertRelease()` now require the deployed
   function to report `releaseId === expected`. The build SHA is injected at build
   time via each `tsup.config.ts` `define` (`CHANNEL_BUILD_SHA || GITHUB_SHA`), and
   GitHub Actions auto-provides `GITHUB_SHA` to the build + smoke steps — so a stale
   function (old/`local` releaseId) now fails the smoke. Verified the build-SHA
   injection path is correct (no workflow change needed).

Independent verification: `pnpm typecheck` (shared + fn-admin + fn-public-api) → 0;
fn-admin + public-api tests pass incl. `health returns safe release metadata without
a session`; both deploy scripts `node --check` clean.

Disposition: P1 resolved and verified. Re-running `Deploy Test` should now either
ship the real code (smoke proceeds to the browser→COS PUT, finally exercising bucket
CORS) or fail loudly at the release-id check — no more silent stale-code green.

Follow-up live run `28433320633` (commit `7f10674`) proved the stale-code guard is
working: `admin` received a real code update RequestId, so the previous
`code request unknown` blind spot is closed. The run then failed in deploy before
smoke because `public-api` tried `updateFunctionConfig` while CloudBase still had
the function in `Updating` after `updateFunctionCode`:

```text
[UpdateFunctionConfiguration] 当前函数处于Updating状态，无法进行此操作，请稍后重试。
```

Codex follow-up fix: after a confirmed `updateFunctionCode`, wait for the function
to return Active/Available before `updateFunctionConfig`; if config still hits the
transient Updating state, wait and retry before failing. This keeps the stricter
no-false-green behavior while matching CloudBase's asynchronous update lifecycle.

## MIU-06 — Legacy Migration + Orphan Cleanup (Claude, parallel to MIU-09)

Started in parallel while Codex hardened the MIU-09 deploy. Env-gated: code +
unit tests land now; live migration runs only after deploy evidence is green.

### Phase 1 — orphan cleanup (done)

New admin-only action `cleanupOrphanImages` (`apps/functions/admin/src/handler.ts`,
dispatch `case 'cleanupOrphanImages'`). Reaps abandoned image docs — `pending`
intents whose upload never finished and `failed` rows from a rejected
`completeUpload` — older than a TTL (default 24h, `olderThanMs` override), deleting
the private storage object FIRST and only then the metadata. Key safety properties:

- Never touches `active` images (the live catalog); admin-only (contributor → `FORBIDDEN`).
- A storage-delete failure leaves the row in place and reports it (`storageFailed`)
  so the next sweep retries — bytes are never silently orphaned (per §20.8 + the
  STO-004 per-file delete-result rule).
- `dryRun` reports candidates (`removed`, counts) without mutating anything.
- Storage keys are logged; no temporary URLs (§20.8 exit criteria).
- Query: `status in [pending,failed]` AND `createdAt < cutoff` (ISO compares
  chronologically; both adapters translate `in`/`lt`).

Tests (`handler.test.ts`, 5): reaps stale pending/failed + deletes objects; `dryRun`
mutates nothing; a failed storage delete keeps the doc (retryable) and is reported;
admin-only; a huge `olderThanMs` reaps nothing. Verified: `pnpm --filter fn-admin
typecheck` + `test` (61 pass) + `biome` all green.

Phase 2 is now implemented as the admin-only `migrateLegacyImages` action rather
than a standalone script. The operator path is documented below: dry-run first,
then bounded live batches against `/api/admin`.

### Codex review — MIU-06 Phase 1 after MIU-09 acceptance — FIXED — 2026-06-30

Fetched `fix/image-upload-storage-design` over SSH after the MIU-09 node-sdk/COS
POST fix. No new remote head was present beyond `657b51d`; this review checked
the existing MIU-06 Phase 1 orphan cleanup against the accepted POST upload
contract.

Disposition: no transport conflict. `cleanupOrphanImages` operates only on
stale `pending`/`failed` metadata and storage object deletion; it does not depend
on browser PUT vs COS multipart POST.

One cleanup-operability gap was fixed: the action accepted `limit` up to `500`,
but the shared DB facade caps a single `list()` page at `100`, so `limit: 500`
silently inspected only the first page. The action now collects candidates through
stable `_id`-sorted pages with a fixed page size up to the requested limit before
mutating rows. This keeps the function bounded, avoids mutation-time
skip/duplicate paging, and makes the advertised limit honest.

Regression added: `cleanupOrphanImages honors a limit above the DB page cap by
collecting stable pages` seeds 105 stale pending rows and verifies all 105 are
scanned and removed with `limit: 105`.

### Claude review — Updating-state race fix (4b9af54) — APPROVED — 2026-06-30

Reviewed Codex's follow-up to the race that run `28433320633` surfaced (the
stale-code guard worked — `admin` got a real RequestId — but `public-api` then hit
`[UpdateFunctionConfiguration] …Updating状态…` because config was attempted while the
code update was still settling). The fix is correct: `deployFunction` now
`waitForActive` AFTER `updateFunctionCode` and BEFORE `updateFunctionConfig`, and
`updateFunctionConfig` retries up to 3× — on an `isFunctionUpdatingResult` it waits
for Active then retries, breaking on success / non-Updating error / final attempt.
This matches CloudBase's asynchronous update lifecycle without weakening the
no-false-green assertions. `node --check` clean. Combined with `7f10674`, the deploy
now: asserts every tool call, recreates on a no-RequestId code update, waits for
Active before config (retrying the transient Updating state), and verifies the
deployed release SHA in the smoke.

### First REAL live mint — P1 found, fixed: upload SDK contract (2026-06-30)

With the deploy chain fixed, run `28433688422` finally shipped the real code (the
`Smoke deployed CloudBase` release-id check passed) and the media smoke **ran**.
It got past `Unknown action` — `createUploadIntent` now executes — but failed with
`createUploadIntent failed: Unexpected server error`. The admin function log gives
the true cause:

```
[fn-admin] unexpected error: TypeError: sdk.getUploadMetadata is not a function
    at getUploadCredential (media-storage/cloudbase) → createUploadIntentAction
```

**Root cause (P1): the entire admin-brokered upload rested on a CloudBase SDK
method that does not exist on the injected runtime object.** The prod entry did
wire the adapter, but it wired `wx-server-sdk` (`cloudStorageSdk = cloud`) into
media-storage. `packages/db/src/wx-server-sdk.d.ts` declared
`getUploadMetadata` on that `Cloud` type, so TypeScript vouched for a false
runtime contract and the gap survived until the first live mint.

Root cause confirmed by inspecting the installed SDKs:

- `wx-server-sdk@3.0.4` exposes storage helpers such as `uploadFile`,
  `getTempFileURL`, and `deleteFile`, but it does **not** expose
  `getUploadMetadata` on the object we were injecting.
- The actual `getUploadMetadata` API exists on `@cloudbase/node-sdk@2.10.0`.
  Its typed/runtime shape is `{ data: { url, authorization, token, fileId,
  cosFileId, download_url } }`, not the hand-written top-level
  `{ uploadUrl, authorization, token, cloudObjectMeta, cloudObjectId }`.
- The node-sdk's own `uploadFile` implementation does a multipart `POST` with
  form fields `Signature`, `x-cos-security-token`, `x-cos-meta-fileid`, `key`,
  and `file`. It is **not** a raw browser `PUT` with custom headers.

Fix:

- `@vibelingan-channel/db/cloudbase` now initialises both SDK boundaries:
  `wx-server-sdk` for database access and `@cloudbase/node-sdk` for storage
  upload-credential minting. The media-storage adapter remains DI-based, but it
  receives the SDK that actually owns `getUploadMetadata`.
- `wx-server-sdk.d.ts` was narrowed back to the real DB-only surface used by the
  DB adapter, preventing TypeScript from proving a false runtime contract.
- `MediaStorageAdapter.getUploadCredential` now maps the node-sdk response to
  `{ uploadUrl, method: "POST", formFields, storageFileId }` and validates all
  required fields as non-empty strings.
- Admin `createUploadIntent`, the site uploader, and the deployed Playwright
  smoke now use browser-origin direct COS multipart `POST` form upload. Bytes
  still go browser -> COS directly; `/api/admin` still only carries tiny JSON.

Expected next evidence: rerun Deploy Test with `run_media_upload_smoke=true`.
The smoke should now progress past `createUploadIntent` and exercise the real
browser-origin COS `POST`/CORS gate.

Local verification before push:

- `pnpm --filter @vibelingan-channel/media-storage test` — pass (26 tests)
- `pnpm --filter @vibelingan-channel/fn-admin test` — pass (61 tests, including
  `cleanupOrphanImages`)
- `pnpm --filter @vibelingan-channel/fn-public-api test` — pass (20 tests)
- `pnpm typecheck` — pass (site has existing React `FormEvent` deprecation hints,
  0 errors)
- `pnpm lint` — pass
- `pnpm package:functions && pnpm smoke:functions` — pass; artifacts do not leave
  unresolved `wx-server-sdk` or `@cloudbase/node-sdk` requires
- `pnpm build` — pass

### Claude review — node-sdk upload-metadata fix (205cd710) — APPROVED — 2026-06-30

This landed as a **parallel collision**: I had independently implemented a fix for
the same `sdk.getUploadMetadata is not a function` P1 (a PUT-with-headers variant
keeping a wx-server-sdk composite). Codex's version is **more correct**, so I
dropped mine and adopted Codex's:

- **POST-multipart, not PUT.** Codex mints `{ uploadUrl, method: 'POST', formFields:
  { Signature, x-cos-security-token, x-cos-meta-fileid, key }, storageFileId }` and
  the browser POSTs a `FormData` (those fields + `file`). This **exactly mirrors
  @cloudbase/node-sdk's own `uploadFile`** (which POSTs that form) — so the minted
  credential is used the way it is actually signed for. My PUT-with-headers variant
  assumed COS PUT semantics and would likely have 403'd against a POST-form-signed
  credential.
- Storage cleanly switched to the node-sdk `app` (`cloudStorageSdk()` returns the
  initialised `CloudBase`); `@cloudbase/node-sdk` externalised in both function
  `tsup.config.ts` (runtime-provided, like wx-server-sdk); `wx-server-sdk.d.ts`
  narrowed to its real DB-only surface (no more false `getUploadMetadata` contract).

Independent verification (post `pnpm install --frozen-lockfile` to materialise the
new dep — the only local snag, resolved in CI's frozen install):

- `pnpm typecheck` across db / media-storage / fn-admin / fn-public-api / site → 0
- `pnpm typecheck:e2e` → 0; `astro check` → 0 errors; `biome check .` (139 files) → 0
- media-storage / fn-admin (61, incl. `cleanupOrphanImages`) / fn-public-api tests → pass
- Browser `uploadImage` (api.ts) correctly builds the multipart form and POSTs to
  the COS url (UA sets the boundary) — consistent with the credential shape.

Disposition: APPROVED. The last code bug on the admin-brokered upload is fixed; only
the live browser→COS POST + bucket CORS remain unproven, which the next Deploy Test
(`run_media_upload_smoke=true`) will exercise.

### ✅ MIU-09 ACCEPTED — live browser→COS evidence recorded — 2026-06-30

Deploy Test run **`28435302827`** (SHA `205cd71`, the node-sdk POST-multipart fix)
**passed end-to-end**, every step green:

- Deploy to CloudBase test ✓ (hardened script — real code shipped)
- Smoke deployed CloudBase ✓ (release-SHA assertion: deployed `releaseId` == build SHA)
- Run public browser E2E ✓
- **Run media upload smoke ✓** — the deployed-env Playwright smoke completed the full
  admin-brokered flow from a real Chromium page:
  browser-origin `login` → `createUploadIntent` → **browser-origin direct COS
  multipart `POST`** → `completeUpload` → admin `getImagePreview` → public
  `/api/images/:id` `404` (unpublished) → published product link → public `200
  image/png`.

This is the live evidence MIU-09 existed to produce: the **browser→COS upload works**
and, because the browser-origin POST to COS succeeded, **bucket CORS is confirmed**
(a CORS/preflight failure would have failed the smoke). Run URL:
`https://github.com/vibelingan/channel/actions/runs/28435302827`.

Follow-up hygiene: the passing media smoke logged best-effort cleanup warnings
(`product remove failed: Unknown API error`, `image metadata remove failed:
Unknown API error`). That does not weaken the upload/CORS evidence, but the cleanup
helper should report the underlying API error and eventually fail if test rows are
left behind.

**MIU-09 is done.** The admin-brokered image-upload feature (MIU-Upload + MIU-04
delivery + MIU-05 UI) is now validated end-to-end against the deployed CloudBase
test environment. Remaining open work is outside catalog-image upload:
**MIU-06 Phase 2** (legacy `images.data` → storage migration script) and
**MIU-08** (OEM Cloud Storage upload/private delivery).

## MIU-08 — OEM Cloud Storage Upload + Private Delivery

### Codex design revision — 2026-06-30

Triggered by browser testing of a realistic OEM ZIP:

- `channel-oem-heavy-image-pack.zip` is 9.0 MiB and contains six normal PNG
  drawing-image exports.
- Submitting it through the public OEM page failed with CloudBase
  `EXCEED_MAX_PAYLOAD_SIZE`.
- Root cause: OEM still uses the legacy `FileReader.readAsDataURL` ->
  `drawingData` -> `/api/admin` JSON -> `files.data` base64 path. A 9 MiB ZIP
  expands to roughly 12 MiB+ before JSON overhead, so the gateway rejects it
  before `submitProject` runs.

Decision now captured in `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §20.10:

- P0 OEM attachment cap is **10 MiB**.
- ZIP/PDF/CAD/drawing-image files are private OEM files, not catalog images.
- New OEM writes must use CloudBase Storage under `oem/`, not base64 JSON.
- Public submit uses a separate public-intent flow:
  `createOemFileUploadIntent` -> browser direct COS multipart POST ->
  `submitProject` finalizes and links `oemProjects.drawing`.
- Admin delivery uses an authenticated short-lived temp URL action; do not add a
  public `/api/files/:id` route and do not return large OEM bytes as JSON/base64.
- Reuse the MIU-09-verified `@cloudbase/node-sdk` upload metadata path. Do not
  reintroduce `wx-server-sdk.getUploadMetadata`.

Implementation-grade requirements added:

- `OEM_FILE_MAX_BYTES = 10 * 1024 * 1024`.
- Allow PDF, ZIP/RAR, common CAD extensions, and drawing images.
- Validate extension + MIME, with `application/octet-stream` allowed only for
  known CAD extensions.
- Store `files` metadata with `purpose: 'oem-drawing'`, lifecycle state,
  storage identifiers, optional checksum, upload intent id, expiry, and
  server-only upload-secret hash.
- Keep `files.data` as legacy-only; no new OEM attachment writes may populate it.
- Add pending-intent cleanup and compensation/idempotency tests around
  `submitProject`, because the current DB facade has no transaction or
  create-with-id primitive.
- Deployed acceptance smoke must upload the 9 MiB ZIP through the public OEM
  page and verify `/api/admin` carries only small JSON while bytes go to
  CloudBase Storage.

### Codex design revision — upload transport policy gate — 2026-06-30

User question: can we keep base64 for small image upload while using CloudBase
Storage for larger files?

Architectural answer captured in `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §5 and
§20.12:

- Yes, base64 can remain, but only for explicit `inline-small` assets and legacy
  compatibility/migration paths.
- No, product catalog images should not switch to base64 just because a file is
  small. All new catalog images stay on the MIU-Upload storage-backed lifecycle
  so preview, public delivery, checksum, cleanup, and migration remain single-path.
- No, OEM files should not use base64 even when the selected file is a small
  image. OEM is a private attachment lifecycle and may be ZIP/PDF/CAD/image; it
  belongs in the `files`/`oem/` storage path, not the `images` collection or
  JSON body.
- The actual decision gate is purpose -> file type -> size. Size is a cap within
  an allowed purpose/type, not the primary transport selector.

New MIU-10 requirements:

- Add a shared `chooseUploadTransport(input)` policy helper before any new
  base64 write feature or OEM implementation.
- Required outcomes:
  - tiny `catalog-image` JPEG => `cloudbase-storage-direct`
  - tiny `oem-drawing` PNG/ZIP => `cloudbase-storage-direct`
  - 9-10 MiB OEM ZIP => `cloudbase-storage-direct`
  - over-10 MiB OEM ZIP => controlled reject or `manual-or-cloudrun-large-file`
  - `inline-small` SVG/PNG/WebP under 50 KiB => `inline-base64`
  - `inline-small` PDF/ZIP/CAD/product photo => reject
- Product/OEM call sites must refuse to mint credentials unless the policy
  returns their expected storage transport.
- Generic CRUD remains unable to write `data`, `storageFileId`, `storagePath`,
  lifecycle state, or upload secrets.

This is intentionally non-breaking for the current upload design: MIU-Upload and
MIU-08 remain storage-backed. The only new design surface is a future
`inline-small` action, if the product actually needs one.

### Codex monitor review — Claude MIU-10 design approval `a017f5a` — 2026-06-30

Fetched and fast-forwarded `fix/image-upload-storage-design` over SSH after
Claude pushed `a017f5a` ("review upload transport policy gate"). The commit is
docs-only and approves `2e089d4` with no blockers.

Review disposition:

- No blocking findings. Claude's §26 review correctly treats MIU-10 as a design
  gate, not an implementation change, and confirms that base64 is limited to
  `inline-small`/legacy while catalog and OEM remain storage-backed.
- Accepted non-blocking nits for implementation:
  - public OEM rate/pending counters must use the existing atomic
    `incrementField` primitive, not read-modify-write;
  - the aggressive OEM download TTL should become a named constant.
- No runtime package or function artifact changed in `a017f5a`, so no function
  package smoke was required for this monitor cycle.

Validation run:

- `pnpm lint`
- `pnpm verify:cloudbase-sdk`

### Codex monitor review — architecture-pattern audit / MIU-11..15 backlog `425c0ff..80d0a5e` — 2026-06-30

Fetched and fast-forwarded `fix/image-upload-storage-design` over SSH after
Claude pushed:

- `425c0ff` — architecture-pattern audit (§27), verdict P0 LLD sufficient.
- `80d0a5e` — formalized enrichment backlog as MIU-11..15 (§20.13).

Review disposition:

- No blocking findings. The additions are docs-only and correctly keep the
  current scenario focused: MIU-08 and MIU-10 remain the implementation gates;
  MIU-11..15 are backlog-level operational maturity.
- Important boundary preserved: MIU-11 is later edge/gateway hardening. It does
  **not** defer MIU-08's P0 public OEM safeguards. MIU-08 must still implement
  shared-state rate/window caps, pending-intent caps, TTL, opportunistic cleanup,
  and controlled rejection before it is accepted.
- The "no dedicated scheduler" choice is acceptable for the current traffic and
  cost profile because §20.13 folds cleanup into bounded sampled sweeps on
  intent creation plus the existing admin cleanup action, with CloudBase native
  scheduled triggers reserved if piggyback cleanup proves insufficient.
- No runtime package changed. I still ran fn-admin typecheck/tests because these
  docs touch cleanup/rate-limit design around the admin function.

Validation run:

- `pnpm lint`
- `pnpm verify:cloudbase-sdk`
- `pnpm --filter @vibelingan-channel/fn-admin typecheck`
- `pnpm --filter @vibelingan-channel/fn-admin test` — 70 tests passed

### Codex review — MIU-08/12 lifecycle helper `35c6400` — FINDINGS — 2026-06-30

Review base: `35c6400` (`feat(media): opportunistic-cleanup selector +
quarantine transition validator`), fetched over SSH after the monitor detected a
new remote head.

Summary: good direction and clean pure helper shape, but not ready to wire into
MIU-08 cleanup/finalization until two review findings are addressed.

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P2 | `selectExpiredPendingForSweep` drops the doc/object pairing needed for safe partial-delete handling. It returns `docIds` and `storageFileIds` as independent arrays, and `storageFileIds` deliberately omits rows without a storage id. A MIU-08 caller that deletes storage objects first cannot map a failed `deleteObject(storageFileId)` back to the doc id to keep that doc retryable; marking all `docIds` deleted would recreate the cleanup false-success class we already fixed in MIU-06. | `packages/shared/src/media-lifecycle.ts` builds `docIds = expired.map(_id)` and `storageFileIds = expired.map(storageFileId).filter(...)`; tests only assert the two arrays independently. Existing `cleanupOrphanImages` behavior keeps the specific doc whose storage delete failed. | Preserve pairing in the selector output, e.g. `items: Array<{ docId, storageFileId?: string, uploadExpiresAt: string }>` or `storageObjects: Array<{ docId, storageFileId }>` plus `docIds`. Add a regression showing a mixed selection can keep only the doc whose object deletion failed. |
| P3 | `isValidMediaStatusTransition` allows same-state transitions before validating enum membership. With TypeScript-only `MediaStatus` this is fine for trusted callers, but DB rows are runtime data and this helper is intended to enforce a quarantine state machine. If a corrupted value is cast/normalized too early, `isValidMediaStatusTransition('unknown' as MediaStatus, 'unknown' as MediaStatus)` returns `true` instead of failing closed. | `packages/shared/src/media-lifecycle.ts` returns `true` immediately when `from === to`; it imports only the type, not `MEDIA_STATUSES`. Existing media delivery hardening fails closed on unknown lifecycle/provider values. | Import `MEDIA_STATUSES` and verify both `from` and `to` are members before allowing same-state idempotency. Add tests for unknown/corrupt `from` and `to` values using explicit casts. |

Validation run:

- `pnpm --filter @vibelingan-channel/shared typecheck`
- `pnpm --filter @vibelingan-channel/shared test` — 27 tests passed
- `pnpm lint`
- `pnpm verify:cloudbase-sdk`
- `pnpm --filter @vibelingan-channel/fn-admin typecheck`
- `pnpm --filter @vibelingan-channel/fn-admin test` — 70 tests passed

### Claude fix — lifecycle helper review findings ADDRESSED — 2026-07-01

Addressed both Codex findings on `35c6400` (`packages/shared/src/media-lifecycle.ts`):

- P2 (doc↔object pairing): `selectExpiredPendingForSweep` now returns
  `items: SweepItem[]` (paired `{ docId, uploadExpiresAt, storageFileId? }`,
  oldest-first) as the authoritative output, plus convenience `docIds` and a
  paired `storageObjects: Array<{ docId, storageFileId }>`. A caller deleting
  objects first can map a failed `deleteObject` back to its doc and keep ONLY
  that doc retryable. New regression test proves a mixed selection keeps just the
  failed-object doc and marks the rest (incl. the no-object doc) deleted — no
  MIU-06 false-success.
- P3 (fail-closed): `isValidMediaStatusTransition` now imports `MEDIA_STATUSES`
  and rejects any `from`/`to` outside the known set BEFORE the same-state
  shortcut, so a corrupt runtime status (e.g. `'unknown' as MediaStatus`,
  same-state) returns `false`. New regression covers unknown/empty values.

Validation: `pnpm --filter @vibelingan-channel/shared typecheck` clean;
`test` — 29 passed; `biome check` clean on both files.

### Codex re-review — lifecycle helper fix `f04cd2f` — APPROVED — 2026-07-01

Fetched and fast-forwarded `fix/image-upload-storage-design` over SSH after
Claude pushed `f04cd2f`.

Disposition: approved; no remaining blockers in this delta.

- P2 resolved: `selectExpiredPendingForSweep` now exposes authoritative
  `items: SweepItem[]` plus paired `storageObjects`, so MIU-08 cleanup can map a
  failed object delete back to exactly one doc and keep only that doc retryable.
- P3 resolved: `isValidMediaStatusTransition` validates both `from` and `to`
  against `MEDIA_STATUSES` before the same-state shortcut, so corrupt runtime
  statuses fail closed.
- Function artifact smoke was run because `packages/shared/src/index.ts`
  exposes the new helper and function bundles consume shared code.

Validation run:

- `pnpm --filter @vibelingan-channel/shared typecheck`
- `pnpm --filter @vibelingan-channel/shared test` — 29 tests passed
- `pnpm lint`
- `pnpm verify:cloudbase-sdk`
- `pnpm --filter @vibelingan-channel/fn-admin typecheck`
- `pnpm --filter @vibelingan-channel/fn-admin test` — 70 tests passed
- `pnpm build:functions`
- `pnpm smoke:functions`

### Codex review — magic-byte content sniffer `fde87ad` — FINDINGS — 2026-07-01

Review base: `fde87ad` (`feat(media): shared magic-byte content sniffer
(MIU-08/12 groundwork)`), fetched over SSH after the monitor detected a new
remote head.

Summary: the pure helper shape is good and the signature checks are a solid
foundation for MIU-08/MIU-12, but there is one pre-wire finding before OEM
archive finalization should depend on `signatureMatchesMime()`.

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P2 | `signatureMatchesMime()` only accepts canonical archive MIME strings, so valid OEM ZIP/RAR uploads can be falsely rejected once MIU-08 uses this as the declared-MIME cross-check. Common upload clients may report ZIP as `application/x-zip-compressed`, `application/x-zip`, or `application/zip-compressed`, and RAR as `application/vnd.rar`; those are still consistent with the same magic bytes and purpose policy. | `packages/shared/src/media-content.ts` maps ZIP only to `application/zip` and RAR only to `application/x-rar-compressed`; tests cover exact canonical pairs plus `image/jpg`, but no archive aliases. The MIU-08 design requires ZIP/PDF byte sniffing and MIME/extension validation before activation, so this helper is on the critical finalization path. | Replace the single canonical MIME map used for matching with a per-signature allowlist, or add explicit archive aliases in `signatureMatchesMime()`. Add tests for ZIP aliases (`application/x-zip-compressed`, `application/x-zip`, `application/zip-compressed`) and RAR alias (`application/vnd.rar`). Keep `application/octet-stream` false here unless a caller intentionally allows it through a separate purpose + extension gate for CAD/unknown-signature files. |

Non-blocking note: GIF sniffing is broader than the current product/OEM allowlists.
That is acceptable only if callers continue to apply purpose/type allowlists before
activation; do not let byte signature alone expand accepted upload types.

Validation run:

- `pnpm --filter @vibelingan-channel/shared typecheck`
- `pnpm --filter @vibelingan-channel/shared test` — 44 tests passed
- `pnpm --filter @vibelingan-channel/fn-admin typecheck`
- `pnpm --filter @vibelingan-channel/fn-admin test` — 70 tests passed
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck`
- `pnpm --filter @vibelingan-channel/fn-public-api test` — 20 tests passed
- `pnpm verify:cloudbase-sdk`
- `pnpm build:functions`
- `pnpm smoke:functions`
- `pnpm lint`

### Claude fix — content sniffer review ADDRESSED + filename sanitizer — 2026-07-01

Addressed Codex's `b43217b` P2 on `packages/shared/src/media-content.ts`:

- P2 (archive MIME aliases): `signatureMatchesMime()` no longer matches only the
  canonical `SIGNATURE_MIME` value. It now uses a per-signature accepted-MIME
  allowlist (`ACCEPTED_MIME`) so real-world declarations pass — ZIP:
  `application/zip` + `x-zip-compressed` + `x-zip` + `zip-compressed`; RAR:
  `x-rar-compressed` + `vnd.rar` + `x-rar`; jpeg keeps the `image/jpg` alias.
  `application/octet-stream` stays `false` here by design (CAD/unknown-signature
  is gated separately by purpose + extension, never by byte signature alone).
  New tests cover every ZIP/RAR alias (case-insensitive) and octet-stream
  rejection. `SIGNATURE_MIME` remains the canonical map for response Content-Type.
- The non-blocking GIF-breadth note is acknowledged: callers must keep applying
  purpose/type allowlists before activation; byte signature never expands the
  accepted upload set on its own.

Also landed in the same module: `sanitizeDownloadFilename()` for the MIU-08 §25-5
download-header requirement — strips CR/LF (header injection), quotes, path
separators, C0/DEL control chars, and Unicode bidi/RTL spoof chars; collapses
leading dots (no hidden/`..`); caps length; falls back when empty.

Validation: `pnpm --filter @vibelingan-channel/shared typecheck` clean;
`test` — shared suite green (23 media-content tests; 52 total in shared);
`biome check` clean.

### Claude impl — rate-limit / pending-cap decision groundwork — 2026-07-01

Added `packages/shared/src/media-ratelimit.ts` (pure, constant-agnostic) for the
MIU-08 public-intent abuse controls (§20.10) and §27.2-2:

- `evaluateFixedWindowRateLimit({ countInWindow, maxPerWindow, windowMs, nowMs?,
  windowResetAtMs? })` → `{ allowed, retryAfterSeconds }`. Allowed iff the
  post-increment count ≤ max; Retry-After is the time to the (epoch-aligned, or
  explicit) window reset, floored at 1s. Fails CLOSED on misconfig.
- `withinPendingCap(currentPending, maxPending)` → boolean; allowed iff adding one
  stays within max; fails closed on bad max/count.

Deliberately takes the limits as parameters so the OEM thresholds
(`OEM_UPLOAD_RATE_*`, `OEM_MAX_PENDING_*`) stay owned by MIU-08, not duplicated
here. MIU-08 wires the atomic `incrementField` counter to these and returns 429 +
`Retry-After` on deny. 8 tests (60 total in shared); tsc + biome clean.

### Codex review — sniffer fix + rate-limit helper `adae0d0..f84d6cc` — FINDINGS — 2026-07-01

Review base: `adae0d0` (`fix(media): resolve sniffer P2 (archive MIME aliases)
+ add sanitizeDownloadFilename`) and `f84d6cc` (`feat(media): rate-limit +
pending-cap decision groundwork (MIU-08 abuse controls)`), fetched and
fast-forwarded over SSH after the monitor detected a new remote head.

Disposition:

- Approved the archive MIME-alias fix. `signatureMatchesMime()` now accepts the
  common ZIP/RAR aliases that browser/OS upload clients emit, while deliberately
  keeping `application/octet-stream` out of signature matching. This resolves
  Codex review `b43217b` for the content sniffer.
- Approved the filename sanitizer direction for MIU-08 downloads: CR/LF, quotes,
  path separators, control chars, and bidi spoof controls are stripped before
  `Content-Disposition` usage.
- One P2 remains on the new rate-limit/pending-cap helper before MIU-08 wires it
  into the public upload-intent action.

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P2 | The abuse-control helper still opens on malformed finite counts because it treats any finite number as readable. A corrupted or buggy `countInWindow = -1` or `currentPending = -1` returns allowed (`-1 <= max`, `-1 < max`), and fractional counts/limits are also accepted. For a public OEM upload-intent limiter, runtime counters and aggregation results must be non-negative integers or fail closed; this is the same counter-integrity class already hardened for `incrementField`/`publishedRefCount`. | `packages/shared/src/media-ratelimit.ts` validates `Number.isFinite(countInWindow)` and `Number.isFinite(currentPending)`, but not `Number.isInteger`, lower bounds, or post-increment minimums. Existing tests cover `NaN` and bad limits, but not negative or fractional counts/limits. Design §20.10 and §27.2-2 require public intent caps to fail closed and use shared atomic counter state, not per-instance memory. | Require integral values and safe lower bounds: `countInWindow` should be an integer `>= 1` because it is post-increment; `maxPerWindow` and `maxPending` should be positive integers; `currentPending` should be an integer `>= 0`; `windowMs` should be a positive finite integer. Ensure `retryAfterSeconds` is always a finite integer `>= 1` even if optional `nowMs`/`windowResetAtMs` are bad. Add regression tests for negative and fractional counts/limits and invalid time inputs. |

Validation run:

- `pnpm --filter @vibelingan-channel/shared typecheck`
- `pnpm --filter @vibelingan-channel/shared test` — 60 tests passed
- `pnpm --filter @vibelingan-channel/fn-admin typecheck`
- `pnpm --filter @vibelingan-channel/fn-admin test` — 70 tests passed
- `pnpm --filter @vibelingan-channel/fn-public-api typecheck`
- `pnpm --filter @vibelingan-channel/fn-public-api test` — 20 tests passed
- `pnpm verify:cloudbase-sdk`
- `pnpm build:functions`
- `pnpm smoke:functions`
- `pnpm lint`

### Claude fix — rate-limit helper P2 (counter integrity) ADDRESSED — 2026-07-01

Addressed Codex's `eee6fb8` P2 on `packages/shared/src/media-ratelimit.ts`:

- Both helpers now require **safe non-negative integers or fail CLOSED** (the same
  discipline as `incrementField`/`publishedRefCount`): `countInWindow` must be an
  integer ≥ 1 (post-increment), `maxPerWindow`/`windowMs` positive integers,
  `currentPending` an integer ≥ 0, `maxPending` a positive integer. A corrupt
  `-1`/fractional counter no longer returns `allowed`.
- `retryAfterSeconds` is now guaranteed a finite integer ≥ 1 even when `nowMs` or
  `windowResetAtMs` are `NaN`/`Infinity` (guarded before use; bad time falls back
  to `Date.now()` / epoch-aligned reset).
- Regressions added: negative + fractional counts/limits, fractional window, and
  malformed time inputs. shared suite green (61 tests); tsc + biome clean.

`media-ratelimit` is now wire-ready for MIU-08.

### Codex review monitor — MIU-08 public-intent wire contract + counter blocker — 2026-07-01

Review base: `724d70c` (`feat(media): public createOemFileUploadIntent action
(MIU-08 Increment 2b)`), fetched over SSH after the monitor detected new remote
commits beyond local `eee6fb8`.

Disposition:

- Fixed in this pass: public OEM limiter denials no longer masquerade as generic
  conflicts. `createOemFileUploadIntent` now returns shared
  `RATE_LIMITED` errors, and the admin HTTP adapter maps them to real HTTP `429`
  responses with a `Retry-After` header. The header is also exposed through CORS
  so browser callers can back off intentionally. Pending-cap denials now compute
  `Retry-After` from the soonest live `uploadExpiresAt`, falling back to the 15
  minute intent TTL only if that timestamp is malformed.
- Remaining blocker: the abuse-control caps still gate by querying `files` and
  then minting the credential. Under parallel requests, the same source can
  overshoot the documented `5 / 60s` rate cap and `3` live-pending cap because
  the check is not backed by the design's required shared atomic counter write.

Finding:

| Severity | Finding | Evidence | Required follow-up |
| --- | --- | --- | --- |
| P1 | `createOemFileUploadIntent` still enforces its public rate and pending caps with read-then-write query counts, so concurrent callers can burst past both the per-source and global ceilings before any `429` is emitted. That weakens the public abuse guard exactly where the design required a shared-state atomic backstop. | [`apps/functions/admin/src/handler.ts`](/tmp/channel-ssh-clone-test/apps/functions/admin/src/handler.ts:1402) uses `countOemFiles(...) + 1` for rate decisions and [`handler.ts`](/tmp/channel-ssh-clone-test/apps/functions/admin/src/handler.ts:1429) / [`handler.ts`](/tmp/channel-ssh-clone-test/apps/functions/admin/src/handler.ts:1434) use query counts for pending-cap decisions. `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` §27.2-2 and the MIU-10 note in this execution log both require the in-function backstop to use atomic `incrementField` shared state, not coarse query counts. | Replace the query-gated limiter with an atomic shared-state counter path before calling MIU-08 hardened. Query-based counts can remain for cleanup/reporting, but the allow/deny decision itself needs an atomic counter doc strategy plus the existing `429 + Retry-After` wire contract. |

Validation:

- `pnpm verify:cloudbase-sdk`
- `pnpm --filter @vibelingan-channel/fn-admin test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm smoke:functions`

### Claude resolution — P1 over-admission fixed via RESERVE-FIRST — 2026-07-01

Merged Codex's `66eaa69` (429 wire contract) and verified it green (shared 70,
admin 84, public-api 20, biome + repo typecheck clean), then resolved the P1
over-admission blocker in `createOemFileUploadIntent`.

- **Fix (mechanism):** switched the caps from check-then-create to **reserve-first**.
  The action now WRITES the `pending` `files` row first, then counts (the
  reservation included) and rolls it back if any ceiling is exceeded, minting the
  COS credential only after all caps clear. Because every ADMITTED reservation
  persists and is visible to concurrent counters, the number admitted can never
  exceed the ceiling — the read-then-write race (bursting past the cap before any
  `429`) is closed. It fails SAFE (under contention it may over-REJECT, never
  over-admit) and preserves the `429 + Retry-After` wire contract.
- **Why not a literal atomic `incrementField` counter (design §27.2-2):** that
  path needs per-`(source,window)` counter docs, which require a NEW upsert-by-id
  storage primitive (CloudBase `doc().set()` — outside the current typed SDK
  surface, gated by the CloudBase SDK Contract Gate) plus counter-doc GC. It also
  mismatches the pending cap, which is a live GAUGE (expires with no decrement
  event) that an increment/decrement counter would drift on and false-block real
  customers. Reserve-first reuses the `files` rows we already write, achieves the
  same "admitted ≤ ceiling" guarantee for BOTH caps, needs no new primitive/GC, and
  keeps the pending gauge query-exact. The atomic-counter mechanism remains an
  option for a future gateway/edge limiter (MIU-11) if per-window precision is
  wanted, but is not required to close this P1.
- **Tests:** rollback-on-reject and rollback-on-mint-failure assertions (no leaked
  reservation) + an accumulation test proving N admits then blocks at the cap
  (admin 84 → 85). Full: admin 85 / shared 70 / public-api 20, repo typecheck +
  biome clean.

### Increment 3 — `submitProject` OEM finalization — 2026-07-01

Rewrote the public `submitProject` to finalize a browser-direct storage upload
(design §20.10 step 2), planned with the `test-planner` agent (82 scenarios) and
the `engineering-craft` skill (single-use-token consume-once + compensation).

- **Three drawing branches:** the storage triad (`drawingFileId`+`uploadIntentId`
  +`uploadSecret`, all-or-`VALIDATION_ERROR`), legacy inline `drawingData`
  (unchanged fallback), or none. Storage path takes precedence over legacy.
- **Ownership = the one-time secret ONLY.** `sha256(uploadSecret)` is
  constant-time compared (`timingSafeEqual`, equal-length guarded) to the stored
  hash — same `…digest('hex')` encoding as `createOemFileUploadIntent` (verified).
- **Security decision (test-planner #63):** structural / not-found / expired /
  WRONG-SECRET failures reject WITHOUT mutating — an unauthenticated caller who
  only guesses a `fileId`+`intentId` must not be able to delete or fail a legit
  uploader's object. ONLY post-secret byte failures (empty / >10 MiB / checksum
  mismatch / magic-byte mismatch) mark the row `failed` + best-effort delete.
- **Server-authoritative bytes:** size + SHA-256 recomputed from the fetched
  bytes (client size never trusted); re-enforces `OEM_FILE_MAX_BYTES`.
- **Magic-byte sniff:** pdf/zip/rar/png/jpg/webp must match their bytes; CAD
  (step/…/dxf) is extension-gated, but a CAD-extension file whose bytes sniff as
  another known type is rejected (anti-disguise).
- **Consume-once atomic gate (engineering-craft storage-gate-not-JS):** an atomic
  `incrementField('files', id, 'finalizeClaim', 1)` — only the request that flips
  it 0→1 finalizes; a concurrent double-submit/replay gets >1 and loses with NO
  side effects. The claim runs AFTER secret verification so an attacker without
  the secret cannot burn it. Added readOnly `finalizeClaim` to `files`/`FileMetadataDoc`.
- **Compensation:** create `oemProjects`, THEN activate the row (`active` +
  `ownerProjectId` + server byteSize/checksum + cleared secret). If activation or
  project-create fails, the project is removed + the row marked `failed` +
  `INTERNAL_ERROR` surfaced — never a success with a dangling/pending drawing.
- **Tests:** 12 finalization tests (admin 86 → 98) — happy storage + CAD, the
  wrong-secret no-DoS invariant, structural rejects (no mutation), post-secret
  byte-failure fail+delete, not-yet-retrievable stays pending, consume-once loser,
  activation-failure compensation, incomplete triad, legacy, no-drawing, bad text.
  Repo typecheck + biome clean; shared 70 / public-api 20 unchanged. Frontend
  (Increment 5) still sends legacy `drawingData`, which keeps working until wired.

### Codex review — `submitProject` finalization `871adff` — FINDINGS — 2026-07-01

Review base: `871adff` (`feat(media): submitProject OEM finalization (MIU-08 Increment 3)`).

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P1 | The single-winner `finalizeClaim` gate runs too late. `submitProject` verifies the secret, then downloads and decodes the untrusted storage object (`getObjectAsBase64`) and may mark/delete on byte failures before the atomic claim. Because the public upload credential is not COS-size-bound in the current CloudBase SDK path, a caller with the one-time secret can submit many parallel finalization requests for the same intent and force repeated function downloads of the same object. More importantly, destructive byte-failure handling is not protected by the consume-once gate, so a same-secret concurrent path can still mutate/delete before it has proven it is the winning finalizer. | `apps/functions/admin/src/handler.ts` `verifyAndClaimOemUpload`: secret check at lines 548-555, `rejectOwned()` failure/delete at 560-568, `mediaStorage().getObjectAsBase64(storageFileId)` at 570-578, byte checks at 580-591, and only then `incrementField('files', ..., 'finalizeClaim', 1)` at 593-597. The tests cover a pre-seeded loser (`finalizeClaim: 1`) but not two concurrent same-secret calls proving only one storage read/destructive path can run. | Move the consume-once claim to immediately after structural + secret verification and before any object download or byte-failure mutation. Requests that lose the claim must return `CONFLICT` without calling storage or updating/deleting the row. Preserve retry semantics for "object not retrievable yet" explicitly (for example, safely release/compensate the claim or accept that the client must re-upload; document the chosen behavior). Add regression tests that fire same-secret parallel calls and prove storage `getObjectAsBase64` runs once, losers do not delete/update, and byte-failure paths cannot run after losing the claim. |
| P2 | The authoritative design doc is still internally inconsistent about CloudBase size enforcement. §20.10 still says the COS POST policy must include `content-length-range`, while the execution record says the installed `@cloudbase/node-sdk` `getUploadMetadata` path cannot express that condition. Leaving both statements active invites future agents to either reject the current implementation for an impossible SDK constraint or assume server-side recheck alone is sufficient without the pre-download gate above. | `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md` still requires `content-length-range` at §20.10 lines around 1761-1763, 1815, 1887-1888, and later review-disposition text. `docs/IMAGE_UPLOAD_EXECUTION.md` records the SDK limitation in the MIU-08 row and the CloudBase SDK contract gate confirms `getUploadMetadata` shape. | Update the design doc so current CloudBase-node-sdk transport is explicit: intent-time declared size is advisory, current credential cannot bind object length, finalization must single-winner claim before download, then server-recompute size/checksum and reject/delete over-cap bytes. Keep `content-length-range` only as a future alternative if switching to a lower-level COS policy/STS path that can actually bind the condition. |

Validation run during review:

- `pnpm --filter @vibelingan-channel/fn-admin typecheck` — pass
- `pnpm --filter @vibelingan-channel/fn-admin test` — pass, 98 tests
- `pnpm --filter @vibelingan-channel/shared typecheck` — pass
- `pnpm --filter @vibelingan-channel/shared test` — pass, 70 tests
- `pnpm verify:cloudbase-sdk` — pass
- `pnpm smoke:functions` — pass
- `pnpm build:functions` — pass
- `pnpm lint` — pass

### Codex monitor review — no new blocker after reserve-first hardening — 2026-07-01

Follow-up review of the reserve-first commit found one additional partial-failure
seam: after the reservation is admitted and the COS credential is minted, the
server still attaches `storageFileId` in a separate DB update. If that update
throws or returns `null`, the pre-review code could leak a `pending` reservation
into the limiter even though the request failed.

- **Fix:** wrap the `updateDoc('files', reserved._id, { storageFileId })` step in
  rollback handling. A thrown update or vanished row now logs, removes the
  reservation, and returns `INTERNAL_ERROR` instead of leaving a leaked pending row.
- **Regression coverage:** added an OEM-intent test that exercises both attach
  failure modes (`update -> null` and `update -> throw`) and proves the store is
  empty afterward.
- **Disposition:** no blocker remains in the `createOemFileUploadIntent`
  reservation/attach path after this hardening. Remaining MIU-08 work is still
  `submitProject` finalization + frontend/browser smoke.

### Claude review — orphan-cleanup paging fix (6ca3e866) — APPROVED — 2026-06-30

Codex reviewed my MIU-06 Phase 1 and fixed a real limitation: my `cleanupOrphanImages`
passed `pageSize: limit`, but the `list()` facade caps a page at 100, so `limit > 100`
silently reaped only the first 100 candidates. Codex's `listOrphanCleanupCandidates`
now pages with a **stable `_id` sort** (the same pagination-stability guard as the
MIU-04 backfill — without it, skip/limit over an unstable order can miss/dup rows),
accumulating up to `limit`, plus a 105-row regression proving it pages past the cap.
Correct and well-scoped. Verified: fn-admin `typecheck` + tests (my 5 cleanup tests +
the new paging test) + `biome` all green. This is the no-fixed-role loop working as it
should — I implemented Phase 1, Codex reviewed and hardened it.

## Process Hardening — CloudBase SDK Contract Gate (2026-06-30)

### Root cause attribution for the upload-metadata SDK miss

The `sdk.getUploadMetadata is not a function` failure was caused by a design +
implementation workflow miss, not by the final CloudBase deploy script.

Commit chain:

- `5a043e0` (`feat(media): MIU-Upload U1 — admin-brokered direct-upload server
  contract`) introduced the wrong assumption. It added `getUploadMetadata` to the
  hand-written `packages/db/src/wx-server-sdk.d.ts` `Cloud` type and implemented
  media-storage around a top-level upload-info shape.
- `ba27b60` (`fix(media): address Codex MIU-Upload U1 review...`) hardened
  validation of that wrong shape (`uploadUrl` / `cloudObjectMeta` /
  `cloudObjectId`) instead of re-verifying the SDK boundary, so TypeScript became
  better at proving the wrong contract.
- `7b8357e` recorded the live P1: deployed `createUploadIntent` reached the
  adapter and crashed because the injected `wx-server-sdk` object did not expose
  `getUploadMetadata`.
- `205cd71` fixed the code by injecting an explicit `@cloudbase/node-sdk` app for
  upload-metadata minting, narrowing the `wx-server-sdk` type shim back to the
  observed DB/storage-helper surface, and switching the browser upload contract
  to node-sdk-compatible multipart `POST`.
- `27578ca` reviewed and approved the node-sdk POST-multipart fix; live run
  `28435302827` then proved browser -> COS POST + CORS end-to-end.

Responsibility split:

- **Design fault:** the design mixed the raw CloudBase Storage OpenAPI upload-info
  model with an assumed SDK-wrapper model and did not prove which runtime object
  would be injected.
- **Implementation fault:** the hand-written `wx-server-sdk.d.ts` made the false
  runtime method typecheck, so normal `tsc` review could not catch it.
- **Review/workflow fault:** reviews checked TypeScript, tests, and deployed
  packaging, but did not require SDK source/runtime proof before accepting a
  new SDK method on an ambient type.

### Permanent prevention now landed

CloudBase SDK-boundary work now has an executable and documented gate:

- New project rule: `AGENTS.md` requires CloudBase SDK/OpenAPI/storage/function
  work to follow `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`.
- New workflow doc:
  `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` requires CloudBase skill/doc
  lookup, official docs/OpenAPI lookup, installed package source/type inspection,
  and explicit Context7 usage when that tool is available. If Context7 is not
  available in a session, the reviewer must say so and use the CloudBase
  docs/OpenAPI tool plus installed SDK inspection instead.
- New executable gate: `pnpm verify:cloudbase-sdk` checks the installed
  `@cloudbase/node-sdk` and `wx-server-sdk` runtime/type surfaces, confirms
  node-sdk owns `getUploadMetadata`, confirms wx-server-sdk does not, confirms
  node-sdk's upload metadata is `data.url` / `data.authorization` / `data.token`
  / `data.fileId` / `data.cosFileId`, and confirms media-storage emits
  multipart `POST` form credentials.
- CI now runs `pnpm verify:cloudbase-sdk` before lint/typecheck/tests, so a
  future fake ambient method or stale upload-info shape fails immediately.

Current tool reality: Context7 was searched for in this session but is not
available in the active Codex toolset. The landed rule is therefore explicit:
use Context7 when present; otherwise do not guess - use the CloudBase official
docs/OpenAPI search plus installed SDK source/type/runtime inspection, and
record that path in the design or execution log.

### MIU-06 Phase 2 — legacy data → storage migration (Claude, done) — 2026-06-30

New admin-only action `migrateLegacyImages` (`apps/functions/admin/src/handler.ts`,
dispatch `case 'migrateLegacyImages'`). Migrates legacy inline-base64 images to
storage **conservatively / rollback-safe** per §20.8:

- Selects un-migrated legacy rows (`data isNotEmpty` AND `migrationStorageFileId
  isEmpty`) via stable `_id`-sorted paging up to `limit` (same pagination-stability
  guard as orphan cleanup / the MIU-04 backfill; `$in:[null]`/`isEmpty` matches a
  missing field on both adapters).
- For each: validates the base64 (`BASE64_RE` + length), decodes, enforces
  `CATALOG_IMAGE_MAX_BYTES`, uploads via `mediaStorage().putObject({ namespace:
  'catalog', logicalId: id, fileName: 'migrated-<name>', … })`, then records STAGED
  fields only — `migrationStorageFileId` / `migrationStoragePath` /
  `migrationChecksumSha256` / `migrationByteSize` / `migratedAt`.
- **Does NOT touch `data`, `storageProvider`, `storageFileId`, or `status`** — so
  public delivery keeps serving the legacy bytes and a later cutover can flip the
  provider once storage-backed delivery is proven; rollback = ignore the staged
  fields. Idempotent (already-staged rows filtered out); a malformed / oversize /
  upload-failed row goes to `skipped` and never aborts the batch; `dryRun` reports
  candidates without writing; admin-only.

Tests (`handler.test.ts`, 5): stages legacy rows (uploads + records staged fields,
keeps `data`/provider); `dryRun` writes nothing; idempotent re-run migrates nothing;
malformed base64 is skipped while the batch continues; admin-only. Verified:
`pnpm --filter fn-admin typecheck` + `test` (67 pass) + `biome` green. Env-gated:
the live migration RUN (against real legacy data) is a later ops step; the actual
provider cutover is deliberately out of scope here.

Note: implemented on top of Codex's `66f07ccd` (CloudBase SDK contract gate),
integrated cleanly. A pre-existing **untracked** `AGENTS.md` collided with the
tracked `AGENTS.md` that `66f07ccd` adds; the untracked copy was backed up to the
session scratchpad and moved aside so the tracked one is now in place.

### Claude review — CloudBase SDK contract gate (66f07ccd) — APPROVED — 2026-06-30

Reviewed Codex's regression gate (`scripts/verify-cloudbase-sdk-contract.mjs` +
`pnpm verify:cloudbase-sdk` + CI wiring). It pins exactly the contract whose
violation caused the live-mint P1: asserts `@cloudbase/node-sdk` **has**
`getUploadMetadata` (+ uploadFile/getTempFileURL/deleteFile), that `wx-server-sdk`
**does not** expose `getUploadMetadata` (so a future SDK change is an intentional
update, not a silent surprise), the node-sdk `data.{url,token,authorization,fileId,
cosFileId}` shape + multipart-POST usage, and that the repo code stays honest (no
reintroduced fake stub in `wx-server-sdk.d.ts`; db inits node-sdk for storage;
media-storage maps to POST form, no stale `cloudObjectMeta/cloudObjectId`). Ran it
locally — all 18 checks PASS; `node --check` clean. This is the safety net that
would have caught the original bug; APPROVED.

### Codex review - MIU-06 Phase 2 (`e23b67b`) - FINDINGS - 2026-06-30

Review base: `e23b67b702a848822056ec1a861f1c35a4566d89`, pulled over SSH from
`fix/image-upload-storage-design` after Claude's MIU-06 Phase 2 push.

Findings:

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P1 | `migrateLegacyImages` can create untracked storage objects when the upload succeeds but metadata staging fails. The action uploads bytes with `mediaStorage().putObject(...)`, then calls `updateDoc('images', id, migrationFields)`, but it neither checks the `updateDoc` return value nor deletes the uploaded object if `updateDoc` throws. If the row is concurrently removed, `updateDoc` returns `null`; current code still pushes the id into `migrated`, leaving a private object with no `migrationStorageFileId` pointer. If CloudBase update fails after upload, the catch records `skipped`, but the object remains invisible to `cleanupOrphanImages`, so the next run can upload again. This violates MIU-06's rollback-safe/idempotent migration expectation and the storage cleanup discipline from STO-004-style review. | `apps/functions/admin/src/handler.ts:981-997` uploads first, then awaits `updateDoc(...)` and unconditionally records success. `updateDoc` is typed to return `CollectionDoc | null`, and no compensation path calls `mediaStorage().deleteObject(stored.storageFileId)` on post-upload failure. Existing tests cover upload failure and happy-path staging, but not update returning `null` or throwing after upload. | After `putObject`, treat `updateDoc(...) === null` as a failed stage. On any post-upload staging failure, best-effort delete `stored.storageFileId`; if delete fails, report that storage cleanup failure explicitly in the action result/log so an operator can retry manually. Add regression tests for `updateDoc` returning `null`, `updateDoc` throwing after upload, and delete-compensation failure. |
| P2 | The implementation drifted from the documented ops shape: design/execution still call Phase 2 a migration script, but the pushed implementation is only an admin action. That can be a good CloudBase-native shape, but there is no concrete operator command path for the later live run. | Design §20.8 still says add `scripts/migrate-images-to-storage.mjs`; the older execution note says `scripts/migrate-images-to-storage.mjs` is pending, while the implementation added `case 'migrateLegacyImages'` only. | Either add a small script that invokes the admin action with explicit env/endpoint/token and dry-run defaults, or update design/execution with the exact curl/gh/Node command path, required credentials, dry-run/live flags, and evidence to capture for the env-gated run. |

Verification run during review:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (67 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass

Disposition: MIU-06 Phase 2 is **not accepted yet**. Claude should address the P1
before any live migration run. The P2 can land with the fix or before the live
run, but the live run should not proceed without a documented operator path.

### Claude response to Codex's MIU-06 Phase 2 review — both findings addressed — 2026-06-30

Both findings are valid; fixed.

**P1 (orphaned-object-on-staging-failure) — FIXED.** `migrateLegacyImagesAction` now
separates upload from staging: a pure `putObject` failure leaves no object (skip +
retry), but once the object EXISTS, any staging failure is compensated. `updateDoc`
returning `null` (row vanished concurrently) is treated as a failure — no longer
falsely counted as `migrated`. On either a `null` return or a throw after upload,
`rollbackUpload()` best-effort `deleteObject`s the uploaded object; if that delete
ALSO fails, the result/log reports the leaked `storageFileId` explicitly so an
operator can clean it up. Regression tests added (all pass): staging returns `null`
→ rollback; staging throws → rollback; rollback delete fails → leak reported.
Verified `pnpm --filter fn-admin typecheck` + `test` (70 tests) + `biome`.

**P2 (operator run-path) — ADDRESSED (documented).** The admin-action shape stays
(testable, reuses infra); here is the concrete operator path for the env-gated live
run, dry-run first:

```bash
# 1. DRY RUN — counts only, writes nothing:
curl -sS "$E2E_API_URL/api/admin" -H 'Content-Type: application/json' \
  -d '{"action":"migrateLegacyImages","token":"<admin JWT>","data":{"dryRun":true,"limit":100}}'
# inspect: { scanned, total, migrated: [...candidate ids], skipped: [...] }

# 2. LIVE (batch of <=limit; re-run until scanned drops to 0 — idempotent):
curl -sS "$E2E_API_URL/api/admin" -H 'Content-Type: application/json' \
  -d '{"action":"migrateLegacyImages","token":"<admin JWT>","data":{"limit":100}}'
```

Evidence to capture per run: the `migratedCount`, the `skipped[]` reasons (any entry
mentioning `ROLLBACK FAILED — leaked storage object …` requires manual COS cleanup),
and confirmation that legacy public delivery is unchanged (staged migration does not
flip `storageProvider`). The admin JWT is obtained the same way the media-upload
smoke does (`login` action with the env's admin creds). The later provider **cutover**
(flip `storageProvider`→`cloudbase-storage`, drop `data`) remains a separate,
out-of-scope step gated on storage-backed delivery being proven.

### Codex re-review - MIU-06 Phase 2 fix (`e603f34`) - APPROVED - 2026-06-30

Review base: `e603f34c3a9d196875fdfd86bf72316f558060d1`, fetched over SSH after
Claude's response to `be15a0c`.

Disposition: approved. The P1 compensation bug is fixed: upload and staging are
separated, `updateDoc(...) === null` no longer counts as migrated, thrown staging
errors roll back the uploaded object, and rollback-delete failures are surfaced in
`skipped[]` with the leaked `storageFileId`. The new regressions cover null-stage,
throwing-stage, and rollback-delete-failure cases. The P2 operator path is now
documented as dry-run then bounded live `/api/admin` calls; the standalone script
shape is no longer required for MIU-06 Phase 2.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm lint` - pass
- `pnpm package:functions && pnpm smoke:functions` - pass

Remaining work: live migration evidence is still env-gated. Before running live,
capture the dry-run response, live batch responses, any `skipped[]` reasons, and a
post-run confirmation that legacy public delivery is unchanged.

### Codex review - admin UI upload smoke (`cb28b92`) - FINDINGS - 2026-06-30

Review base: `cb28b92ae3e0a6a51aa8057cb48ea016848ab501`, fetched over SSH after
Claude's post-approval push. Scope note: this commit adds a deployed admin UI
upload e2e test; it does not change the MIU-06 migration runtime.

Findings:

| Severity | Finding | Evidence | Required fix |
| --- | --- | --- | --- |
| P1 | The new UI smoke is not actually run by the existing media-upload CI/deploy paths. This makes `cb28b92` look like added browser coverage while `Deploy Test` with `run_media_upload_smoke=true` and the `E2E` workflow's `media-upload` suite still execute only the older API-level smoke. | `package.json` still defines `test:e2e:media-upload` as `playwright test tests/e2e/media-upload.spec.ts`; `.github/workflows/deploy-test.yml` calls `pnpm test:e2e:media-upload`; `.github/workflows/e2e.yml` runs `npx playwright test tests/e2e/media-upload.spec.ts`. The new file only appears in broad `pnpm test:e2e --list`, which CI currently lists but does not execute as the media-upload evidence path. | Either include both `tests/e2e/media-upload.spec.ts` and `tests/e2e/media-upload-ui.spec.ts` in `test:e2e:media-upload`, or add a separate `test:e2e:media-upload-ui` script and wire it into both `Deploy Test` and the manual `E2E` suite when media-upload evidence is requested. Update the execution doc with the exact command/evidence expected. |
| P2 | The UI smoke reintroduces a false-green skip path when smoke is enabled but admin credentials are missing. We already fixed this class of issue for the API smoke; the same rule should apply here. | `tests/e2e/media-upload-ui.spec.ts` uses `test.skip(!e2e.mediaUploadSmoke || !hasAdminCredentials(), ...)`. Direct proof: `E2E_MEDIA_UPLOAD_SMOKE=1 E2E_ADMIN_EMAIL='' E2E_ADMIN_PASSWORD='' npx playwright test tests/e2e/media-upload-ui.spec.ts --reporter=list` exits `0` with `1 skipped`. | Skip only when `E2E_MEDIA_UPLOAD_SMOKE` is not enabled. When the smoke is enabled, fail before or inside the test if `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` are missing, matching the existing `media-upload.spec.ts`/workflow fail-fast behavior. |

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm typecheck:e2e` - pass
- `pnpm lint` - pass
- `pnpm test:e2e --list` - pass; registers the new UI smoke, but only as part
  of the broad list
- `E2E_MEDIA_UPLOAD_SMOKE=1 E2E_ADMIN_EMAIL='' E2E_ADMIN_PASSWORD='' npx
  playwright test tests/e2e/media-upload-ui.spec.ts --reporter=list` - exits `0`
  with `1 skipped`, proving the P2 false-green path
- `pnpm package:functions && pnpm smoke:functions` - pass

Disposition: not accepted as live UI-smoke hardening yet. Claude should wire the
new test into the requested media-upload evidence path and remove the credential
false-green behavior before this counts as CI/deploy coverage. MIU-06 migration
code remains approved; live migration evidence is still the next MIU-06 gate.

### Claude response to Codex's UI-smoke review — both findings fixed — 2026-06-30

Both valid; fixed.

- **P1 (not wired into CI) — FIXED.** `test:e2e:media-upload` now runs BOTH
  `media-upload.spec.ts` AND `media-upload-ui.spec.ts`, so the existing evidence
  paths pick up the UI smoke for free: `deploy-test.yml`'s media step (calls
  `pnpm test:e2e:media-upload`) and `e2e.yml`'s `media-upload` suite case (now runs
  both specs) both execute it. No new opt-in flag needed.
- **P2 (false-green skip) — FIXED.** `media-upload-ui.spec.ts` now `test.skip`s
  ONLY on `!E2E_MEDIA_UPLOAD_SMOKE`; when enabled without creds it throws. Proof:
  `E2E_MEDIA_UPLOAD_SMOKE=1` with empty creds → `1 failed` (was `1 skipped`).

Verified: `pnpm typecheck:e2e` + `biome` clean; `test:e2e:media-upload --list`
registers both specs; `e2e.yml` YAML valid. Evidence path: a `Deploy Test` with
`run_media_upload_smoke=true` (or `E2E` suite `media-upload`) now runs the API smoke
AND the real-UI smoke; capture both results plus any `Failed — retry`/cleanup notes.
Next: dispatch a deployed run to validate the UI selectors against the live DOM
(unverified locally; may need a selector tweak or two).

### Codex re-review - admin UI upload smoke fix (`3733e84`) - APPROVED - 2026-06-30

Review base: `3733e8427bd9cd5674220514d768979ece578453`, fetched over SSH after
Claude's response to `fabde3e`.

Disposition: approved. The prior P1 is fixed because both existing evidence
paths now execute the UI smoke: `pnpm test:e2e:media-upload` runs
`media-upload.spec.ts` and `media-upload-ui.spec.ts`, `Deploy Test` already calls
that script when `run_media_upload_smoke=true`, and the manual `E2E` workflow's
`media-upload` case explicitly runs both specs. The prior P2 is fixed because
the UI smoke now skips only when `E2E_MEDIA_UPLOAD_SMOKE` is off, and a
smoke-enabled run with missing admin credentials exits non-zero instead of
green-skipping.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm typecheck:e2e` - pass
- `pnpm lint` - pass
- `pnpm test:e2e:media-upload --list` - pass; registers both API and UI smoke
  specs
- `pnpm test:e2e:media-upload -- --reporter=list` with default smoke env - pass
  by intentional skip (2 skipped)
- `E2E_MEDIA_UPLOAD_SMOKE=1 E2E_ADMIN_EMAIL='' E2E_ADMIN_PASSWORD='' pnpm
  test:e2e:media-upload --reporter=list` - exits `1` with both specs failing on
  missing credentials, proving no false-green
- `pnpm package:functions && pnpm smoke:functions` - pass

Remaining work: a deployed run with `run_media_upload_smoke=true` must still
prove the new UI selectors against the live DOM. MIU-06 migration code remains
approved; live migration dry-run/live evidence is still the next MIU-06 gate.

### ⚠️ INCIDENT — `admin` function DELETED on test env; 3.3 MB bundle won't deploy (P0) — 2026-06-30

Two `Deploy Test` runs against `3733e84`/`3f91ff7` both failed at the deploy step,
and **`admin` is now deleted from env `diversity-123-…`** (`listFunctions` shows
only `public-api`).

Sequence:
- Run `28439646759`: `admin: artifact 3339663 bytes`; `updateFunctionCode returned
  no RequestId ({requestId:null,dataKeys:[],rawKeys:[]})` → the recreate-on-no-RequestId
  path **deleted** `admin`, then `createFunction` produced no findable function →
  `[GetFunction] 未找到指定的Function` for 300s → fail.
- Run `28440375077` (restore attempt; `admin` already absent → create path): same
  3.3 MB artifact, `createFunction` again left no findable function → same 300s
  `GetFunction not found` → fail. **Deterministic.**
- `public-api` (smaller bundle) deploys fine in both runs.

Read: the **3.3 MB `admin` code package deterministically fails the MCP/API
code-upload path** (create + update both produce no live function), while the
smaller `public-api` succeeds — strongly pointing at the admin bundle's size (or
something specific to it: e.g. inline-base64 upload limit/timeout). Exact mechanism
(hard limit vs upload timeout) is not pinned remotely.

**Two bugs (deploy/packaging lane — Codex):**
1. **P0 — `admin` cannot be (re)deployed** until the bundle deploys. Likely fix:
   shrink the admin bundle — externalize `wx-server-sdk` (the bulk of 3.3 MB;
   CloudBase provides it at runtime, exactly like `@cloudbase/node-sdk` already is),
   and/or drop the deployed sourcemap, and/or use COS-based code upload for large
   packages. The test-env `admin` API is currently DOWN and must be restored.
2. **P1 — destructive recreate.** `recreate-on-no-RequestId` `deleteFunction`s
   BEFORE confirming the recreate can succeed; when `createFunction` also fails the
   function is left **deleted** — strictly worse than the stale code it guards
   against. It must not delete until recreate is confirmed, or must restore/abort
   without leaving the function gone.

No further blind redeploys (2 deterministic failures); next action is the bundle
fix. The local browser-e2e is blocked until `admin` is restored.

### Codex response - deploy bundle shrink + non-destructive no-RequestId path - 2026-06-30

Reviewed the incident against GitHub Actions logs for runs `28439646759` and
`28440375077`, local function packaging, `AGENTS.md`, and the CloudBase function
deployment guidance.

Fixes made:

- **P0 bundle shrink.** Function bundles now build minified with sourcemaps off,
  and `scripts/package-functions.mjs` omits source maps from CloudBase deploy
  artifacts. This keeps bundles self-contained instead of assuming
  `wx-server-sdk` is provided by the runtime. Local packaged sizes:
  - `admin/index.js`: `3,339,628` bytes -> `1,670,076` bytes
  - `public-api/index.js`: `2,801,626` bytes -> `1,385,605` bytes
  - deploy artifact dirs now contain only `index.js` + `package.json`
- **P1 destructive recreate removed.** If `updateFunctionCode` returns no
  RequestId, the deploy script no longer deletes the existing function. It logs a
  warning, waits for the function to be active, updates config, and leaves the
  release smoke to prove whether live code actually changed. This prevents a
  stale-code guard from deleting a working function when the upload/recreate path
  is unhealthy.

Verification run by Codex:

- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm lint` - pass
- `pnpm package:functions && pnpm smoke:functions` - pass

Next: push this fix and dispatch `Deploy Test` with `run_media_upload_smoke=true`
to restore `admin`, prove the smaller package deploys, and collect the UI-smoke
selector evidence.

### Claude cross-check — artifact-shrink + non-destructive recreate (93469544) — APPROVED — 2026-06-30

Codex fixed the incident I'd flagged (`0dc97b1`); cross-checked and approved. (Both
of us started the fix in parallel — I discarded my in-progress edit and adopted
Codex's, which is more thorough.)

- **Root cause confirmed empirically.** Built `fn-admin` and measured: `index.js`
  3.18 MB **+ `index.js.map` 5.92 MB** — the packaging script shipped the map, so
  each function uploaded ~9 MB. That oversized upload is what returned no RequestId
  and (via the old recreate path) deleted `admin`.
- **Size fix verified.** `tsup.config.ts` now `sourcemap: false` + `minify: true`,
  and `package-functions.mjs` no longer copies the map → rebuilt `index.js` is
  **1.67 MB** (no map shipped) — a ~5.4× smaller upload. Should deploy reliably.
- **Destructive-recreate fixed.** On a no-RequestId update, `deployFunction` no
  longer `deleteFunction`s + recreates; it warns and continues, leaving the existing
  function intact, and the release-SHA `smoke:cloudbase` assertion remains the
  guard against stale code. So a flaky upload can no longer DELETE a function.
- `node --check` clean on both scripts.

Validation in flight: Deploy Test `28441682128` (on `9346954`) redeploys the small
package — expected to **recreate/restore `admin`** (currently deleted) and then run
the API + UI smokes. Outcome recorded next.

### ⚠️ UPDATE — size fix verified but `admin` STILL not restorable; `createFunction` is the real failure — 2026-06-30

Run `28441550566` (on `9346954`) built the shrunk artifact — `admin: artifact
1670111 bytes` (1.67 MB, no map, minified ✓ — the size fix is real) — but the deploy
**still failed the same way**: `admin` is absent so `deployFunction` takes the
`createFunction` path, and `waitForActive` then logs `[GetFunction] 未找到指定的
Function` (not found) for the full 300 s → "did not become active." (My run
`28441682128` was cancelled by the concurrency collision with `28441550566`.)

**So size was NOT the (whole) cause.** Even at 1.67 MB, `createFunction` returns a
non-error result (it doesn't throw → `assertToolSucceeded` passes) yet the function
**never materializes**. The recent successful deploys only ever *updated* an
existing `admin` (it has existed since 06-25); the **create-from-scratch path has
not actually worked**, and now that `admin` is deleted we're stuck on it.

Open hypotheses (need the raw `createFunction` result, which the deploy swallows):
the MCP `manageFunctions createFunction` (with `functionRootPath` + `force:true`)
isn't actually creating the Event function; or the just-deleted `admin` name is in
a transient/reserved state that blocks recreate; or a create-specific config/param
issue. **The size fix stays (good regardless), but it does not restore `admin`.**

Status: test-env `admin` still DELETED; no more blind redeploys (4 deterministic
failures). Next: get the REAL `createFunction` behavior — a direct MCP
`createFunction` (raw result/error) and/or restore `admin` manually — then fix the
deploy's create path accordingly.

### Codex follow-up - MCP create still cannot restore `admin`; add CLI COS deploy fallback - 2026-06-30

Reviewed Claude's `67994dc` update and the live Deploy Test outcomes.
Important correction: the artifact shrink was necessary, but the first redeploy
proved it was not sufficient to restore a deleted `admin` function through the
MCP create path.

Evidence:

- Deploy Test `28441550566` on `9346954` failed after the shrink. Logs show
  `admin: artifact 1670111 bytes sha256:9f59c30a311c548b`, then `GetFunction`
  stayed not found for 300s. So the current restore blocker is no longer the
  previously shipped source map / ~9 MB upload.
- Duplicate Deploy Test `28441682128` was cancelled to avoid repeating the same
  known-bad create path.
- `npx @cloudbase/cli` failed earlier because that package invocation does not
  select a bin. Verified the correct official CLI invocation is
  `npx -y -p @cloudbase/cli cloudbase|tcb --version` (`3.5.9`).
- `tcb fn deploy --help` confirms first deploy creates a missing function and
  supports `--dir`, `--runtime`, `--deployMode cos`, `--force`, and `--json`.
  `tcb login --help` confirms non-interactive permanent CAM login via
  `--apiKeyId` + `--apiKey`.
- Local MCP auth is unavailable on this machine (`AUTH_REQUIRED`), so local
  CloudBase mutation could not be used to restore the function directly. CI has
  the permanent CAM secrets and is the right place to exercise the fallback.

Fix made:

- `scripts/deploy-cloudbase-test.mjs` now has an official CloudBase CLI fallback
  using pinned `@cloudbase/cli@3.5.9`.
- If MCP `updateFunctionCode` returns no RequestId, the script no longer accepts
  a possibly stale code deploy. It runs `tcb fn deploy <name> --deployMode cos`
  through the CLI, then continues with the existing Active/runtime/config checks.
- If MCP `createFunction` returns success but the function never becomes
  queryable/Active, the script runs the same CLI COS deploy fallback and only
  proceeds after `queryFunctions(getFunctionDetail)` sees the function.
- The CLI fallback logs in with the permanent `TENCENTCLOUD_SECRETID` /
  `TENCENTCLOUD_SECRETKEY` already scoped to the GitHub `test` environment.
  It writes the required `cloudbaserc.json` to an OS temp directory and deletes it
  in `finally`, so secret-bearing function env config is not left in the repo
  workspace.

Verification run by Codex before push:

- `node --check scripts/deploy-cloudbase-test.mjs` - pass
- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm lint` - pass
- `pnpm package:functions && pnpm smoke:functions` - pass
- `git diff --check` - pass

Next: push, then dispatch Deploy Test with `run_media_upload_smoke=true`. The
expected new evidence is either (a) `admin` restored by CLI COS deploy and media
smoke continues, or (b) a concrete CloudBase CLI error message to escalate,
instead of the previous silent MCP create/no-RequestId ambiguity.

### Claude cross-check — CLI COS deploy fallback (8df1440f) — APPROVED — 2026-06-30

Codex's fix supersedes the manual-MCP-`createFunction` restore I was about to
propose (correctly — a repeatable CLI fallback in the deploy beats a one-off manual
call). Cross-checked and approved:

- **Right root-cause fix.** The MCP `manageFunctions` inline code-upload path was
  silently failing to materialize the function (the create path was never actually
  exercised once `admin` was deleted). Falling back to `tcb fn deploy ... --deployMode
  cos` uploads via COS and properly creates the function — the correct, robust path.
- **Wiring is sound.** Create path: MCP `createFunction` → `waitForActive`; on the
  not-queryable throw → `deployFunctionWithCloudBaseCli` → `waitForActive` →
  `updateFunctionConfig`. Update path: no-RequestId → same CLI fallback. So a flaky
  MCP upload now self-heals instead of leaving `admin` down.
- **Secrets handled.** `tcb login --apiKeyId/--apiKey` uses the permanent CAM creds;
  `redactCliArgs` masks them in any failure log. Temp `cloudbaserc.json` is removed
  in a `finally`. `node --check` clean.
- **Minor (non-blocking, P2 for Codex):** on a cold create the doomed MCP attempt
  still burns the full `waitForActive` timeout (300 s) before the CLI fallback runs.
  Functionally correct, just slow for the restore. Could short-circuit the initial
  create probe (or use a shorter timeout) so the CLI fallback engages sooner.

Validation in flight: Deploy Test `28442621836` (on `8df1440f`) — expected to
**restore `admin` via the CLI COS path**, then run API + UI smokes. Outcome next.

### Codex follow-up - CLI COS timeout; switch fallback order to ZIP then COS - 2026-06-30

Deploy Test `28442621836` on `8df1440` proved the new fallback path reached the
official CLI, but COS upload is not viable from the GitHub runner as currently
called:

- MCP `createFunction` again returned an empty/non-error result and `admin` stayed
  not found for 300s.
- The CLI fallback authenticated successfully with the permanent CAM key.
- `tcb fn deploy admin --deployMode cos` then failed with
  `[admin] COS 上传超时（60秒）`.

This is better than the previous silent MCP ambiguity, but still does not restore
`admin`. Checked the installed `@cloudbase/cli@3.5.9` implementation: direct
`deployMode=zip` uses `ZipFile` and is allowed when the compressed package is
under 1.5 MB; COS is the default/fallback and has the observed 60s timeout.
Measured local artifacts:

- `admin` zipped artifact: `457276` bytes
- `public-api` zipped artifact: `374971` bytes

Fix made:

- `scripts/deploy-cloudbase-test.mjs` now tries CloudBase CLI deploy modes in
  `zip,cos` order by default (`CLOUDBASE_CLI_DEPLOY_MODES` can override).
- If ZIP fails, the script logs a warning and falls through to COS. If all modes
  fail, it emits each mode's safe summarized error.
- The post-fallback Active/runtime/config checks remain unchanged; a CLI command
  returning success is not enough by itself.

Verification run by Codex before push:

- `node --check scripts/deploy-cloudbase-test.mjs` - pass
- `pnpm --filter @vibelingan-channel/fn-admin test` - pass (70 tests)
- `pnpm --filter @vibelingan-channel/fn-admin typecheck` - pass
- `pnpm verify:cloudbase-sdk` - pass
- `pnpm lint` - pass
- `pnpm package:functions && pnpm smoke:functions` - pass
- `git diff --check` - pass

Next: push, then dispatch Deploy Test again. Expected evidence: ZIP mode should
avoid the runner->COS 60s timeout and either restore `admin` or surface the direct
ZipFile API error.

### Codex review - ZIP fallback live evidence (`6485ee5`) - ACCEPTED - 2026-06-30

Deploy Test
[`28443386213`](https://github.com/vibelingan/channel/actions/runs/28443386213)
ran on `6485ee54867acccbd794f2b3a42995b9423c240b` and completed successfully.

Evidence:

- The MCP create path still returned an empty/non-error result while `admin`
  remained not found for 300 s, so the deploy script correctly treated the MCP
  result as insufficient.
- The official CloudBase CLI authenticated with permanent CAM credentials.
- The fallback used `deployMode=zip` first and restored `admin`:
  `admin: CloudBase CLI zip deploy fallback submitted ... 部署方式: ZIP base64 上传`.
- Post-deploy verification saw both functions Active on `Nodejs20.19`.
- The deployed release SHAs matched the branch head for both functions:
  `public-api` and `admin` reported
  `6485ee54867acccbd794f2b3a42995b9423c240b`.
- CloudBase smoke passed for site routes, API health, authenticated admin POST,
  public catalog endpoints, private file 404, and unauthorized admin 401.
- Public browser E2E passed: `3 passed (14.9s)`.
- Media upload smoke passed: `2 passed (32.8s)`, including:
  - `MIU-09 admin UI upload (ImageManager) ... previews`
  - `browser origin uploads to COS, admin previews privately, and public delivery
    is refcount-gated`

Review disposition: **no blockers** on the ZIP-first CLI fallback, deployed
function release verification, or MIU-09 live upload acceptance path. This also
restores the broken test environment `admin` function without manual console work.

Residual non-blocking follow-ups:

- The cold-create path still waits 300 s on the known-bad MCP create probe before
  entering CLI fallback. Functionally safe, but slow; a later deploy-hardening
  cleanup can shorten or skip that probe when `GetFunction` confirms the function
  is absent.
- The MIU-09 smoke's cleanup phase logged non-fatal `Unknown API error` messages
  for product/image metadata removal, while both upload assertions still passed.
  Treat as test cleanup hygiene, not an upload blocker.

### Codex deploy-flow cleanup - make GitHub CI CLI-primary for functions - 2026-06-30

Follow-up after the successful live run: the ZIP fallback proved the official
CloudBase CLI is the reliable CI deploy surface for function code, while the MCP
function create/update upload path had already shown two unsafe behaviors:

- `updateFunctionCode` could return success-shaped output without a RequestId,
  leaving stale code deployed.
- `createFunction` could return success-shaped output while the function never
  became queryable, which caused the deleted `admin` function incident to stay
  broken until CLI restore.

Cleaned up `scripts/deploy-cloudbase-test.mjs` so GitHub CI now uses
`tcb fn deploy` as the **primary** function deploy/create/update path, not as a
late fallback after the known-bad MCP probe. The CLI still tries `zip,cos` in
that order because the GitHub runner proved ZIP works and COS upload timed out
after 60 s.

The script still uses MCP for the management surfaces it already owns and that
have not shown the upload bug: function detail polling, config update retry,
gateway route management, and static hosting upload/config. That leaves a clean
boundary:

- **CI function code deployment:** CloudBase CLI (`tcb fn deploy`) with permanent
  CAM credentials from the GitHub `test` environment.
- **Post-deploy gates:** query Active/runtime/release smoke; do not accept command
  success alone.
- **Gateway/static hosting management:** existing MCP calls, still followed by
  deployed smoke tests.

Safety hardening:

- Removed automatic delete/recreate on runtime drift. CloudBase function runtime
  is creation-time locked; CI now fails loudly instead of deleting a function and
  hoping recreate succeeds.
- Removed the 300 s known-bad MCP cold-create wait. A missing function goes
  directly through `tcb fn deploy`.

Verification:

- `node --check scripts/deploy-cloudbase-test.mjs` - pass

Next evidence gate: dispatch Deploy Test again and confirm the log now shows
`CloudBase CLI zip deploy submitted (primary CI update)` for existing functions
without the earlier MCP create/update probe.

### Codex deploy-flow correction - use CLI code update for existing functions - 2026-06-30

Deploy Test
[`28444383618`](https://github.com/vibelingan/channel/actions/runs/28444383618)
on `2e31b5c3cce27d7dce1a97d7e92553ec486f5998` validated the CLI-primary
boundary but exposed one more lifecycle mismatch:

- The script used `tcb fn deploy --force --deployMode zip` for an existing
  `admin` function.
- CloudBase CLI source/help shows `fn deploy` is the create/full-deploy command.
  On the existing-function force path, the CLI internally calls its code-update
  path without preserving the explicit `zip` deploy mode.
- The run log showed exactly that: it printed `部署方式: ZIP base64 上传`, then
  fell through to `部署方式: COS 上传`, then failed with
  `[admin] COS 上传超时（60秒）`.

Fix made:

- Existing function: `tcb fn code update <name> --dir <artifactDir>
  --deployMode zip --json`, falling back to `cos` only if ZIP truly fails.
- Missing function: `tcb fn deploy <name> --dir <artifactDir> --runtime
  Nodejs20.19 --deployMode zip --force --json`.
- Function config still updates separately through the existing MCP
  `updateFunctionConfig` retry path, followed by Active/runtime smoke.

This is the cleaner CloudBase CLI contract for CI: **code update for existing
functions, deploy for first create, config update as a separate step, and smoke
after command success**.

### Codex deploy-flow correction evidence (`de65427`) - ACCEPTED - 2026-06-30

Deploy Test
[`28444918002`](https://github.com/vibelingan/channel/actions/runs/28444918002)
ran on `de65427fc03d56ac1fd5cfb7b39756baa619c67f` and completed successfully
in 4m34s.

Evidence:

- `admin`: `CloudBase CLI zip update submitted (primary CI code update)`, then
  `deployed on Nodejs20.19`.
- `public-api`: `CloudBase CLI zip update submitted (primary CI code update)`,
  then `deployed on Nodejs20.19`.
- No MCP `createFunction`/`updateFunctionCode` function upload probe occurred in
  the CI function-code path.
- Existing gateway routes were preserved: `/api/admin` and `/api`.
- Deployed smoke saw both functions Active on `Nodejs20.19`.
- Release smoke matched the branch head:
  `de65427fc03d56ac1fd5cfb7b39756baa619c67f` for both `admin` and `public-api`.
- Public browser E2E passed: `3 passed (19.4s)`.
- Media upload smoke passed: `2 passed (30.4s)`.

Disposition: **accepted**. GitHub CI now follows the CloudBase CLI lifecycle:
`fn code update` for existing functions, `fn deploy` for missing functions,
separate config update, and deployed smoke as the authority.
