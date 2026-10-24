# CUI-06E — Local RFQ proof and CI release gate

## Runtime problem and scope

The user requires local validation first and CI/CD-only releases. The current
`Deploy Test` workflow starts on `push: test` independently of `CI`, and runs
only `pnpm test:deploy-smoke` before cloud writes. A failing full CI run therefore
does not prevent release. `test` serves the live website, so this is a release
boundary, not a disposable sandbox.

This MIU changes workflow gating and tests only, plus fixes any verified local
regressions in the current workstream. No cloud mutations, deployment, real
buyer records, emails, publication, or unrelated worktree changes.

## Data, ownership and invariant

- `github.sha`: immutable trigger commit; both validation and release check out it.
- CI result: belongs to the same workflow invocation, not another branch's last
  successful run. Only success may unlock the deploy job.
- `catalogDetailPublication.revision`: server-approved product/SKU snapshot;
  submitting stale or unapproved context must not create an inquiry.
- Inquiry workflow: viewing/notes do not process it; explicit transitions and
  reasons persist across server restart; retries do not duplicate history.

## Design and technology constraint

Use GitHub's native reusable workflow and `needs` dependency:

```yaml
ci:
  uses: ./.github/workflows/ci.yml
deploy:
  needs: ci
  if: ${{ github.ref == 'refs/heads/test' && needs.ci.result == 'success' }}
```

The relative reusable-workflow path resolves at the caller commit. No deployment
secrets are passed into validation. Manual dispatch has the same prerequisite
and cannot deploy a feature branch. Preserve the target-scoped non-cancelling
deployment mutex. CI concurrency uses its existing distinct prefix, so calling
it from Deploy Test does not cancel the parent workflow.

Both package producers run the real bundled entry smoke under Node 20.19.0,
assert the embedded release SHA, then restore Node 22.13.0 for the site build.
The installed YAML parser tests the actual scheduler input graph and negative
mutations; this is configuration validation, not execution of GitHub's scheduler.

Rejected: poll/check the latest CI run (wrong-SHA and timing hazards), duplicate
only a short test list (drifts from full CI), or privilege-bearing workflow_run
as a shortcut. Existing push CI may run alongside the reusable validation; the
extra run is intentional, preserves current status checks, and is not the gate.

Official contracts checked 2026-09-07:
[same-commit reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[needs and failure propagation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

## Local validation and release coupling decision

Local policy/file persistence, HTTP handlers, schema, auth, workflow and bundle
wiring can be tested without cloud deployment. A loopback integration test will
submit through HTTP, log in normally, process the same record, restart with a new
adapter/server, and independently reread the stored snapshot/history. Use only
synthetic fixtures in a new temporary directory, not the user's sample database.

The actual CloudBase commit/conflict engine, deployed gateway, IAM and collection
rules still require post-CI/CD cloud acceptance; local doubles cannot prove them.

The buyer-facing release is coupled: approved canonical snapshots → formal detail
API/route → quote transport → persisted inquiry → Admin processing. Therefore do
not release/enable the current RFQ slice alone just to obtain a cloud test result.
CUI-07/08 local navigation/journey work does **not** depend on live CUI-06D
acceptance. Complete local navigation and the separate production wiring / approval
release unit first; then release it together through CI/CD, initially gated off.
Email, taxonomy decisions, orders/payment/invoices and import-worker activation
are independent deferred scopes, not prerequisites for this inquiry loop.

## Code translation and checks

- `.github/workflows/ci.yml`: add workflow_call, pinned checkout, packaged runtime check.
- `.github/workflows/deploy-test.yml`: full-CI prerequisite and success/branch guard,
  pinned checkout, matching runtime check. No remote workflow is triggered here.
- `scripts/deploy-ci-gate.test.mjs`: regression and negative-mutant checks.
- Local inquiry loop test: real HTTP + JSON adapter, no frontend-only receipt.

RED: `node --test scripts/deploy-ci-gate.test.mjs` must reject the old independent
deployment graph. GREEN: rerun it after the workflow patch; include it automatically
in `pnpm test:deploy-smoke` and thus full CI. Then run full local tests, lint,
types, SDK contract, clean package smoke and site build. Record actual outcomes
below; local success is not a claim that remote Actions or cloud acceptance ran.

## Verification results

Completed locally on 2026-09-07, branch `fix/alibaba-sync-storage-wiring`, base
HEAD `60b051b` plus the preserved uncommitted worktree. No commit, push, merge,
GitHub run, deployment, feature-flag update or cloud database write was performed.

| Check | Observed result |
| --- | --- |
| RED old release graph | 3 failures: missing reusable CI prerequisite and deployed-runtime smoke |
| Full `pnpm test`, Node 22.13.0 (same as CI build) | 1,365 passed, 0 failed, 0 skipped; includes 36 deployment-contract tests |
| Full tests under host Node 25 with Web Storage disabled | Also 1,365 passed; supplementary, not the CI-runtime evidence |
| New local inquiry loop | Both local-preview and real cloud HTTP handler variants passed; rerun after harness cleanup improvement also passed |
| Full typecheck + E2E typecheck under Node 22 | Passed; Astro 165 files, 0 errors / 0 warnings / 8 existing hints |
| Full lint | Passed, 506 files |
| SDK contract gate | Passed against installed node-sdk 3.17.2 / database 1.4.3 / wx-server-sdk 4.0.2, including callback commit/rollback/retry probes |
| Build/package under Node 22 → smoke under Node 20.19.0 | All 3 bundles passed; public-api executed legacy product/variant query with real bundled SDK and offline transport |
| Missing collection negative control | Failed on the actual packaged productVariants query as intended; smoke recognized this negative result |
| Wrong release SHA negative control | Exit 1 with `Prepared release was overwritten or built without its release id` |
| Site build under Node 22 | 15 pages; server-secret-name scan passed across 125 built files |
| Playwright discovery | 97 specs in 19 files discovered; this is discovery, NOT 97 executed browser tests |
| Registry | 12 unique task IDs; dependency graph acyclic |

Validation repairs: the old runtime-contract test assumed exactly one Node setup
and an unconditional deploy job. Updated it to validate the active runtime at
site-build time and the exact branch/full-CI condition. A negative mutation
leaving Node 20 active still fails the Astro floor check. Added negative graph
mutations for removed needs, always(), moving refs, conditional/full-test removal
and continue-on-error. Fixed a strict-unknown test response check and formatted
the existing inquiry test/registry; no application business code was changed in
this MIU.

The disposable loopback fixture is the only database written by the new tests.
It uses normal password login, not a forged cloud token. Viewing and note-only
saves leave newCount=1; processing clears it; stale admin versions and missing
completion reasons return 409; after server/adapter restart, resubmitting and
replaying completion leave exactly one inquiry and three actor-stamped events.
The test uses JsonFileAdapter for both HTTP paths; it does not pretend that
CloudBase's real remote transaction engine ran locally.

Local package label: `cui06e-local-60b051b` (dirty worktree verification artifact,
not a committed or remotely released SHA). Build scripts and probes do not deploy.
Temporary validation logs: `/tmp/channel-cui06e-node22-tests.log`,
`/tmp/channel-cui06e-node22-checks.log`, `/tmp/channel-cui06e-node22-package.log`.

### Browser check

Fresh isolated `cui06e` Playwright browser; retained site/API services at 4328/3013
were not restarted or reseeded. The existing user inquiry was not modified.

- Route: `/products/item/?preview=shared&id=24ee8f21-1cac-49f0-93a2-30ba1746289f`.
- Select Black SKU, quantity 500 → open RFQ: same SKU and quantity are carried in.
- Quantity 0 → requirements cannot advance; invalid input receives focus/error.
- Restore 500 → synthetic contact data → CountryPicker Hong Kong → review.
- 390×844 and 1440×1024: page/dialog horizontal overflow false; final Save button
  reachable at the bottom of the scrolling dialog. Screenshots were inspected.
- No Save click, receiptCount=0, no POST/PUT/PATCH/DELETE in request log; local
  detail GET returned 200. Console errors=0 and warnings=0.
- Screenshots: `output/playwright/cui06e-review-mobile.png` and
  `output/playwright/cui06e-review-desktop.png`.

This is a current read-only RFQ UI smoke, not the unfinished CUI-07/08 navigation
and all-browser acceptance. CLI command names differed from the installed skill
reference; used the installed help (`run-code` function argument, `requests`)
before retrying. No product fix was inferred from the harness errors.

### Remaining release boundaries

The workflow changes are locally validated configuration only. GitHub scheduling
and environment protection will be observed after the reviewed branch is pushed;
no remote green check is claimed. Formal route/transport and approved-snapshot
integration remain unfinished. CUI-07 local navigation is the next implementation
step; live CUI-06D acceptance stays deferred until the coupled release is ready.
