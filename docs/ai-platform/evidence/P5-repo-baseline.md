# P5 — Repo baseline (MIU 0)

**Recorded:** 2026-08-15T16:56:38Z
**Branch:** feat/ai-miu0-evidence
**Commit:** 7978369d63d6e208a34a467567222d9c5fbf86d8
**Base:** origin/main @ 7978369

## Gates at the starting point

| Gate | Command | Result |
|---|---|---|
| typecheck | `corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck` | clean |
| lint | `npx biome check .` | 10 errors |
| unit tests | `corepack pnpm -r test` | see per-package counts below |

### Per-package test counts

```
packages/media-storage:  26;packages/shared:  84;packages/alibaba-catalog-sync:  114;packages/db:  38;packages/auth:  2;apps/site:  125;apps/functions/alibaba-catalog-sync:  74;apps/functions/public-api:  46;apps/functions/admin:  153;
```

## E2E starting state

`playwright.config.ts` has **no `webServer` block** — E2E requires a site and API
already running (`E2E_SITE_URL`, `E2E_API_URL`; defaults 4321/same-origin).

Observed on 2026-08-15 from this worktree: **36 passed, 2 failed, 8 skipped**.
The 2 failures are `public.spec.ts` cases asserting zero console errors while
`/api/images/*` returns 404 — the local API 404s those ids directly, i.e. seeded
data referencing assets absent from local storage. Pre-existing and environmental,
not caused by any AI-assistant change.

`scripts/pipeline-e2e.sh` (untracked) targets ports 3000/3001/4000 and does not
match this repo's 4321/3002 — it would fail if wired into the validation gate as-is.

## Patterns to reuse rather than reinvent

- `apps/functions/alibaba-catalog-sync/src/rate-limit.ts` — reserve-first
  `rateLimitHits` ledger; MIU 6f should follow it.
- `packages/db/src/alibaba-lease.test.ts` — existing lease/fencing test shape.
- `packages/db/src/adapter.ts` — how `DbAdapter` keeps CloudBase behind a port,
  the same shape `ConversationEngine` uses for the vendor.

## Confirmed repo facts relevant to the design

| Claim | Verified |
|---|---|
| No PostgreSQL client, Dockerfile, or CI database service exists | yes — only occurrence of "pg" is the `'pg-storage'` media enum value |
| Gateway maps `/api` → public-api and `/api/admin` → admin as wildcards | yes — `scripts/cloudbase-function-manifest.mjs`; collides with the proposed `/api/ai/*` |
| Session JWT is in origin-scoped `localStorage` as `channel.token` | yes — `apps/site/src/lib/session.ts`, read by `islands/shop/api.ts` on public `/headphones` |
| No NoSQL `leads` collection exists | yes — the analogue is `oemProjects` |
| Roles are an ascending ladder with no `sales` concept | yes — `packages/shared/src/auth.ts` |
| Only page-level CSP in the repo is on a media response | yes — `apps/functions/public-api/src/handler.ts`; `BaseLayout.astro` ships 2 inline scripts |
