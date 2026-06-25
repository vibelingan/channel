# Browser E2E Test Plan

Status: implemented test harness, destructive suites gated by environment flags
Scope: CloudBase-hosted Channel portal browser and HTTP verification
Last updated: 2026-06-25

## 1. Current Deployment Target

The first test deployment is agent-operated, not CI/CD-operated yet.

- Site:
  `https://channel-test-diversity-123-d9grnqfux221323bb.webapps.tcloudbase.com`
- API:
  `https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`
- CloudBase EnvId: `diversity-123-d9grnqfux221323bb`
- Web App service: `channel-test`
- Web App version: `channel-test-001`
- Web App buildId: `2601180875`

The deployed site currently uses the CloudBase default/free Web App domain and
the default CloudBase HTTP access domain. A custom domain is still a later
deployment item.

## 2. Test Modes

Default safe mode:

```bash
E2E_SITE_URL=https://channel-test-diversity-123-d9grnqfux221323bb.webapps.tcloudbase.com \
E2E_API_URL=https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com \
pnpm test:e2e:public
```

This mode does not need credentials and does not write data.

Full suite listing:

```bash
pnpm test:e2e --list
```

This is safe and validates that the specs can be discovered. It does not open a
browser or mutate CloudBase data.

Admin smoke mode:

```bash
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=... \
pnpm test:e2e -- tests/e2e/admin-auth.spec.ts
```

This requires an existing active admin user. It verifies API login, user listing,
and browser login.

Mutation mode:

```bash
E2E_ALLOW_MUTATION=1 \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=... \
pnpm test:e2e -- tests/e2e/mutation.spec.ts
```

This writes real CloudBase records with an `e2e-` run id, verifies them through
the public site/API, and removes them in `finally` cleanup blocks.

One-shot bootstrap mode:

```bash
E2E_ENABLE_BOOTSTRAP=1 \
E2E_BOOTSTRAP_ADMIN_TOKEN=... \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=... \
pnpm test:e2e -- tests/e2e/bootstrap.spec.ts
```

Only run this before the first admin exists. After a successful bootstrap,
immediately disable bootstrap in the deployed `admin` function config.

## 3. Coverage Matrix

| Suite | Writes data | Needs admin | Purpose |
| --- | --- | --- | --- |
| `public.spec.ts` | No | No | Core pages render, public API/CORS works, public files stay hidden |
| `admin-auth.spec.ts` | No | Yes | Admin API login and browser dashboard login work |
| `bootstrap.spec.ts` | Yes | Bootstrap token | First-admin creation works exactly once |
| `mutation.spec.ts` | Yes | Yes | Product publishing, public catalog visibility, OEM submission, file privacy, cleanup |

## 4. Data Strategy

The public suite is designed for an empty real database. It accepts either an
empty catalog state or visible product cards after the `/api/products` request
has completed.

Mutation suites never depend on dummy seed records. They create records with a
unique `E2E_RUN_ID` prefix, verify the user-visible behavior, and delete the
records they created. If cleanup fails, the record names include the run id so
they can be found and removed from the CloudBase admin dashboard.

## 5. Safety Gates

- `E2E_ALLOW_MUTATION=1` is required before catalog/OEM write tests run.
- `E2E_ENABLE_BOOTSTRAP=1` is required before first-admin bootstrap runs.
- Admin credentials are read from environment variables only.
- Test output goes under `output/playwright/`, which is gitignored.
- Real secret values must not be committed to `.env.e2e.example` or docs.

## 6. Current Known Boundary

As of this plan, P0.11 has not been run in this thread. That means the safe
public suite is runnable without credentials, while admin/bootstrap/mutation
suites should remain skipped until the first admin credential is intentionally
created and bootstrap is then disabled.
