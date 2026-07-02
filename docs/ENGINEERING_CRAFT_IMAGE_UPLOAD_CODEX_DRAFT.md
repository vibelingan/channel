# Image Upload Engineering Craft - Codex Draft

Status: draft material from the Codex review/implementation session. This file
is intentionally additive and does not replace `docs/ENGINEERING_CRAFT.md`.
Use it as merge material for the canonical engineering-craft guide and for
future upload implementation skills.

## What Happened

The original upload path sent image/file bytes as base64 inside `/api/admin`
JSON. That worked for tiny fixtures but failed for real product/OEM files
because the deployed CloudBase HTTP body limit was far below normal media size.
Base64 overhead made the practical cap even smaller.

The durable direction was storage-backed upload: keep `/api/admin` as a small
control plane, move bytes directly to CloudBase Storage/COS, and store only
metadata, ownership, lifecycle state, and durable storage IDs in the database.

The hard lessons came from the edges:

- The first design typed `wx-server-sdk` as if it had `getUploadMetadata`; the
  deployed runtime did not. The correct upload-metadata provider was
  `@cloudbase/node-sdk`.
- A green TypeScript compile was not a provider contract proof.
- Public OEM upload intents created a new abuse/cleanup surface.
- Private media preview and download needed an explicit app-auth and Blob URL
  pattern instead of exposing raw storage URLs casually.
- CI/deploy needed deterministic CloudBase CLI function deployment with
  permanent scoped credentials, while MCP stayed useful for IDE/resource
  management and inspection.
- Background review monitors helped for a while, then became context/memory
  noise; actual review work should remain chat-visible unless the user asks for
  silent background health checks.

## Incident Lessons

| Issue | Symptom | Resolution | Craft Rule |
| --- | --- | --- | --- |
| JSON/base64 upload cap | Real images/OEM ZIPs failed with 413 / `EXCEED_MAX_PAYLOAD_SIZE` | Move bytes to storage; keep API requests as metadata and finalization JSON | Measure deployed body limits before choosing transport |
| Base64 as default | Small product/OEM files could still fall into a divergent legacy path | Purpose/type/size transport policy; base64 only for `inline-small` or legacy | Purpose first, type second, size third |
| False SDK declaration | Runtime failed with `sdk.getUploadMetadata is not a function` | Inject `@cloudbase/node-sdk` for upload metadata; remove fake wx surface; add `pnpm verify:cloudbase-sdk` | Provider SDK contracts need runtime/package evidence |
| Raw OpenAPI vs wrapper shape | Code assumed stale upload URL/field shape | Inspect installed node-sdk wrapper and browser POST fields | Check the exact SDK wrapper, not only raw docs |
| Public OEM intents | Anonymous users could mint pending objects without guaranteed cleanup | Add TTL, source rate limit, pending cap, one-time secret hash, expired sweep | Public upload intent creation is an abuse surface |
| Finalize race | Same secret could trigger repeated object reads or destructive validation races | Single-winner claim before storage read/delete/mutation | Claim once before large side effects |
| CloudBase size binding gap | Upload credential could not express `content-length-range` through current SDK | Enforce declared size early, recompute size at finalize, reject/delete over-cap landed objects | Intent metadata is advisory unless the provider credential proves enforcement |
| Admin private download | `window.open(tempUrl)` could inline-render, drop filenames, or be popup-blocked | Fetch temp URL as Blob, save with `<a download>`, surface CORS/fetch errors | Browser download contract must be implemented, not just described in JSON |
| Delete result ambiguity | Batch delete could hide per-object failures | Inspect per-file delete results and keep retryable metadata | Cleanup correctness includes partial failure handling |
| Deployment drift | A successful deployment could later fail due to stale/expired auth or non-deterministic MCP path | Use CloudBase CLI primary in CI with permanent CAM credentials; record release SHA | CI/CD needs deterministic, auditable provider tooling |
| Weak smoke evidence | Retry-green and small fixture could overstate completion | Qualify flaky evidence; run near-cap and final admin download smoke | Acceptance evidence must match the claim |
| Monitor noise | Repeated no-op monitor messages inflated chat context | Disable stale cron/launchd/app automations after usefulness ends | Review loops need an exit plan |

## Craft Rules To Promote

### 1. Upload Transport Is A Product Policy

Do not ask "is this file small enough for base64?" first. Ask what the file is
for.

- Catalog images use the catalog storage lifecycle for all new writes.
- OEM drawings/files use private OEM storage lifecycle for all new writes.
- Marketing media gets its own publishing/cache policy.
- Tiny inline assets may use base64/static storage only through an explicit
  `inline-small` action and a raw-byte cap.
- Legacy base64 reads can stay during migration, but they are not a new-write
  fallback.

### 2. The API Is Control Plane, Not Byte Pipe

For normal media, the application API should validate actor/purpose/type/size,
mint an upload intent, finalize the object, and manage metadata. The API should
not carry megabytes of base64 JSON unless the selected runtime has been designed
and proven for that byte size.

### 3. SDK Contracts Need Proof

Before design approval and before merge:

- Read the relevant provider skill/docs.
- Check official docs or provider knowledge base.
- Inspect the installed package that production bundles.
- Confirm TypeScript declarations match runtime behavior.
- Add an executable contract gate when the boundary is important.

In this repo the concrete gate is:

```bash
pnpm verify:cloudbase-sdk
```

### 4. Intent/Finalize Is The Core Abstraction

Good upload implementations converge on the same protocol:

1. Server validates metadata and chooses storage path.
2. Server writes a pending row and returns a short-lived credential.
3. Browser uploads bytes directly to storage.
4. Server finalizes by claiming once, verifying object bytes/metadata, and
   activating ownership.
5. Cleanup sweeps expired pending or failed rows and deletes paired objects.

### 5. Private Delivery Needs Its Own Path

Public catalog delivery and private/admin preview are different products.
Private media should use authenticated app routes or short-lived signed URL
contracts. In browser UIs, use `Blob` plus `URL.createObjectURL(blob)` for
private previews/downloads, and revoke object URLs when done.

### 6. Cleanup Is Part Of The Feature

Every upload design must describe what happens when the browser uploads but
never finalizes, finalization fails after object creation, delete partially
fails, or the owner record cannot be written. If cleanup is only in unit tests
and not wired into a production action/timer/piggyback path, the upload surface
is not complete.

### 7. Deployment Evidence Must Match Runtime Claims

Record:

- deployed release SHA;
- provider SDK versions;
- route/body limit proof;
- browser network evidence that bytes bypass JSON APIs;
- CORS and private download behavior;
- near-policy-size success or an honest lower-size caveat;
- failure paths such as oversize, unsupported type, expired intent, and cleanup.

### 8. CI/CD Tooling Should Be Deterministic

For CloudBase in this repo, MCP is good for resource inspection and IDE-assisted
management, while CloudBase CLI is the deterministic function-code deployment
path in GitHub CI. Permanent scoped CAM credentials are a better CI primitive
than temporary STS tokens that expire and silently break later deploys.

## Proposed Reusable Skill

This session produced a repo-local draft skill at:

```text
.codex/skills/image-upload-storage/
```

The skill separates portable upload architecture from CloudBase-specific notes:

- `SKILL.md`: workflow and when to use it.
- `references/policy-and-transport.md`: purpose/type/size policy and transport
  choices.
- `references/lifecycle-and-cleanup.md`: metadata, intent/finalize, delivery,
  cleanup, and migration.
- `references/provider-cloudbase.md`: CloudBase/COS SDK, CORS, deployment, and
  direct-upload caveats from this project.
- `references/review-checklist.md`: review findings checklist and evidence
  requirements.

## Merge Notes

When consolidating with other agents' summaries, keep these distinctions:

- Canonical engineering craft should stay provider-neutral where possible.
- Provider-specific facts belong in a provider reference or project appendix.
- The CloudBase SDK contract failure deserves a permanent gate because it was a
  design-time and implementation-time miss, not just a code typo.
- The base64 rule should be narrow: base64 is allowed for explicit tiny inline
  assets and legacy reads, but not as a hidden fallback for catalog/OEM.
- Background automation guidance should emphasize review-loop hygiene: useful
  while active, disabled when no longer needed, and actual review findings
  should appear in the visible collaboration channel.
