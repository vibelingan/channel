# AI Assistant Deployment Readiness Review

**Date:** 2026-09-07
**Branch:** `feat/ai-assistant-platform-design`
**Reviewed HEAD:** `ff2642f3e2cebd3ef192aa83a824affb3335f93a`
**Remote state:** local branch is one commit ahead of `origin/feat/ai-assistant-platform-design`

## Decision

**Ready for a private integration deployment after the code blockers below are fixed. Not ready for production traffic.**

The local BFF, worker, PostgreSQL state machine, public widget, production bundles, hosted-KB adapter and most publication controls are implemented. A clean-database AI suite and a rebuilt local runtime pass.

Production is still a **No-Go** because:

1. there is no executable CloudRun deployment consumer;
2. the current public corpus contains a known corrupted supplier statistic;
3. concurrent service startup races database migrations;
4. a dead-lettered cancellation can permanently occupy a conversation;
5. worker shutdown does not drain an active provider operation;
6. TencentDB PostgreSQL, VPC/private 5432, TLS and runtime Secret delivery do not exist yet;
7. the current hosted-KB health and security evidence is not current enough to authorize release;
8. the production site build does not receive the AI BFF URL.

## Findings

### P0 - No CloudRun deployment path consumes the manifest

`buildCloudRunServiceDefs()` is used only by `scripts/cloudrun-manifest.test.mjs`. No script or workflow builds and pushes the two images, resolves their registry digests, applies the manifest, runs migrations, deploys BFF/worker, verifies active revisions, shifts traffic or rolls back.

The current `.github/workflows/deploy-test.yml` contains none of:

```text
PUBLIC_AI_API_BASE_URL=false
build:ai=false
cloudrun-service-manifest=false
smoke:ai=false
```

It deploys the existing CloudBase functions and site only.

**Required:** create one protected CloudRun integration workflow or deploy command that consumes the manifest and owns build -> registry digest -> migration -> BFF/worker canary -> remote smoke -> site URL/CORS wiring -> promotion/rollback.

### P0 - The current hosted corpus contains a known false supplier fact

The 2026-09-02 buyer-content run observed the assistant claim **5,000+ engineers**. The site says **40+ Engineers** and **5000+ m2 Facility**.

The root cause is still present at HEAD. Array records such as:

```yaml
- value: '40+'
  label: Engineers
- value: '5000+'
  label: m2 Facility
```

are flattened into separate lines, then globally deduplicated. Current dry-run output still contains separated entries such as:

```text
stats -> items -> value: 50+
stats -> items -> label: Case Studies
stats -> items -> value: 30+
stats -> items -> label: Trusted Clients
```

The latest commit records the defect but does not fix it.

**Required:** emit each list record atomically (`Engineers: 40+`), add projector tests using repeated values, rebuild the corpus generation, and rerun buyer-content plus security acceptance. Do not deploy a known false supplier credential.

### P1 - Concurrent startup migrations fail

Both BFF and worker call `migrateUp()` before listening. The migration runner checks applied versions without a transaction-wide advisory lock, then executes `CREATE EXTENSION` and schema migrations.

A real empty-database probe ran two migrations concurrently:

```text
migration_a=0
migration_b=1
constraint=pg_extension_name_index
```

This can make an initial BFF/worker rollout or parallel scale-up fail nondeterministically.

**Required:** use a PostgreSQL advisory lock covering discovery and application, or run migrations as one explicit pre-deploy job and keep service startup migration-free. Add a concurrent migration test against PostgreSQL.

### P1 - A dead-lettered `cancel_run` strands a live conversation

`failOutboxAttempt()` atomically compensates only a dead-lettered `start_run`. A final `cancel_run` failure has no equivalent terminalization or repair path.

A real isolated-database probe produced:

```json
{
  "disposition": "dead_letter",
  "outbox": "dead_letter",
  "run": "running",
  "cancelRequested": true,
  "activeRunId": "still-set"
}
```

Nothing can claim the dead-lettered cancellation, while the active run continues to occupy the conversation.

**Required:** atomically terminalize/release the run when `cancel_run` dead-letters, or create a durable repair/reaper path. Add a database invariant test that no dead-letter cancellation can coexist with a live active run.

### P1 - Worker shutdown does not drain active work

On SIGTERM the worker sets `shuttingDown`, closes the health server and closes PostgreSQL in the server callback. It does not wait for the current `processOne()`/provider stream, abort it deliberately, complete or release its outbox claim, or prove shutdown within CloudRun's termination window.

A rollout can therefore close the pool underneath active work or leave a provider stream and lease to expire.

**Required:** track the active operation, stop claiming new work, abort/drain the current engine stream, persist a retryable state or release the claim, await pool close, then exit. Add process-level SIGTERM tests for idle, provider-in-flight and DB-in-flight states.

### P1 - Hosted KB release evidence is stale/incomplete today

Historical 2026-09-01 evidence reports authenticated retrieval, sync/SSE generation and citations against the public workspace. The latest 2026-09-02 evidence says the 29-case security battery and browser verification were not run because outbound connectivity failed.

The current review's unauthenticated probe of `https://kb.supplychainsai.com/api/ping` failed during TLS connection (`HTTP 000`). This does not prove the service is down globally, but it means the old acceptance cannot be treated as current release evidence.

The canonical triage still lists K4/K5 as pending despite later historical success, so the repository has conflicting status sources.

**Required:** after fixing/reingesting the corpus, rerun the authenticated probe with the exact serving credential/workspace/generation/provenance, sync and SSE generation, citations, public-source isolation, forbidden-write check and the full security battery. Publish one current evidence artifact and reconcile K4/K5 once.

### P1 - Production Widget URL and CORS are not wired

The widget requires `PUBLIC_AI_API_BASE_URL` at site build time. No workflow supplies it. A manual build with a placeholder URL proves the mechanism works, but the production deployment path does not use it.

The BFF separately requires `CORS_ALLOWED_ORIGINS`; the future CloudRun deployment must include the exact production site origins.

**Required:** after BFF canary URL exists, build the site with `PUBLIC_AI_API_BASE_URL=<BFF HTTPS origin>`, configure the same site origin in BFF CORS, and run browser create/message/SSE/cancel/resume/citation tests against deployed services.

### P1 - Production database/network/Secret resources do not exist

Read-only CloudBase inspection on 2026-09-07 observed:

- environment `diversity-123-d9grnqfux221323bb`: normal, Shanghai, Standard plan;
- PostgreSQL: not provisioned;
- CloudRun environment: enabled;
- CloudRun services: only historical `ai-probe`;
- no `ai-bff` or `ai-worker` service.

`ai-probe` is function mode, MinNum 0, public/OA/miniapp accessible, no VPC, no internal access, no environment variables, and currently returns HTTP 503 after about 31 seconds. It is evidence infrastructure, not a production runtime.

The manifest describes required environment keys but is not a CloudRun API payload and does not define actual VPC/subnet, service identity, secret transfer, active revision verification or rollback.

**Required:** obtain budget approval, provision pay-as-you-go TencentDB PostgreSQL in Shanghai, choose exact VPC/subnet/security group, attach BFF and worker, allow private 5432 only, confirm TLS, and define protected runtime Secret injection. Never use a public database endpoint.

### P2 - Browser retry/backoff and AI deployment E2E need hardening

The widget retries only after a clean stream EOF. Fetch/read/JSON failures become unavailable immediately. `Retry-After` is not exposed through CORS or represented in the public error contract.

Repository tests prove route placement statically and transcript auto-follow through source inspection, but no normal Playwright spec exercises the deployed widget. The 2026-09-02 document explicitly says browser verification was outstanding.

**Required before production enablement:** deployed browser E2E for route allowlist, conversation persistence, reconnect from `Last-Event-ID`, cancel, expiry, rate-limit backoff, mobile viewport, keyboard/focus behavior and first-party citation navigation.

### P2 - Branch and documentation are not release-clean

The branch is one commit ahead of origin. Several architecture/procurement/readme files are modified but uncommitted, and `.claude` session artifacts are untracked. `CHANNEL_AI_ASSISTANT_ARCHITECTURE.md` currently has a trailing-whitespace diff error.

**Required:** reconcile concurrent documentation deliberately, keep session artifacts out of delivery, push the reviewed commit, and require local/remote/reviewed SHA equality before deployment.

## Corrections to static-review concerns

The current code does handle several areas better than a surface read suggests:

- BFF readiness calls `AiStore.health()`, which verifies READ COMMITTED and performs a temporary-table write inside a rollback transaction.
- Human cancellation atomically increments the conversation control version, records `cancel_requested_at`, enqueues `cancel_run`, and writes an audit event.
- `start_run` dead-letter terminalization is atomic with its outbox transition.
- Provider output and citations are withheld until publication policy passes, then committed in one fenced transaction.
- Credential scope/expiry, message idempotency, event sequencing and one-live-run constraints are database-backed.
- Images are digest-pinned locally, bundles build as Node 22 artifacts, and remote HTTP KB transport is refused by production configuration.

These strengths justify moving into private integration after the code blockers are fixed. They do not replace the missing deployment and infrastructure gates.

## Independent validation

| Check | Result |
|---|---|
| CloudBase environment inspection | PASS - normal, Shanghai |
| CloudRun environment | PASS - enabled |
| Production BFF/worker inventory | FAIL - neither exists |
| PostgreSQL inventory | FAIL - not provisioned |
| Existing ai-probe | FAIL - HTTP 503; no VPC; scale-to-zero |
| Manifest deploy consumer | FAIL - absent |
| Deployment workflow AI wiring | FAIL - 4 required consumers absent |
| Current corpus projection | FAIL - list value/label still split |
| Concurrent migration probe | FAIL - one of two runners exits 1 |
| cancel_run dead-letter probe | FAIL - live run/active pointer stranded |
| Current hosted KB health from this network | FAIL - TLS connection did not complete |
| AI tests without DB | PASS with 26 DB tests skipped |
| Full AI tests on isolated PostgreSQL | PASS - 290 total, 288 passed, 2 intentional adapter skips |
| Deployment/script contracts | PASS - 159 |
| Production AI bundles | PASS - BFF/worker build |
| Workspace and E2E typechecks | PASS - 18 projects |
| Lint | PASS - 374 files |
| Current-HEAD local container rebuild | PASS |
| Current-HEAD BFF/worker smoke | PASS |
| Site build | PASS - 10 pages |
| Widget build-time URL injection | PASS manually; FAIL in deployment workflow |
| Public website | PASS - HTTP 200 |
| Full 29-case security battery | NOT RUN in latest evidence |

## Deployment sequence for Claude

### Phase D0 - Fix code and content blockers

1. Fix statistics/list-record corpus projection and add adversarial tests.
2. Add migration serialization and concurrent-start test.
3. Add `cancel_run` dead-letter compensation/recovery and invariant test.
4. Implement Worker shutdown drain and process-level SIGTERM tests.
5. Rebuild the hosted public corpus and rerun the full KB/security evidence.

### Phase D1 - Build an executable deployment consumer

1. Create a protected CloudRun workflow/script that imports `cloudrun-service-manifest.mjs`.
2. Build both images from the reviewed SHA and push to an approved registry.
3. Resolve immutable digests and deploy only digest references.
4. Inject protected environment values without committing or logging them.
5. Add release identity, active-revision checks, canary traffic and rollback.
6. Wire `PUBLIC_AI_API_BASE_URL` into the site build and exact site origins into BFF CORS.

### Phase D2 - Private cloud integration

Requires explicit budget/resource approval:

1. Provision TencentDB PostgreSQL in `ap-shanghai`.
2. Configure same-VPC private connectivity and security group for port 5432.
3. Run serialized migrations and S0-S11 from the cloud path.
4. Deploy worker privately and BFF publicly with MinNum 1.
5. Run remote readiness, round-trip SSE, cancellation, takeover and failure smokes.
6. Keep the widget disabled or pointing nowhere during this phase.

### Phase D3 - Canary and production enablement

1. Run deployed browser E2E and the 29-case security battery.
2. Verify current KB evidence, citations, corpus generation and credential rotation.
3. Verify logs/alerts, dead-letter detection, rate-limit behavior and shutdown drain.
4. Enable the widget for a canary origin/traffic slice.
5. Promote only after active revision, metrics and customer-visible answers pass.

## Final answer

**Start deployment engineering now, but do not deploy customer traffic yet.**

The immediate Claude task is Phase D0 followed by D1. Do not purchase TencentDB or create production BFF/worker services until the migration, cancellation, shutdown and corrupted-corpus blockers are fixed and the deploy consumer exists. Once those are green, the project is ready for a bounded private CloudRun/TencentDB integration window.
