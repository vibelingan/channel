# CloudBase Provider Notes

These notes capture the Channel image/OEM upload lessons. Re-check the current
CloudBase skill and installed packages before reusing them in another app.

## Known Boundaries

- CloudBase HTTP-access JSON routes can have small request body caps. In Channel,
  `/api/admin` effectively rejected realistic media with
  `EXCEED_MAX_PAYLOAD_SIZE` around the 100 KiB body range.
- Base64 expands bytes by roughly one third, so JSON/base64 loses capacity before
  the raw file reaches the route limit.
- CloudBase Storage direct upload should move bytes out of the function request
  body. The function should mint upload metadata and finalize with small JSON.

## SDK Contract

Do not assume one CloudBase SDK object has every storage method.

- `wx-server-sdk` in the Channel runtime exposed DB helpers and storage helpers
  such as upload/download/temp-url/delete, but did not expose
  `getUploadMetadata`.
- `@cloudbase/node-sdk@2.10.0` exposed `getUploadMetadata({ cloudPath })`.
- The node-sdk wrapper returned data shaped like
  `{ url, authorization, token, fileId, cosFileId, download_url }`.
- The browser upload used multipart POST form fields, not a stale raw PUT/header
  contract.
- `wx-server-sdk` command-based atomic increment was not honored in the deployed
  runtime even though plain updates worked. Route atomic counters and
  single-winner claims through the verified native CloudBase node SDK, and prove
  them with a deployed smoke.

Mandatory gate when touching CloudBase media/storage SDK code:

```bash
pnpm verify:cloudbase-sdk
```

Also inspect the installed packages and declarations. A hand-written `.d.ts`
file is never the source of truth. If live library docs such as Context7 are
available, use them; otherwise use the CloudBase official docs/knowledge base
plus installed package inspection, and record that Context7 was unavailable.

## Direct Upload Shape

1. Function receives file metadata only.
2. Function validates purpose/type/declared size/rate limits.
3. Function calls the verified node-sdk upload-metadata path.
4. Function writes a `pending` metadata row with a server-chosen storage path.
5. Browser posts bytes directly to the returned COS URL and fields.
6. Function finalizes by claiming once, verifying object bytes or metadata, then
   activating the row.

Current Channel limitation: the verified `getUploadMetadata` path did not bind a
`content-length-range` condition. Enforce max size at finalization and delete or
fail over-cap landed objects. If switching to lower-level COS/STS, re-prove the
policy shape and update the design.

## Public OEM Uploads

Public unauthenticated intent creation is an abuse surface. Add:

- short intent TTL;
- per-source or best-available rate limit;
- max concurrent pending intents;
- one-time upload secret stored only as a hash;
- server-generated `oem/` path;
- expired pending sweep that deletes storage objects;
- server-side size/checksum/magic-byte verification before activation.
- denials as `429` with `Retry-After`, with the header exposed through CORS when
  browser clients need to read it.

## Private Delivery

- Admin/private previews should not expose durable raw storage URLs in the DOM.
- If using CloudBase temp URLs, return them as a short-lived contract and do not
  store them.
- For attachment downloads where the temp URL cannot set
  `Content-Disposition`, fetch the temp URL as a `Blob` and save it with
  `<a download>` using the sanitized filename returned by the app action.
- CloudBase bucket CORS/security-domain must allow the deployed site origin for
  browser upload POST and temp-url GET paths.
- Browser code cannot set `Content-Length`; do not list it as a required
  frontend/CORS header. Configure/verify the headers the browser actually
  preflights, such as the COS signature/security-token metadata headers and
  `Content-Type` when used.
- Managed CloudBase storage buckets may appear under the CloudBase bucket view
  rather than the generic COS bucket list. Verify the platform-specific storage
  view or API before assuming the bucket is missing.

## Deployment And Ops

- For CI/CD function code deployment, prefer the deterministic CloudBase CLI
  path with permanent scoped CAM credentials.
- Use MCP for IDE/resource management, inspection, and setup where appropriate,
  but do not make CI depend on interactive device-auth or ambiguous MCP upload
  behavior.
- Record deployed release SHA and function health after deploy. A green local
  build is not enough evidence for SDK/runtime behavior.
- Do not paste CAM SecretKeys or STS credentials into chat. Set GitHub
  environment secrets directly through a secure local/console path. When moving
  from STS to permanent CAM keys, remove stale `TENCENTCLOUD_SESSIONTOKEN` so
  the SDK/CLI does not try an expired session token first.
