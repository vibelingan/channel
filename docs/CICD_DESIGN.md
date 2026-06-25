# CI/CD Design

Status: design only, workflows not implemented yet
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
3. Run `pnpm typecheck`.
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
5. Update function runtime env from GitHub Environment values.
6. Ensure HTTP access routes exist.
7. Deploy Web App/static site.
8. Poll Web App build/version status until success or failure.
9. Run HTTP smoke:
   - Site pages `/`, `/admin`, `/login`, `/oem`, `/headphones`, `/overstock`
   - `GET /api/health`
   - `GET /api/products?pageSize=1`
   - `GET /api/overstock?pageSize=1`
   - `POST /api/admin` unauthenticated returns controlled `401`
   - `GET /api/files/__missing__` remains not publicly exposed
10. Optionally run `pnpm test:e2e:public` once the site/API URLs are known.

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
- `bootstrap` requires `E2E_ENABLE_BOOTSTRAP=1` and must be followed by disabling
  bootstrap in CloudBase runtime config.

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

- `TCB_ENV_ID`
- `APP_ENV=test`
- `CLOUDBASE_REGION=ap-shanghai`
- `PUBLIC_CB_PROXY=0`
- `PUBLIC_API_BASE_URL`
- `SITE_URL`
- `CORS_ALLOWED_ORIGINS`
- `LOGIN_URL`
- `ADMIN_EMAIL`

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
