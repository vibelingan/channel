# Phase 1 remote KB handoff

**Branch:** `feat/ai-assistant-platform-design`
**Audience:** implementation, infrastructure and KB owners
**Last verified:** 2026-08-31 (Asia/Tokyo)
**Scope:** local application acceptance against the hosted
AnythingLLM-compatible KB. This document does not authorize cloud purchases or
production mutations.

## Outcome

Phase 1 works end to end from the local application to the current hosted KB:

```text
local client -> local BFF -> local PostgreSQL -> local worker
             -> hosted KB -> publication policy -> local SSE
```

The positive query produced `token`, `citation`, `final`, using one approved
document identity and no provider `file:` URL. The negative query targeting the
gateway test document produced `error` only, with zero token and zero citation
events. The BFF and worker readiness checks passed before both probes.

This is integration acceptance, not production acceptance. The hosted endpoint
is still HTTP, its developer token has been exposed in supplied material, and
the workspace is not a dedicated public corpus.

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

Required for the BFF:

```dotenv
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<database>
PORT=58080
CORS_ALLOWED_ORIGINS=http://localhost:4321
AI_ENGINE_ID=anythingllm
AI_ENGINE_VERSION=<reviewed-hosted-fork-version>
AI_ENGINE_IMAGE_DIGEST=<immutable-reviewed-provenance>
AI_IP_HASH_SECRET=<random-value-at-least-24-characters>
```

Required for the worker:

```dotenv
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/<database>
PORT=58081
AI_ENGINE_ID=anythingllm
AI_ENGINE_VERSION=<reviewed-hosted-fork-version>
AI_ENGINE_IMAGE_DIGEST=<immutable-reviewed-provenance>
ANYTHINGLLM_BASE_URL=https://<approved-kb-host>
ANYTHINGLLM_API_KEY=<secret-manager-value>
ANYTHINGLLM_WORKSPACE_SLUG=<dedicated-public-workspace>
AI_KNOWLEDGE_CREDENTIAL_ID=<first-16-hex-of-sha256-api-key>
ANYTHINGLLM_CITATIONS_VERIFIED=1
ANYTHINGLLM_CREDENTIAL_ROTATION=<monotonic-counter>
AI_APPROVED_SOURCE_PREFIX=<approved-document-prefix>
AI_SITE_ORIGIN=https://<public-website-host>
AI_MAX_OUTPUT_TOKENS=4096
AI_MAX_TOOL_CALLS=0
AI_WORKER_LEASE_SECONDS=90
AI_MAX_STREAM_DURATION_MS=55000
```

`ALLOW_INSECURE_ANYTHINGLLM=true` was used only for the bounded diagnostic
against the current HTTP endpoint. It is forbidden by the production manifest
and must not appear in a production environment.

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
                        AI_ENGINE_ID/VERSION/IMAGE_DIGEST, AI_IP_HASH_SECRET
.env.ai-worker.local    DATABASE_URL, PORT=58181, AI_ENGINE_* runtime values,
                        KB URL/key/workspace/attestation, source prefix,
                        AI_SITE_ORIGIN and worker limits
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

1. **KB/infrastructure owner:** terminate the hosted KB on HTTPS before issuing
   a replacement developer token. Do not retain the HTTP diagnostic override.
2. **Security/KB owner:** rotate the token visible in supplied screenshots and
   increment `ANYTHINGLLM_CREDENTIAL_ROTATION`; update the expected credential
   attestation in the secret inventory.
3. **Content owner:** create a dedicated public workspace containing only
   approved Supply Chains AI material. The current workspace also contains a
   gateway test document. Re-run positive, negative and forbidden-write probes.
4. **KB owner:** provide immutable provenance for the hosted fork version. Do
   not invent an image digest for a third-party deployment.
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
