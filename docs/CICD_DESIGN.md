# CI/CD Design

Status: Step 1 PR CI implemented; deploy workflows not implemented yet
Scope: GitHub Actions path for repeatable CloudBase deployments
Last updated: 2026-06-25

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

There is no GitHub Actions deploy workflow in the repo yet.

## 3. Proposed Workflows

### Pull Request CI

Trigger:

- `pull_request`
- Pushes to feature branches, if desired

No secrets.

Steps:

1. Install with `pnpm install --frozen-lockfile`.
2. Run `pnpm lint`.
3. Run `pnpm typecheck`, including `tests/e2e` typechecking.
4. Run `pnpm build:functions`.
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
- Later: push to `test`

Uses GitHub Environment `test`.

Steps:

1. Run the PR CI checks.
2. Build function artifacts.
3. Build static site with:
   - `PUBLIC_API_BASE_URL`
   - `PUBLIC_CB_PROXY=0`
4. Deploy/update CloudBase functions.
5. Update function runtime env from GitHub Environment values. Do not copy names
   blindly: map GitHub `TCB_ENV_ID` to function runtime `TCB_ENV`.
6. Ensure HTTP access routes exist.
7. Deploy Web App/static site.
8. Poll Web App build/version status until success or failure.
9. Run HTTP smoke:
   - Site pages `/`, `/admin`, `/login`, `/oem`, `/headphones`, `/overstock`
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
- site URL
- API URL

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

- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `JWT_SECRET`
- `ADMIN_PASSWORD_HASH`
- `BOOTSTRAP_ADMIN_TOKEN`
- Optional: `E2E_ADMIN_PASSWORD`
- Optional SMTP secrets

Current known gap: only the GitHub PAT has been set through the earlier setup.
Tencent deploy credentials and runtime secrets are not fully in GitHub
Environments yet, so GitHub Actions cannot reproduce the current manual
CloudBase deployment today.

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

### Step 1: Add PR CI Workflow

Create `.github/workflows/ci.yml`.

Triggers:

- `pull_request`
- Push to `dev/albertli/try01`, `test`, and later `main`

Runner steps:

1. `actions/checkout`
2. `pnpm/action-setup` with pnpm 11.5.0
3. `actions/setup-node` with Node 22.12.0 and pnpm cache
4. `pnpm install --frozen-lockfile`
5. `pnpm lint`
6. `pnpm typecheck`
7. `pnpm package:functions`
8. `pnpm smoke:functions`
9. `pnpm build`
10. Static scan of `apps/site/dist` for server secret names
11. `pnpm test:e2e --list`

No GitHub Environment and no CloudBase/Tencent secrets are attached to this
workflow.

### Step 2: Add Manual Test Deploy Workflow

Create `.github/workflows/deploy-test.yml`.

Trigger:

- `workflow_dispatch`

Environment:

- `test`

Runner steps:

1. Run the same install/check/package/build sequence as PR CI.
2. Build `apps/site` with:
   - `PUBLIC_API_BASE_URL=${{ vars.PUBLIC_API_BASE_URL }}`
   - `PUBLIC_CB_PROXY=0`
3. Configure CloudBase auth from Tencent deploy secrets.
4. Set active EnvId from `${{ vars.TCB_ENV_ID }}`.
5. Deploy/update packaged functions.
6. Update function runtime env using the explicit mapping table in §4.
7. Ensure gateway routes:
   - `/api/admin` -> `admin`
   - `/api` -> `public-api`
8. Deploy/update Web App `channel-test`.
9. Poll Web App version until success/failure.
10. Run HTTP smoke exactly as listed in §3.
11. Write a deployment summary with commit SHA, EnvId, Web App URL, API URL, and
    smoke result. Do not print secret values.

### Step 3: Add Manual E2E Workflow

Create `.github/workflows/e2e.yml`.

Trigger:

- `workflow_dispatch`

Inputs:

- `suite`: `public`, `admin`, `mutation`, or `bootstrap`
- `site_url`
- `api_url`

Runner steps:

1. `pnpm install --frozen-lockfile`
2. `npx playwright install --with-deps chromium`
3. Export `E2E_SITE_URL` and `E2E_API_URL` from workflow inputs.
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
