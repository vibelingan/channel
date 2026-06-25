# CI/CD Execution

Status: review-hardening MIU prepared; implementation not started in this
document update
Scope: executable follow-up plan for CloudBase GitHub Actions CI/CD
Last updated: 2026-06-26

## 1. Review Source And Disposition

Thread-aware GitHub review scan for PR #1 returned no conversation comments, no
reviews, and no inline review threads. The review source for this pass is the
pulled commit `72c1a96`, which appended "CI/CD Implementation Review" to
`docs/CICD_DESIGN.md`.

I validated the review against current code before turning it into execution
work. The design doc should stay high-level; this file now owns execution order,
MIU traces, and review disposition.

| ID | Disposition | Evidence | Execution Decision |
| --- | --- | --- | --- |
| D1 | accept | `.github/workflows/deploy-test.yml` and `.github/workflows/e2e.yml` put deploy/E2E secrets in job-level `env`, so install/build steps inherit them. | MIU-01. Scope secrets to the exact deploy, smoke, and selected E2E run steps. |
| D2 | accept as residual risk | `scripts/deploy-cloudbase-test.mjs` passes function env values inside `mcporter --args`, so runtime secrets can appear in same-runner process args. | MIU-02. First confirm `mcporter` transport/log behavior; then move to stdin/env-file if supported, otherwise document the accepted test-env residual risk. |
| D3 | accept | `.github/workflows/deploy-test.yml` concurrency is `deploy-test-${{ github.ref }}`, not EnvId-scoped. | MIU-01. Serialize deploys by `vars.TCB_ENV_ID`, with `cancel-in-progress: false`. |
| D4 | accept as test-only limitation | `scripts/deploy-cloudbase-test.mjs` updates code/config non-atomically and deletes/recreates on runtime drift. | MIU-04. Keep acceptable for test; explicitly block prod reuse until release manifest or alias strategy exists. |
| D5 | accept | `e2e.yml` sets `E2E_ENABLE_BOOTSTRAP=1`, while deploy sets function `BOOTSTRAP_ENABLED=0`; the workflow does not enable or verify the server-side gate. | MIU-03. Add an explicit manual precondition or an enable/verify/disable sequence before bootstrap E2E. |
| D6 | fixed, not active | Root `test` script and CI "Unit tests" step now exist in commit `72c1a96`. | Do not keep as actionable work. |
| D7 | accept, low priority | `scripts/smoke-cloudbase-deploy.mjs` still checks `/api/files/__missing__`, which is a catch-all 404, not the real image/privacy route. Hosting uses `errorDocument: index.html`, so site unknown paths can soft-200. | MIU-03. Keep catch-all smoke if useful, but add real `/api/images/:id` privacy coverage where test data makes it deterministic. |
| G1 | duplicate | Same issue as D3. | Covered by MIU-01. |
| G2 | accept | Secret hygiene belongs in CD ownership, not just security review notes. | Covered by MIU-01 and MIU-02. |
| G3 | accept | `/api/health` currently returns only non-release health data, so `RELEASE_ID` consistency cannot be verified through HTTP yet. | MIU-02. Add safe release metadata or an admin-only diagnostic. |
| G4 | accept as constraint | Backward-compatible API/DB deploy discipline is not enforced by a gate. | MIU-04. Add contract-test gate only after function boundaries grow beyond the current two-function setup. |

No review point was rejected as technically wrong. D6 is the only item removed
from the active queue because it is already fixed.

## 2. Execution Order

1. MIU-01: secret scoping and EnvId deploy serialization.
2. MIU-02: release identity, deploy manifest, and process-argument hardening.
3. MIU-03: bootstrap E2E gating and privacy smoke correction.
4. MIU-04: production deploy guardrails and compatibility gates.

Each MIU should be implemented and verified separately. Do not combine these
into one large CI/CD change.

## MIU-01 - Secret Scope And EnvId Deploy Serialization

### Runtime Problem

The current workflows attach sensitive values at job scope. That means ordinary
dependency and build steps inherit deploy credentials and runtime secrets before
any CloudBase operation happens.

Current risky shape:

```yaml
jobs:
  deploy:
    environment: test
    env:
      TENCENTCLOUD_SECRETID: ${{ secrets.TENCENTCLOUD_SECRETID }}
      TENCENTCLOUD_SECRETKEY: ${{ secrets.TENCENTCLOUD_SECRETKEY }}
      JWT_SECRET: ${{ secrets.JWT_SECRET }}

    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm deploy:cloudbase:test
```

The deploy workflow also serializes by git ref:

```yaml
concurrency:
  group: deploy-test-${{ github.ref }}
  cancel-in-progress: false
```

Two refs can target the same CloudBase EnvId and interleave function updates.

### Data Shape

| Value | Example | Lifetime | Scope |
| --- | --- | --- | --- |
| Tencent deploy credentials | `TENCENTCLOUD_SECRETID`, `TENCENTCLOUD_SECRETKEY`, `TENCENTCLOUD_SESSIONTOKEN` | GitHub Environment secret lifetime | deploy and smoke steps only |
| Function runtime secrets | `JWT_SECRET`, `ADMIN_PASSWORD_HASH`, email secrets | GitHub Environment secret lifetime | deploy step only |
| E2E admin credentials | `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | test account lifetime | selected E2E run step only |
| CloudBase EnvId | `diversity-123-...` | test environment lifetime | whole deploy workflow, safe as var |

### Technology Constraint

GitHub Actions job-level `env` is inherited by every step. Dependency install
and build steps run package manager and toolchain code; they should not receive
CloudBase or app runtime secrets.

GitHub Actions `concurrency.group` controls cancellation/serialization only
within identical group keys. Ref-scoped groups do not protect a shared CloudBase
environment.

### Best-Practice Fix

Keep non-secret vars at job scope, and move secrets to only the steps that need
them.

Target deploy concurrency:

```yaml
concurrency:
  group: cloudbase-deploy-${{ vars.TCB_ENV_ID || github.ref_name }}
  cancel-in-progress: false
```

Target secret scoping:

```yaml
- name: Deploy to CloudBase test
  env:
    TENCENTCLOUD_SECRETID: ${{ secrets.TENCENTCLOUD_SECRETID }}
    TENCENTCLOUD_SECRETKEY: ${{ secrets.TENCENTCLOUD_SECRETKEY }}
    TENCENTCLOUD_SESSIONTOKEN: ${{ secrets.TENCENTCLOUD_SESSIONTOKEN }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
    ADMIN_PASSWORD_HASH: ${{ secrets.ADMIN_PASSWORD_HASH }}
  run: pnpm deploy:cloudbase:test
```

For `e2e.yml`, keep `E2E_SITE_URL` and `E2E_API_URL` safe at job scope, but set
`E2E_ADMIN_PASSWORD` and `E2E_BOOTSTRAP_ADMIN_TOKEN` only on the selected E2E
run step.

### Alternatives Rejected

- Keep job-level secrets because GitHub masks logs.
  Reason rejected: masking logs does not remove secrets from step environments.
- Use `cancel-in-progress: true`.
  Reason rejected: cancelling mid-deploy can leave CloudBase functions in a
  mixed or partially updated state.

### Risk / Test

Focused validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Remote validation:

- Trigger `Deploy Test`.
- Confirm install/build steps run without CloudBase secrets in their step env.
- Confirm a second deploy targeting the same EnvId waits instead of running
  concurrently.

## MIU-02 - Release Identity And Deploy Transport Hardening

### Runtime Problem

The §8 design requires release consistency checks, but current functions do not
expose a release identity. The deploy script also passes full tool args as
process arguments.

Current shapes:

```js
['mcporter', 'call', selector, '--args', JSON.stringify(args), '--output', 'json'];
```

```json
{ "status": "ok", "service": "public-api" }
```

### Data Shape

| Value | Example | Lifetime | Scope |
| --- | --- | --- | --- |
| Release id | Git SHA | one deploy | all deployed functions and static build metadata |
| Manifest | function list, hashes, runtime, routes | one deploy plus artifact retention | CI artifact/operator evidence |
| Runtime secret values | JWT/email/admin hashes | secret lifetime | deploy transport only |

### Technology Constraint

Same-host process arguments are easier to inspect than stdin or files with
controlled permissions. Also, release consistency cannot be verified by HTTP
until a function reports non-secret release metadata or a trusted diagnostic can
query it.

### Best-Practice Fix

1. Add `RELEASE_ID=${GITHUB_SHA}` to deployed function env.
2. Generate a non-secret release manifest before deploy.
3. Extend smoke to verify every function reports or is configured with the same
   release id.
4. Investigate whether `mcporter` supports stdin or env-file input for args that
   contain secrets. If not, record the test-env residual risk and avoid using
   this transport unchanged for prod.

### Alternatives Rejected

- Verify only function runtime/status.
  Reason rejected: runtime/status proves availability but not same-release
  consistency.
- Expose all runtime env in `/api/health`.
  Reason rejected: health responses must never include secret or config values.

### Risk / Test

Focused validation:

```bash
pnpm package:functions
pnpm smoke:functions
pnpm smoke:cloudbase
```

Remote validation:

- Deploy Test summary includes release id and manifest location.
- `/api/health` or admin diagnostic exposes only safe release metadata.

## MIU-03 - Bootstrap Gate And Privacy Smoke

### Runtime Problem

The bootstrap E2E harness flag controls whether the test runs, but the deployed
admin function independently requires `BOOTSTRAP_ENABLED=1`. Current deploys set
it to `0`, and the E2E workflow does not change or verify it.

The smoke script also checks `/api/files/__missing__`, which proves only a
catch-all 404. It does not prove that image/file privacy rules are enforced.

### Data Shape

| Value | Example | Lifetime | Scope |
| --- | --- | --- | --- |
| Bootstrap server flag | `BOOTSTRAP_ENABLED=1` | one bootstrap window | admin function runtime env |
| Bootstrap harness flag | `E2E_ENABLE_BOOTSTRAP=1` | one E2E run | Playwright process |
| Private media id | `images/<id>` or `files/<id>` | DB/storage record lifetime | public API privacy boundary |

### Technology Constraint

Bootstrap is intentionally a two-gate operation: deployed server flag plus E2E
harness flag. A browser test cannot safely assume the server flag is enabled.

The public API has a real `/api/images/:id` route but no public `/api/files/:id`
route. Testing `/api/files/*` validates route absence, not privacy.

### Best-Practice Fix

For bootstrap:

- Either document a manual precondition in the workflow summary and fail fast if
  the server flag is not enabled, or add an approved enable/verify/run/disable
  sequence.
- Never leave `BOOTSTRAP_ENABLED=1` after the bootstrap suite.

For privacy:

- Keep `/api/files/*` as a "no public files route" check.
- Add deterministic `/api/images/:id` privacy coverage when test data is
  available, for example unlinked image returns 404 and published-linked image
  returns 200.

### Alternatives Rejected

- Make `E2E_ENABLE_BOOTSTRAP=1` implicitly enable the server flag.
  Reason rejected: that hides a privileged CloudBase runtime-config change
  inside a browser-test switch.
- Treat `/api/files/*` 404 as file privacy proof.
  Reason rejected: the route does not exist by design.

### Risk / Test

Focused validation:

```bash
npx playwright test tests/e2e/bootstrap.spec.ts
npx playwright test tests/e2e/mutation.spec.ts
```

Run bootstrap only after explicit approval and immediately disable the server
flag afterward.

## MIU-04 - Production Guardrails And Compatibility Gates

### Runtime Problem

The current deploy path is acceptable for test but not for production: function
updates are sequential, runtime drift can trigger delete/recreate, rollback is
manual, and compatibility is a written rule rather than an enforced gate.

### Data Shape

| Value | Example | Lifetime | Scope |
| --- | --- | --- | --- |
| API contract | `/api/products`, `/api/admin` envelope | release to release | browser and function callers |
| DB shape | catalog/image/user documents | persistent | CloudBase database |
| Function release set | admin + public-api | one deploy | CloudBase functions |

### Technology Constraint

CloudBase by-name function updates are not atomic across multiple functions and
static hosting. Until alias/version routing is proven, production must assume a
short mixed-release window.

### Best-Practice Fix

- Keep the current delete/recreate-on-runtime-drift behavior test-only.
- Before prod, add release manifest, release id, preflight, post-deploy
  consistency smoke, and resume/rollback metadata.
- Add compatibility tests only when APIs or function count grow enough that the
  risk justifies the gate.
- Complete the SCF alias/qualifier spike before promising blue/green deploy.

### Alternatives Rejected

- Reuse test deploy unchanged for prod.
  Reason rejected: a prod traffic path needs stronger rollback and consistency
  guarantees than the current by-name rolling update provides.

### Risk / Test

Prod readiness requires:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm package:functions
pnpm smoke:functions
```

Then a protected test deploy must prove release consistency before any prod
workflow is enabled.
