# CI/CD Design

Status: PR CI, test deploy, and manual E2E workflows implemented; test deploy
proven by GitHub Actions run 28160182821
Scope: GitHub Actions path for repeatable CloudBase deployments
Last updated: 2026-06-26

## 1. Answer To The E2E/CI Question

CI/CD does not need to run the full browser E2E suite on every change.

The correct split is:

- Pull requests: fast checks only, no CloudBase secrets, no real DB writes.
- `test` deploy: build, deploy, HTTP smoke, and optionally public browser smoke.
- Manual or protected release gate: admin and mutation E2E against the real test
  environment.
- Bootstrap E2E: one-shot manual flow only.

This keeps CI useful without making every code push depend on a writable shared
CloudBase database.

## 2. Current Deployment Method

Current P0 deployment has been performed by the agent through CloudBase
MCP/`mcporter` operations:

- Create/update Event Functions: `admin`, `public-api`
- Configure runtime environment variables directly on functions
- Configure HTTP access routes:
  - `/api/admin` -> `admin`
  - `/api` -> `public-api`
- Deploy CloudBase Web App service `channel-test`
- Verify CloudBase build/version status and HTTP smoke

GitHub Actions now has:

- `.github/workflows/ci.yml` for PR/branch checks without CloudBase secrets.
- `.github/workflows/deploy-test.yml` for protected test deployment.
- `.github/workflows/e2e.yml` for manual protected E2E gates.

The deploy workflow has one successful GitHub Actions proof run for the
CloudBase test env. Future changes should preserve the same build, deploy,
smoke, and verification sequence.

## 3. Proposed Workflows

### Pull Request CI

Trigger:

- `pull_request` for feature-branch work.
- Push to `test` and `main` for release-branch checks.

No secrets.

Steps:

1. Install with `pnpm install --frozen-lockfile`.
2. Run `pnpm lint`.
3. Run `pnpm typecheck`, including `tests/e2e` typechecking.
4. Run `pnpm test`.
5. Run `pnpm package:functions`.
6. Run `pnpm smoke:functions`.
7. Run `pnpm build` with non-secret public defaults.
8. Run static secret-name scan over `apps/site/dist`.
9. Run `pnpm test:e2e --list` to validate Playwright spec syntax/discovery.

Do not deploy from PRs. Do not expose CloudBase or Tencent credentials to forked
PRs.

### Test Deploy

Trigger:

- `workflow_dispatch`
- Push to `test`

Uses GitHub Environment `test`.

Steps:

1. Run the PR CI checks.
2. Build function artifacts.
3. Build static site with:
   - `PUBLIC_API_BASE_URL`
   - `PUBLIC_CB_PROXY=0`
4. Deploy/update CloudBase functions with runtime `Nodejs20.19`.
5. Update function runtime env from GitHub Environment values. Do not copy names
   blindly: map GitHub `TCB_ENV_ID` to function runtime `TCB_ENV`.
6. Ensure HTTP access routes exist.
7. Upload the built static site to CloudBase hosting for the existing
   `channel-test` web app domain.
8. Configure `index.html` as both index and error document for SPA routing.
9. Run HTTP smoke:
  - Active site pages `/`, `/admin`, `/login`, `/oem`, `/portfolio` return `200`
  - Retired storefront routes `/headphones` and `/overstock` return `404`
   - `GET /api/health`
   - `GET /api/products?pageSize=1`
   - `GET /api/overstock?pageSize=1`
   - `POST /api/admin` with
     `{"action":"list","data":{"collection":"users"}}` and no token returns
     controlled `401`
   - Unknown public paths, including `/api/files/__missing__`, return `404`
10. Optionally install Chromium with `npx playwright install --with-deps chromium`
    and run `pnpm test:e2e:public` once the site/API URLs are known.

### Manual E2E Gate

Trigger:

- `workflow_dispatch` only

Inputs:

- suite: `public`, `admin`, `mutation`, or `bootstrap`

GitHub Environment `test` provides `SITE_URL`, `PUBLIC_API_BASE_URL`,
`TCB_ENV_ID`, and protected E2E credentials.

Rules:

- `public` may run any time after a successful test deploy.
- `admin` requires an active admin credential.
- `mutation` requires `E2E_ALLOW_MUTATION=1` and should run against `test` only.
- `bootstrap` requires both local `E2E_ENABLE_BOOTSTRAP=1` and deployed
  `BOOTSTRAP_ENABLED=1`; it must be followed by disabling bootstrap in CloudBase
  runtime config.
- Browser-driving suites require `npx playwright install --with-deps chromium`
  before execution on a clean GitHub Actions runner.

### Production Deploy

Trigger:

- `workflow_dispatch`
- Later: push to `main` or tag release

Uses GitHub Environment `prod`.

Blocked until:

- A real prod CloudBase EnvId exists.
- The intended owner account/resource owner is confirmed.
- Production Tencent CAM deployment credentials exist.
- Production runtime secrets and URLs are configured.
- Required reviewer approval is enabled.

Production should not use the current test EnvId.

## 4. Required Variables And Secrets

GitHub Environment variables for `test`:

- `TCB_ENV_ID` (deploy target; map to function runtime `TCB_ENV`)
- `APP_ENV=test` (non-app deploy label; current code does not read it)
- `CLOUDBASE_REGION=ap-shanghai`
- `CLOUDBASE_FUNCTION_RUNTIME=Nodejs20.19` or workflow default
- `PUBLIC_CB_PROXY=0`
- `PUBLIC_API_BASE_URL`
- `SITE_URL`
- `CORS_ALLOWED_ORIGINS`
- `LOGIN_URL`
- `ADMIN_EMAIL`

Function runtime env mapping for `admin`:

| GitHub source | Function runtime name |
| --- | --- |
| `vars.TCB_ENV_ID` | `TCB_ENV` |
| `vars.CORS_ALLOWED_ORIGINS` | `CORS_ALLOWED_ORIGINS` |
| `vars.LOGIN_URL` | `LOGIN_URL` |
| `vars.ADMIN_EMAIL` | `ADMIN_EMAIL` |
| `secrets.JWT_SECRET` | `JWT_SECRET` |
| `secrets.ADMIN_PASSWORD_HASH` | `ADMIN_PASSWORD_HASH` |
| `secrets.BOOTSTRAP_ADMIN_TOKEN` | `BOOTSTRAP_ADMIN_TOKEN` |

Function runtime env mapping for `public-api`:

| GitHub source | Function runtime name |
| --- | --- |
| `vars.TCB_ENV_ID` | `TCB_ENV` |
| `vars.PUBLIC_API_BASE_URL` | `PUBLIC_API_BASE_URL` |
| `vars.CORS_ALLOWED_ORIGINS` | `CORS_ALLOWED_ORIGINS` |

GitHub Environment secrets for `test`:

- `TENCENTCLOUD_SECRETID`
- `TENCENTCLOUD_SECRETKEY`
- `TENCENTCLOUD_SESSIONTOKEN` when using temporary credentials from MCP
- `JWT_SECRET`
- `ADMIN_PASSWORD_HASH`
- `BOOTSTRAP_ADMIN_TOKEN`
- Optional: `E2E_ADMIN_PASSWORD`
- Optional SMTP secrets

Current known gap: the workflow and scripts are present, but the GitHub
Environment must be verified to contain the deploy credentials and runtime
secrets before GitHub Actions can reproduce the current manual CloudBase
deployment.

## 5. Implementation Order

1. Keep P0 agent-operated deployment stable.
2. Finish first-admin bootstrap and disable bootstrap.
3. Run/manual-verify the public/admin/mutation E2E gates when credentials are
   intentionally available.
4. Add PR CI without CloudBase secrets.
5. Add manual `test` deploy workflow.
6. Add optional/manual E2E workflow.
7. Add protected `main` -> `prod` workflow only after prod EnvId exists.

## 6. Concrete Execution Plan

### Step 1: PR CI Workflow (implemented in `.github/workflows/ci.yml`)

Triggers:

- `pull_request` (all PRs — gates feature-branch work)
- Push to `test` and `main` (release branches)

Runner steps:

1. `actions/checkout`
2. `pnpm/action-setup` with pnpm 11.5.0
3. `actions/setup-node` with Node 22.13.0 and pnpm cache
4. `pnpm install --frozen-lockfile`
5. `pnpm lint`
6. `pnpm typecheck`
7. `pnpm test` (workspace unit tests)
8. `pnpm package:functions`
9. `pnpm smoke:functions`
10. `pnpm build`
11. Static scan of `apps/site/dist` for server secret names
12. `pnpm test:e2e --list`

No GitHub Environment and no CloudBase/Tencent secrets are attached to this
workflow.

### Step 2: Add Test Deploy Workflow

Create `.github/workflows/deploy-test.yml`.

Trigger:

- `workflow_dispatch`
- Push to `test`

Environment:

- `test`

Runner steps:

1. Run the same install/check/package/build sequence as PR CI.
2. Build `apps/site` with:
   - `PUBLIC_API_BASE_URL=${{ vars.PUBLIC_API_BASE_URL }}`
   - `PUBLIC_CB_PROXY=0`
3. Configure CloudBase auth from Tencent deploy secrets.
4. Set active EnvId from `${{ vars.TCB_ENV_ID }}`.
5. Deploy/update packaged functions with target runtime `Nodejs20.19`.
   CloudBase function runtime is effectively creation-time immutable in this
   workflow: same-name force create and config update do not change runtime.
   If an existing function runtime differs from the target, the deployment
   script must delete and recreate that function name, then restore config and
   gateway access before smoke.
6. Update function runtime env using the explicit mapping table in §4.
7. Ensure gateway routes:
   - `/api/admin` -> `admin`
   - `/api` -> `public-api`
8. Upload `apps/site/dist` to CloudBase static hosting for the existing
   `channel-test` web app domain.
9. Configure website index/error document to `index.html`.
10. Run HTTP smoke exactly as listed in §3.
11. Write a deployment summary with commit SHA, EnvId, Web App URL, API URL, and
    smoke result. Do not print secret values.

### Step 3: Add Manual E2E Workflow

Create `.github/workflows/e2e.yml`.

Trigger:

- `workflow_dispatch`

Inputs:

- `suite`: `public`, `admin`, `mutation`, or `bootstrap`

Runner steps:

1. `pnpm install --frozen-lockfile`
2. `npx playwright install --with-deps chromium`
3. Export `E2E_SITE_URL` and `E2E_API_URL` from GitHub Environment values,
   defaulting from `TCB_ENV_ID` when explicit URLs are absent.
4. For `admin` and `mutation`, export `E2E_ADMIN_EMAIL` and
   `E2E_ADMIN_PASSWORD` from protected environment values.
5. For `mutation`, require `suite == mutation` and set `E2E_ALLOW_MUTATION=1`.
6. For `bootstrap`, require a protected environment approval, set
   `E2E_ENABLE_BOOTSTRAP=1`, and verify the deployed function has
   `BOOTSTRAP_ENABLED=1` before running.
7. Run the selected spec:
   - public: `npx playwright test tests/e2e/public.spec.ts`
   - admin: `npx playwright test tests/e2e/admin-auth.spec.ts`
   - mutation: `npx playwright test tests/e2e/mutation.spec.ts`
   - bootstrap: `npx playwright test tests/e2e/bootstrap.spec.ts`
8. Upload `output/playwright/` only when `E2E_RECORD_ARTIFACTS=1`; otherwise keep
   artifacts disabled to avoid recording credentials.
9. For mutation, run a cleanup assertion for `e2e-` records after the suite.

### Step 4: Add Production Workflow Later

Do not implement production deploy until:

- A real prod CloudBase EnvId exists.
- The owner account/resource ownership is confirmed.
- `prod` GitHub Environment has Tencent deploy credentials and runtime secrets.
- Required reviewer approval is enabled.
- The `test` workflow has successfully reproduced the current P0 deployment.

## 7. Review Audit (2026-06-25)

The env-var/secret table (§4) and smoke steps (§3) were reconciled against the
code that actually consumes them (`apps/functions/*/src/index.ts`,
`packages/shared/src/env.ts`) and the canonical deployment docs. Names match
except where noted. Workflows are still design-only, so these are
pre-implementation corrections.

### Findings

| # | Sev | Location | Issue | Fix |
| --- | --- | --- | --- | --- |
| C1 | P1 (latent) | §4 variable list | The GitHub Environment variable is named `TCB_ENV_ID`, but both functions read `TCB_ENV` at init (`apps/functions/admin/src/index.ts`, `apps/functions/public-api/src/index.ts`). Step 5 ("update function runtime env from GitHub Environment values") implies a 1:1 copy — copying `TCB_ENV_ID` verbatim makes the function throw `Missing required environment variable: TCB_ENV` at cold start. Doc-nit today, deploy-breaking BLOCK the moment the workflow is implemented. | Map GitHub var `TCB_ENV_ID` -> function runtime var `TCB_ENV` explicitly, or rename the GitHub var to `TCB_ENV`. |
| C2 | P2 | §3 Test Deploy step 9 | "`GET /api/files/__missing__` remains not publicly exposed" — there is no `/api/files/*` route; this is a generic catch-all 404, not a files guard. (The literal also differs from the spec's `e2e-missing`.) | Reword to "any unknown path (incl. `/api/files/*`) returns 404"; to actually smoke file privacy, hit `/api/images/<unlinked-id>` and expect 404. |
| C3 | P2 | §3 Test Deploy step 9 | "`POST /api/admin` unauthenticated returns controlled 401" holds only for a protected action sent without a token; a `{}` body returns 400 ("must include an action"). | Specify the smoke posts e.g. `{"action":"list","data":{"collection":"users"}}` with no token to deterministically get 401. |
| C4 | P3 | §4 variable list | `APP_ENV=test` is listed as required, but no code reads it (only `NODE_ENV` / `PUBLIC_*` / the named runtime vars). | Drop it, or label it explicitly as a non-app deploy label. |
| C5 | P3 | §3 Manual E2E Gate | The browser-driving suites (admin/mutation/bootstrap and the public render test) require Playwright browser binaries; only `pnpm install --frozen-lockfile` is mentioned. (Verified: discovery fails with "playwright: command not found" before install, and `page`-based tests need the browser.) | Add `npx playwright install --with-deps chromium` to the Manual E2E Gate and the optional public-browser-smoke step. |

### Verified correct

- Env-var names match code: `PUBLIC_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `JWT_SECRET`, `ADMIN_PASSWORD_HASH` (not `ADMIN_PASSWORD`), `LOGIN_URL`, `ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN`.
- URL topology (`*.webapps.tcloudbase.com` site / `*.service.tcloudbase.com` API / EnvId `diversity-123-…`) matches `CLOUDBASE_DEPLOYMENT_DESIGN.md`.
- Smoke routes `/api/health`, `/api/products`, `/api/overstock` exist; every `pnpm` script referenced in §3 exists in `package.json`; no secrets committed; the "no real-DB E2E as a default PR gate" split is sound.

### Resolution

- C1 fixed with explicit `TCB_ENV_ID -> TCB_ENV` runtime mapping.
- C2 fixed by describing `/api/files/*` as an unknown-path 404 and reserving
  real image privacy for the browser E2E mutation suite.
- C3 fixed by specifying the exact unauthenticated protected admin action body.
- C4 fixed by labeling `APP_ENV` as a deploy label, not an app runtime input.
- C5 fixed by adding the Chromium install step before browser-driving suites.

## 8. Multi-Function Release Consistency

### Problem

The current test deployment updates CloudBase functions by function name. That is
acceptable while the function set is small and every change is backward
compatible, but it is not atomic across a group of functions or across
functions plus the static site. If the project later has many functions, live
traffic can temporarily hit a mixed release: some functions already on the new
code, some still on the previous code, and possibly a static site built for a
different API shape.

This is part of CD, not a separate infrastructure concern. The deployment
workflow owns the release order, consistency checks, rollback posture, and
visibility of what release is active.

### Risk Cases

- Cross-function contract drift: one function writes a new DB shape while
  another still reads the old shape.
- Static/backend mismatch: the web app is uploaded before all required backend
  functions are verified.
- Runtime/config mismatch: code deploys before required env vars or runtime
  settings are in place.
- Route churn: deleting/recreating a function to change runtime can temporarily
  leave the HTTP access route missing or pointing at an unavailable function.
- DB migration mismatch: destructive schema or document-shape changes are
  deployed before all readers are compatible.
- Auth/session mismatch: one function issues tokens or role claims that another
  release cannot validate.
- Partial failure: the deploy fails halfway and the next run does not know
  whether to resume, roll forward, or restore the previous state.
- Concurrent deploys: two workflow runs target the same EnvId and interleave
  function updates.

### Required Enhancements

1. Release manifest

   The package/deploy step should create a manifest for every release:

   - `releaseId`: Git SHA for GitHub Actions deploys.
   - Function name, artifact hash, target runtime, handler, and source package.
   - Function env-key contract, without secret values.
   - Expected HTTP access route for each function.
   - Static build hash or build marker for `apps/site/dist`.
   - Smoke endpoints that prove the release is serving.

2. Release identity in runtime config

   Add `RELEASE_ID` to every deployed function env. Health or metadata smoke can
   verify that all functions serving test traffic report the same release id.
   If a public health response includes release data, expose only non-secret
   metadata such as release id, runtime family, and build timestamp.

3. Phased deploy order

   The deploy script should become manifest-driven:

   1. Preflight current state: EnvId, function names, runtime, routes, and env
      key presence.
   2. Snapshot previous state needed for rollback or operator diagnosis.
   3. Update function config and deploy backend functions.
   4. Verify each function is active, has target runtime, has expected
      non-secret env keys, and serves the new `RELEASE_ID`.
   5. Ensure HTTP access routes are present.
   6. Upload static site last.
   7. Run public smoke and selected deployed E2E gates.
   8. Write a deployment summary with release id, function versions observed,
      routes, site URL, API URL, and smoke result.

4. Compatibility rule

   Until a true blue/green function switch exists, each release must be
   compatible with the previous release for at least one deploy window:

   - API changes are additive or tolerate old fields.
   - DB changes follow expand/contract: add new fields first, migrate, then
     remove old fields in a later release.
   - New env vars are optional/defaulted for one release before becoming
     required.
   - Static site upload stays last, after backend verification.

5. Rollback and resume posture

   The first implementation should favor safe roll-forward plus clear state over
   pretending that rollback is always automatic. If failure happens before static
   upload, abort the static upload. If failure happens after static upload, the
   deployment summary must make it clear which functions and static build are
   active so the operator can rerun the previous commit or apply a fix-forward
   commit.

   The script should be idempotent: rerunning the same release id should compare
   observed state against the manifest and converge missing pieces instead of
   blindly recreating everything.

6. Deploy concurrency

   The GitHub Actions deploy workflow must serialize deploys per CloudBase EnvId:

   ```yaml
   concurrency:
     group: cloudbase-deploy-${{ vars.TCB_ENV_ID || github.ref_name }}
     cancel-in-progress: false
   ```

   `cancel-in-progress: false` avoids killing a deploy after some functions have
   already been updated. Newer runs should wait for the active deploy to finish.

### Version/Alias Research Track

CloudBase HTTP access currently works by mapping a path such as `/api` to a
CloudBase function name. Tencent Cloud SCF supports function versions, aliases,
and weighted traffic shifting, including grayscale release and alias rollback.
That is the likely path for true near-atomic backend switching, but it needs a
small spike before it becomes part of the main CD design.

Spike questions:

- Can CloudBase-managed functions expose SCF `PublishVersion`, `CreateAlias`,
  and `UpdateAlias` operations safely through the available Tencent/CloudBase
  deploy credential?
- Can CloudBase HTTP access target a function alias or qualifier, or does it
  always resolve only by function name?
- If HTTP access cannot target aliases directly, can a stable router function or
  CloudRun service route to versioned backends without adding unacceptable
  latency or complexity?

If aliases are viable, the future deployment flow should become:

1. Deploy each function as a new unpublished/latest artifact.
2. Publish immutable versions for all changed functions.
3. Smoke the new versions out of band.
4. Move a stable alias, for example `test-current`, to the new version set.
5. Keep the previous alias target available for quick rollback.

If aliases are not viable in CloudBase HTTP access, keep the manifest-driven
rolling deploy, enforce the compatibility rule, and consider grouping tightly
coupled APIs into fewer functions to reduce mixed-release surface area.

Reference docs:

- CloudBase HTTP access:
  <https://docs.cloudbase.net/en/service/access-cloud-function>
- CloudBase cloud function HTTP quick start:
  <https://docs.cloudbase.net/en/cloud-function/quick-start>
- Tencent SCF alias grayscale release:
  <https://www.tencentcloud.com/document/product/583/37458>
- Tencent SCF traffic routing:
  <https://www.tencentcloud.com/document/product/583/35952>

### Implementation Landing Points

- `scripts/deploy-cloudbase-test.mjs`: make deployment manifest-driven, add
  `RELEASE_ID`, preflight current state, verify post-deploy state, and make
  reruns idempotent.
- `.github/workflows/deploy-test.yml`: add EnvId-scoped concurrency, pass
  `GITHUB_SHA` as the release id, and upload the deployment summary artifact.
- `scripts/smoke-cloudbase-deploy.mjs`: assert release id consistency, runtime
  consistency, route availability, and public API/site smoke.
- `apps/functions/*`: expose safe release metadata through health or admin-only
  diagnostics, without returning secrets.

### Phased Execution

Phase A should be implemented first because it is low risk and immediately
verifiable: release manifest, `RELEASE_ID`, EnvId concurrency, post-deploy
consistency checks, and summary output.

Phase B adds stronger resume/rollback metadata and a dry-run or plan mode.

Phase C is the SCF alias/qualifier spike.

Phase D implements alias-based blue/green or canary release only if Phase C
proves CloudBase HTTP access can route to aliases safely.

## 9. Validated Review Disposition

The implementation review pulled in commit `72c1a96` was validated against the
current workflows and deploy scripts on 2026-06-26. Thread-aware GitHub review
scan for PR #1 found no separate conversation comments, reviews, or inline
threads.

The valid active follow-ups are now tracked in
`docs/CICD_EXECUTION.md`:

1. Scope deploy/E2E secrets to only the steps that need them.
2. Change deploy concurrency from ref-scoped to CloudBase EnvId-scoped.
3. Add release identity/manifest checks before relying on multi-function
   consistency.
4. Treat `mcporter --args` secret transport as a test-env residual risk unless
   stdin or env-file transport is confirmed.
5. Make bootstrap E2E explicitly require or manage deployed
   `BOOTSTRAP_ENABLED=1`.
6. Replace catch-all file-route smoke with deterministic real media privacy
   coverage when test data is available.
7. Add CloudBase-specific deploy gates for function env read-merge, function public
   access permission, and `manageApps` vs `manageHosting` hosting-mode choice.

The previously noted missing unit-test gate is already fixed and is not kept as
an active execution item.
