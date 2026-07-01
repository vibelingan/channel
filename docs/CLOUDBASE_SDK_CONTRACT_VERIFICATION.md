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

- `wx-server-sdk@3.0.4` exposes the DB surface and storage helpers such as
  `uploadFile`, `downloadFile`, `getTempFileURL`, and `deleteFile`, but not
  `getUploadMetadata`.
- `@cloudbase/node-sdk@2.10.0` exposes `getUploadMetadata({ cloudPath })`.
- The node-sdk wrapper returns `{ data: { url, authorization, token, fileId,
  cosFileId, download_url } }`.
- The node-sdk's own upload path uses multipart `POST` form fields
  `Signature`, `x-cos-security-token`, `x-cos-meta-fileid`, `key`, and `file`.

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
- node-sdk storage implementation uses multipart `POST` with the expected COS
  form fields.
- the local `wx-server-sdk.d.ts` does not reintroduce a fake
  `getUploadMetadata`.
- `packages/media-storage/src/cloudbase.ts` consumes the node-sdk data shape and
  emits POST form credentials, not stale PUT/header credentials.

## Review Standard

A review that only runs `tsc` is not sufficient for CloudBase SDK-boundary work.
The reviewer must look for these failure modes:

- hand-written declarations claiming runtime methods that do not exist;
- raw OpenAPI response shapes copied into SDK-wrapper code without wrapper proof;
- method/transport confusion such as raw `PUT` versus signed multipart `POST`;
- one SDK object used as a structural substitute for another SDK object;
- direct browser auth assumptions that are not proven in the current CloudBase
  environment.

If any of those appear, stop the implementation path and ask for contract
evidence before continuing.
