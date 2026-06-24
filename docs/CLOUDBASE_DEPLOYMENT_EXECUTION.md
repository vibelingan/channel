# CloudBase Deployment Execution Plan

Status: implementation plan for client availability
Scope: concrete work order for deploying the Channel portal to CloudBase
Last updated: 2026-06-24

## 1. Execution Principle

Prioritize the shortest safe path to a client-visible website:

1. Make the deployed site and deployed APIs talk to each other.
2. Make admin login possible.
3. Protect private OEM files.
4. Make deployment repeatable.
5. Then do storage migration, custom domain, stronger monitoring, and other
   nice-to-haves.

Do not start by polishing CI, custom domains, or storage migration if the app
cannot yet serve `/api/admin` and `/api/products` from CloudBase.

## 2. P0 Definition Of Done

P0 is done when all of these are true:

- A client-visible URL loads the Astro site from CloudBase.
- `/`, `/admin`, `/login`, `/oem`, `/headphones`, and `/overstock` render.
- Browser API calls reach CloudBase HTTP functions.
- `GET /api/health` succeeds.
- `GET /api/products?pageSize=1` succeeds with a valid JSON envelope.
- `POST /api/admin` can log in as the first admin.
- Admin can list at least one collection.
- OEM submission writes to CloudBase.
- OEM file download is not publicly accessible by guessing `/api/files/:id`.
- Static build contains no runtime secrets.
- Function package has no unresolved workspace imports.
- Deployment notes record EnvId, URLs, commit SHA, smoke status, and known gaps.

## 3. P0 Workstream

### P0.0 Preflight

Owner: deployment agent
Goal: confirm the repo and CloudBase env are ready before code changes.

Steps:

1. Confirm branch and cleanliness.

   ```bash
   git status --short --branch
   git pull --ff-only
   ```

2. Confirm local checks.

   ```bash
   pnpm typecheck
   pnpm build:functions
   pnpm build
   ```

3. Confirm CloudBase MCP auth and env binding.

   ```bash
   npx mcporter call cloudbase.auth action=status --output json
   npx mcporter call cloudbase.auth action=set_env envId=diversity-123-d9grnqfux221323bb --output json
   npx mcporter call cloudbase.queryEnv action=info envId=diversity-123-d9grnqfux221323bb --output json
   ```

4. Record the current CloudBase state in deployment notes:

   - EnvId
   - Runtime mode
   - Existing functions
   - Existing collections
   - Static/Web App status
   - Storage bucket
   - CLS status

Acceptance:

- Repo is clean.
- CloudBase env is reachable.
- No implementation starts against an implicit env.

### P0.1 Secret And Variable Setup

Owner: deployment agent with account owner approval
Goal: set up secret separation before deploy automation uses sensitive values.

Create GitHub Environment:

```bash
gh api repos/:owner/:repo/environments/client-demo -X PUT
```

Set non-secret environment variables:

```bash
gh variable set TCB_ENV_ID --env client-demo --body "diversity-123-d9grnqfux221323bb"
gh variable set APP_ENV --env client-demo --body "client-demo"
gh variable set CLOUDBASE_REGION --env client-demo --body "ap-shanghai"
gh variable set PUBLIC_CB_PROXY --env client-demo --body "0"
```

Generate runtime secrets locally:

```bash
openssl rand -base64 48
```

Use the output for `JWT_SECRET`.

Generate a first-admin temporary password outside chat. Hash it locally:

```bash
pnpm exec tsx -e "import { hashPassword } from './packages/auth/src/password.ts'; console.log(await hashPassword(process.argv[1]));" 'replace-with-temp-password'
```

Store secrets in GitHub Environment:

```bash
gh secret set TENCENT_SECRET_ID --env client-demo
gh secret set TENCENT_SECRET_KEY --env client-demo
gh secret set JWT_SECRET --env client-demo
gh secret set ADMIN_PASSWORD_HASH --env client-demo
gh secret set BOOTSTRAP_ADMIN_TOKEN --env client-demo
```

Store non-secret runtime values:

```bash
gh variable set ADMIN_EMAIL --env client-demo --body "admin@example.com"
gh variable set LOGIN_URL --env client-demo --body "https://<site-url>/login"
gh variable set CORS_ALLOWED_ORIGINS --env client-demo --body "https://<site-url>,http://localhost:4321"
```

Optional SMTP:

```bash
gh variable set EMAIL_HOST --env client-demo --body "smtp.exmail.qq.com"
gh variable set EMAIL_PORT --env client-demo --body "465"
gh variable set EMAIL_SECURE --env client-demo --body "true"
gh variable set EMAIL_FROM --env client-demo --body '"Channel Portal" <admin@example.com>'
gh secret set EMAIL_USER --env client-demo
gh secret set EMAIL_PASSWORD --env client-demo
```

Acceptance:

- No `.env` file contains client-demo runtime secrets.
- Static build job will receive only `PUBLIC_*` variables.
- CloudBase function env receives runtime secrets after deploy or as part of
  function config update.

### P0.2 Route Strategy Spike

Owner: deployment agent
Goal: decide how the first client-visible site calls APIs.

Fast path:

- Use CloudBase Web App domain for static site.
- Use CloudBase default HTTP access domain for APIs.
- Add `PUBLIC_API_BASE_URL` support in frontend clients.

Implementation tasks:

1. Add an API URL helper in the site code.
2. Use it in:
   - admin API client
   - session API client
   - shop API client
   - image/file URL helpers
3. If `PUBLIC_API_BASE_URL` is empty, preserve current same-origin behavior.
4. If it is set, prefix every `/api/*` URL with it.

Acceptance:

- Local dev still works with relative `/api/*`.
- A production build can target a separate API origin without code changes.
- CORS origin list is explicit.

Do not block P0 on custom domain unless the client requires the final domain for
the first review.

### P0.3 Admin HTTP Adapter

Owner: backend agent
Goal: make `admin` usable as a CloudBase HTTP function.

Implementation tasks:

1. Add a small HTTP adapter module in `apps/functions/admin/src`.
2. Detect HTTP envelope fields such as method, headers, body, and base64 flag.
3. Parse JSON body into `{ action, data, token }`.
4. Preserve direct invocation fallback only for tests.
5. Return HTTP response objects with:
   - `statusCode`
   - JSON `Content-Type`
   - CORS headers
   - stringified JSON body
6. Return `204` on `OPTIONS`.
7. Map handler errors to JSON envelope, not unhandled HTTP 500 where possible.
8. Add tests for:
   - plain JSON POST
   - base64 JSON POST
   - invalid JSON
   - OPTIONS
   - direct invocation fallback

Acceptance:

- `POST /api/admin` with `{"action":"login"}` reaches `handleAdminRequest`.
- Unknown action returns JSON `BAD_REQUEST`.
- Browser `fetch` contract remains unchanged.

### P0.4 Public API Function

Owner: backend agent
Goal: move local public routes into a deployable CloudBase HTTP function.

Implementation tasks:

1. Create `apps/functions/public-api`.
2. Share or extract catalog helper logic from `apps/local-server/src/main.ts`
   without importing Express.
3. Implement routes:
   - `GET /api/health`
   - `GET /api/products`
   - `GET /api/products/:id`
   - `GET /api/overstock`
   - `GET /api/overstock/:id`
   - `GET /api/images/:id`
4. Do not implement public `/api/files/:id`.
5. Enforce `published: true` on catalog reads.
6. Enforce `pageSize <= 48`.
7. Gate image bytes by published-linked record.
8. Return binary responses with correct `Content-Type` and cache headers.
9. Add tests for published filtering, unpublished 404, image authorization, and
   page size cap.

Acceptance:

- Public catalog routes work without admin token.
- Unpublished documents never leak.
- Raw image ids not linked to published records do not leak.
- OEM files cannot be downloaded through public API.

### P0.5 First Admin Bootstrap

Owner: backend/deployment agent
Goal: create the first admin in CloudBase without plaintext production password.

Preferred implementation:

- Add a one-shot bootstrap script that writes to CloudBase NoSQL through a
  trusted management path.

Minimum acceptable P0 implementation:

- Add temporary `bootstrapAdmin` action to the admin function.
- Require:
  - `BOOTSTRAP_ENABLED=1`
  - `BOOTSTRAP_ADMIN_TOKEN`
  - `ADMIN_EMAIL`
  - `ADMIN_PASSWORD_HASH`
- Check if any active admin user exists.
- If an admin exists, return conflict and do not write.
- If no admin exists, create one user with:
  - `email`
  - `username`
  - `role: "admin"`
  - `status: "active"`
  - `passwordHash`
  - `loginCount: 0`
- Immediately disable bootstrap after success.

Acceptance:

- Admin can be created exactly once.
- No plaintext admin password is stored in GitHub, CloudBase env, docs, or logs.
- Re-running bootstrap does not overwrite an existing admin.

### P0.6 Function Packaging Fix

Owner: backend/deployment agent
Goal: ensure deployed functions can cold start outside the monorepo.

Implementation tasks:

1. Decide native dependency handling for `argon2`.
2. Bundle internal workspace packages.
3. Ensure `@vibelingan-channel/email` is not left as unresolved external.
4. Ensure `zod`, `jose`, and `nodemailer` are either bundled or listed in the
   deploy artifact package manifest.
5. Keep `wx-server-sdk` external only if the selected CloudBase runtime provides
   it.
6. Generate a deploy artifact directory per function.
7. Add a package smoke:

   ```bash
   rg '@vibelingan-channel/' apps/functions/*/dist
   node -e "require('./apps/functions/admin/dist/index.js')"
   ```

   The `node -e` command may need a stub or CloudBase runtime guard if
   `wx-server-sdk` is unavailable locally; unresolved workspace imports are not
   acceptable.

Acceptance:

- Function artifact has no unresolved workspace imports.
- CloudBase deploy command receives the artifact directory, not the monorepo
  source root by accident.
- Runtime dependency strategy is documented.

### P0.7 CloudBase Resources

Owner: deployment agent
Goal: create the minimum cloud resources before deploying code.

Use MCP or CloudBase CLI with explicit EnvId.

Collections:

```text
users
products
overstock
oemProjects
images
files
```

Indexes:

```text
users.email
users.username
products.published
products.category
overstock.published
overstock.category
oemProjects.status
oemProjects.createdAt
```

Permissions:

- Deny direct client writes.
- Deny direct client reads for `users`, `oemProjects`, and `files`.
- If all browser reads go through functions, direct client reads can be denied
  for all collections in P0.

First write-permission test:

1. Create a temporary collection or document named `deploymentChecks`.
2. Write a timestamped document.
3. Read it back.
4. Delete it.
5. Record result in deployment notes.

Acceptance:

- Required collections exist.
- Index creation result is recorded.
- Write permissions are confirmed with a harmless create/read/delete.

### P0.8 Deploy Functions

Owner: deployment agent
Goal: publish `admin` and `public-api`.

Predeploy:

```bash
pnpm typecheck
pnpm build:functions
```

Set function runtime env:

```text
TCB_ENV=diversity-123-d9grnqfux221323bb
APP_ENV=client-demo
SITE_ORIGIN=https://<site-url>
CORS_ALLOWED_ORIGINS=https://<site-url>,http://localhost:4321
JWT_SECRET=<from GitHub Secret>
ADMIN_EMAIL=<from GitHub Variable>
ADMIN_PASSWORD_HASH=<from GitHub Secret>
BOOTSTRAP_ENABLED=1
BOOTSTRAP_ADMIN_TOKEN=<from GitHub Secret>
LOGIN_URL=https://<site-url>/login
EMAIL_*=...
```

Deploy:

- Use MCP `manageFunctions` or CloudBase CLI.
- Always pass EnvId explicitly.
- Record function names, runtime, and request IDs.

Acceptance:

- `queryFunctions(action=listFunctions)` shows `admin` and `public-api`.
- Both functions have expected env vars, without printing secret values.

### P0.9 Configure HTTP Access

Owner: deployment agent
Goal: make deployed functions reachable over HTTP.

Fast path:

- Use default CloudBase HTTP access domain.
- Add routes:
  - `/api/admin` -> `admin`
  - `/api/products` and `/api/products/*` -> `public-api`
  - `/api/overstock` and `/api/overstock/*` -> `public-api`
  - `/api/images/*` -> `public-api`
  - `/api/health` -> `public-api`

Validate:

```bash
curl -i https://<api-origin>/api/health
curl -i "https://<api-origin>/api/products?pageSize=1"
curl -i -X OPTIONS https://<api-origin>/api/admin
```

Acceptance:

- API origin and routes are known.
- CORS preflight succeeds for the site origin.
- `PUBLIC_API_BASE_URL` can be set to the API origin.

### P0.10 Deploy Static Site

Owner: frontend/deployment agent
Goal: publish the client-visible site.

Build:

```bash
PUBLIC_CB_PROXY=0 PUBLIC_API_BASE_URL=https://<api-origin> pnpm build
```

Secret scan:

```bash
rg 'JWT_SECRET|ADMIN_PASSWORD|ADMIN_PASSWORD_HASH|TENCENT_SECRET|EMAIL_PASSWORD|BOOTSTRAP' apps/site/dist
```

Deploy:

- Use CloudBase Web App through MCP `manageApps` for the first deployment.
- Service name suggestion: `channel-portal-client-demo`.
- Build path: `apps/site/dist`.

Acceptance:

- Site URL is returned.
- `/`, `/admin`, `/login`, `/oem`, `/headphones`, `/overstock` load.
- Network calls go to the API origin.

### P0.11 Bootstrap And Smoke

Owner: deployment agent
Goal: prove the site is usable.

Bootstrap:

```bash
curl -sS -X POST https://<api-origin>/api/admin \
  -H 'Content-Type: application/json' \
  -d '{"action":"bootstrapAdmin","data":{"token":"<BOOTSTRAP_ADMIN_TOKEN>"}}'
```

Then disable bootstrap:

- Set `BOOTSTRAP_ENABLED=0`, or remove the bootstrap token/runtime variable.
- Redeploy or update function config if CloudBase requires it.

Smoke:

```bash
curl -f https://<api-origin>/api/health
curl -f "https://<api-origin>/api/products?pageSize=1"
curl -f https://<site-url>/
curl -f https://<site-url>/admin/
```

Browser smoke:

- Open site URL.
- Open `/headphones`.
- Open `/overstock`.
- Open `/login`.
- Log in as admin.
- Open `/admin`.
- List collections.
- Create a throwaway product as unpublished.
- Confirm it does not appear in public catalog.
- Delete the throwaway product.
- Submit an OEM request without file.
- Confirm it appears in admin.

Private file smoke:

- Request a known `/api/files/:id` without auth.
- Expected: 401, 403, or 404. Never raw bytes.

Acceptance:

- Client URL works.
- Admin URL works.
- Bootstrap disabled after use.
- Smoke results are recorded.

## 4. P1 Workstream

P1 starts after P0 is client-visible.

### P1.1 GitHub Actions Deploy Workflow

Implement:

- PR workflow without secrets.
- Client-demo deploy workflow using GitHub Environment `client-demo`.
- Secret-to-CloudBase runtime env update step.
- Function artifact validation.
- Static secret scan.
- Post-deploy smoke tests.

Acceptance:

- Manual deploy can reproduce P0 from a clean runner.
- Fork PRs cannot access deployment secrets.

### P1.2 Storage Migration

Implement:

- Upload image bytes to CloudBase Storage.
- Upload OEM files to CloudBase Storage.
- Replace `data` fields with metadata and storage paths.
- Keep rollback backup.
- Add cleanup for orphaned objects.

Acceptance:

- No large base64 binaries remain in NoSQL for real data.
- Private OEM files are served only by authenticated function logic.

### P1.3 Rate Limits And Abuse Controls

Implement:

- Login attempts by IP and normalized email.
- Register attempts by IP and email.
- Recovery attempts by IP and email.
- OEM submit attempts by IP and email.
- Upload size and type validation in both browser and function.

Acceptance:

- Abuse limits are covered by tests.
- Legitimate admin/content flows still work.

### P1.4 Logs And Monitoring

Implement:

- Enable CLS/log service.
- Log action name, status code, duration, and request id.
- Do not log tokens, passwords, password hashes, or SMTP secrets.
- Add smoke log review.

Acceptance:

- Deployment smoke can find function logs.
- Basic error spikes can be inspected.

### P1.5 Custom Domain

Implement after domain/cert readiness:

- Bind `www.client-domain.com` or `api.client-domain.com`.
- Add HTTP access routes.
- Update `PUBLIC_API_BASE_URL` as needed.
- Update `LOGIN_URL`, `SITE_ORIGIN`, and `CORS_ALLOWED_ORIGINS`.
- Run full smoke.

Acceptance:

- Client can use the intended domain.
- SSL is valid.
- No mixed-content or CORS errors.

## 5. P2 Nice-To-Haves

Do these after client availability and P1 stability:

- Separate staging and production CloudBase environments.
- Promote immutable artifacts instead of rebuilding for production.
- Move session storage to httpOnly secure cookies.
- Add stronger admin password policy.
- Add cursor-based pagination for deep catalogs.
- Add CDN cache policy tuning.
- Add uptime monitoring outside CloudBase.
- Add CloudRun only if function constraints become limiting.
- Add CloudBase native Web SDK auth only if product needs it.

## 6. Agent Handoff Checklist

Every implementation agent should report:

- Branch and commit SHA.
- Files changed.
- Which priority item was addressed.
- Commands run.
- CloudBase resources created or changed.
- Runtime env keys changed, with secret values redacted.
- URLs tested.
- Smoke result.
- Remaining blockers.

## 7. Stop Conditions

Stop and ask before continuing if:

- The CloudBase EnvId differs from `diversity-123-d9grnqfux221323bb`.
- A command would print or export secret values.
- Same-domain custom routing cannot be validated and the code still lacks
  `PUBLIC_API_BASE_URL`.
- Function deployment requires a runtime lower than the code can support.
- Bootstrap would overwrite an existing admin.
- Any public endpoint returns OEM file bytes without auth.

## 8. Suggested Issue Split

P0 issues:

1. Add API base URL helper and CORS-aware clients.
2. Add CloudBase HTTP adapter for `admin`.
3. Add `public-api` HTTP function.
4. Add first-admin bootstrap flow.
5. Fix function packaging and runtime dependency strategy.
6. Provision NoSQL collections/indexes/rules.
7. Deploy functions and HTTP routes.
8. Deploy static site/Web App.
9. Run and document smoke tests.

P1 issues:

10. Add GitHub Actions client-demo deploy.
11. Migrate binaries to CloudBase Storage.
12. Add rate limiting and upload validation.
13. Enable logs/CLS and structured function logs.
14. Bind custom domain and route `/api/*`.

P2 issues:

15. Add staging/prod environment split.
16. Harden session cookies.
17. Improve pagination and catalog scale.
18. Add external uptime monitoring.
