# CI/CD Hardening Plan — MIU-02: Release Identity & CloudBase Deploy Hardening

Status: **Contract re-verified 2026-07-06 (Context7) — CB1 REAL (verdict reversed; the earlier "merge" reading was wrong), CB2 not needed for HTTP** (see §0). CB1 read-merge → prod guardrail (`CICD_PRODUCTION_PLAN.md` §4); D2 minor/optional; G3 shipped.
Scope: MIU-02 from `docs/CICD_EXECUTION.md` — CB1, CB2, D2, G3.
Prereq: MIU-01 (secret scoping + EnvId deploy concurrency) — implemented.
Reviews: assumption-checker 2026-07-05 (BLOCK → revised); **CloudBase SDK contract verification 2026-07-06** (this consolidation — §0).
Last updated: 2026-07-06

This is the implementation-ready spec for MIU-02. It follows the MIU methodology
(one product task → technical MIUs). No workflow/script/app code is changed by
this document. The CB1/CB2/D2 items harden the CloudBase deploy so it is safe to
reuse for a first-time / production environment (MIU-04 depends on this). G3
(release identity) is already implemented — this doc keeps it as verify-only.

## 0. Contract Verification Outcome (2026-07-06)

Per the AGENTS.md CloudBase SDK Contract Gate + `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`.
**Context7 was NOT available** this session; sources used: the CloudBase MCP tool contract
(`mcporter describe cloudbase --all-parameters`), official docs
(`docs.cloudbase.net/cloud-function/security-rules`), installed packages
(`@cloudbase/node-sdk@2.10.0`, `wx-server-sdk@3.0.4`), and the proven test deploys.

**CB1 — VERIFIED REAL (verdict reversed 2026-07-06, Context7).** The earlier reading of the MCP
`envVariables` label **“配置更新时要合并的环境变量”** as "the tool merges for you" was a **misread** —
it means "the vars *the caller* wants merged in," and the caller must do the merge. Authoritative
sources: the CloudBase MCP skill (`cloudbase-mcp` `config/source/skills/cloud-functions/SKILL.md`, via
Context7): *"When updating environment variables, it's crucial to first query the existing values and
merge them with the new ones to prevent accidental overwriting"*; and the tool exposes
`patchMode:"merge"` **precisely because the default is full-replace**. Our `updateFunctionConfig(def)`
sends `envVariables: def.envVariables` (manifest-only — no `getFunctionDetail` read-merge, no
`patchMode`) → it **replaces** function env and would erase any console-managed key absent from the
manifest. This matches Codex's PD-5 (`CLOUDBASE_DEPLOYMENT_DESIGN.md` Section 13) and this repo's own
`CICD_EXECUTION.md` best-practice #5 / "Alternatives Rejected → Replace full env config". **Impact:**
low for test (the manifest is the complete env set and no console-only vars exist, so each deploy
re-sets everything), **real for prod** (an out-of-band console hotfix would be silently erased).
**Action:** resolve for prod via read-merge-update (query `getFunctionDetail` env → merge manifest over
existing → send the union, with an explicit removal list for intentional deletes) — reinstated as
MIU-02.3 and tracked as a prod guardrail in `CICD_PRODUCTION_PLAN.md` §4. (`BOOTSTRAP_ENABLED='0'` is
still correctly reset because it is always in the manifest.)

**CB2 — VERIFIED NOT NEEDED for HTTP.** CloudBase cloud-function *security rules*
(`managePermissions/queryPermissions resourceType="function"`, the `{ "*": { "invoke": … } }`
JSON) govern **client SDK `callFunction`** — per the official docs they do NOT apply to the
management API, triggers, or **HTTP Access**. Our functions are reached over HTTP Access
(gateway `createAccess`), which the proven deploys already make public. No `managePermissions`
call is needed for HTTP access; the existing smoke (public `200` / protected `401`) is the
correct proof.

**API surface confirmed** (for the record): `queryFunctions(action="getFunctionDetail")`,
`manageFunctions(action="updateFunctionConfig", envVariables /* merged */)`,
`queryPermissions(action="getResourcePermission", resourceType="function")`, and
`managePermissions(action="updateResourcePermission", resourceType="function", securityRule)`
all exist.

**Net remaining MIU-02 work: CB1 read-merge (reinstated — deferred to prod guardrail
`CICD_PRODUCTION_PLAN.md` §4) + D2 (optional, minor) + these doc corrections.** G3 already shipped.
MIU-02.3 (CB1) below is REINSTATED by this §0; MIU-02.4 (CB2) stays SUPERSEDED (HTTP ≠ SDK rules).

## 1. Goal (re-scoped after verification)

- **CB1** — **read-merge-update REQUIRED for prod** (MCP `updateFunctionConfig` **replaces** env;
  verdict reversed 2026-07-06, Context7). Low impact for test (manifest is the complete, authoritative
  env); tracked as a prod guardrail in `CICD_PRODUCTION_PLAN.md` §4.
- **CB2** — ~~function permission gate~~ **NOT needed** for HTTP (security rules are SDK-only;
  gateway `createAccess` governs HTTP, proven).
- **G3** — ✅ already shipped (build-time `CHANNEL_BUILD_SHA`).
- **D2** — the one remaining (minor) item: keep secret values out of process argv where the
  transport allows.

Non-goals (elsewhere): production workflow + hosting-mode + compatibility gate (MIU-04);
bootstrap gate + `/api/images` privacy smoke (MIU-03); release manifest file (MIU-04 / §8).

## 2. Current State (verified 2026-07-05 against `scripts/deploy-cloudbase-test.mjs`, 573 lines)

- `updateFunctionConfig(def)` (≈L378) sends `envVariables: def.envVariables` (manifest-only — no `patchMode`, no `getFunctionDetail` read-merge). Per §0 the CloudBase MCP **replaces** function env, so a console-managed key absent from the manifest is erased (CB1 real; low impact for test because the manifest is the complete, authoritative env; must fix for prod — `CICD_PRODUCTION_PLAN.md` §4).
- `ensureGateway(def)` (≈L471) calls `manageGateway(action:"createAccess", auth:false)`, which governs **HTTP access** (proven public). Function *security rules* are a separate SDK-`callFunction` control, not required here (CB2 not needed).
- Function env is built by `envEntries({...})` (≈L408 admin, L429 public-api). The deploy also sets `ADMIN_EMAIL` on admin — a managed key CB1's merge set must include.
- `callTool(...)` shells `npx mcporter call <tool> --args <JSON>` (L67) → secret values in argv (D2 open; accepted for test, tighten for prod).
- **G3 is DONE** (commit `7f10674`, 2026-06-30): `packages/shared/src/release.ts` bakes `releaseId = CHANNEL_BUILD_SHA` at **build time** (tsup `define`, ← `GITHUB_SHA`); `/api/health` returns `{ status, service, releaseId, buildTime }` (public-api `http-adapter.ts` L231, admin `handler.ts` L311); smoke asserts `releaseId` (`smoke-cloudbase-deploy.mjs` L78/L120). No new G3 work.

## 3. MIU Breakdown

### G3 — Release identity (ALREADY IMPLEMENTED — verify-only, no MIU)

Release identity is shipped (commit `7f10674`, 2026-06-30) using a **build-time**
define — the correct, immutable mechanism (immune to the env-merge bugs CB1 fixes):

- `packages/shared/src/release.ts` computes `releaseId = process.env.CHANNEL_BUILD_SHA || 'local'`,
  where `CHANNEL_BUILD_SHA` is baked at build time by tsup `define` (← `GITHUB_SHA`).
- `/api/health` returns `{ status, service, releaseId, buildTime }` on both functions
  (public-api `http-adapter.ts` L231, admin `handler.ts` L311).
- `scripts/smoke-cloudbase-deploy.mjs` asserts `releaseId === CHANNEL_BUILD_SHA || GITHUB_SHA || 'local'`
  for public-api and admin (L78/L120).

**Do NOT add a runtime `RELEASE_ID` env var** — the handler reads the build-time
define, so a runtime env would be dead code AND would break the existing smoke
assertion. The only ongoing action is keeping `GITHUB_SHA` wired as the build arg
in the deploy workflow (already the case).

### MIU-02.3 — Read-merge-update function env (CB1) — IMPLEMENTED (contract live-verified; e2e deploy test recommended)

> Verdict reversed 2026-07-06 (Context7): the MCP **replaces** env on `updateFunctionConfig`, so this
> read-merge IS the required fix. **Implemented 2026-07-06** on `dev/SeanCai/cicd-prod-hardening`
> (`scripts/deploy-cloudbase-test.mjs`: `MANAGED_ENV_KEYS` + `mergeEnvWithExisting()` before
> `updateFunctionConfig`, GUARD 1/GUARD 2 semantics, defensive fallback to manifest-only).
> **Contract LIVE-VERIFIED 2026-07-06** via the CloudBase MCP: `getFunctionDetail` on `admin` returns
> `Environment.Variables` as `[{Key,Value}]` exactly as the code reads, so the read-merge path executes
> (not just the fallback); `BOOTSTRAP_ENABLED=0` observed live. All current keys are managed (no
> console-only keys yet), so today merge == manifest-only. A full **end-to-end deploy test** (add a
> console-only key → redeploy → confirm survival) remains the final check before it graduates into
> `deploy-prod.yml` (`CICD_PRODUCTION_PLAN.md` §4).

```
Block:        INFRASTRUCTURE
Files:        scripts/deploy-cloudbase-test.mjs
Type:         modify-existing
Depends on:   none

What it does:
  - PREREQUISITE: confirm `getFunctionDetail` actually returns the current env map
    (today the code reads only Status/Runtime/CodeSize) — contract-verify per
    `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` before relying on it.
  - Before updateFunctionConfig, read current env; compute the new env as:
    unmanaged(current) + manifest(managed). The manifest OWNS a fixed key set:
    TCB_ENV, APP_ENV, ADMIN_EMAIL, JWT_SECRET, ADMIN_PASSWORD_HASH,
    CORS_ALLOWED_ORIGINS, LOGIN_URL, PUBLIC_API_BASE_URL,
    EMAIL_HOST/PORT/SECURE/USER/PASSWORD/FROM, BOOTSTRAP_ENABLED,
    BOOTSTRAP_ADMIN_TOKEN. (No RELEASE_ID — release id is a build-time define, not
    function env.)
  - GUARD 1 (managed present): a managed key set by this deploy ALWAYS takes the
    manifest value — BOOTSTRAP_ENABLED back to '0', never merge-preserved from a
    stale '1'.
  - GUARD 2 (managed absent = delete): a managed key NOT set this deploy (optionalEnv
    unset — e.g. BOOTSTRAP_ADMIN_TOKEN, EMAIL_*) must be DELETED, not preserved.
    Today's full-replace already drops them; the merge must not resurrect a stale
    BOOTSTRAP_ADMIN_TOKEN or SMTP secret.
  - Only UNMANAGED (console-only) keys are preserved; deleting an unmanaged key needs
    an explicit removal list.

Build/Deploy/Runtime impact:
  - Deploy-script only; changes how env is composed before update. No app change.
    Failure mode: a managed key wrongly demoted to "preserved" would keep a stale
    value — the managed-set list is the single source of truth and must be complete.

Test plan (verification):
  - Deploy once with a manually-added console-only key present → after deploy the
    console-only key survives AND all managed keys equal the manifest.
  - Deploy after a manual BOOTSTRAP_ENABLED=1 → after a normal deploy it is back to '0'
    (managed key wins; not merge-preserved).

Done when:
  - getFunctionDetail read precedes update; managed keys authoritative; unmanaged keys
    preserved; BOOTSTRAP_ENABLED provably reset by a normal deploy.
```

### MIU-02.4 — Public-access permission gate (CB2) — SUPERSEDED (see §0: HTTP ≠ SDK rules — NOT needed)

> Pre-verification proposal, kept for history. HTTP access is governed by the gateway
> (`createAccess`), not by function security rules, so this is **not implemented**.

```
Block:        INFRASTRUCTURE
Files:        scripts/deploy-cloudbase-test.mjs, scripts/smoke-cloudbase-deploy.mjs
Type:         modify-existing
Depends on:   none

What it does:
  - PREREQUISITE (blocking): `managePermissions(resourceType="function")` is used
    NOWHERE in this repo/tool surface yet. Contract-verify the exact tool/action name
    and response shape per `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` (AGENTS.md
    CloudBase SDK Contract Gate) BEFORE implementation — do not assume the API.
  - After ensureGateway, query the function's resource permission; if the desired
    public access is not in effect, configure it via the verified permission tool,
    then re-verify.
  - smoke already proves unauthenticated public routes 200 and protected admin 401;
    add an explicit assertion that these prove access, keyed to the permission check.

Build/Deploy/Runtime impact:
  - Deploy + smoke scripts. Matters most for a FIRST-TIME env (test env got its
    permission from earlier manual MCP setup; prod won't). No app change.

Test plan (verification):
  - On the test env: permission query returns the expected public state; smoke's
    GET /api/health (200, unauth) and POST /api/admin no-token (401) still hold.
  - (Prod dry proof) a fresh function without the permission fails public smoke until
    the gate configures it.

Done when:
  - Deploy verifies (and sets if needed) function public-access permission before
    declaring success; smoke's public 200 / protected 401 are tied to that gate.
```

### MIU-02.5 — Reduce secret exposure in tool transport (D2)

```
Block:        INFRASTRUCTURE
Files:        scripts/deploy-cloudbase-test.mjs
Type:         modify-existing
Depends on:   none

What it does:
  - Confirm whether mcporter/CloudBase CLI accepts args via stdin or an env/args file
    instead of `--args <JSON>` on argv (the newer deployFunctionWithCloudBaseCli path
    may already avoid argv for some ops). For any call that carries secret env values,
    switch to stdin/file transport if supported.
  - If not supported, DOCUMENT it as an accepted test-env residual risk and require the
    prod path (MIU-04) to only pass secrets to CLI ops that do not expose argv, or via
    the CloudBase CLI env-var mechanism.

Build/Deploy/Runtime impact:
  - Deploy-script only. GitHub-hosted runners are ephemeral + single-tenant (mitigates),
    but process argv is still visible same-host; prod secrets warrant the tighter path.

Test plan (verification):
  - `ps`-style check on a runner (or local) confirms no secret value appears in argv for
    the secret-carrying calls after the change; deploy still succeeds.

Done when:
  - Secret-carrying tool calls avoid argv, OR the residual risk is documented and the
    prod path constraint is recorded for MIU-04.
```

## 4. Execution Order (after verification)

Contract verification (§0) retired CB1 and CB2; G3 is shipped. Remaining:
1. **MIU-02.5 (D2)** — optional, minor: investigate stdin/env-file transport for
   secret-carrying tool calls; else record the accepted test-env residual + the prod
   constraint. (Because the MCP merges env, secrets could alternatively be set once
   out-of-band and omitted from routine deploys — evaluate under MIU-04/prod.)
2. Optional CB1 residual (explicit clear of stale optional secrets) — only if we decide it matters.

**MIU-02 needs no CB1/CB2 code.** The substantive next work is MIU-03 and MIU-04 (production).

## 5. Local Verification (each MIU)

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm package:functions && pnpm smoke:functions
```
Remote proof of any deploy/smoke change requires a real Deploy Test run — these
paths do not execute on PRs.

## 6. Rollback

All changes are in the deploy/smoke scripts + the public-api handler. Revert the
commit to restore prior behavior. No data migration; CB1's merge is additive
(preserves more, deletes nothing implicitly), so it cannot lose function config.

## 7. Out of Scope

MIU-03 (bootstrap gate D5, `/api/images` privacy smoke D7); MIU-04 (production
workflow, `manageApps` vs `manageHosting` CB3, compatibility gate G4, release
manifest file, prod prerequisites).
