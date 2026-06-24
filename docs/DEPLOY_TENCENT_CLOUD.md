# Tencent Cloud Deployment Design

Status: design for cross validation  
Scope: Channel portal production deployment on Tencent Cloud / CloudBase  
Last updated: 2026-06-24

## 1. Current Repository State

The repository is already shaped for a CloudBase-first backend, but the
production deployment system is not complete yet.

Current code that already points at Tencent Cloud:

- `apps/site`: Astro static site with React islands for admin, auth, and shop UI.
- `apps/functions/admin`: shared admin API handler intended for CloudBase cloud functions.
- `apps/local-server`: local Express adapter that mirrors the production handler with a JSON file DB.
- `packages/db`: adapter facade with local JSON and CloudBase-oriented persistence boundaries.
- `packages/shared`: collection registry, validation schema, API envelope, auth role rules, query model.
- `.env.example`: includes `TCB_ENV`, `JWT_SECRET`, email settings, and local API proxy settings.

Missing or incomplete deployment pieces:

- No CloudBase deployment config is committed yet.
- No static hosting deployment config for `apps/site/dist`.
- No production route mapping for `/api/*`.
- No separate public API cloud function for storefront routes.
- No CloudBase Storage migration from DB base64 files.
- No database index/security rule definition.
- No CI/CD workflow.
- No production smoke-test, rollback, or runbook.

## 2. Target Architecture

Primary recommendation: use CloudBase as the main Tencent Cloud platform.

```text
Browser
  -> CloudBase Static Hosting
      -> Astro static pages and assets
  -> /api/*
      -> CloudBase HTTP cloud functions
          -> CloudBase Database
          -> CloudBase Storage
          -> SMTP / email provider
          -> CloudBase logs and monitoring
```

Target environments:

| Environment | Suggested CloudBase env | Purpose |
| --- | --- | --- |
| Development | `channel-dev` | Developer integration and sandbox data |
| Staging | `channel-staging` | Release validation before production |
| Production | `channel-prod` | Public customer and staff traffic |

Production domain model:

| Domain | Target |
| --- | --- |
| `www.example.com` | CloudBase Static Hosting |
| `www.example.com/api/*` | CloudBase HTTP function routes |
| `admin.example.com` | Optional alias to `/admin` |

Prefer same-domain `/api/*` over a separate API domain at first. It avoids CORS
complexity and keeps browser security behavior simpler.

## 3. Module Design

### 3.1 Frontend Hosting

Current app:

- Source: `apps/site`
- Build command: `pnpm build`
- Build output: `apps/site/dist`

Deploy target:

- CloudBase Static Hosting.
- Static hosting is backed by COS + CDN capability in CloudBase hosting.
- Bind a custom domain with HTTPS enabled.

Required production settings:

```env
PUBLIC_CB_PROXY=0
PUBLIC_CB_HOST=
```

Frontend should call relative API paths such as:

```text
/api/admin
/api/products
/api/overstock
/api/images/:id
/api/files/:id
/api/health
```

Deployment requirements:

- Upload only `apps/site/dist`.
- Set route fallback for static pages if needed.
- Verify `/`, `/admin`, `/login`, `/oem`, `/overstock`, and `/headphones`.
- Do not expose source maps in production unless access is restricted.

### 3.2 Admin API Function

Current app:

- Source: `apps/functions/admin`
- Build command: `pnpm build:functions`
- Existing bundle output: `apps/functions/admin/dist`

Deploy target:

- CloudBase HTTP cloud function named `admin`.
- Route: `POST /api/admin`.

Responsibilities:

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

Required environment variables:

```env
TCB_ENV=channel-prod-xxx
JWT_SECRET=<long random secret>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD_HASH=<argon2id hash>
LOGIN_URL=https://www.example.com/login
EMAIL_HOST=smtp.exmail.qq.com
EMAIL_PORT=465
EMAIL_SECURE=true
EMAIL_USER=<smtp user>
EMAIL_PASSWORD=<smtp password>
EMAIL_FROM="Channel Portal" <admin@example.com>
```

Design decisions:

- Keep `{ action, data, token }` protocol for now to minimize frontend churn.
- Keep the shared handler so local and production behavior stay aligned.
- Keep JWT role claims, but make revocation policy explicit: role changes take effect after token expiry or re-login.
- Do not let browsers write directly to the database.

### 3.3 Public API Function

Current local-only routes live in `apps/local-server/src/main.ts`.

Production should add a separate CloudBase HTTP function:

- Function name: `public-api`
- Routes:
  - `GET /api/health`
  - `GET /api/products`
  - `GET /api/products/:id`
  - `GET /api/overstock`
  - `GET /api/overstock/:id`
  - `GET /api/images/:id`
  - `GET /api/files/:id`, restricted where needed

Reason for a separate function:

- Public storefront traffic and authenticated admin writes have different risk profiles.
- Public API can be rate-limited, cached, and observed separately.
- The admin function can stay stricter and simpler.

Public API behavior:

- Only return `published: true` catalog records.
- Apply category/search/page/pageSize server-side.
- Cap `pageSize`, for example max 48.
- Never return raw storage credentials.
- File downloads for OEM drawings must require admin/contributor authorization.

### 3.4 Database

Recommended CloudBase database mode:

- Use CloudBase document database for the current registry-driven model.
- Revisit MySQL only if the data model becomes relational enough to need joins,
  transactions across many tables, or reporting-heavy workloads.

Collections:

| Collection | Purpose | Access |
| --- | --- | --- |
| `users` | Portal accounts, roles, auth metadata | Admin only for list/write |
| `products` | Headphone catalog | Public read for published, admin/contributor write |
| `overstock` | Clearance inventory | Public read for published, admin/contributor write |
| `oemProjects` | Public OEM submissions | Public create, admin/contributor read/write |
| `images` | Image metadata | Public read for published-linked images, admin/contributor write |
| `files` | OEM file metadata | Admin/contributor only |

Suggested indexes:

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

Database rules:

- Default client direct access: deny write.
- Default client direct access to sensitive collections: deny read.
- All privileged operations go through cloud functions.
- Public catalog reads can be through cloud functions only at first.

### 3.5 Storage

Current local model stores image/file bytes as base64 in database collections.
This is acceptable for local development, but not ideal for production.

Production design:

- Use CloudBase Storage for binary objects.
- Store only metadata and `fileID` or storage path in database.

Storage paths:

```text
catalog/images/{imageId}/{safeFileName}
oem/projects/{projectId}/{safeFileName}
admin/uploads/{yyyy}/{mm}/{uuid}-{safeFileName}
```

Image metadata example:

```ts
{
  _id: string,
  name: string,
  fileID: string,
  storagePath: string,
  mimeType: string,
  size: number,
  width?: number,
  height?: number,
  createdAt: string,
  updatedAt: string
}
```

OEM file metadata example:

```ts
{
  _id: string,
  projectId: string,
  name: string,
  fileID: string,
  storagePath: string,
  mimeType: string,
  size: number,
  uploadedBy: "public-oem-form" | string,
  createdAt: string
}
```

Consistency rule:

- Upload object first.
- Create DB metadata second.
- If DB write fails, delete the uploaded object as compensation.
- If object deletion fails, log a cleanup task.

Security rule:

- Product images can be publicly readable when linked from published records.
- OEM drawings and admin uploads are private.
- Never trust client-provided MIME type alone; validate extension, size, and type server-side.

### 3.6 Authentication and Authorization

Current role model:

| Role | Meaning |
| --- | --- |
| `admin` | Full access, including users and roles |
| `contributor` | Content management, no user management |
| `member` | Storefront account with VIP pricing |
| `viewer` | Storefront account with wholesale pricing |
| `""` | Default base entitlement |

Production design:

- Continue with JWT for now.
- Store password hashes only, never plaintext passwords.
- Use `ADMIN_PASSWORD_HASH` in production bootstrap.
- Keep token TTL around 12 hours unless product wants shorter admin sessions.
- Consider moving token storage from localStorage to httpOnly secure cookies in a later hardening MIU.

Authorization source of truth:

- Backend cloud functions decide whether action is allowed.
- Frontend UI gating is convenience only, not security.

Abuse controls:

- Rate-limit login, register, recover, and OEM submit by IP and normalized email.
- Make recovery responses enumeration-safe.
- Log failed admin login attempts.

### 3.7 Email

Current package:

- `packages/email`
- Uses nodemailer.
- Falls back to console mock when SMTP is not configured.

Production design:

- Phase 1: Tencent Exmail or existing SMTP.
- Phase 2: optional Tencent Cloud email service or another managed provider.

Email events:

- Password recovery.
- OEM submission confirmation.
- Optional internal admin notification for new OEM requests.

Operational requirements:

- Email failures must not block OEM submission.
- Password recovery should log delivery failure without leaking whether the account exists.
- Alert on sustained email failure rate.

### 3.8 Domain, DNS, HTTPS, and CDN

Initial route plan:

```text
https://www.example.com/              -> static hosting
https://www.example.com/admin         -> static hosting
https://www.example.com/api/admin     -> admin HTTP function
https://www.example.com/api/products  -> public-api HTTP function
```

DNS:

- Bind custom domain in CloudBase hosting.
- Configure CNAME as returned by CloudBase.
- Use Tencent Cloud DNSPod if the domain is managed in Tencent Cloud.

HTTPS:

- Use CloudBase custom domain HTTPS where available.
- Enforce HTTPS redirects.

CDN/cache:

- Static assets under `/_astro/*`: long cache with hashed filenames.
- HTML pages: short cache or no-cache until release process is stable.
- Public catalog API: short cache only if product accepts stale published data.

### 3.9 Deployment Configuration

Recommended files to add in implementation:

```text
cloudbaserc.json
deploy/cloudbase/dev.json
deploy/cloudbase/staging.json
deploy/cloudbase/prod.json
scripts/deploy-hosting.sh
scripts/deploy-functions.sh
scripts/smoke-tencent.sh
docs/DEPLOY_TENCENT_CLOUD.md
```

Example logical `cloudbaserc.json` shape:

```json
{
  "envId": "${TCB_ENV}",
  "functionRoot": "apps/functions",
  "functions": [
    {
      "name": "admin",
      "dir": "apps/functions/admin",
      "runtime": "Nodejs18.15",
      "type": "HTTP"
    },
    {
      "name": "public-api",
      "dir": "apps/functions/public-api",
      "runtime": "Nodejs18.15",
      "type": "HTTP"
    }
  ],
  "hosting": {
    "source": "apps/site/dist"
  }
}
```

The exact schema must be validated against the selected CloudBase CLI version
before implementation.

Manual deployment command shape:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm build:functions
tcb fn deploy admin --httpFn -e "$TCB_ENV"
tcb hosting deploy apps/site/dist -e "$TCB_ENV"
```

### 3.10 CI/CD

Recommended GitHub Actions:

| Trigger | Action |
| --- | --- |
| Pull request | install, typecheck, lint, build, function build |
| Push to `dev/albertli/try01` or `dev` | deploy to `channel-dev` |
| Push to `main` | deploy to `channel-prod` after approval |

Required secrets:

```text
TENCENT_SECRET_ID
TENCENT_SECRET_KEY
TCB_ENV_DEV
TCB_ENV_STAGING
TCB_ENV_PROD
JWT_SECRET_DEV
JWT_SECRET_STAGING
JWT_SECRET_PROD
EMAIL_USER
EMAIL_PASSWORD
EMAIL_FROM
```

CI safety:

- Use Tencent CAM sub-user with minimum required CloudBase permissions.
- Do not expose prod secrets to pull requests from forks.
- Production deployment should require approval.
- Run smoke tests after every deployment.

### 3.11 Observability

Metrics and logs:

- Cloud function invocation count, latency, errors, timeouts.
- `/api/admin` action names and outcome codes.
- Login failure count.
- OEM submission success/failure.
- Storage upload failure and compensation failure.
- Email delivery failure.

Alerts:

- Cloud function 5xx spike.
- Login failure spike.
- OEM submission failure.
- Storage upload/delete failure.
- Email failure sustained over threshold.
- Database read/write errors.

Health checks:

```text
GET /api/health
POST /api/admin { action: "collections", token: synthetic monitor token }
GET /api/products?pageSize=1
```

Synthetic checks should avoid mutating production data.

### 3.12 Migration

Current local seed DB:

```text
apps/local-server/data/db.local.json
```

Migration plan:

1. Export local JSON and keep immutable backup.
2. Create CloudBase collections.
3. Import non-binary documents.
4. Upload `images.data` and `files.data` base64 bytes to CloudBase Storage.
5. Replace base64 fields with `fileID`, `storagePath`, `mimeType`, `size`.
6. Verify document counts.
7. Verify sample image render and OEM file download.
8. Lock migration script to be idempotent.

Required migration script:

```text
scripts/import-local-db-to-cloudbase.ts
```

Validation counters:

```text
users
products
overstock
oemProjects
images
files
```

### 3.13 Rollback

Frontend rollback:

- Keep previous hosting artifact.
- Re-deploy previous `apps/site/dist` artifact if needed.

Function rollback:

- Keep previous `dist` package by commit SHA.
- Re-deploy previous function package.

Database rollback:

- Avoid destructive migrations.
- Prefer additive schema changes.
- Back up collections before migration.
- For risky migrations, write rollback scripts before production run.

Storage rollback:

- Treat storage objects as append-only during migration.
- Do not overwrite existing object paths.
- Use content-addressed or UUID paths.

### 3.14 Security Boundaries

Boundary inventory:

| Boundary | Decision |
| --- | --- |
| Ownership | Single company portal for now; no tenant scope required yet |
| Actor | Public visitor, registered storefront user, contributor, admin |
| Durable data | Users, catalog records, OEM projects, image/file metadata |
| Ephemeral data | JWTs, local UI session, temporary upload buffers |
| Money/value | No payment flow currently; pricing visibility is entitlement-sensitive |
| Time/concurrency | Catalog edits and batch mutations can race; last-write-wins is acceptable initially but should be documented |
| External provider | CloudBase, CloudBase Storage, SMTP/email |
| User-visible truth | Admin UI must reflect backend authorization and persisted status |

Security rules:

- Public users can submit OEM requests but cannot list all OEM requests.
- Public users can read only published catalog items.
- Admin/contributor permissions must be checked in cloud functions.
- Users collection is admin-only.
- OEM file download is admin/contributor-only.
- Uploaded file size limits must exist on both frontend and backend.
- Avoid putting secrets in Astro public env variables.

### 3.15 Cost and Quota Controls

Initial controls:

- Cap upload size.
- Cap API `pageSize`.
- Add rate limits for public submission endpoints.
- Use image compression or upload size limits before storage write.
- Add storage lifecycle policy for abandoned temporary uploads if temporary paths are introduced.
- Monitor CDN/storage egress.

### 3.16 Implementation Workstreams

Suggested MIU split:

1. Deployment documentation and environment matrix.
2. CloudBase config scaffold and scripts.
3. `public-api` cloud function extracted from local-server public routes.
4. CloudBase Storage adapter for images and files.
5. Migration script from local JSON/base64 to CloudBase DB + Storage.
6. CI validation workflow.
7. CI deployment workflow for dev.
8. Production deployment workflow with approval gate.
9. Observability and smoke tests.
10. Security hardening: rate limits, private file downloads, upload validation.

Each MIU should include tests or smoke evidence before merging.

## 4. Cross Validation Checklist

Ask reviewers to validate:

- Is CloudBase Static Hosting the right target for Astro static output?
- Should public API be a separate function or share `admin`?
- Is document database sufficient, or should any collection move to MySQL?
- Are image and OEM file permissions strict enough?
- Is same-domain `/api/*` routing feasible with chosen CloudBase route config?
- Are all production environment variables named and scoped correctly?
- Are data migration and rollback steps safe enough?
- Are rate limits and upload caps sufficient for public OEM submission?
- Is the token revocation behavior acceptable for admin role changes?
- Are CI/CD secrets and CAM permissions least-privilege?

## 5. Official References

- CloudBase overview: https://docs.cloudbase.net/en/
- CloudBase backend and hosting capability overview: https://docs.cloudbase.net/en/solutions/vibe-coding-platform/app-backend
- CloudBase CLI quick start: https://docs.cloudbase.net/en/cli-v1/quick-start
- CloudBase function deployment: https://docs.cloudbase.net/en/cli-v1/functions/deploy
- CloudBase cloud functions overview: https://docs.cloudbase.net/en/cloud-function/introduce
- CloudBase static hosting CLI: https://docs.cloudbase.net/en/cli-v1/hosting
- Tencent Cloud CloudBase static website management: https://www.tencentcloud.com/document/product/1266/75758
- Tencent Cloud CloudBase database overview: https://www.tencentcloud.com/document/product/1266/71676
- Tencent Cloud CloudBase storage download and security note: https://www.tencentcloud.com/document/product/1266/71668
- CloudBase environment and domain management: https://docs.cloudbase.net/en/quick-start/integrate-cloudbase

