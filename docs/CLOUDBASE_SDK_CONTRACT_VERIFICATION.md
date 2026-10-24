# CloudBase SDK Contract Verification

Status: mandatory workflow for CloudBase SDK / Storage / Function changes.
Owner: media/storage implementation and reviews.

## Why This Exists

MIU-09 exposed a serious SDK-boundary mistake: the upload design and first
implementation treated `wx-server-sdk` as if it exposed `getUploadMetadata`.
TypeScript accepted that only because our hand-written `wx-server-sdk.d.ts` said
so. The deployed runtime then failed at the first real mint with
`sdk.getUploadMetadata is not a function`.

The real contract is split:

- `wx-server-sdk@4.0.2` exposes the DB surface and storage helpers such as
  `uploadFile`, `downloadFile`, `getTempFileURL`, and `deleteFile`, but not
  `getUploadMetadata`.
- `@cloudbase/node-sdk@3.17.2` exposes `getUploadMetadata({ cloudPath })`.
- The node-sdk wrapper returns `{ data: { url, authorization, token, fileId,
  cosFileId, download_url } }`.
- **The upload verb is PUT, and the verb is the whole contract.** node-sdk 3.x
  asks the control plane to sign the upload for `method: 'put'`, then sends the
  raw bytes with `PUT` carrying `Signature`, `x-cos-security-token`,
  `x-cos-meta-fileid`, a lowercase `authorization` duplicate of `Signature`, and
  a URI-encoded `key` as request HEADERS — no multipart form, no `file` part.

  Under node-sdk 2.10.0 this was a multipart `POST` with those same names as
  FORM FIELDS. Upgrading to 3.17.2 while still sending the multipart POST makes
  COS reject every upload with `403 SignatureDoesNotMatch`: the signature is
  scoped to the verb. This is not hypothetical — it shipped, and it was caught
  only by a deployed upload smoke (Deploy Test run 31063836951), never by
  `tsc`, unit tests, or the public read-only browser suite.

Raw CloudBase Storage OpenAPI docs are still useful, but they are not a
substitute for checking the installed SDK wrapper. The raw OpenAPI upload-info
shape can differ from the node-sdk wrapper shape.

## Required Workflow

Use this checklist before design approval and again before implementation merge
whenever CloudBase SDKs, storage contracts, or ambient SDK types are touched.

1. Read the relevant local skill.
   - Start with the CloudBase skill.
   - Add the Cloud Functions, Cloud Storage, web, or auth reference skill that
     matches the actual change.

2. Check current official docs.
   - Prefer Context7/live library docs if that tool is available in the session.
   - If Context7 is not available, explicitly say so and use CloudBase's official
     docs/OpenAPI source through `mcp__cloudbase.searchKnowledgeBase`.
   - For storage upload metadata, check both:
     - CloudBase Storage OpenAPI upload-info docs.
     - CloudBase server/node SDK storage docs or installed SDK wrapper docs.

3. Inspect the installed package that production will bundle or execute.
   - Run `pnpm list @cloudbase/node-sdk wx-server-sdk -r --depth 3`.
   - Inspect resolved package versions and files under `node_modules`.
   - Confirm runtime methods with a no-network Node probe where practical.
   - Confirm TypeScript declarations match the runtime method surface.

4. Keep SDK surfaces separate.
   - `wx-server-sdk` remains the DB adapter boundary unless the installed runtime
     proves otherwise.
   - Upload-metadata minting uses the explicit `@cloudbase/node-sdk` app
     injection.
   - Do not make a broad composite type that claims one SDK has another SDK's
     methods.

5. Never let hand-written declarations become the source of truth.
   - Ambient declarations may describe only observed runtime methods used by this
     repo.
   - A `.d.ts` addition must cite the installed runtime package and should have a
     contract check or unit test.

6. Add or update an executable gate.
   - For this media path, run `pnpm verify:cloudbase-sdk`.
   - If a future SDK change intentionally alters the contract, update the script,
     the design doc, and the execution log in the same change.

## Current Enforced Gate

`pnpm verify:cloudbase-sdk` checks the installed packages and local integration:

- `@cloudbase/node-sdk` app exposes `getUploadMetadata`.
- `wx-server-sdk` does not expose `getUploadMetadata`.
- node-sdk declarations include `url`, `authorization`, `token`, `fileId`, and
  `cosFileId` inside the upload metadata data item.
- node-sdk `uploadFile` sends the BYTES with `PUT`, carries the credential in
  headers, and uses no multipart form. This assertion is extracted from the
  `uploadFile` FUNCTION BODY, never grepped from the whole module: the earlier
  probe scanned the entire file for a POST and matched the control-plane
  `storage.getUploadMetadata` request — which is legitimately a POST — so it
  certified a multipart upload contract while the SDK was PUTting bytes.
- node-sdk requests the upload signature scoped to `put`.
- the local `wx-server-sdk.d.ts` does not reintroduce a fake
  `getUploadMetadata`.
- `packages/media-storage/src/cloudbase.ts` consumes the node-sdk data shape and
  emits `PUT` + header credentials matching the installed SDK.
- the application's own two sides are pinned so they cannot drift apart
  silently: `UploadCredential` is a PUT/headers contract with no `formFields`,
  and the browser client sends `intent.upload.headers` with a raw body rather
  than a `FormData`.

## Review Standard

A review that only runs `tsc` is not sufficient for CloudBase SDK-boundary work.
The reviewer must look for these failure modes:

- hand-written declarations claiming runtime methods that do not exist;
- raw OpenAPI response shapes copied into SDK-wrapper code without wrapper proof;
- method/transport confusion such as raw `PUT` versus signed multipart `POST`
  — and, just as important, a CONTRACT PROBE that matches the wrong request:
  assert the verb inside the specific function that sends the bytes, because a
  module-wide grep will happily match an unrelated control-plane call;
- one SDK object used as a structural substitute for another SDK object;
- direct browser auth assumptions that are not proven in the current CloudBase
  environment.

If any of those appear, stop the implementation path and ask for contract
evidence before continuing.
