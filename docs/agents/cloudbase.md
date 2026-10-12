# Working with CloudBase and production (agent reference)

Facts an agent needs before touching deploys, production data or the CloudBase
SDKs in this repo. Each was re-derived at least once at a cost; read this
first. Deeper design: `docs/CLOUDBASE_DEPLOYMENT_DESIGN.md`,
`docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`.

## Environments

- There is one CloudBase environment, `diversity-123-d9grnqfux221323bb`. It
  serves the live site **supplychainsai.com** and is also the owner's only
  test environment.
- The `test` branch deploys it. Merge or fast-forward a feature branch into
  `test` directly (no PR into `test`); PRs are only for `main`.
  Fast-forward: `gh api -X PATCH repos/vibelingan/channel/git/refs/heads/test -f sha=<sha> -F force=false`.

## Is my change live?

- Every function reports what it runs:
  - public API: `GET /api/health`
  - Alibaba sync: `GET /api/alibaba-catalog-sync/health`
  - admin: `POST /api/admin` with `{"action":"health"}`
  Each returns `releaseId` (the commit) and `buildTime`. Watch that, not the
  workflow status: the code is live when the function says so.
- API base: `https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`.

## Deploy timing and failure modes

- A deploy takes about an hour (42–78 min, average 52 in October 2026): CI
  runs the full suite, then the deploy job runs it again, deploys functions
  (about 25 minutes in), then the site.
- Watch in the background and keep working; say the expected wait.
- Not every red run is your code:
  - the "Install Playwright" step has hung for 31 minutes and been cancelled;
  - the post-deploy browser step can hit the deploy job's 45-minute limit
    while still passing.
  Read step names and timings (`gh run view <id> --json jobs`) before
  touching code.
- `Deploy Test` and the manual `E2E` workflow share the concurrency group
  `cloudbase-deploy-test`. A new push replaces a PENDING run in that group,
  including a queued E2E run.
- The `test` environment only accepts runs from `test` (and two other refs):
  dispatch E2E with `--ref test`.

## Latency

- Every request from outside mainland China spends 0.6–3 s in the CloudBase
  gateway while functions run in tens of milliseconds
  (`x-cloudbase-upstream-timecost` shows the function's own time). Count
  round trips before blaming anything else; prefer one request that does the
  whole job server-side (see `apps/functions/admin/src/catalog-approve-once.ts`).

## Database

- Every registered collection must be provisioned by the deploy
  (`scripts/cloudbase-nosql-resources.mjs`); a parity test fails otherwise.
  A missing collection makes `list` throw a 500, and anything that scans
  collections (such as `abandonUpload`) fails with it.
- Transactions are short and capped at 100 operations; they cannot wait on
  network calls. Use "prepare off to the side, one guarded write".
- Two SDKs with different result shapes:
  - `@cloudbase/node-sdk` (transactions, increments): `remove()` resolves
    `{ deleted }`.
  - `wx-server-sdk` (plain CRUD in `cloudbase-adapter.ts`): `remove()`
    resolves `{ stats: { removed } }`.
  The hand-written types in `cloudbase-adapter.ts` must match the installed
  SDK; `pnpm verify:cloudbase-sdk` pins the shapes we rely on.
- Approval writes do not change `updatedAt`; a revision guard alone does not
  detect an approval in between. Add a state guard (`requireUnapprovedDraft`).

## Production data and admin actions

- Admin API calls go through the owner's signed-in admin page: in-page
  `fetch` to `/api/admin` with `token: localStorage.getItem('channel.token')`.
  Never read, print or type the token or a password. When the session
  expires, ask the owner to sign in.
- Read-only checks before and after every production write; get the owner's
  go-ahead for writes outside the agreed runbook, and for anything that
  publishes products.
- Consistency audit (read-only):
  `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api <base>`.

## Local quirks

- Node 25: `NODE_OPTIONS=--no-experimental-webstorage` for tests.
- Browser lanes: `TMPDIR=/Volumes/Lexar-Mac/Projects/.channel-e2e-tmp`
  (same disk as the repo); `pnpm test:e2e:catalog-admin-local`, with
  `E2E_CATALOG_FORMAL=1` for the approval-on lane.
