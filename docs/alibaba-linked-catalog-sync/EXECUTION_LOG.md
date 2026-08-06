# Execution Log — feature/alibaba-linked-catalog-sync

Chronological record of MIU execution. Newest entries at the bottom.

## MIU 0 — Baseline and live contract evidence

**Started:** 2026-08-06 (UTC)

### Baseline

- Branch: `feature/alibaba-linked-catalog-sync`
- Created from: `origin/main @ 2f79a6188730043c24fc357faa1ac548d5c0c850`
  (`docs(sdk): record the probe rows the upgrade should have written`)
- Documentation baseline referenced by this doc set: `main @ 5c14193b93cf023ed791086902bc4423fd077198` — verified an ancestor of the
  actual starting commit, 6 commits behind. The 6 intervening commits are
  CloudBase SDK upload fixes (PUT contract) and docs/learnings only; none touch
  pricing, the product registry, or the public API surface.
- Worktree: `channel-alibaba-linked-catalog-sync` (sibling of the main checkout)
- `pnpm install --frozen-lockfile`: clean (pnpm 11.5.0)

### Secrets handling

- `ALI_APP_KEY` / `ALI_APP_SECRET` stored in gitignored `.env` only.
  `.env.example` receives placeholder entries (no real values) in this branch.
- Raw values that had been pasted into the main checkout's uncommitted
  `.env.example` were moved into `.env` and the example file restored, so the
  secret cannot reach git history from any session.

### Upstream platform contract evidence

- Prior verified research: `docs/accio-alibaba-integration/REPORT.md`
  (2026-07-28, parked on `main`) confirms:
  - Platform: Alibaba.com International Station Open Platform
    (`open.alibaba.com`), NOT 1688/Taobao/AliExpress.
  - Product APIs: `alibaba.icbu.product.list` (30/page, 5,000-item query cap,
    `gmt_modified_from/to` windows), `alibaba.icbu.product.get`,
    `alibaba.icbu.product.schema.render` — matching ARCHITECTURE.md §11's
    windowed bisection enumeration contract.
  - OAuth 2.0 authorization-code flow; server-side token create/refresh;
    signed API calls (app key + timestamp + HMAC signature).
  - Products/orders are classified user-privacy data → OAuth mandatory.
- App registration: self-developed app, App Key `511630` (secret in `.env`).
- Remaining external gates (permission approval state, live response fixtures,
  signature golden vector against the live gateway) are recorded per-MIU below
  as they are exercised.

### Baseline verification runs

`pnpm test` on the untouched worktree at `2f79a61`: **420 tests, 0 failures**.

| Package | Tests |
|---|---|
| packages/media-storage | 26 |
| packages/shared | 75 |
| packages/db | 23 |
| packages/auth | 2 |
| apps/site | 105 |
| apps/functions/public-api | 42 |
| apps/functions/admin | 147 |

`pnpm typecheck` baseline: **green** (all packages `tsc --noEmit` clean; `astro
check` 0 errors / 0 warnings across 98 files; e2e tsconfig clean).

Local invocation note: the root `typecheck` script shells out to `npx pnpm`,
which under this machine's corepack resolves a pnpm newer than the repo's
`packageManager` pin and aborts. Equivalent local form that honors the pin:

```bash
corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck && corepack pnpm typecheck:e2e
```
