# CI/CD Hardening Plan — Secret Scoping & Deploy Serialization

Status: design + execution plan only — NOT implemented. Awaiting review and approval.
Scope: two P2 review findings — D1 (job-level secret exposure) and D3 (ref-scoped deploy concurrency).
Source: `docs/CICD_EXECUTION.md` §1 disposition (D1, D3, G2) and §MIU-01.
Review: assumption-checker audit on 2026-06-26 — PASS. Current-state, the
secret→step map, and the H2 concurrency change were verified against the live
workflows and the deploy/smoke/E2E scripts; the two cosmetic nits it raised are
applied.
Last updated: 2026-06-26

This document is the detailed, implementation-ready spec for the two P2 hardening
items summarized as MIU-01 in `docs/CICD_EXECUTION.md`. It follows the MIU
methodology (two-level decomposition: one product-level hardening task →
technical MIUs). No workflow code is changed by this document.

## 1. Goal & Non-Goals

Goal: close two pre-existing P2 hardening gaps in the already-deployed CI/CD
workflows **without changing what they deploy or how the app behaves**.

- **H1 — secret minimization.** Deploy and E2E secrets are currently declared at
  job-level `env:`, so dependency-install, build, and toolchain steps inherit
  them. Scope each secret to only the step that consumes it.
- **H2 — deploy serialization.** The test-deploy `concurrency.group` is
  ref-scoped, so two runs targeting the same CloudBase EnvId can deploy
  concurrently. Serialize by EnvId.

Non-goals (tracked elsewhere, do not touch here): RELEASE_ID / release manifest,
CloudBase `updateFunctionConfig` env read-merge (CB1), function resource permission
(CB2), `mcporter --args` transport (D2), production workflow, and any
application/runtime/bundle change. **This is a planning document only;
implementation is a separate, approved step.**

## 2. Design

### H1 — Secret scoping

**Problem.** GitHub Actions job-level `env:` is inherited by *every* step.
- `deploy-test.yml` declares all Tencent deploy credentials and all function
  runtime secrets at job level, so `pnpm install` (third-party postinstall
  scripts), `pnpm build`, and `npx playwright install` run with those secrets in
  their process environment — a supply-chain exfiltration surface.
- `e2e.yml` declares `E2E_ADMIN_PASSWORD` and `E2E_BOOTSTRAP_ADMIN_TOKEN` at job
  level, so `pnpm install` and `npx playwright install` inherit them too.

**Constraint.** Job-level `env:` cannot be partially scoped. The only mechanism
to limit a secret's exposure is to declare it on the specific step (`env:` on the
step). Step `env:` is additive to job `env:`, so the consuming step still sees
all non-secret job vars plus its own secrets. Non-secret config (URLs, EnvId,
`APP_ENV`, `BOOTSTRAP_ENABLED=0`) can safely remain at job level.

**Secret → consuming step map** (the heart of this change):

| Secret(s) | Consuming step(s) | Why |
| --- | --- | --- |
| `TENCENTCLOUD_SECRETID` / `SECRETKEY` / `SESSIONTOKEN` | `Deploy to CloudBase test` **and** `Smoke deployed CloudBase test` | both shell out to `mcporter`, which authenticates to Tencent/CloudBase |
| `JWT_SECRET`, `ADMIN_PASSWORD_HASH`, `BOOTSTRAP_ADMIN_TOKEN`, `EMAIL_*` | `Deploy to CloudBase test` only | the deploy script writes these as CloudBase function runtime env; smoke/E2E do not need them |
| `E2E_ADMIN_PASSWORD`, `E2E_BOOTSTRAP_ADMIN_TOKEN` (e2e.yml) | `Run selected E2E suite` only | only the Playwright run authenticates |

The `public` browser-E2E steps require **no** secret (read-only suite).

**Target shape (deploy-test.yml).** Job `env:` keeps only non-secret values
(`CI`, `APP_ENV`, `TCB_ENV_ID`, `CLOUDBASE_*`, `PUBLIC_*`, `SITE_URL`,
`CORS_ALLOWED_ORIGINS`, `LOGIN_URL`, `ADMIN_EMAIL`, `BOOTSTRAP_ENABLED`,
`E2E_SITE_URL`, `E2E_API_URL`). Secrets move to step `env:`:

```yaml
- name: Deploy to CloudBase test
  env:
    TENCENTCLOUD_SECRETID: ${{ secrets.TENCENTCLOUD_SECRETID }}
    TENCENTCLOUD_SECRETKEY: ${{ secrets.TENCENTCLOUD_SECRETKEY }}
    TENCENTCLOUD_SESSIONTOKEN: ${{ secrets.TENCENTCLOUD_SESSIONTOKEN }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
    ADMIN_PASSWORD_HASH: ${{ secrets.ADMIN_PASSWORD_HASH }}
    BOOTSTRAP_ADMIN_TOKEN: ${{ secrets.BOOTSTRAP_ADMIN_TOKEN }}
    EMAIL_HOST: ${{ secrets.EMAIL_HOST }}
    EMAIL_PORT: ${{ secrets.EMAIL_PORT }}
    EMAIL_SECURE: ${{ secrets.EMAIL_SECURE }}
    EMAIL_USER: ${{ secrets.EMAIL_USER }}
    EMAIL_PASSWORD: ${{ secrets.EMAIL_PASSWORD }}
    EMAIL_FROM: ${{ secrets.EMAIL_FROM }}
  run: pnpm deploy:cloudbase:test

- name: Smoke deployed CloudBase test
  env:
    TENCENTCLOUD_SECRETID: ${{ secrets.TENCENTCLOUD_SECRETID }}
    TENCENTCLOUD_SECRETKEY: ${{ secrets.TENCENTCLOUD_SECRETKEY }}
    TENCENTCLOUD_SESSIONTOKEN: ${{ secrets.TENCENTCLOUD_SESSIONTOKEN }}
  run: pnpm smoke:cloudbase
```

**Target shape (e2e.yml).** Keep `CI`, `E2E_SITE_URL`, `E2E_API_URL`,
`E2E_ADMIN_EMAIL`, `TCB_ENV_ID` at job level; move the two secrets to the run
step:

```yaml
- name: Run selected E2E suite
  env:
    E2E_ADMIN_PASSWORD: ${{ secrets.E2E_ADMIN_PASSWORD }}
    E2E_BOOTSTRAP_ADMIN_TOKEN: ${{ secrets.BOOTSTRAP_ADMIN_TOKEN }}
  run: |
    case "${{ inputs.suite }}" in
      ...
```

**Guards (do not regress):** values are unchanged — this is a scope-only move.
`BOOTSTRAP_ENABLED` stays a non-secret job-level var fixed at `'0'` (it is not a
secret and must remain desired-state, not promoted to a secret or removed).

**Alternatives rejected.**
- Keep job-level secrets and rely on GitHub log masking. Rejected: masking hides
  values in *logs*, not in step *process environments* — it does not address the
  supply-chain surface.
- Wrap secrets in a composite/reusable action. Rejected: over-engineering for two
  workflows; step-level `env:` is the minimal, auditable change.

### H2 — Deploy serialization by EnvId

**Problem.** `deploy-test.yml` uses `concurrency.group: deploy-test-${{ github.ref }}`.
`github.ref` differs per branch and per dispatch, so two runs that target the
**same CloudBase EnvId** (e.g. a push to `test` overlapping a manual dispatch, or
two branches both pointed at the test EnvId) compute different group keys and run
concurrently — interleaving function updates on one shared environment.

**Constraint.** `concurrency.group` only serializes runs that resolve to the
**same** key. The key must derive from the deploy *target* (EnvId), not the
source ref.

**Target shape (deploy-test.yml).**

```yaml
concurrency:
  group: cloudbase-deploy-${{ vars.TCB_ENV_ID || github.ref_name }}
  cancel-in-progress: false
```

`vars.TCB_ENV_ID` is the deploy target; the `github.ref_name` fallback keeps the
group non-empty if the var is ever unset. `cancel-in-progress: false` is retained
so a second run **queues** rather than cancelling a deploy mid-flight.

**Alternatives rejected.**
- `cancel-in-progress: true`. Rejected: cancelling mid-deploy can leave CloudBase
  functions half-updated (mixed release).
- Keep ref-scoped. Rejected: it does not protect a shared EnvId — the exact race
  §8 of `CICD_DESIGN.md` warns about.

## 3. MIU Breakdown

> CI workflow YAML is not unit-testable; "Test plan" below uses structural
> assertions (parse + grep) plus a named remote run, which is the meaningful
> verification for an Actions change.

### MIU-H1: Step-scope secrets in deploy and E2E workflows

```
Block:        INFRASTRUCTURE
Files:        .github/workflows/deploy-test.yml, .github/workflows/e2e.yml
Type:         modify-existing
Depends on:   none

What it does:
  - deploy-test.yml: delete TENCENTCLOUD_SECRETID/SECRETKEY/SESSIONTOKEN,
    JWT_SECRET, ADMIN_PASSWORD_HASH, BOOTSTRAP_ADMIN_TOKEN, and EMAIL_* from the
    job-level `env:`. Add the full set to the `Deploy to CloudBase test` step
    `env:`, and add only the three TENCENTCLOUD_* values to the
    `Smoke deployed CloudBase test` step `env:`. Leave every non-secret var at
    job level untouched.
  - e2e.yml: delete E2E_ADMIN_PASSWORD and E2E_BOOTSTRAP_ADMIN_TOKEN from the
    job-level `env:`. Add them to the `Run selected E2E suite` step `env:`.
  - Scope-only move: no value changes. BOOTSTRAP_ENABLED ('0') stays job-level.

Build/Deploy/Runtime impact:
  - Touches the two GitHub Actions workflows only. No app code, no function
    bundle, no function runtime change: the deploy STEP still receives the same
    secrets and still writes the same function env, so the deployed result is
    byte-identical.
  - These workflows run on push to `test` (deploy) and workflow_dispatch (both);
    neither runs on pull_request, so PR CI does NOT exercise this change — it
    must be verified by a real `Deploy Test` / `E2E` run (and locally by
    actionlint + a grep guard).
  - Failure mode: a secret consumed by a step that no longer has it in scope →
    that step fails at runtime. Mitigation is the secret→step map in §2 H1.

Test plan (verification):
  - actionlint (or `yaml`/`js-yaml` parse) passes on both workflows.
  - Structural assertion: the job-level `env:` block of each workflow contains
    zero `secrets.*` references (only `vars.*` / literals); each removed secret
    re-appears under exactly its consuming step's `env:`.
  - Negative: the `Install dependencies`, `Build site`, and
    `Install Playwright Chromium` steps have no secret in scope.
  - Remote (post-merge): a `Deploy Test` run completes deploy + CloudBase smoke
    green (secrets reached deploy + smoke steps); an `E2E` admin run authenticates
    (E2E creds reached the run step).

Done when:
  - Both workflows parse; job-level `env:` has zero secrets; each secret appears
    only on its consuming step(s); a real Deploy Test run deploys + smokes green;
    `pnpm lint && pnpm typecheck && pnpm test` still pass (unaffected).
```

### MIU-H2: EnvId-scoped deploy concurrency

```
Block:        INFRASTRUCTURE
Files:        .github/workflows/deploy-test.yml
Type:         modify-existing
Depends on:   none

What it does:
  - Change concurrency.group from `deploy-test-${{ github.ref }}` to
    `cloudbase-deploy-${{ vars.TCB_ENV_ID || github.ref_name }}`; keep
    `cancel-in-progress: false`.

Build/Deploy/Runtime impact:
  - Workflow-only; changes how GitHub serializes deploy runs. No app/runtime
    impact. Not exercised on PRs (deploy runs on push to `test` / dispatch);
    verify by triggering two overlapping deploys to the same EnvId.

Test plan (verification):
  - actionlint / yaml parse passes.
  - Structural assertion: concurrency.group resolves from `vars.TCB_ENV_ID`;
    `cancel-in-progress` stays `false`.
  - Remote: start a deploy, then start a second deploy to the same EnvId while
    the first is running → the second QUEUES (does not run concurrently).

Done when:
  - Workflow parses; group is EnvId-scoped with the ref_name fallback; a second
    same-EnvId deploy waits instead of interleaving.
```

## 4. Execution Order

H1 and H2 are independent (`Depends on: none` each). Implement as **two separate
commits**, verified independently — do not combine:

1. MIU-H2 (concurrency — one line, lowest risk).
2. MIU-H1 (secret scoping).

## 5. Local Verification (run before any remote trigger)

```bash
pnpm lint && pnpm typecheck && pnpm test           # unaffected — must stay green

# secret-scope guard: fail if any `secrets.` reference appears before `steps:`
# (i.e. in a job-level `env:` block); secrets may only live under a step.
for f in .github/workflows/deploy-test.yml .github/workflows/e2e.yml; do
  awk '/^[[:space:]]*steps:/{s=1} /secrets\./ && !s {print FILENAME": "FNR": "$0; rc=1} END{exit rc}' "$f" \
    && echo "OK: $f job env is secret-free" || echo "FAIL: $f has job-level secret(s)"
done
```

If `actionlint` is available, run it on both files; otherwise validate YAML with
a parser.

## 6. Rollback

Pure workflow edits with no state migration and no data risk — revert the
commit to restore prior behavior. If a deploy/smoke/E2E step fails for a missing
secret, add that secret to the failing step's `env:` (never back to the job
`env:`).

## 7. Out of Scope (tracked in `docs/CICD_EXECUTION.md`)

D2 (`mcporter --args` transport), CB1 (function env-merge), CB2 (function
resource permission), RELEASE_ID / release manifest (MIU-02), production
guardrails (MIU-04).
