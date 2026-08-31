# AI platform review round 5

**Reviewed range:** `3e12a693c8446b2745850de984f41673e811aef4..c8ffc7dd195de9988e247a63a4381682a8f32446`

**Branch:** `feat/ai-assistant-platform-design`

**Review date:** 2026-08-31 (Asia/Tokyo)

**Decision:** HOLD — the new HTTPS KB endpoint is reachable and isolated, but
the current code must not seed or release the new public workspace yet.

## Current evidence

The following claims were independently observed from this checkout and the
public network, without a KB credential:

| Check | Result |
| --- | --- |
| Branch state before adding this review | clean, `HEAD == origin/feat/ai-assistant-platform-design == c8ffc7d` |
| DNS | `kb.supplychainsai.com -> 43.157.53.132` |
| TLS identity | certificate SAN contains `kb.supplychainsai.com`; valid 2026-08-31 through 2026-11-29 |
| Public health | `GET https://kb.supplychainsai.com/api/ping` -> 200 |
| Unauthenticated protected API | workspace request -> 403 |
| Raw service ports | public `43.157.53.132:3001` and `:8888` unreachable |
| Public citation pages | `/`, `/oem`, `/headphones`, `/portfolio` -> 200; `/overstock` -> 404 |
| Local build/contracts | build, typecheck and lint pass; deploy contracts 128/128 pass |
| Dedicated PostgreSQL tests | engine 47 pass/2 explicit skips; store 21/21; adapter 96/96; BFF 6/6; worker 7/7 |

The CVM operator separately reported a dedicated empty workspace named
`supplychainsai-public-prod`, a rotated credential with rotation counter 2,
nginx SSE settings, systemd services and successful certificate renewal. Those
remain operator-reported until the rotated credential is supplied through the
approved encrypted transfer and the authenticated probe is rerun.

No remote corpus mutation or billable generation was performed in this review.
The full local BFF/PostgreSQL/worker/KB/SSE acceptance is therefore still
pending, not passed.

## P1 findings

### R5-P1-01 — the public corpus script includes unpublished content

`scripts/ai-ingest-content.mjs` uploads `overstock/en-US.md` and assigns the
public citation `/overstock`. The repository deliberately keeps that page at
`apps/site/src/pages/_overstock.astro`, and
`apps/site/src/i18n/hidden-sections.test.ts` asserts the route must not exist.
The production URL currently returns 404.

Running `pnpm ai:ingest` now would publish content the website intentionally
withholds and create a broken citation. Exclude hidden sources by construction,
add a test that every ingest source maps to a built public route, and make the
live preflight require a 200 first-party URL before any upload.

### R5-P1-02 — remote HTTP can bypass the production fence by hostname

`safeBaseUrl()` treats the literal hostname `anythingllm` as local, so
`http://anythingllm:3001` is accepted without `ALLOW_INSECURE_ANYTHINGLLM`.
That name can resolve outside Docker. The production manifest forbids the flag,
but the hostname exemption silently bypasses the control. This was reproduced
by constructing the adapter without the override: it was accepted.

Only loopback IPs/localhost may be intrinsically local. Docker HTTP must require
the already-present explicit local override, with a regression test proving the
literal hostname is rejected without it.

### R5-P1-03 — dead-letter terminalization has a crash gap

`processOne()` first calls `retryOutbox()`, which permanently changes the item
to `dead_letter` and clears its claim, then calls `terminalizeRun()` in another
transaction. A crash between those calls leaves an active run and conversation
with no claimable outbox item. The current test performs both calls in sequence
and cannot prove the crash boundary.

Dead-lettering and run/conversation terminalization must be one fenced database
transaction, with a test that stops after the first durable write and proves a
later worker can still reach a terminal state.

### R5-P1-04 — the negative live acceptance can pass for the wrong reason

`accept-ai-phase1.mjs` accepts any sole `error` event as proof that an
unapproved source was blocked. Provider permission, quota, network and timeout
errors produce the same green result. Require a stable public error code/reason
emitted only by the publication gate, then mutation-test the gate away and
prove the acceptance turns red.

### R5-P1-05 — CVM Git provenance cannot be called an image digest

Worker startup requires `AI_ENGINE_IMAGE_DIGEST`, but the hosted engine is
reported as a Git checkout on a CVM, not a digest-pinned container. Putting a
Git SHA or placeholder in `imageDigest` produces false audit data.

Model immutable runtime provenance explicitly (for example a discriminated
OCI-digest or Git-commit attestation), or deploy the KB from a digest-pinned
image. Do not invent a digest to make startup pass.

### R5-P1-06 — an empty citation-required corpus can report ready

Worker readiness checks database health and authenticated engine health. It
does not prove a known public document retrieves and cites successfully, while
`supportsCitations` is an operator boolean. Under the operator-reported
zero-document workspace, readiness can be 200 even though every allowed answer
must fail.

Readiness/release evidence must include a non-secret positive-control corpus
attestation that binds the deployed corpus generation and verified citation
capability. An auth-only check is liveness, not answer readiness.

### R5-P1-07 — runtime attestation compares configuration with itself

Worker startup compares credential id, workspace and rotation against values
from the same environment used to construct the adapter. The direct probe does
not emit an independently signed or persisted credential/workspace/rotation
attestation. A consistently wrong environment therefore passes the comparison.

Make the probe produce a secret-free evidence artifact containing the
credential hash id, workspace id/slug, rotation counter, corpus generation and
probe timestamp; bind startup/deploy acceptance to that artifact.

## P2 findings

1. Probe failures can print raw vendor `body.error`; only successful reports go
   through the sanitizer. Make every failure a fixed local code plus HTTP
   status, and test the CLI failure path with a credential-shaped vendor error.
2. `PHASE-1-REMOTE-KB-HANDOFF.md`, the engine evaluation and older triage still
   describe public HTTP, shared corpus and 403 generation. Preserve old rounds
   as history, but make the current handoff and status markers point to this
   exact reviewed range and current evidence.
3. Local 1.16.0 image/version claims are not checked against every consumer.
   Add an executable drift contract for Compose, examples and the runbook.

## Required correction order

1. Fix R5-P1-01 before any production-workspace ingest.
2. Fix the transport, dead-letter and observer defects with mutation-red tests.
3. Replace the false image-digest contract and bind probe evidence to startup.
4. Seed only currently published Supply Chains AI pages into the dedicated
   workspace using the rollback-safe corpus refresh.
5. Run the authenticated direct KB probe, then the built local
   BFF/PostgreSQL/worker/SSE positive and negative acceptance.
6. Update the current handoff with exact command results and the final reviewed
   end SHA. Production CloudBase/TencentDB deployment remains a separate,
   explicitly approved step.

## Acceptance required for the next review

- The ingest source list contains no hidden route; every citation target is a
  live first-party 200 URL.
- Removing the source-approval gate makes the negative E2E fail.
- A transport/provider/quota failure cannot satisfy the negative proof.
- A crash at the final dead-letter attempt cannot strand an active run.
- Runtime provenance truthfully describes the CVM deployment or a real OCI
  digest.
- The evidence artifact matches the actual credential id, workspace, rotation
  and corpus generation without exposing the credential.
- Direct KB and full local application E2E both pass against
  `https://kb.supplychainsai.com` and `supplychainsai-public-prod`.

## Follow-up review after the pushed Round 5 implementation

**Reviewed range:** `c8ffc7dd195de9988e247a63a4381682a8f32446..8d7661c088933ab64dca83f7ad32d118e985a0cb`

**Correction commits:**
`f14c7beb63a66264500513b1b25c904f4a472ede` and
`62433986156d81617d9435c743a05e21d6462bbe`

**Decision:** LOCAL ACCEPT / HOSTED HOLD. The deterministic application stack
now passes end to end from freshly built Node 22 containers. The hosted-KB path
still needs the rotated credential and immutable CVM provenance before it can
be tested honestly.

This section is the continuous follow-up that was missing from the first
version of this file. Earlier review results were being narrated in chat and in
the handoff while this canonical review stopped at `c8ffc7d`; that split source
of truth was a process defect. The pushed Claude changes and the corrections
below are now recorded against exact ranges and SHAs.

### Standards review — independent findings and disposition

1. **P1 — probe evidence could not reach or satisfy the worker.** The probe did
   not emit all fields startup required, and neither Compose nor the CloudRun
   manifest supplied the evidence artifact. **Fixed:** the probe now emits a
   secret-free artifact bound to credential id, rotation, workspace id/slug,
   corpus generation, approved-source positive control, tool surface, transport
   and timestamp. Compose mounts it; CloudRun injects it; worker startup checks
   it against the actual key and the separately approved credential id.
2. **P1 — default FakeEngine Compose contradicted provenance parsing.** Compose
   selected `oci` with an empty digest, so the default local stack could not
   boot. **Fixed:** fake defaults omit provenance; explicit AnythingLLM
   deployments must provide the complete discriminated record.
3. **P1 — the dead-letter fix rejected the real worker state.** The worker
   claims the run before provider I/O, so final failure arrives while the run is
   `running`, but terminalization accepted only `creating`. **Fixed:** the exact
   claimed/dead-lettered `start_run` outbox row is the authority for either live
   state, in the same transaction.
4. **P2 — handoff and triage overclaimed closure and named retired variables.**
   **Fixed in the documentation update that contains this section.**

Residual standards observation: the evidence artifact has two validators (the
probe and the worker). The worker remains the release authority and fails
closed; consolidation is desirable, but is not a hosted-E2E blocker.

### Specification review — independent findings and disposition

1. **P1 — evidence/probe/deploy contract was incomplete.** Same underlying
   defect as Standards finding 1; fixed with an executable, deployable evidence
   contract and exact workspace/corpus binding.
2. **P1 — the FakeEngine default was not runnable.** Same underlying defect as
   Standards finding 2; fixed and proven from rebuilt containers.
3. **P1 — dead-lettering could still strand a `running` run.** Same underlying
   defect as Standards finding 3; fixed with a database-backed crash-boundary
   test using the real claimed state.
4. **P2 — Git provenance named source but not deployed configuration.** Fixed:
   Git provenance now requires `repository`, a full 40-hex commit and
   `AI_ENGINE_CONFIG_DIGEST=sha256:<64 hex>`. Migration 003 enforces the same
   shape in PostgreSQL.

### Defects found only by executing the acceptance path

1. The Node probe imported `engine.ts` directly. Local Node 25 accepted it, but
   the pinned Node 22 runtime fails with `ERR_UNKNOWN_FILE_EXTENSION`. The
   shared workspace inspector is now plain ESM with a declaration file; a
   Node-22 container imports and executes it successfully.
2. The first provenance migrations failed on populated databases: legacy Git
   SHAs/placeholders in `image_digest`, and pre-003 Git rows without a config
   digest, violated the new constraints. The migration now preserves those
   untrusted historical assertions in `audit_events`, clears them from the
   canonical provenance columns, and keeps valid OCI records. Both real upgrade
   states were executed against a dedicated PostgreSQL database.
3. Adapter test files ran concurrently with a deliberate five-second silent
   vendor case, causing a random real-HTTP citation test to hit the same
   deadline. The package test command is serial and now completes 101/101
   deterministically.

### Verified result at `6243398`

| Check | Result |
| --- | --- |
| Pinned runtime import | Node `22.13.0` imports and executes the shared probe inspector |
| Typecheck / Biome | pass; no new errors |
| AI engine | 58 total, 56 pass and 2 explicit harness skips |
| AnythingLLM adapter | 101/101 |
| Policy | 80/80 |
| PostgreSQL store | 24/24 against a real database |
| BFF / worker | 6/6 and 20/20 |
| Deployment and script contracts | 156/156 |
| Production bundles | BFF and worker build and cold-import on Node 22 |
| Fresh Compose stack | BFF, worker and PostgreSQL healthy on loopback ports |
| Process-level positive case | `token`, `citation`, `final`; one approved citation |
| Process-level negative case | only `publication_blocked`; zero leaked tokens/citations |

### Remaining hosted acceptance inputs

No authenticated request, ingest or remote mutation was made in this follow-up
because this checkout still has no rotated KB credential. The next run needs:

1. the rotated token delivered through the approved encrypted channel;
2. the hosted checkout's full 40-character Git commit and repository id;
3. the canonical applied-configuration digest;
4. approval to perform the billable probe and public-only corpus ingest.

The probe derives the vendor workspace id and writes the remaining evidence.
Until that run succeeds, the hosted path is not production-accepted even though
the local application path is.
