# CI/CD Production Plan — MIU-04

Status: design + prerequisites checklist — NOT implemented. Blocked on human/ops prereqs (§1). Reviewed 2026-07-06 (assumption-checker WARN → findings 1–4 applied).
Scope: MIU-04 from `docs/CICD_EXECUTION.md` — production deploy guardrails, hosting-mode (CB3),
compatibility (G4). Builds on MIU-01 (secret scoping + EnvId concurrency, done) and the
contract verification in `docs/CICD_HARDENING_MIU02.md` §0 (CB1/CB2 retired; release id G3 shipped).
Last updated: 2026-07-06

Production must go through a **gated `deploy-prod.yml`** (reviewer approval + GitHub-stored prod
secrets). The agent can configure CloudBase directly, but prod is deliberately routed through the
reviewed workflow — no hand-configuring prod.

## 1. Prerequisites Checklist — YOU (can't be delegated to the agent)

These are account / GitHub-admin / decision actions. Nothing below can proceed until they exist.

- [ ] **Provision a prod CloudBase EnvId** (new, separate from test `diversity-123-…`). Creating a
      new paid env is a console/billing action. Record the EnvId.
- [ ] **Confirm the resource-owner account** for that env (who owns billing + CAM).
- [ ] **Create prod Tencent CAM deploy credentials** (least-privilege **permanent** sub-account/API
      key with SCF + hosting + gateway manage rights — **no STS SessionToken**; permanent keys avoid
      the STS-expiry failure the repo already retired). These become prod `TENCENTCLOUD_SECRETID/SECRETKEY`.
- [ ] **Create GitHub Environment `prod`** with **required reviewer(s)** (manual approval gate) —
      needs repo **admin** (the working PAT is push-only, so this is GitHub web-UI work).
- [ ] **Populate `prod` Environment variables**: `TCB_ENV_ID`, `SITE_URL`, `PUBLIC_API_BASE_URL`,
      `CORS_ALLOWED_ORIGINS`, `LOGIN_URL`, `ADMIN_EMAIL`, `CLOUDBASE_REGION`, `APP_ENV=prod` (deploy
      label). Note: `PUBLIC_CB_PROXY=0`, `CLOUDBASE_FUNCTION_RUNTIME=Nodejs20.19`, and
      `BOOTSTRAP_ENABLED=0` are **hardcoded literals** in the workflow (as in `deploy-test.yml`), so
      `deploy-prod.yml` keeps them hardcoded — do NOT set them as Environment vars (inert unless the
      workflow reads `${{ vars.* }}`).
- [ ] **Populate `prod` Environment secrets** (NEW values, distinct from test): `TENCENTCLOUD_SECRETID`,
      `TENCENTCLOUD_SECRETKEY` (permanent, no SessionToken), `JWT_SECRET` (fresh), `ADMIN_PASSWORD_HASH`
      (prod admin), `BOOTSTRAP_ADMIN_TOKEN`, `EMAIL_*` (if email used).
- [ ] **Hosting-mode decision (CB3)** — see §3.
- [ ] **Custom domain decision** (prod likely wants a real domain vs the default `*.webapps.tcloudbase.com`).

I can *generate* candidate values (e.g. a random `JWT_SECRET`, an argon2 `ADMIN_PASSWORD_HASH` from a
password you provide) but **the values must land in the GitHub `prod` Environment, which only a repo
admin can populate.**

## 2. What the AGENT can do (once §1 exists)

- Write `deploy-prod.yml` (mirrors `deploy-test.yml` with the `prod` Environment + guardrails below).
- Extend `scripts/deploy-cloudbase-test.mjs` (or a shared module) for the prod guardrails (§4).
- Extend `scripts/smoke-cloudbase-deploy.mjs` for the prod consistency + release smoke.
- Configure the prod CloudBase env directly for a first bring-up if you prefer (functions, gateway,
  hosting) — but recommended only as a one-time bootstrap; routine prod deploys go through the workflow.
- Draft the first-admin bootstrap runbook for prod (one-shot, then disable).

## 3. Hosting-mode decision (CB3) — verified 2026-07-06

`manageApps` and `manageHosting` are **not interchangeable** (CloudBase MCP contract + docs):
- `manageApps(action="deployApp")` → independent Web App subdomain + version management (CloudBase
  guidance's preferred first-time path for `*.webapps.tcloudbase.com`).
- `manageHosting(action="upload")` → static hosting upload (what test uses today; existing/fallback
  path, different URL topology).

**Action:** before the first prod deploy, inspect the prod env's app/static-hosting resources and
**explicitly choose one mode**, then derive `SITE_URL` / `CORS_ALLOWED_ORIGINS` / `LOGIN_URL` from it
(do not assume the test template). Switching modes later changes URLs and breaks CORS/bookmarks/smoke.

## 4. `deploy-prod.yml` shape + guardrails

Trigger: `workflow_dispatch` (and later `main`/tag), **always gated by the `prod` Environment
required reviewer**. Concurrency: `cloudbase-deploy-${{ vars.TCB_ENV_ID }}` (EnvId-scoped, per MIU-01),
`cancel-in-progress: false`.

Sequence (reuse test's build/package/secret-scan, then):
1. Build with `CHANNEL_BUILD_SHA=${{ github.sha }}` (release id already wired — G3).
2. Deploy functions to the **prod** EnvId (secrets step-scoped, per MIU-01).
3. Ensure gateway routes (`/api/admin`, `/api`).
4. Deploy static site via the **chosen** hosting mode (§3).
5. **Consistency smoke** (`smoke:cloudbase`): all functions report the same `releaseId` (= `github.sha`),
   public routes `200`, protected admin `401`, and the current no-public-files check
   (`/api/files/__missing__` `404`). The stronger `/api/images/<unlinked>` `404` privacy assertion
   lands with MIU-03 (§7); until then it lives only in the mutation E2E, not the smoke.
6. Emit a deployment summary (commit SHA, EnvId, URLs, release id, smoke result — no secret values).

Guardrails (prod):
- **Fail on runtime drift (no delete/recreate).** The deploy script already **throws** on runtime
  drift (CloudBase runtime is creation-time locked; CI does not delete/recreate) — keep that
  fail-fast behavior for prod so a runtime mismatch requires a deliberate manual migration, not
  auto-downtime.
- **BOOTSTRAP_ENABLED stays `0`.** First-admin bootstrap is a separate, approved, one-shot run that
  temporarily sets `1`, creates the admin, then sets it back to `0` (never left on).
- **Roll-forward posture:** on failure before static upload, abort static upload; the summary states
  which functions + build are active so the operator can fix-forward or re-run the previous SHA.

## 5. Compatibility rule (G4)

Until alias/version routing exists, each prod release must be compatible with the previous for one
deploy window: additive API, DB expand/contract (add fields → migrate → remove later), new env vars
optional-then-required, static site uploaded last after backend verification. Enforced by discipline
now; add a cross-function contract-test gate only when the function count grows.

## 6. Rollout order

1. YOU complete §1 (prod EnvId, CAM creds, GitHub `prod` Environment + secrets, hosting-mode).
2. Agent writes `deploy-prod.yml` + prod guardrails + prod smoke → `/dp-review` → verify.
3. First-admin bootstrap runbook (one-shot) → create prod admin → disable bootstrap.
4. First gated prod deploy (reviewer-approved) → consistency smoke green → done.
5. Later: custom domain, SCF alias/version blue-green spike (see `CICD_DESIGN.md` §8 — multi-function release consistency).

## 7. Out of scope

MIU-03 (bootstrap E2E gate + `/api/images` privacy smoke — small, agent-doable, can land before prod).
