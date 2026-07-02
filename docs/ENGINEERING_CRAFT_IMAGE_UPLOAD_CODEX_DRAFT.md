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
- A later deployed smoke found a second SDK boundary: `wx-server-sdk` plain
  updates worked, but its atomic `db.command.inc()` did not apply in the
  CloudBase runtime. The single-winner claim moved to the verified
  `@cloudbase/node-sdk` path.
- A green TypeScript compile was not a provider contract proof.
- A green unit suite with fake adapters was not a provider runtime proof.
- Public OEM upload intents created a new abuse/cleanup surface.
- Private media preview and download needed an explicit app-auth and Blob URL
  pattern instead of exposing raw storage URLs casually.
- Browser-direct storage needed bucket CORS/security-domain setup; that was an
  ops prerequisite, not an application-code detail.
- CI/deploy needed deterministic CloudBase CLI function deployment with
  permanent scoped credentials, while MCP stayed useful for IDE/resource
  management and inspection.
- Temporary STS credentials and stale session-token secrets could make a
  previously green deploy fail later; permanent scoped CAM keys belonged in
  GitHub environment secrets, never in chat.
- Shared-branch collaboration across Codex/Claude needed SSH Git discipline,
  fast-forward pulls, commit-SHA review ledgers, and visible review findings.
- Background review monitors helped for a while, then became context/memory
  noise; actual review work should remain chat-visible unless the user asks for
  silent background health checks.

## Session Shape

The useful structure was MIU-sized, but the roles were intentionally fluid:
sometimes Claude implemented and Codex reviewed; sometimes Codex implemented and
Claude reviewed. The durable interface between agents was the branch plus the
execution/design docs, not a PR. That made the following practices important:

- use the user's configured SSH Git remote, not HTTPS;
- fetch the live remote head before every review or push;
- avoid force pushes on the shared feature branch;
- record review base SHAs and test/deploy evidence;
- keep background monitors quiet or disabled when no new remote head exists;
- put actual findings in the visible chat/review docs, not only in automation
  logs.

## Incident Lessons

| Issue | Symptom | Resolution | Craft Rule |
| --- | --- | --- | --- |
| JSON/base64 upload cap | Real images/OEM ZIPs failed with 413 / `EXCEED_MAX_PAYLOAD_SIZE` | Move bytes to storage; keep API requests as metadata and finalization JSON | Measure deployed body limits before choosing transport |
| Base64 as default | Small product/OEM files could still fall into a divergent legacy path | Purpose/type/size transport policy; base64 only for `inline-small` or legacy | Purpose first, type second, size third |
| False SDK declaration | Runtime failed with `sdk.getUploadMetadata is not a function` | Inject `@cloudbase/node-sdk` for upload metadata; remove fake wx surface; add `pnpm verify:cloudbase-sdk` | Provider SDK contracts need runtime/package evidence |
| Raw OpenAPI vs wrapper shape | Code assumed stale upload URL/field shape | Inspect installed node-sdk wrapper and browser POST fields | Check the exact SDK wrapper, not only raw docs |
| Atomic SDK operator divergence | Deployed OEM finalization failed as `NOT_FOUND` although unit tests passed | Route atomic `incrementField` through `@cloudbase/node-sdk`; keep deployed smoke | Test doubles do not prove third-party SDK operators |
| Graceful fallback masking | Catalog image delivery fallback hid broken `publishedRefCount` maintenance | Grep shared primitive callers and add fallback observability | Fallbacks are failure masks unless measured |
| CORS/security-domain gap | Browser POST/GET to storage failed even with correct app code | Configure and prove bucket CORS/security domains for site and dev origins | Browser-direct storage has deploy-time ops prerequisites |
| Public OEM intents | Anonymous users could mint pending objects without guaranteed cleanup | Add TTL, source rate limit, pending cap, one-time secret hash, expired sweep | Public upload intent creation is an abuse surface |
| Finalize race | Same secret could trigger repeated object reads or destructive validation races | Single-winner claim before storage read/delete/mutation | Claim once before large side effects |
| CloudBase size binding gap | Upload credential could not express `content-length-range` through current SDK | Enforce declared size early, recompute size at finalize, reject/delete over-cap landed objects | Intent metadata is advisory unless the provider credential proves enforcement |
| Admin private download | `window.open(tempUrl)` could inline-render, drop filenames, or be popup-blocked | Fetch temp URL as Blob, save with `<a download>`, surface CORS/fetch errors | Browser download contract must be implemented, not just described in JSON |
| Delete result ambiguity | Batch delete could hide per-object failures | Inspect per-file delete results and keep retryable metadata | Cleanup correctness includes partial failure handling |
| Deployment drift | A successful deployment could later fail due to stale/expired auth or non-deterministic MCP path | Use CloudBase CLI primary in CI with permanent CAM credentials; record release SHA | CI/CD needs deterministic, auditable provider tooling |
| Secret handling | Agent could not safely reveal/move live credentials through chat | User set permanent CAM credentials through secure secret flow; stale session token removed | Live secrets never belong in transcripts |
| Weak smoke evidence | Retry-green and small fixture could overstate completion | Qualify flaky evidence; run near-cap and final admin download smoke | Acceptance evidence must match the claim |
| Cross-region smoke size | Near-10 MiB CI upload could time out from distant GitHub runner to China storage | Default CI smoke to multi-MiB mechanism proof; keep near-cap probe explicit/configurable | CI smokes prove mechanism; cap tests can be separate |
| Git transport confusion | Branch fetch/push got stuck or confused by config/remotes and HTTPS assumptions | Confirm SSH remote, clean stale fetch config, compare live head before review | Shared-branch agents must verify Git transport and refspecs |
| Wrong UI ownership assumption | Admin OEM request form showed file metadata but no upload input | Treat public OEM form as upload entrypoint; admin form reviews/edits submitted record | Upload policy starts from actor and entrypoint |
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

### 9. Provider Operators Need Live Proof

Local tests with fake adapters are still necessary, but they only prove local
logic. Any correctness path that depends on provider operators such as atomic
increment, transactions, conditional writes, upload credential minting, or temp
URL generation needs a deployed smoke against the real runtime.

When a deployed failure contradicts local green tests, do not patch around the
symptom. Build differential probes that isolate where control flow reaches, then
move the primitive to the SDK/API proven in the deployed environment.

### 10. Ops Preconditions Belong In The Design

Browser-direct storage needs storage CORS/security-domain configuration for the
actual deployed and local origins. For CloudBase/COS, do not include
`Content-Length` as a frontend-set header because browsers manage it. Verify the
real preflight and record the allowed origins/methods/headers.

### 11. Secrets Stay Out Of Chat

Agents should not fetch or reveal live cloud credentials into transcripts. Use
secure local scripts, GitHub environment secrets, or console flows. For CloudBase
CI, use permanent scoped CAM `SecretId`/`SecretKey` without a stale
`TENCENTCLOUD_SESSIONTOKEN`; temporary STS credentials are acceptable for local
operator sessions but not durable CI.

### 12. Shared-Branch Multi-Agent Work Needs A Protocol

When there is no PR and two agents operate on the same branch:

- use SSH Git if that is the user's configured transport;
- fetch and fast-forward before review and before push;
- record the reviewed commit SHA;
- keep doc/ledger updates small and attributable;
- make review findings visible to the human, not only to cron or launchd logs.

### 13. Smoke Claims Must Match The Fixture

A 2 MiB deployed smoke can prove the direct-to-storage mechanism because it is
well beyond a 100 KiB function body cap. It does not prove a 10 MiB policy cap.
Keep the wording honest: mechanism proof, near-cap proof, and final admin
download/CORS proof are different pieces of evidence.

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
- `references/operations-and-review.md`: shared-branch review, secrets, CI,
  deployed smoke, diagnosis, and monitor hygiene.

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
- Combine this Codex draft with `docs/ENGINEERING_CRAFT_PROPOSALS.md` rather
  than treating either as canonical alone. That other doc captures especially
  strong live-debugging examples; this draft adds the broader session protocol,
  credential, Git, and provider-contract workflow lessons.
