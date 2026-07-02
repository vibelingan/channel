---
name: image-upload-storage
description: Design, implement, or review storage-backed image and file upload flows for web apps. Use when replacing base64/JSON uploads, choosing direct-to-storage or server-upload transport, building upload intents and finalization, private media previews/downloads, cleanup/migration, object storage integration, SDK contract verification, deployed upload smoke tests, or purpose/type/size upload policy.
---

# Image Upload Storage

## Overview

Use this skill to build upload flows where file bytes, metadata, privacy, and
cleanup have to remain coherent. The default target is a small JSON control
plane plus storage-backed byte transport, with base64 only for explicit tiny
inline or legacy compatibility paths.

## Workflow

1. Classify the upload by purpose first, file type second, and size third.
   Do not let a small product/OEM/business file fall back to base64 just because
   it is small. Read `references/policy-and-transport.md`.

2. Measure the real infrastructure boundary before approving the design.
   Check HTTP body caps, function runtime limits, browser origin/CORS rules,
   auth model, object storage upload APIs, provider SDK versions, and deployed
   routing. Treat a local success as incomplete until the deployed path is
   proven.

3. Choose a byte transport and keep metadata on a separate path.
   Prefer direct-to-storage upload when files are user-selected objects and the
   backend only needs to mint credentials and finalize. Use server upload only
   when the route can safely carry the target byte size. Use base64 only through
   an explicit `inline-small` or legacy action.

4. Model lifecycle before code.
   Define states such as `pending`, `active`, `failed`, and `deleted`; store
   durable storage identifiers, size, checksum, MIME, purpose, owner/reference,
   expiry, and intent identifiers. Read `references/lifecycle-and-cleanup.md`.

5. Build an intent/finalize protocol.
   The server chooses the storage path, mints a short-lived credential, stores a
   pending row, the browser uploads bytes to storage, and finalization verifies
   the stored object before activation. Finalization must be single-winner.

6. Keep delivery boundaries explicit.
   Public media delivery is publish/ref-count gated. Private previews/downloads
   must authenticate through an app route or use a short-lived signed URL
   contract; browser UIs should fetch bytes into `Blob` object URLs and revoke
   them.

7. Verify provider contracts with runtime evidence.
   Do not trust hand-written TypeScript declarations, old memory, or raw
   OpenAPI shapes alone. Inspect the installed SDK that production bundles, run
   the repo's provider contract gate, and record the evidence.

8. Prove deployed behavior.
   Evidence should include the deployed release SHA, a near-policy-size upload,
   network proof that the JSON/API route only carries metadata, CORS/private
   delivery proof, cleanup/failure cases, and a no-flake or clearly qualified
   smoke result.

9. Keep the review and ops path visible.
   For shared branches, remote agents, CI credentials, deployed smoke, or
   monitoring loops, read `references/operations-and-review.md`. Background
   health checks should not replace visible review findings and should be
   stopped when they become context noise.

## Provider Notes

For CloudBase/COS implementations, read
`references/provider-cloudbase.md` before approving design or code. For other
object storage providers, keep the same policy/lifecycle/review shape and
replace the provider-specific credential, CORS, SDK, and deployment checks.

## Review Checklist

Before calling the upload work done, run through
`references/review-checklist.md`. A review that only checks `tsc` is not enough
for storage SDK boundaries, private media delivery, direct browser uploads, or
cleanup of pending objects.
