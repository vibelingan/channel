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
npx playwright test tests/e2e/public.spec.ts
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
npx playwright test tests/e2e/admin-auth.spec.ts
```

This requires an existing active admin user. It verifies API login, user listing,
and browser login.

Mutation mode:

```bash
E2E_ALLOW_MUTATION=1 \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=... \
npx playwright test tests/e2e/mutation.spec.ts
```

This writes real CloudBase records with an `e2e-` run id, verifies them through
the public site/API, and removes them in `finally` cleanup blocks.

One-shot bootstrap mode:

```bash
E2E_ENABLE_BOOTSTRAP=1 \
E2E_BOOTSTRAP_ADMIN_TOKEN=... \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD=... \
npx playwright test tests/e2e/bootstrap.spec.ts
```

Only run this before the first admin exists. This requires both the local
`E2E_ENABLE_BOOTSTRAP=1` harness flag and deployed `admin` function runtime
config `BOOTSTRAP_ENABLED=1`. After a successful bootstrap, immediately set
`BOOTSTRAP_ENABLED=0` again.

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
- `E2E_ENABLE_BOOTSTRAP=1` and deployed `BOOTSTRAP_ENABLED=1` are both required
  before first-admin bootstrap runs.
- Admin credentials are read from environment variables only.
- Public CORS smoke accepts either the exact `E2E_SITE_URL` origin or `*`,
  because an empty CloudBase allowlist intentionally falls back to `*`.
- Test output goes under `output/playwright/`, which is gitignored.
- Screenshots, traces, and videos are off by default to avoid recording
  credentials. Set `E2E_RECORD_ARTIFACTS=1` only for non-sensitive debugging.
- Real secret values must not be committed to `.env.e2e.example` or docs.

## 6. Current Known Boundary

P0.11 has now been run locally against the deployed `test` environment. First
admin bootstrap completed once and deployed bootstrap is disabled. The safe
public suite remains credential-free. Admin and mutation suites require the
local admin credential env vars. Bootstrap should stay skipped unless the test
environment is intentionally reset and `BOOTSTRAP_ENABLED=1` is restored
temporarily.

## 7. Review Audit (2026-06-25)

This plan and the `tests/e2e/` implementation were audited against the real
function handlers (`apps/functions/admin`, `apps/functions/public-api`) and the
rendered site DOM (`apps/site/src`). Spec discovery (`pnpm test:e2e --list`,
8 tests / 4 files) and `biome check` both pass. The API and DOM contracts the
specs assume were verified correct except where listed below.

### Findings

| # | Sev | Location | Issue | Fix |
| --- | --- | --- | --- | --- |
| E1 | P2 | `tests/e2e/public.spec.ts:69` | `getByRole('link', { name: /View details/i })` matches nothing — `ProductCard` renders a single `<a>` whose accessible name is the product name (`viewDetail` exists in i18n but is never rendered). `cards` is always `0`, so on a non-empty catalog the poll `emptyStates + cards > 0` times out and the test FAILS; on an empty DB it passes vacuously. This contradicts §4 ("accepts either an empty catalog state or visible product cards"). | Count real card links, e.g. `page.locator('a[href^="/headphone-item"]')`, or render `aria-label={content.viewDetail}` on the card `<a>` (uses the already-defined string, improves a11y) and keep the selector. |
| E2 | P2 | `tests/e2e/public.spec.ts:49`, `tests/e2e/mutation.spec.ts:127` | The file-privacy assertions hit `/api/files/<id>`, but public-api has no `/api/files/*` route — it 404s via the catch-all. The real public media gate is `/api/images/<id>` (serves only images linked to a published catalog item). The "files stay private" / "file downloads unexposed" property is asserted but never exercised. | Assert against the real route: `GET /api/images/<drawingFileId>` returns 404 (the OEM drawing is not linked to a published item). Keep the `/api/files/*` 404 only as a separate "no such route" check, not as the privacy gate. |
| E3 | P2 | `tests/e2e/public.spec.ts:28` | The "no-credential, no-config" public suite silently requires the deployed `CORS_ALLOWED_ORIGINS` to contain `E2E_SITE_URL` exactly. public-api echoes the Origin only if it is in the allowlist; an empty allowlist returns `*` and the assertion fails. | Document this precondition in §2/§5, or soften to `expect([e2e.siteUrl, '*']).toContain(header)`. |
| E4 | P3 | `tests/e2e/public.spec.ts:14` | `core pages render` asserts zero console errors across six pages including `/admin`, which is `client:only` and client-redirects to `/login` when unauthenticated. All-or-nothing `problems == []` across a redirecting page is brittle (any favicon/font/third-party/hydration message fails the whole pass). | Capture console per page, allowlist benign messages, or assert `/admin` separately after the redirect settles. |
| E5 | P3 | §2 "One-shot bootstrap mode" | The harness flag `E2E_ENABLE_BOOTSTRAP=1` only gates whether the spec runs; the deployed admin function independently requires `BOOTSTRAP_ENABLED=1` or `bootstrapAdmin` is rejected. The plan implies the harness flag is sufficient. | State both gates: `BOOTSTRAP_ENABLED=1` on the function (then back to `0` after), plus the harness flag. |
| E6 | P3 | `.env.e2e.example:4-5` (also §1, §2) | The live test EnvId/URLs (`diversity-123-…`) are hard-coded as example values; when the EnvId rotates this drifts silently. Not secrets, but couples the committed harness to one ephemeral deployment. | Use placeholders in `.env.e2e.example` (e.g. `https://<your-site>.tcloudbase.com`); the helper already fails over to `localhost`, so prefer failing fast when `E2E_SITE_URL` is unset over shipping a stale default. |
| E7 | P3 | `package.json` `typecheck` | e2e specs are not type-checked — `typecheck` filters only `packages/**`/`apps/**`; Playwright transpiles specs via esbuild (type-stripping). `--list` catches syntax/import errors, not type errors. | Optional: add `tsc --noEmit` over `tests/e2e`, or accept discovery-only validation and note it. |

### Verified correct

- Admin envelope `{ ok, data }` / `{ ok:false, error:{ code, message } }`; `login`/`list`/`create`/`remove`/`bootstrapAdmin` input+output shapes; `remove` -> `{ deleted:true }` with `NOT_FOUND` / "Document not found"; unauthenticated protected action -> 401; `search` supported on `list`.
- Public `/api/health` -> `{ status:'ok', service:'public-api' }`; `/api/products` & `/api/overstock` -> `{ items, total, page, pageSize }`; `search` substring filter; pagination default 24 / max 48; images private unless linked to a published item.
- DOM: `AuthForm` island + `Email`/`Password` labels + `Sign in`; `/admin` shows `Channel Admin` + `Headphones` button and client-redirects when unauthenticated; headphones heading, `animate-pulse`, empty-state regex, `Search products…` placeholder, `/api/products` fetch; OEM `form[data-project-form]` with all named fields, `Submit project`, redirect to `/oem_submit_result?id=`, stored `status:'new'` + `drawing` file id.

### Resolution

- E1 fixed by counting real `/headphone-item` card links rather than a
  non-rendered `View details` label.
- E2 fixed by adding mutation coverage for `/api/images/:id`: unlinked images
  are 404, images linked from a published product are 200, and OEM file IDs are
  not served as images.
- E3 fixed by accepting exact origin or `*` for public CORS smoke.
- E4 mitigated by isolating console/page-error capture per route.
- E5 fixed in this plan by documenting the deployed `BOOTSTRAP_ENABLED` gate.
- E6 fixed by turning `.env.e2e.example` URLs into placeholders.
- E7 fixed by adding `tsconfig.e2e.json` and `pnpm typecheck:e2e`.
