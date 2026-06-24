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
- Deployment notes record git branch, GitHub Environment, CloudBase EnvId, URLs,
  commit SHA, env mapping, smoke status, and known gaps.

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

### P0.1 Two-Env Branch, Secret, And Variable Setup

Owner: deployment agent
Goal: set up the two-environment model and secret separation before deploy
automation uses sensitive values.

Environment plan:

1. Use `diversity-123-d9grnqfux221323bb` as the `dev` CloudBase env unless the
   team decides to recreate a cleaner dev/test env.
2. Create a separate `prod` CloudBase env before enabling `main` deploys.
3. Do not create a separate staging env for this small project.
4. Do not provision PostgreSQL or MySQL. CloudBase NoSQL is the selected
   database for P0/P1.
5. Do not enable CloudRun minimum instances, CLS, or other potentially
   chargeable services unless a priority item explicitly requires them.

Branch model:

```text
dev  -> GitHub Environment dev  -> CloudBase dev/test env
main -> GitHub Environment prod -> CloudBase prod env
PRs  -> checks only, no CloudBase deploy secrets
```

Prepare the deployment branches:

```bash
git fetch origin
git switch dev 2>/dev/null ||
  git switch --track origin/dev 2>/dev/null ||
  git switch -c dev
git push -u origin dev
```

If `origin/dev` does not exist yet, create it from the reviewed workstream that
should become the test deployment baseline. Keep `main` for production-ready
builds only.

Create the required GitHub Environments:

```bash
gh api repos/:owner/:repo/environments/dev -X PUT
gh api repos/:owner/:repo/environments/prod -X PUT
```

Do not create a `staging` GitHub Environment.

Set non-secret environment variables:

```bash
gh variable set TCB_ENV_ID --env dev --body "diversity-123-d9grnqfux221323bb"
gh variable set APP_ENV --env dev --body "dev"
gh variable set CLOUDBASE_REGION --env dev --body "ap-shanghai"
gh variable set PUBLIC_CB_PROXY --env dev --body "0"

gh variable set TCB_ENV_ID --env prod --body "<prod-env-id>"
gh variable set APP_ENV --env prod --body "prod"
gh variable set CLOUDBASE_REGION --env prod --body "ap-shanghai"
gh variable set PUBLIC_CB_PROXY --env prod --body "0"
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
gh secret set TENCENT_SECRET_ID --env dev
gh secret set TENCENT_SECRET_KEY --env dev
gh secret set JWT_SECRET --env dev
gh secret set ADMIN_PASSWORD_HASH --env dev
gh secret set BOOTSTRAP_ADMIN_TOKEN --env dev

gh secret set TENCENT_SECRET_ID --env prod
gh secret set TENCENT_SECRET_KEY --env prod
gh secret set JWT_SECRET --env prod
gh secret set ADMIN_PASSWORD_HASH --env prod
gh secret set BOOTSTRAP_ADMIN_TOKEN --env prod
```

Store non-secret runtime values:

```bash
gh variable set ADMIN_EMAIL --env dev --body "admin@example.com"
gh variable set LOGIN_URL --env dev --body "https://<dev-site-url>/login"
gh variable set CORS_ALLOWED_ORIGINS --env dev --body "https://<dev-site-url>,http://localhost:4321"

gh variable set ADMIN_EMAIL --env prod --body "admin@example.com"
gh variable set LOGIN_URL --env prod --body "https://<prod-site-url>/login"
gh variable set CORS_ALLOWED_ORIGINS --env prod --body "https://<prod-site-url>"
```

Optional SMTP:

```bash
gh variable set EMAIL_HOST --env dev --body "smtp.exmail.qq.com"
gh variable set EMAIL_PORT --env dev --body "465"
gh variable set EMAIL_SECURE --env dev --body "true"
gh variable set EMAIL_FROM --env dev --body '"Channel Portal" <admin@example.com>'
gh secret set EMAIL_USER --env dev
gh secret set EMAIL_PASSWORD --env dev

gh variable set EMAIL_HOST --env prod --body "smtp.exmail.qq.com"
gh variable set EMAIL_PORT --env prod --body "465"
gh variable set EMAIL_SECURE --env prod --body "true"
gh variable set EMAIL_FROM --env prod --body '"Channel Portal" <admin@example.com>'
gh secret set EMAIL_USER --env prod
gh secret set EMAIL_PASSWORD --env prod
```

Acceptance:

- `dev` exists for test deploys and `main` remains the production branch.
- GitHub Environments `dev` and `prod` exist.
- No `.env` file contains dev or prod runtime secrets.
- Static build job will receive only `PUBLIC_*` variables.
- CloudBase function env receives runtime secrets after deploy or as part of
  function config update.
- The `prod` GitHub Environment points only at the production CloudBase EnvId.

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
users.role
products.published
products.category
products.name
products.updatedAt
overstock.published
overstock.category
overstock.productCode
overstock.updatedAt
oemProjects.status
oemProjects.email
oemProjects.createdAt
images.name
files.name
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
APP_ENV=dev
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
- Service name suggestion: `channel-portal-dev`.
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

- Deployment config scaffold:
  - `cloudbaserc.json`
  - `deploy/cloudbase/dev.json`
  - `deploy/cloudbase/prod.json`
  - `scripts/deploy-functions.sh`
  - `scripts/deploy-webapp.sh`
  - `scripts/smoke-cloudbase.sh`
- PR workflow without secrets.
- `dev` branch deploy workflow using GitHub Environment `dev`.
- `main` branch production deploy workflow using GitHub Environment `prod`.
- Secret-to-CloudBase runtime env update step.
- Function artifact validation.
- Static secret scan.
- Post-deploy smoke tests.

Acceptance:

- A `dev` push can reproduce P0 from a clean runner in the dev env.
- A `main` production deploy uses only the `prod` GitHub Environment and the
  recorded production CloudBase EnvId.
- Fork PRs cannot access deployment secrets.

### P1.2 Storage Migration

Implement:

- Upload image bytes to CloudBase Storage.
- Upload OEM files to CloudBase Storage.
- Replace `data` fields with metadata and storage paths.
- Keep immutable backup of `apps/local-server/data/db.local.json`.
- Write or update `scripts/import-local-db-to-cloudbase.ts`.
- Import non-binary documents before binary storage backfill.
- Delete uploaded objects as compensation if the metadata write fails.
- Keep rollback backup and avoid destructive mutations.
- Add cleanup for orphaned objects.

Acceptance:

- No large base64 binaries remain in NoSQL for real data.
- Private OEM files are served only by authenticated function logic.
- Document counts match expected counters for `users`, `products`, `overstock`,
  `oemProjects`, `images`, and `files`.
- A sample catalog image renders from CloudBase Storage.
- A sample OEM file download works only through authenticated function logic.

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
- Track invocation count, latency, errors, timeouts, login failures, OEM
  submission failures, storage compensation failures, email failures, and DB
  read/write errors.
- Configure alerts for 5xx spikes, login failure spikes, OEM submission
  failures, storage upload/delete failures, sustained email failures, and DB
  errors.

Acceptance:

- Deployment smoke can find function logs.
- Basic error spikes can be inspected.
- `GET /api/health` is usable as a non-mutating synthetic check.

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

- Immutable artifact promotion from `dev` to `main`/`prod`.
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

- A dev deploy target differs from `diversity-123-d9grnqfux221323bb` before the
  team records a replacement dev EnvId.
- A production deploy target is not the production EnvId recorded in deployment
  notes.
- Any command would enable optional paid capacity such as CloudRun minimum
  instances before the workstream explicitly requires it.
- A workflow would deploy `dev` to the prod env or `main` to the dev env.
- A command would print or export secret values.
- Same-domain custom routing cannot be validated and the code still lacks
  `PUBLIC_API_BASE_URL`.
- Function deployment requires a runtime lower than the code can support.
- Bootstrap would overwrite an existing admin.
- Any public endpoint returns OEM file bytes without auth.

## 8. Suggested Issue Split

P0 issues:

1. Confirm two-env model and establish `dev`/`main` branch mapping.
2. Add API base URL helper and CORS-aware clients.
3. Add CloudBase HTTP adapter for `admin`.
4. Add `public-api` HTTP function.
5. Add first-admin bootstrap flow.
6. Fix function packaging and runtime dependency strategy.
7. Provision NoSQL collections/indexes/rules.
8. Deploy functions and HTTP routes.
9. Deploy static site/Web App.
10. Run and document smoke tests.

P1 issues:

11. Add GitHub Actions `dev` -> `dev` deploy.
12. Add `main` -> `prod` deploy gate.
13. Migrate binaries to CloudBase Storage.
14. Add rate limiting and upload validation.
15. Enable logs/CLS and structured function logs.
16. Bind custom domain and route `/api/*`.

P2 issues:

17. Harden session cookies.
18. Improve pagination and catalog scale.
19. Add external uptime monitoring.

---

## 9. Reviewer Insights — Round 2 (post-consolidation)

> Advisory, append-only. Independent review of the consolidated DESIGN + this
> EXECUTION plan against the code on `dev/albertli/try01` (2026-06-24). The plan
> already absorbs the round-1 findings (HTTP adapter, token-gated idempotent
> bootstrap, private OEM file endpoint, `PUBLIC_API_BASE_URL`, function bundling).
> The items below are code-verified refinements to fold into the named P0 steps.
> Severity: 🔴 can hard-block a cold start · 🟠 fix before client demo · 🟡 track.

### R2-1 🔴 argon2 is a NATIVE module — choose the runtime-safe path before P0.8 (folds into P0.6)

Confirmed: `packages/auth/package.json` depends on `argon2@^0.41.1` and
`packages/auth/src/password.ts` calls `argon2.hash` / `argon2.verify`. argon2
compiles a native binding, so a binary built on macOS will **not** load on the
CloudBase Linux runtime — the function crashes at cold start. Resolve, in order:

1. **Preferred:** switch to a WASM argon2id (e.g. `hash-wasm`). No native binary,
   runs on any runtime, and it emits standard `$argon2id$...` PHC strings, so
   existing hashes and the generated `ADMIN_PASSWORD_HASH` stay verifiable.
2. **Else:** install argon2 built for the Linux target at deploy time (remote
   `npm install` on CloudBase, or `npm_config_target_platform=linux`); never ship
   the macOS-built binary.

Constraint: `ADMIN_PASSWORD_HASH` (generated in P0.1) must be produced by a lib
the deployed runtime can verify. If the hashing lib changes, regenerate the hash
with the **same** lib. Also: the P0.6 smoke `node -e "require('dist/index.js')"`
loads argon2 — it can pass on macOS yet fail on CloudBase. Validate the package on
a Linux/CloudBase-equivalent, not only locally.

### R2-2 🟠 `@vibelingan-channel/email` is not bundled (folds into P0.6)

`apps/functions/admin/tsup.config.ts` `noExternal` lists only `shared`, `auth`,
`db` — **not** `email`. The handler imports `@vibelingan-channel/email`, so `dist`
keeps an unresolved `workspace:*` require (exactly the DESIGN §7.1 risk). Add
`@vibelingan-channel/email` to `noExternal`, and confirm its transitive
`nodemailer` plus `zod` and `jose` are bundled or declared in the artifact
`package.json`.

### R2-3 🟠 Cross-origin image URLs break when API origin ≠ site origin (folds into P0.2 / P0.4)

The catalog API embeds image URLs as **relative** `/api/images/:id` (see
`apps/local-server/src/main.ts` `resolveImages`). With `PUBLIC_API_BASE_URL`
pointing at a separate API origin, `<img src="/api/images/x">` resolves against
the **site** origin (which serves no `/api`) and 404s. The base-URL helper in P0.2
must rewrite the image/file URLs returned **inside** API JSON, not only the
outbound `fetch()` calls — or `public-api` must emit absolute image URLs. Add a
smoke that a catalog image actually renders from the API origin.

### R2-4 🟠 Bootstrap token: pre-auth placement + timing-safe compare (folds into P0.5)

The bootstrap token travels in `data.token` (P0.11), not the session `token`
field. The `bootstrapAdmin` action must live in the **public, pre-`authenticate`**
switch in `handler.ts`, and compare `BOOTSTRAP_ADMIN_TOKEN` with a constant-time
check (`crypto.timingSafeEqual`), never `===`. Keep the "fail if any admin exists"
guard in the same single path.

### R2-5 🟡 Minor

- DESIGN §5.4 index list omits `products.name` while EXECUTION P0.7 includes it —
  reconcile.
- `PUBLIC_CB_PROXY` is only read by `astro.config.ts` for the **dev** server proxy;
  it is a no-op in a static production build (harmless, but don't rely on it in prod).
- `tsup` target is already `node18`, which matches the CloudBase runtime; only the
  repo `engines: >=20` is out of step (DESIGN §9.2) — align the `engines` field.

### Verdict

Design + execution are implementation-ready. **R2-1 (argon2)** is the single item
that can hard-block a cold start — resolve it before the P0.8 deploy. Everything
else is a fold-in refinement to an already-correct plan.
