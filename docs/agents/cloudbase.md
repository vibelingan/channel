# Working with CloudBase and production (agent reference)

Facts an agent needs before touching deploys, production data or the CloudBase
SDKs in this repo. Each was re-derived at least once at a cost; read this
first. Deeper design: `docs/CLOUDBASE_DEPLOYMENT_DESIGN.md`,
`docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`. Measured call costs and
upload/cleanup timings for making a deploy faster: the project skill
`.claude/skills/cloudbase-engineering/`.

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
  Each returns `releaseId` (the commit whose build is running) and
  `buildTime`. Watch that, not the workflow status: the code is live when the
  function says so.
- The normal deploy skips a function's code upload when the running package
  equals the new build apart from its stamp (`releaseId`/`buildTime`). That
  function keeps reporting the earlier `releaseId`; its `deployedReleaseId`
  names the deploy that confirmed it. `deployedReleaseId` disappears if any
  other path replaces the code. The deploy log says "code upload skipped",
  and `output/function-release/releases.json` lists what each function must
  report. Set `CLOUDBASE_FORCE_FUNCTION_CODE=1` to upload every function.
- Before fast-forwarding `test`, check that every live `releaseId` is an
  ancestor of the commit you are about to deploy
  (`git merge-base --is-ancestor <releaseId> <commit>`). `test` is not the
  only writer: on 2026-11-01 the SEO static canary deployed `public-api`
  from `feat/seo-foundation`, which `test` did not contain, so a plain
  `test` deploy would have rolled that work back.
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
  - a browser unit test can time out because a crashed WebKit helper stalled
    the runner's disk; see `docs/agents/ci-test-flakes.md` for that and for
    any other test that fails only sometimes.
  Read step names and timings (`gh run view <id> --json jobs`) before
  touching code.
- `Deploy Test` and the manual `E2E` workflow share the concurrency group
  `cloudbase-deploy-test`. A new push replaces a PENDING run in that group,
  including a queued E2E run.
- The `test` environment only accepts runs from `test` (and two other refs):
  dispatch E2E with `--ref test`.

## Site recovery copies

- Every site delivery keeps a private copy of the release payload under
  `seo-recovery/objects/<sha256>.bin` in the environment's storage, registered
  in `catalogSeoArchives`, so a rollback works after the 90-day GitHub
  artifact expires. Schema 1 records (doc id = artifact id) hold one ZIP.
  Schema 2 records (doc id `site-v2-<artifact id>`, from Nov 2026) list a head,
  large files alone and 32 packs; see
  `docs/delivery/2026-11-12/RECOVERY-ARCHIVE-V2.md`.
- Schema 2 objects are shared by every record with the same members. Never
  delete anything under `seo-recovery/` and never add an expiry rule (the code
  refuses one). A cleanup must first count references across all records of
  both schemas.
- Each deploy reads the accepted record in full: it prefers the private copy
  over the GitHub artifact. A broken copy therefore fails the next deploy while
  the accepted site is loaded (`Retained release ZIP differs`,
  `ARCHIVE_OBJECT_NOT_FOUND` in the `private-archive-transfer` lines), not a
  later rollback. Fix (owner's call, it deletes a record): remove that one
  `site-v2-<id>` document. The next delivery then falls back to the GitHub
  artifact (while it is under 90 days old) and writes the record again,
  re-uploading the missing objects.
- The `site-retention` log line of each delivery says how many objects were
  reused or uploaded, and how many bytes were uploaded.

- *Deploy AI CloudRun* (tag `ai-cloudrun-deploy-*`) can fail at
  `cloudbase.manageCloudRun deploy` with nothing wrong in the commit. On
  2026-11-11 one deploy passed in the morning, then four in a row failed
  there: twice "timed out after 240000ms", then "400 Bad Request HTTP ERROR"
  after 8 and 5 minutes with no Tencent request id. The same commit deployed
  cleanly the next morning (upload about 2 minutes). Deploy Test, running in
  between, saw slow function creation and refused `DeleteFunction` calls in
  the same hours. Before changing code: push a tag
  `ai-cloudrun-deploy-inspect-<date>-<n>`, which only reads both services
  (status, version, last deploy task); if both are `normal` with nothing
  queued, wait and rerun the failed job. A failed attempt replaces neither
  service. The upload is about 16 MB and normally takes 35 seconds.

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
- Colliding transactions: `@cloudbase/database` retries a
  `DATABASE_TRANSACTION_CONFLICT` 3 times with no pause, then throws it. The
  admin function answers `BUSY` (409, nothing saved) and the admin page
  resends it. Do not write a shared record (a photo used by hundreds of
  products) in a transaction unless its value changes (DEC-21).
- Coded answers: through `@cloudbase/node-sdk` (what our functions use) a
  failed database call THROWS a `TcbError` with its `code` (request layer →
  `processReturn`, `throwOnCode` true by default; never turn it off). The bare
  `@cloudbase/database` API would return `{ code }` instead; the approval
  wrappers guard against that with `sdkAnswer`. `pnpm verify:cloudbase-sdk`
  pins both behaviours.
- An approval job finishes within an hour or never; photo deletes ignore older
  unfinished jobs (`packages/db/src/approval-job-age.ts`).
- Approval writes do not change `updatedAt`; a revision guard alone does not
  detect an approval in between. Add a state guard (`requireUnapprovedDraft`).

### AI assistant PostgreSQL (outside CloudBase)

- The AI services (`ai-bff`, `ai-worker` on CloudRun) use their own TencentDB
  for PostgreSQL in VPC `vpc-1xrpitgs`, subnet `subnet-7ye4wxgz`
  (`channel-ai-postgres-sh2`), security group `sg-glj0najs` (5432 from the
  CloudRun subnet `10.42.10.0/24`). It is NOT part of the CloudBase package and
  has its own bill.
- The first instance, `postgres-nalivqki`, was monthly prepaid and paid until
  2026-10-14 14:51; it was not renewed, was isolated and then released. From
  then on the BFF answered liveness but hung on every database call. Check it
  with `postgres DescribeDBInstances` (ap-shanghai) or by the subnet's free IP
  count: 253 of 253 free means no instance.
- A new instance goes in the same subnet and security group, with SSL on and
  auto-renew on. `DATABASE_URL` (GitHub secret, owner-entered) uses
  `sslmode=verify-full&sslrootcert=/app/certs/tencentdb-postgres-ca.crt`; the
  services create the schema on start (`waitForDatabase` → `migrateUp`).
- Prepaid resources here default to manual renewal and the account balance can
  be near zero: check expiry dates before relying on any of them.

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
