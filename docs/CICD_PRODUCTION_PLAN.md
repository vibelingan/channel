# CI/CD Production Plan — MIU-04

Status: design + prerequisites checklist + reconciled readiness audit (§8) — NOT implemented. Blocked on human/ops prereqs (§1). Reviewed 2026-07-06 (assumption-checker WARN → findings 1–4 applied); reconciled 2026-07-06 with Codex `CLOUDBASE_DEPLOYMENT_DESIGN.md` Section 13 (PD-1…PD-7) + CB1 verdict corrected (Context7).
Scope: MIU-04 from `docs/CICD_EXECUTION.md` — production deploy guardrails, hosting-mode (CB3),
compatibility (G4), and the reconciled production-readiness audit (§8, absorbing Codex's
`CLOUDBASE_DEPLOYMENT_DESIGN.md` Section 13 PD-1…PD-7). Builds on MIU-01 (secret scoping + EnvId
concurrency, done); CB2 not needed for HTTP and release id G3 shipped (`docs/CICD_HARDENING_MIU02.md`
§0); **CB1 (env read-merge) is a real prod guardrail — §4** (verdict corrected 2026-07-06).
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
6. Emit a **durable, non-secret release manifest artifact** (commit SHA, EnvId, per-function names +
   code hashes + runtime, gateway routes, hosting mode, release id, smoke result — no secret values),
   uploaded as a CI artifact for operator evidence/rollback (closes Codex PD-5's "no durable release
   manifest").

Guardrails (prod):
- **Env read-merge (CB1).** `updateFunctionConfig` **replaces** function env (CloudBase default —
  verified 2026-07-06 via Context7; the earlier "merge" reading was wrong). For prod, read current env
  (`getFunctionDetail`) and merge the manifest over it before update, with an explicit removal list for
  intentional deletes — so an out-of-band console value isn't silently erased and a rotated secret is
  still removed deliberately. (Test is unaffected: its manifest is the complete, authoritative env;
  design in `docs/CICD_HARDENING_MIU02.md` MIU-02.3 with GUARD 1/GUARD 2 delete semantics.)
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

## 8. Production-readiness audit — reconciled with Codex Section 13 (PD-1…PD-7)

This folds Codex's independent production audit (`docs/CLOUDBASE_DEPLOYMENT_DESIGN.md` Section 13,
branch `dev/albertli/try01` @ `99f130e`, findings PD-1…PD-7) into this canonical plan so there is **one**
production gate, not two divergent reviews. Where our earlier contract verification disagreed, the
settled verdict is recorded here.

| PD | Sev | Finding (Codex) | Reconciled disposition |
| --- | --- | --- | --- |
| PD-1 (superseded 2026-07-27) | P1 | Historical finding: the OEM refresh retired both storefront routes. Commit `90bd06e` later restored `/headphones`; `/overstock` remains retired. | Current prod DoD = `/`, `/admin`, `/login`, `/oem`, `/portfolio`, `/headphones` → `200`; `/overstock` → `404`. The deployment docs and smoke pin this split outcome. |
| PD-2 | P1 | Secret-name drift: canonical/execution docs use `TENCENT_SECRET_ID/KEY`; workflow/scripts use `TENCENTCLOUD_SECRETID/SECRETKEY`; SMTP var-vs-secret drift. | **Accept.** This plan already standardizes on `TENCENTCLOUD_SECRETID/SECRETKEY` (§1) and `EMAIL_*` as secrets. Fix the stale `TENCENT_SECRET_ID/KEY` names in `CLOUDBASE_DEPLOYMENT_*` at merge. |
| PD-3 | P1 | Section 2 "current facts" state baseline is stale (`none yet`). | **Accept.** Run a fresh CloudBase inspection for `test` + the new `prod` EnvId at prod bring-up (§6); replace with dated "last verified" state. |
| PD-4 | P1 | Hosting mode: first prod deploy should use `manageApps`; test uses `manageHosting upload`. | **Already this plan's CB3 / §3** — independent agreement. Choose mode before first prod deploy; derive URLs from it. |
| PD-5 | P1 | `updateFunctionConfig` can erase console-managed env; gateway doesn't verify function permission; secrets via `mcporter --args`; no durable release manifest. | **Settled.** Env-replace is **real** → CB1 read-merge (§4, reverses our earlier "merge" reading). Gateway-vs-function-permission = CB2 (not needed for HTTP; `CICD_HARDENING_MIU02.md` §0). Secret transport = D2 (harden for prod). Durable release manifest = §4 step 6 (now a CI artifact). |
| PD-6 (resolved 2026-08-23) | P2 | Factory video bundled in static build vs storage/CDN policy (OR-4). | Resolved by the reviewed static launch video exception in `IMAGE_UPLOAD_STORAGE_DESIGN.md`: the current 7.2 MB OEM clip may remain static; new/replacement videos require signed raw COS `PUT`. |
| PD-7 | P2 | "HTTP function" terminology vs Event Function via HTTP Access. | **Accept** wording fix in the deploy docs; our runtime is an **Event Function via HTTP Access** (matches `CICD_HARDENING_MIU02.md` §0). |

**Net for the prod gate:** PD-4 (=CB3, §3) and PD-5's env-replace (=CB1, §4) are the two findings that
change *this* plan; both are now folded in. PD-1/PD-2/PD-3/PD-7 are doc-consistency fixes for the
CloudBase deploy docs (now applied); PD-6 is resolved outside CI/CD. Codex's
"Verified Correct" items (Event-Function/HTTP-Access model, `TENCENTCLOUD_*` not copied into runtime
env, storage SDK boundary, private-media delivery, retired-route pruning) corroborate MIU-01 + the
storage design and need no action.

This section is the canonical production-readiness gate and **supersedes Codex's Section 13**; at branch
merge, reduce that section to a pointer here.
