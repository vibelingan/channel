# CloudBase Deployment Design

Status: canonical deployment design after review
Scope: make the Channel portal available on Tencent CloudBase with clean secret separation
Last updated: 2026-06-25

## 1. Purpose

This document replaces the initial exploratory deployment plan with a reviewed
design that is ready to drive implementation. It incorporates:

- The independent review findings from the original Tencent Cloud deployment
  draft, now merged into this canonical document.
- The live CloudBase environment inspection for `diversity-123-d9grnqfux221323bb`.
- A clean separation of build-time variables, GitHub Secrets, Docker/build
  inputs, and CloudBase runtime environment variables.
- A deployment path that gets the website in front of the client quickly, while
  leaving lower-risk hardening as follow-up work.

## 2. Current Facts

Repository facts:

- `apps/site` is an Astro static build with React islands.
- `apps/functions/admin` is a CloudBase function package, but its entrypoint
  currently accepts direct invocation shape instead of HTTP envelope shape.
- `apps/local-server` has the only complete HTTP API today.
- The browser clients use a small API URL helper. With no
  `PUBLIC_API_BASE_URL`, they preserve same-origin relative paths such as
  `/api/admin`, `/api/products`, `/api/overstock`, `/api/images/:id`, and
  `/api/files/:id`. When `PUBLIC_API_BASE_URL` is set, API and API-backed media
  URLs resolve against that API origin.
- `pnpm build`, `pnpm build:functions`, and `pnpm typecheck` pass locally.

Live CloudBase environment facts:

- EnvId: `diversity-123-d9grnqfux221323bb`
- Alias: `diversity-123`
- Region: `ap-shanghai`
- Package: `baas_trial`
- Runtime mode: NoSQL
- PostgreSQL: not provisioned
- MySQL: not provisioned
- NoSQL collections: none yet
- Cloud functions: none yet
- CloudRun services: none yet
- CloudBase Web Apps: none yet
- Static hosting: online, contains CloudBase auth helper files and
  `cloud-admin/index.html`
- Storage bucket: present and private
- CLS/log service: not enabled
- CloudBase app auth username/password: enabled
- CloudBase publishable key: not present
- Local Web SDK safe domains: no `localhost` entry

Design implication:

- Use CloudBase NoSQL for the first deployment.
- CloudBase NoSQL, effectively MongoDB-style document storage, is the selected
  application database for now. PostgreSQL and MySQL are intentionally not part
  of the P0/P1 plan and do not need to be provisioned unless the data model
  changes materially.
- Use HTTP functions for the app API, not direct browser database writes.
- Treat the current env as the first `test` env. Production should use a
  separate `prod` env before the first `main` deployment.

## 3. Deployment Goals

P0 goal:

- A client can open a CloudBase-hosted URL and use the core website.
- Public catalog pages load from CloudBase HTTP APIs.
- Admin can log in and manage content.
- OEM submissions persist.
- No obvious private OEM file leak exists.

P1 goal:

- Deployment is repeatable from GitHub Actions.
- Runtime secrets are managed through GitHub Environments and CloudBase function
  environment variables.
- Static hosting, functions, database, and storage are smoke-tested after deploy.
- Logs and rollback are operationally usable.

P2 goal:

- Custom domain, production isolation, CloudBase Storage migration, rate
  limiting, durable monitoring, and cookie-based auth hardening are in place.

### 3.1 Two-Environment Branch Strategy

This is a small project, so use exactly two CloudBase environments by default:
`test` for test/client-review builds and `prod` for production. Do not create a
separate staging environment unless the project grows enough to justify it.

| Git branch | GitHub Environment | CloudBase env | Deploy behavior | Notes |
| --- | --- | --- | --- | --- |
| Feature branches / PRs | none | none | Checks only, no CloudBase deploy | No cloud secrets |
| `test` | `test` | Current env or future `channel-test` env | Test/client-review deploys | Current EnvId starts here |
| `main` | `prod` | `channel-prod` env | Production deploy | Separate prod data and secrets |

Environment decisions:

- Use `diversity-123-d9grnqfux221323bb` as `test` unless the team chooses to
  recreate a cleaner test env.
- Use `test` as the deployment branch name while the remote has nested refs such
  as `dev/albertli/try01`. Git cannot have both a top-level `dev` branch and
  existing `dev/...` branches at the same time.
- Create a separate `prod` CloudBase env before enabling `main` production
  deployments. Do not promote the current test env to prod.
- The production CloudBase EnvId should come from the account intended to own
  production resources. If the CloudBase owner account should own production,
  create the `prod` env under that account and grant deployment credentials for
  CI/agents.
- Treat release validation as a state of the `test` environment, not a third
  staging environment.
- After production launch, never let the `test` branch deploy into `prod`, and
  never let `main` deploy into `test`.
- Keep CloudRun, minimum instances, CLS, and other potentially chargeable
  services off until they are part of an explicit priority item.

## 4. Target Topology

### 4.1 Fast Dev/Test Topology

Use this first because it avoids blocking on custom domain, ICP, DNS, or
same-domain routing.

```text
Browser
  -> CloudBase Web App domain
      -> Astro static site
      -> browser calls PUBLIC_API_BASE_URL + /api/*
  -> CloudBase HTTP access default domain
      -> /api/admin      -> admin Event Function via HTTP access
      -> /api            -> public-api Event Function via HTTP access
                            (products, overstock, images, health)
```

CloudBase HTTP access strips the matched route prefix before invoking the Event
Function. The `public-api` adapter therefore accepts both full API paths such as
`/api/products` and stripped paths such as `/products` when it is mounted at
`/api`.

Frontend build behavior:

- `PUBLIC_API_BASE_URL` is a non-secret build-time value.
- If `PUBLIC_API_BASE_URL` is empty, the client uses same-origin relative paths.
- If `PUBLIC_API_BASE_URL` is set, the client prefixes all API calls with it.

Function CORS behavior:

- Allow the CloudBase Web App domain.
- Allow the eventual custom client domain.
- Allow `localhost:4321` only for development.
- Return `204` for `OPTIONS`.

### 4.2 Production Custom-Domain Topology

Use this after the first client-visible deployment is stable.

```text
www.client-domain.com
  -> HTTP access custom domain
      -> /api/* -> CloudBase HTTP functions
      -> /*     -> static hosting or Web App/static upstream
```

CloudBase HTTP service routing supports mapping domain + path rules to upstream
resources such as SCF, Cloud Run, and Static Hosting. The custom-domain route
plan must be validated with the selected CloudBase CLI/MCP before changing the
frontend back to same-origin-only paths.

Fallback if single-domain routing is not approved or not feasible:

```text
www.client-domain.com      -> static site
api.client-domain.com      -> CloudBase HTTP functions
```

In that fallback, the static build sets:

```env
PUBLIC_API_BASE_URL=https://api.client-domain.com
```

## 5. Application Boundaries

### 5.1 Static Site

Source:

- `apps/site`

Build:

```bash
pnpm build
```

Output:

- `apps/site/dist`

Deployment target:

- P0: CloudBase Web App through `manageApps` so the site receives an independent
  `*.webapps.tcloudbase.com` domain.
- P1: custom domain via CloudBase HTTP access routes or static hosting binding.

Build-time inputs:

- `PUBLIC_API_BASE_URL`
- `PUBLIC_CB_PROXY=0`, for local/dev proxy control only. It is harmless but
  does not affect a static production build.
- `PUBLIC_CB_HOST` only for local development or temporary preview builds.

Static build must never receive:

- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `ADMIN_PASSWORD_HASH`
- `BOOTSTRAP_ADMIN_TOKEN`
- `EMAIL_PASSWORD`
- Tencent SecretId or SecretKey

### 5.2 Admin HTTP Function

Source:

- `apps/functions/admin`

Route:

- `POST /api/admin`
- `OPTIONS /api/admin`

Required first fix:

- Add an HTTP envelope adapter. The adapter parses CloudBase HTTP function input,
  decodes `event.body` if needed, preserves direct invocation support only as a
  test fallback, calls `handleAdminRequest`, and returns:

```ts
{
  statusCode: number,
  headers: Record<string, string>,
  body: string,
  isBase64Encoded?: false
}
```

The handler-level protocol stays:

```json
{ "action": "login", "data": {}, "token": "optional" }
```

Actions:

- `register`
- `login`
- `recover`
- `submitProject`
- `me`
- `updateProfile`
- `changePassword`
- `collections`
- `list`
- `get`
- `create`
- `update`
- `remove`
- `batchUpdate`
- `batchRemove`

Bootstrap action:

- Prefer a one-shot trusted script over a public HTTP action.
- If a temporary HTTP bootstrap action is needed for P0, gate it behind
  `BOOTSTRAP_ADMIN_TOKEN`, require `BOOTSTRAP_ENABLED=1`, and make it fail once
  any admin user exists.
- Remove `BOOTSTRAP_ADMIN_TOKEN` or set `BOOTSTRAP_ENABLED=0` immediately after
  first admin creation.

### 5.3 Public API HTTP Function

Source:

- Add `apps/functions/public-api`.

Routes:

- `GET /api/health`
- `GET /api/products`
- `GET /api/products/:id`
- `GET /api/overstock`
- `GET /api/overstock/:id`
- `GET /api/images/:id`

Do not expose in the public function:

- `GET /api/files/:id` for OEM drawings

Public API requirements:

- Return only `published: true` catalog records.
- Apply category/search/page/pageSize server-side.
- Cap `pageSize` to 48.
- Gate image bytes by published-linked records, not by raw image id alone.
- Return JSON errors with stable `ok: false` envelopes.
- Add CORS headers for approved origins.

OEM file downloads:

- Move behind `admin` function or a dedicated authenticated route.
- Require admin or contributor role.
- Keep filename sanitization for `Content-Disposition`.

### 5.4 Database

Current target:

- CloudBase NoSQL document database.

Collections:

| Collection | Purpose | P0 access path |
| --- | --- | --- |
| `users` | Portal users, password hashes, roles | Admin function only |
| `products` | Public catalog | Public function read, admin write |
| `overstock` | Clearance catalog | Public function read, admin write |
| `oemProjects` | Public OEM submissions | Admin function create/read/write |
| `images` | Image metadata or temporary base64 image docs | Public function read only when published-linked |
| `files` | OEM drawing metadata or temporary base64 file docs | Admin/contributor only |

P0 may temporarily keep the current base64 storage model if the data set is
small and file uploads are capped. That is acceptable only for test review.

P1 must move binary objects to CloudBase Storage before real customer files or
large catalog images are accepted.

Indexes:

- `users.email`
- `users.username`
- `users.role`
- `products.published`
- `products.category`
- `products.name`
- `products.updatedAt`
- `overstock.published`
- `overstock.category`
- `overstock.productCode`
- `overstock.updatedAt`
- `oemProjects.status`
- `oemProjects.email`
- `oemProjects.createdAt`
- `images.name`
- `files.name`

Database rules:

- Browser clients do not directly read/write NoSQL collections in P0.
- Server-side functions use CloudBase manager/server privileges.
- Default collection client rules should deny direct write.
- Sensitive collections should deny direct client read.

### 5.5 Storage

P0:

- Keep the CloudBase storage bucket private.
- Do not expose raw OEM file URLs.
- Serve private downloads through authenticated function logic.

P1:

- Store binaries in CloudBase Storage.
- Store only metadata and `fileID` or storage path in NoSQL.

Recommended paths:

```text
catalog/images/{imageId}/{safeFileName}
oem/projects/{projectId}/{safeFileName}
admin/uploads/{yyyy}/{mm}/{uuid}-{safeFileName}
```

Storage write consistency:

1. Upload object.
2. Create metadata document.
3. If metadata write fails, delete uploaded object.
4. If delete fails, log cleanup work.

### 5.6 Auth

Current app auth:

- Custom password auth in the admin function.
- JWT session tokens with role embedded.
- Token TTL is about 12 hours.

P0:

- Keep custom JWT.
- Keep role decisions in backend functions.
- Store password hashes only.
- Use `ADMIN_PASSWORD_HASH`, not plaintext `ADMIN_PASSWORD`, for production
  bootstrap.
- Keep `localStorage` token storage for now, with the risk documented.

P1:

- Add rate limits for login, register, recovery, and OEM submit.
- Log failed login attempts.
- Consider shorter admin TTL.

P2:

- Evaluate httpOnly secure cookies.
- Evaluate CloudBase native auth/Web SDK only if product needs CloudBase user
  identities directly.

CloudBase publishable key:

- Not required for the current custom-JWT P0 path.
- Required only if the frontend starts using CloudBase Web SDK directly for auth,
  database, or storage. If that happens, create/ensure the publishable key and
  add safe domains first.

### 5.7 Email

Package:

- `packages/email`

Runtime:

- Nodemailer via SMTP.
- Console mock when SMTP is not configured.

P0:

- Password recovery and OEM confirmation should not block core writes if SMTP
  fails.
- Function runtime env may omit SMTP for initial client demo if recovery email is
  not part of the demo.

P1:

- Configure Tencent Exmail or chosen SMTP.
- Add internal notification for new OEM submissions if requested.
- Alert on sustained email failures.

## 6. Secret And Environment Separation

### 6.1 Principle

There are four separate env surfaces:

1. GitHub Actions secrets and variables.
2. Static build-time variables.
3. Docker/build context variables.
4. CloudBase function runtime variables.

Secrets are stored in GitHub only to deliver deployment and runtime
configuration. The actual runtime source of truth is CloudBase function
environment configuration after deployment.

No secret may be:

- Committed to git.
- Added to an Astro `PUBLIC_` variable.
- Written into `apps/site/dist`.
- Baked into a Docker image layer.
- Echoed in CI logs.

### 6.2 GitHub Environments

Create GitHub Environments:

- `test`: maps to the `test` branch and the current CloudBase test env.
- `prod`: maps to the `main` branch and the separate CloudBase production env.

Use environment protection:

- `test`: deploy allowed from `test`; manual deploy can be allowed from the
  current working branch during the initial transition.
- `prod`: deploy allowed from `main` only, with required reviewer approval.
- PRs and feature branches run checks without deployment secrets.

Repository-level variables can hold non-secrets:

| Name | Example | Notes |
| --- | --- | --- |
| `NODE_VERSION` | `20` | Build runner version |
| `PNPM_VERSION` | `11.5.0` | Matches repo package manager |
| `CLOUDBASE_REGION` | `ap-shanghai` | Non-secret |

Environment variables can hold non-secret environment-specific values:

| Name | `test` value | `prod` value | Notes |
| --- | --- | --- | --- |
| `TCB_ENV_ID` | `diversity-123-d9grnqfux221323bb` | `<prod EnvId>` | Non-secret but environment-scoped |
| `APP_ENV` | `test` | `prod` | Runtime label |
| `SITE_ORIGIN` | Test Web App URL | Production URL | Used for CORS/login links |
| `PUBLIC_API_BASE_URL` | Test API origin | Production API origin | Build-time public value |

Environment secrets:

| Name | Used by | Notes |
| --- | --- | --- |
| `TENCENT_SECRET_ID` | GitHub deploy job | CAM sub-account, least privilege |
| `TENCENT_SECRET_KEY` | GitHub deploy job | Never passed to static build |
| `JWT_SECRET` | CloudBase runtime | Function env only |
| `ADMIN_PASSWORD_HASH` | Bootstrap script/action | Argon2id hash only |
| `BOOTSTRAP_ADMIN_TOKEN` | First admin bootstrap only | Remove/disable after bootstrap |
| `EMAIL_USER` | CloudBase runtime | SMTP identity |
| `EMAIL_PASSWORD` | CloudBase runtime | SMTP secret |

Use the same secret names inside each GitHub Environment instead of repository
secrets with suffixes such as `_DEV` or `_PROD`. That keeps PRs secret-free and
prevents accidental production secret use from the `test` branch.

Values that can be GitHub variables instead of secrets:

- `ADMIN_EMAIL`
- `LOGIN_URL`
- `EMAIL_HOST`
- `EMAIL_PORT`
- `EMAIL_SECURE`
- `EMAIL_FROM`, if it has no private token.

### 6.3 Static Build-Time Variables

Allowed:

```env
PUBLIC_CB_PROXY=0
PUBLIC_API_BASE_URL=https://api-or-default-http-domain.example
```

Maybe allowed:

```env
PUBLIC_SITE_ENV=dev
```

Disallowed:

```env
JWT_SECRET=...
ADMIN_PASSWORD=...
ADMIN_PASSWORD_HASH=...
EMAIL_PASSWORD=...
TENCENT_SECRET_ID=...
TENCENT_SECRET_KEY=...
```

Build guard:

- CI should fail if any disallowed name is present in the static build env.
- CI should scan `apps/site/dist` for known secret values after build.

### 6.4 CloudBase Runtime Variables

Set on `admin` and `public-api` functions as needed:

| Variable | Function | Secret | Notes |
| --- | --- | --- | --- |
| `TCB_ENV` | both | no | Exact EnvId |
| `APP_ENV` | both | no | `test` or `prod` |
| `SITE_ORIGIN` | both | no | Browser origin allowed by CORS |
| `CORS_ALLOWED_ORIGINS` | both | no | Comma-separated list |
| `JWT_SECRET` | admin | yes | Session signing |
| `ADMIN_EMAIL` | bootstrap | no | First admin identity |
| `ADMIN_PASSWORD_HASH` | bootstrap | yes | Argon2id hash |
| `BOOTSTRAP_ENABLED` | bootstrap | no | Must become `0` after bootstrap |
| `BOOTSTRAP_ADMIN_TOKEN` | bootstrap | yes | Temporary |
| `LOGIN_URL` | admin | no | Recovery email link |
| `EMAIL_HOST` | admin | no | SMTP host |
| `EMAIL_PORT` | admin | no | SMTP port |
| `EMAIL_SECURE` | admin | no | SMTP SSL flag |
| `EMAIL_USER` | admin | yes | SMTP user |
| `EMAIL_PASSWORD` | admin | yes | SMTP password |
| `EMAIL_FROM` | admin | maybe | Sender value |

CloudBase function env variable names must avoid reserved prefixes such as
`SCF_`, `QCLOUD_`, and `TENCENTCLOUD_`.

### 6.5 Docker And Image Builds

P0 does not require Docker because the app uses static hosting and CloudBase
functions.

If CloudRun is introduced later:

- Docker build args must be non-secret only.
- Runtime secrets go into CloudRun service environment variables, not image
  layers.
- Use Docker BuildKit secrets only for build-only credentials such as private
  package registry access, and ensure they are not copied into the final image.
- Never copy `.env` into the image.
- Tag images by git SHA.
- Scan final image metadata/history for leaked secret names and values.

## 7. Deployment Packaging

### 7.1 Function Packaging

CloudBase Node functions need an entry file and `package.json` when npm packages
are used.

Resolved P0.6 packaging strategy:

- Internal workspace packages are bundled into function artifacts.
- `@vibelingan-channel/email` is explicitly bundled into the admin artifact.
- `packages/auth` uses `hash-wasm` argon2id instead of native `argon2`, so the
  deployed password verifier no longer depends on macOS-built native bindings.
- `zod`, `jose`, `nodemailer`, `hash-wasm`, and `wx-server-sdk` are bundled
  rather than required from a deploy-time `node_modules`.
- CloudBase Nodejs18.15 does not provide `wx-server-sdk` to this deployed
  function by default, so leaving it external causes cold start failure.

Artifact command:

```bash
pnpm package:functions
pnpm smoke:functions
```

Deployment should use:

```text
.cloudbase-artifacts/functions/admin
.cloudbase-artifacts/functions/public-api
```

Generate `ADMIN_PASSWORD_HASH` with the same `hash-wasm` based
`hashPassword(...)` helper that the deployed runtime verifies.

Function artifact should contain:

```text
index.js
package.json
```

Acceptance:

- In a clean directory with only the artifact, `node -e "require('./index.js')"`
  must resolve every bundled non-builtin dependency, including `wx-server-sdk`.

### 7.2 Frontend Packaging

Static artifact:

```text
apps/site/dist
```

Must not include:

- Source maps unless intentionally published.
- `.env`
- Any runtime secret value.

### 7.3 Deployment Method

Preferred for AI-assisted CloudBase work:

- MCP or `mcporter` with explicit EnvId.

Acceptable for CI:

- CloudBase CLI using CAM credentials stored as GitHub Environment secrets.

Do not rely on:

- A developer's local device-code session for CI.
- Implicit CloudBase current env.

Recommended deployment scaffold for implementation:

```text
cloudbaserc.json
deploy/cloudbase/test.json
deploy/cloudbase/prod.json
scripts/deploy-functions.sh
scripts/deploy-webapp.sh
scripts/smoke-cloudbase.sh
```

The exact `cloudbaserc.json` schema must be validated against the selected
CloudBase CLI/MCP path before implementation. The logical shape should include:

- Explicit EnvId from the selected GitHub Environment.
- Function root under `apps/functions`.
- HTTP functions `admin` and `public-api`.
- Static/Web App source `apps/site/dist`.
- No staging target.

## 8. GitHub Actions Design

Detailed browser E2E coverage lives in `docs/E2E_TEST_PLAN.md`. Detailed
CI/CD workflow design lives in `docs/CICD_DESIGN.md`. This section records only
the canonical deployment boundary.

### 8.1 Pull Request Workflow

Runs without secrets:

- Install dependencies.
- Typecheck.
- Lint.
- Build static site.
- Build functions.
- Check generated function package for unresolved workspace imports.
- Check `apps/site/dist` does not contain known secret names.
- Validate Playwright spec discovery with `pnpm test:e2e --list`.

No deploy on forked PRs.

Do not run the full real-DB browser E2E suite as a default PR gate.

### 8.2 Test Deploy Workflow

Trigger:

- Manual `workflow_dispatch`.
- Push to `test` after the first deploy is stable.
- Temporary manual deploy from the current working branch is allowed only during
  the initial transition.

Uses GitHub Environment:

- `test`

Steps:

1. Install dependencies.
2. Run checks.
3. Build functions.
4. Build static site using only public build variables.
5. Configure/update CloudBase function runtime env from GitHub Environment
   secrets/variables.
6. Deploy functions.
7. Configure HTTP routes.
8. Deploy Web App/static site.
9. Run smoke tests.
10. Print only URLs and non-sensitive metadata.

After the deployed site/API URLs are known, public browser smoke may run against
the `test` environment. Admin, mutation, and bootstrap E2E suites remain manual
or protected gates because they require credentials or write real CloudBase data.

Branch rule:

- `test` is the only automatic test/client-review deploy branch.
- Feature branches and PRs must not receive CloudBase deployment secrets.

### 8.3 Production Workflow

Trigger:

- Manual `workflow_dispatch`.
- Push to `main` after the `prod` CloudBase env and secrets are configured.
- Later: tags after approval.

Uses GitHub Environment:

- `prod`

Additional controls:

- Required reviewers.
- No direct deploy from feature branches.
- No deploy from `test` to the `prod` env.
- Require previous artifact promotion when possible.
- Write deployment summary with commit SHA, EnvId, domains, smoke status, and
  rollback artifact id.

## 9. CloudBase Resource Design

### 9.1 Environment

For immediate test deployment:

- Use `diversity-123-d9grnqfux221323bb`.
- Label it as `test` in GitHub Environments.

For production launch:

- Create a separate `prod` CloudBase env, for example `channel-prod`.
- Map `main` deployments to `prod` only.
- Keep production data, secrets, and storage separate from `test`.
- Do not create a separate staging env for this small project.

### 9.2 Functions

Functions:

- `admin`
- `public-api`

Runtime:

- Use the CloudBase-supported Node runtime selected during implementation.
- Current docs show Nodejs 18.15 as an available runtime. The repo currently
  states Node `>=20`; align repo, tsup target, and CloudBase runtime before
  deployment.

Function permissions:

- `admin`: authenticated admin/contributor/member flows only, except login,
  register, recover, OEM submit, and temporary bootstrap if enabled.
- `public-api`: read-only public catalog and health endpoints.

### 9.3 HTTP Access

P0:

- Use CloudBase default HTTP access domain for functions.
- Use CORS to allow the Web App domain.

P1:

- Bind custom domain with SSL certificate.
- Use route rules for `/api/*`.
- Add static upstream route only after a spike proves the selected CloudBase path
  supports the desired static upstream.

### 9.4 Static Hosting Or Web App

P0:

- Deploy with CloudBase Web App independent subdomain.

P1:

- Bind custom domain and decide whether static traffic is served by Web App,
  Static Hosting, or HTTP access routing.

### 9.5 Database And Storage

P0:

- Create NoSQL collections.
- Create indexes.
- Keep direct client access denied.
- Keep storage bucket private.

P1:

- Migrate images/files to CloudBase Storage.
- Add metadata backfill and rollback.
- Add temporary upload cleanup.
- Keep an immutable backup of imported local JSON before migration.
- Verify document counts for `users`, `products`, `overstock`, `oemProjects`,
  `images`, and `files`.
- Verify a sample catalog image render and an authenticated OEM file download.
- Make migration scripts idempotent and avoid destructive schema changes.
- Treat storage objects as append-only during migration; use UUID or
  content-addressed paths and do not overwrite existing object paths.

### 9.6 Logs

P0:

- Function console logs are acceptable for first validation.

P1:

- Enable CLS/log service.
- Add smoke log checks.
- Log action name, status code, duration, request id, and env label.
- Never log tokens, passwords, password hashes, SMTP secrets, or CAM keys.
- Track cloud function invocation count, latency, errors, and timeouts.
- Track login failures, OEM submission success/failure, storage compensation
  failures, email failures, and database read/write errors.
- Alert on 5xx spikes, login failure spikes, OEM submission failures, sustained
  email failures, storage upload/delete failures, and database errors.
- Prefer unauthenticated `GET /api/health` for synthetic checks; if an admin
  smoke uses credentials, define a renewable monitor credential because JWTs
  expire.

## 10. Security Decisions

Secrets:

- No plaintext admin password in production.
- No runtime secret in static build.
- No Tencent CAM key in app runtime.

Data:

- Users collection is admin-only.
- Public catalog only exposes published records.
- OEM drawings are private.
- Public image bytes require published-linked validation.

Auth:

- JWT role claims remain for P0.
- Role changes take effect after token expiry or re-login.
- First admin bootstrap is explicit, idempotent, and temporary.

Rate limits:

- P0 can launch only if basic request caps and upload caps are present.
- P1 adds durable per-IP/per-email rate limiting.

## 11. Open Decisions

These must be resolved before production, but should not block the first
test deploy unless the client requires them immediately:

1. What is the production CloudBase EnvId after `channel-prod` or equivalent is
   created?
2. What is the client-facing domain?
3. Is ICP already complete for that domain if required?
4. Should the production site use one domain or split `www` and `api`?
5. Is SMTP required for the first test client review?
6. Are real catalog images and OEM drawings expected before P1 storage migration?
7. Who owns production smoke approval after `main` deploys to `prod`?

## 12. Official References Checked

- CloudBase HTTP function access: https://docs.cloudbase.net/en/service/access-cloud-function
- CloudBase HTTP service routes: https://docs.cloudbase.net/en/cli-v1/routes
- CloudBase custom domains: https://docs.cloudbase.net/en/cli-v1/domains
- CloudBase function environment variables: https://docs.cloudbase.net/en/cloud-function/function-configuration/env
- CloudBase cloud function quick start: https://docs.cloudbase.net/en/cloud-function/quick-start
- CloudBase MCP tools: https://docs.cloudbase.net/en/ai/cloudbase-ai-toolkit/mcp-tools
