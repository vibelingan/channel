# Phase 1 remote KB handoff

**Branch:** `feat/ai-assistant-platform-design`
**Audience:** implementation, infrastructure and KB owners
**Last verified:** 2026-09-01 (Asia/Tokyo)
**End SHA:** `62433986156d81617d9435c743a05e21d6462bbe`
**Scope:** local application acceptance against the hosted
AnythingLLM-compatible KB. This document does not authorize cloud purchases or
production mutations.

## Outcome

**The local deterministic Phase 1 path is accepted. The hosted-KB path is not
yet accepted.** An earlier revision said the hosted path worked end to end.
That claim rested on an observer that could not fail for the right reason, and
it remains withdrawn rather than edited quietly.

The negative case — "an unapproved source is refused" — was asserted as "the
stream produced exactly one `error` event, of any kind". A provider outage, a
quota trip, a timeout or a dropped connection all satisfied it. The hosted KB
was, at the time, returning HTTP 500 wrapping an upstream provider 403 on every
generation, so the evidence that hidden content stays hidden was very likely an
unrelated provider failure. The gate may well have been working; nothing in that
run distinguished the two. The corrected local acceptance now does: its
negative fixture can only produce `publication_blocked`, and the observer
requires that exact category.

### What IS verified, at this SHA

| Check | Result |
| --- | --- |
| Build, typecheck, biome | pass; Node 22 production bundles cold-import |
| Deterministic contracts (real PostgreSQL) | engine 56 pass/2 skip, policy 80, store 24, adapter 101, BFF 6, worker 20, scripts 156 |
| Built runtime bundle | `check-ai-runtime-bundle.mjs` passes — this caught a real defect, see below |
| Liveness / readiness, BFF 58180 and worker 58181 | all four endpoints answer; liveness carries no database, readiness proves READ COMMITTED |
| Positive SSE shape (fresh containers) | `token`, `citation`, `final`; one approved citation; no `file:` URL |
| Negative SSE shape (fresh containers) | only `publication_blocked`; zero leaked token/citation events |
| Legacy database upgrades | pre-002 invalid provenance and pre-003 Git provenance both migrate; old claims are preserved in audit events |
| Pinned probe runtime | shared workspace inspector executes on Node 22.13.0 without a TypeScript loader |
| Ingest preflight against the LIVE site | `/`, `/oem`, `/headphones`, `/portfolio` all 200 on `https://www.supplychainsai.com` |
| `/overstock` | **404 in production**, and the ingest now refuses it — see finding 1 |

### What is NOT verified, and why

| Check | Blocked on |
| --- | --- |
| Workspace policy read-back | the rotated KB credential, delivered separately |
| Corpus ingest with generation swap | same |
| Direct KB probe + evidence artifact | same |
| Positive SSE against the hosted KB | the rotated credential and approved diagnostic spend |
| Negative SSE against the hosted KB | same; local proof is complete, remote proof is still required |
| Provider generation succeeding at all | KB owner — the model permission 403 is upstream and no code change reaches it |

The fake engine now has one request-specific, acceptance-only unapproved
fixture. It is never part of the production KB path. Removing the publication
gate makes the negative acceptance fail instead of allowing an unrelated
provider error to satisfy it.

## Round 5 findings, closed locally in code

1. **The corpus published an unrouted page.** `overstock/en-US.md` was ingested
   against `/overstock`, which Astro does not route and which answers 404 in
   production. The manifest is now derived from the router, and a live preflight
   requires every citation target to answer 200 before the first upload.
2. **A hostname bought plaintext.** The literal host `anythingllm` was treated
   as local, so any host resolving that name received an instance-wide bearer
   over HTTP. Only loopback is intrinsically local now.
3. **A dead letter could orphan its run.** The outbox transition and the run's
   terminalization were two transactions; a crash between them left an
   unclaimable item beside a run nothing would finish. They now commit together.
4. **Any error proved the gate fired.** The gate emits `publication_blocked`,
   which nothing else emits, and the observer requires exactly that code.
5. **A git checkout claimed an image digest.** Provenance is now a discriminated
   `oci` | `git` record, refused at startup if a commit is offered as a digest,
   and carried through run rows (migration 002) and the CloudRun manifest.
6. **Readiness compared configuration with itself.** Startup now verifies a
   secret-free evidence artifact written by a real authenticated probe,
   including a positive control that retrieval returned approved material — an
   empty workspace can no longer be ready. The probe no longer echoes the
   vendor's error body; only a bounded upstream status code survives.

Two further defects surfaced while running the acceptance:

- The built BFF bundle left `@vibelingan-channel/ai-engine` external. Workspace
  packages publish TypeScript, so the container died on a `.ts` import. Only the
  built artifact showed it.
- `pnpm test:ai` ran suites concurrently while three of them `TRUNCATE` the same
  tables, so results depended on scheduling.
- The probe imported a TypeScript source file directly. Node 25 accepted it,
  but the pinned Node 22 runtime refused it. The shared inspector is executable
  plain ESM now.
- The provenance migrations worked on an empty database but rejected legacy
  rows. Upgrade tests now preserve invalid historical claims in `audit_events`
  and keep canonical provenance honest.

The independent Standards and Specification findings, kept separate with their
dispositions, are recorded in `REVIEW-ROUND-5-2026-08-31.md`.

## Current live facts

- `https://kb.supplychainsai.com/api/ping` answers 200; the workspace endpoint
  without a token answers 403. Raw public ports 3001 and 8888 time out. These
  public boundary checks were repeated on 2026-09-01.
- `https://www.supplychainsai.com` serves `/`, `/oem`, `/headphones`,
  `/portfolio` (200 each) and `/overstock` 404, repeated on 2026-09-01.
- The CVM operator reports that `supplychainsai-public-prod` exists, is empty,
  and the old credential is invalid. Its authenticated contents and the rotated
  credential remain **unverified from this checkout** because no credential is
  present here.

## What changed in the application

- The conformance-tested AnythingLLM adapter is the only package export.
- The adapter exercises authenticated health, validates vendor frames, removes
  reasoning content, preserves document identity, drops `file:` URLs and
  refuses remote HTTP by default.
- Worker startup checks the expected credential/workspace/rotation attestation
  against the exact hosted workspace schema observed on 2026-08-31. Any new
  top-level field or nested document/thread field is unknown and refuses
  startup until reviewed; enabled agent fields in that exact shape are refused.
- Provider text and sources remain in memory until the final citation set
  passes grounding, the approved source prefix and the first-party citation URL
  policy.
- Mixed or unapproved sources fail closed. Nothing from a rejected answer is
  committed or streamed.
- The AI build cold-imports both emitted services from their production Docker
  runtime stages, catching missing production dependencies and top-level
  evaluation failures that the monorepo can hide.
- One CloudRun service manifest now covers both deployables, ports and required
  runtime gates. Its caller must supply complete per-service image references
  ending in immutable `@sha256:<64 lowercase hex>` digests; tags are refused.

## Local configuration

Copy `.env.ai-runtime.example` to a gitignored local file and inject real
values from the approved secret source. Never paste them into this document.

Required for both BFF and worker when the hosted KB is a Git checkout:

```dotenv
AI_ENGINE_ID=anythingllm
AI_ENGINE_VERSION=<reviewed-hosted-fork-version>
AI_ENGINE_PROVENANCE_KIND=git
AI_ENGINE_GIT_COMMIT=<full-40-hex-commit>
AI_ENGINE_GIT_REPOSITORY=<owner/repository>
AI_ENGINE_CONFIG_DIGEST=sha256:<64-hex-canonical-config-digest>
```

Required for the BFF:

```dotenv
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<database>
PORT=58080
CORS_ALLOWED_ORIGINS=http://localhost:4321
AI_IP_HASH_SECRET=<random-value-at-least-24-characters>
```

Required for the worker:

```dotenv
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<database>
PORT=58081
ANYTHINGLLM_BASE_URL=https://<approved-kb-host>
ANYTHINGLLM_API_KEY=<secret-manager-value>
ANYTHINGLLM_WORKSPACE_SLUG=<dedicated-public-workspace>
ANYTHINGLLM_WORKSPACE_ID=<vendor-workspace-id>
AI_KNOWLEDGE_CREDENTIAL_ID=<first-16-hex-of-sha256-api-key>
ANYTHINGLLM_CITATIONS_VERIFIED=1
ANYTHINGLLM_CREDENTIAL_ROTATION=<monotonic-counter>
AI_CORPUS_GENERATION=<approved-ingest-generation>
AI_KB_EVIDENCE_JSON=<single-line-secret-free-probe-evidence>
AI_APPROVED_SOURCE_PREFIX=<approved-document-prefix>
AI_SITE_ORIGIN=https://<public-website-host>
AI_MAX_OUTPUT_TOKENS=4096
AI_MAX_TOOL_CALLS=0
AI_WORKER_LEASE_SECONDS=90
AI_MAX_STREAM_DURATION_MS=55000
```

`ALLOW_INSECURE_ANYTHINGLLM=true` is for the loopback/private local container
only. It is forbidden by the production manifest and must not appear in a
production environment; the hosted endpoint is HTTPS.

## Repeatable local checks

Start the normal local stack and verify its deterministic path:

```bash
AI_POSTGRES_PORT=55433 AI_BFF_PORT=58080 AI_WORKER_PORT=58081 pnpm dev:ai
pnpm build:ai
pnpm smoke:ai
```

Run the contracts against a dedicated test database. These tests truncate their
target database, so never point them at shared or production data.

```bash
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<test_database> pnpm test:ai
pnpm test:deploy-smoke
pnpm typecheck
pnpm lint
```

The direct provider probe below is **not read-only**: it creates a retained
remote thread, performs billable model calls, and may leave provider-side chat
history. Its CLI output is sanitized, but it still requires the KB owner's
approval for the target workspace and diagnostic spend. Populate the gitignored
`.env.ai-probe` only after that approval:

```bash
pnpm test:ai:kb
```

The full Phase 1 acceptance goes through the application instead of creating a
provider thread directly. Prepare **two** gitignored files so the BFF process
does not inherit the KB developer token:

```text
.env.ai-bff.local       DATABASE_URL, PORT=58180, CORS_ALLOWED_ORIGINS,
                        AI_ENGINE_ID/VERSION/provenance, AI_IP_HASH_SECRET
.env.ai-worker.local    DATABASE_URL, PORT=58181, AI_ENGINE_* runtime values,
                        KB URL/key/workspace/evidence/corpus generation,
                        source prefix, AI_SITE_ORIGIN and worker limits
```

Use a newly created, dedicated local database. Build and migrate before starting
the two services in separate terminals:

```bash
pnpm build:ai
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<test_database> pnpm migrate:ai
node --env-file=.env.ai-bff.local apps/ai-bff/dist/server.js
node --env-file=.env.ai-worker.local apps/ai-worker/dist/worker.js
```

Then run the content-safe acceptance client. It prints only event types/counts,
never answer text or citation titles:

```bash
AI_BFF_URL=http://127.0.0.1:58180 \
AI_WORKER_URL=http://127.0.0.1:58181 \
AI_PHASE1_APPROVED_PREFIX=<approved-document-prefix> \
AI_PHASE1_POSITIVE_QUESTION='What does the company do?' \
AI_PHASE1_NEGATIVE_QUESTION='What does the gateway test document say?' \
pnpm accept:ai:phase1
```

These calls create local conversation rows and perform provider generation, so
use an isolated database and an approved diagnostic window. Stop both local
processes with `Ctrl-C` after the result. Preserve the database as acceptance
evidence or have its owner remove that exact test database; never run cleanup
against a shared/production URL.

Accept only these terminal shapes:

| Case | Required events | Additional assertion |
| --- | --- | --- |
| Approved public answer | `token`, one or more `citation`, `final` | every source identity uses the approved prefix; no `file:` URL |
| Unapproved/mixed source | `error` only | zero token and zero citation events |

## Current blockers and owners

1. **KB/security owner:** deliver the already-rotated token through the approved
   encrypted channel, never chat or a committed file. The code derives its
   attestation and checks it against `AI_KNOWLEDGE_CREDENTIAL_ID`.
2. **KB owner:** provide the hosted checkout's repository id, full 40-character
   commit and canonical applied-configuration digest. Do not invent an image
   digest for a Git deployment.
3. **Content owner:** approve the four currently published site sources for the
   empty `supplychainsai-public-prod` workspace. Run the rollback-safe ingest,
   authenticated probe/evidence write and hosted positive acceptance. Do not
   add an internal negative-test document to production; the publication gate's
   negative case is proven locally, or separately in a disposable test
   workspace whose corpus is never used by the public service.
4. **KB owner:** confirm through that probe that provider generation and real
   citations now work; the earlier upstream 403 is not considered fixed merely
   because an unauthenticated health endpoint is green.
5. **Infrastructure owner:** provision TencentDB PostgreSQL only after approval,
   in the same Shanghai-region VPC path as CloudBase Run, private port 5432.
6. **Infrastructure owner:** deploy BFF publicly and worker privately from the
   single CloudRun manifest; keep both at minimum one instance because the
   worker is not request-driven.
7. **MCP owner:** treat the separate port-9021 CRUD/FTS MCP service as another
   integration. It is not this ConversationEngine and was not made reachable by
   this work.

## Release gate

Production is allowed only after HTTPS, token rotation, public-only corpus,
immutable engine provenance, approved PostgreSQL/VPC connectivity, deploy-time
secret injection, and the same positive/negative BFF acceptance all pass. No
passing unit test or direct provider response substitutes for that gate.

## Current executable status — 2026-09-01 (supersedes earlier blockers)

**Verified implementation:** `a31b46cb5bb6e1e8dcbcdf6b17f1101c27828a35`

Phase 1 now works locally against the deployed KB. No additional RSA exchange,
workspace creation or corpus ingest is required to reproduce it on this
machine.

- Hosted KB: `https://kb.supplychainsai.com`
- Workspace: `supplychainsai-public-prod` / id `4`
- Corpus: five public-only documents, generation `1788241419198`
- Credential: rotation 2; plaintext exists only in mode-0600 local files and
  gitignored `.env.ai-hosted`

```bash
docker compose --env-file .env.ai-hosted -f docker-compose.ai.yml up -d --build postgres ai-bff ai-worker
PUBLIC_CB_PROXY=0 PUBLIC_AI_API_BASE_URL=http://127.0.0.1:58080 \
  pnpm --filter @vibelingan-channel/site dev --host 127.0.0.1 --port 4322
```

Open `http://localhost:4322`, click **Ask our AI**, and send a product
question. The streamed answer is followed by first-party citations. The BFF,
worker and PostgreSQL remain loopback-only, and the browser never receives the
KB token.

Do not copy `.env.ai-hosted`, the RSA private key or decrypted token into Git,
CloudBase variables, chat, screenshots or browser storage. Production still
needs approved TencentDB PostgreSQL and CloudRun deployment; that is the next
infrastructure phase, not a local E2E blocker.
