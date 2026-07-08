# Review findings — fix/enhance-features-vip round 5 (full-branch sweep, HEAD 2deca4c)

6 parallel cluster reviewers (admin-fn, packages, deploy/CI, site-islands, astro/config, e2e/local-server),
each primed with the freshly-mined 55-rule catalog as incident priors. Goal: verify current code obeys its
OWN rules everywhere (sibling paths the original fixes missed) + fresh-eyes on areas rounds 1–4 skipped.
Most findings are PRE-EXISTING gaps (not regressions from the VIP/V3 commits), surfaced by the new priors.

## Gate decision: BLOCK (P1s present) → fix highest-value security/correctness, defer design/asset/cross-branch items

| # | Sev | File:Line | Reviewer | Issue | Disposition |
|---|-----|-----------|----------|-------|-------------|
| 1 | P1 | admin/handler.ts submitProject ~648 | admin | Unauth OEM submit: no rate limit; legacy drawingData bypasses size caps; emails caller-chosen address (spam/reputation bomb) | FIX — rate-limit + cap legacy path |
| 2 | P1 | admin/handler.ts recover ~483 | admin+packages | Unauth destructive password reset, unthrottled → admin-lockout DoS; rotates hash BEFORE send; logs live password when SMTP unconfigured | FIX — rate-limit + send-then-commit + no-body-log |
| 3 | P1 | scripts/deploy-cloudbase-test.mjs:96 | deploy | callTool rethrow embeds full mcporter argv incl. JWT_SECRET/ADMIN_PASSWORD_HASH/EMAIL_PASSWORD into CI logs (JSON-escaped secrets dodge GH masking) | FIX — redact |
| 4 | P1 | scripts/deploy-cloudbase-test.mjs:378 | deploy | env read-merge (MANAGED_ENV_KEYS) missing on this branch; updateFunctionConfig REPLACES env → erases console-managed vars. Fix exists only on dev/SeanCai/cicd-prod-hardening | DEFER — cross-branch reconciliation (test env is fully deploy-managed; converge when cicd-prod-hardening merges) |
| 5 | P2 | admin/handler.ts completeUpload ~1475 | admin | null activation result returned as success → verified object leaks with no doc pointer (rule e603f34) | FIX — compensate + fail |
| 6 | P2 | admin/handler.ts login ~463 | admin | No brute-force throttle on password login | FIX — rate-limit (same primitive) |
| 7 | P2 | admin/handler.ts remove/batchRemove ~940 | admin | Generic delete of images/files rows orphans COS objects permanently (no reaper covers them) | DEFER — needs soft-delete design decision |
| 8 | P2 | deploy-test.yml:29 | deploy | concurrency group keys to github.ref_name (env-scoped TCB_ENV_ID unavailable at workflow level) → per-branch mutex, not per-target | FIX — static key cloudbase-deploy-test |
| 9 | P2 | smoke-function-artifacts.mjs:13 | deploy | require-denylist missing jose/zod/nodemailer/hash-wasm (lazily-required externalized dep 500s in prod) | FIX — add entries |
| 10 | P2 | e2e.yml + mutation/bootstrap.spec | deploy+e2e | false-green skip gate: dispatch sets flag, missing secret silently skips whole suite, run greens | FIX — flag-only skip, throw on missing creds |
| 11 | P2 | media-upload-ui.spec.ts | e2e | not wired into deploy-test npm script; only positive assertion is a weak selector (vacuous pass) | FIX — wire + positive assert |
| 12 | P2 | islands/admin/PreviewModal.tsx:69 | islands | preview of UNpublished item fetches via public refcount-gated route → 404 broken images (unfixed twin of ImageManager's getImagePreview) | FIX — use getImagePreview |
| 13 | P2 | layouts/BaseLayout.astro:22 | astro | Google Fonts render-blocking from fonts.googleapis.com; blocked in mainland China (primary audience) | DEFER — needs self-hosted font assets |
| 14 | P3 | admin/handler.ts filter/sort field | admin+packages+islands (3×) | field name not allowlisted → startsWith/contains oracle over redacted passwordHash/uploadSecretHash (admin/contributor-only, defense-in-depth) | FIX — server-side field allowlist (3-reviewer consensus) |
| 15 | P3 | admin/handler.ts loginCount ~474 | admin | read-modify-write counter bypasses incrementField guard (NaN-poison, lost updates) | FIX — incrementField |
| 16 | P3 | admin/handler.ts:11 | admin | stale module comment contradicts V3 (says role change waits for 12h token expiry) | FIX — update comment |
| 17 | P3 | ci.yml:70 + deploy-test.yml:93 | deploy+astro | built-site secret-name scan omits EMAIL_PASSWORD | FIX — add |
| 18 | P3 | public.spec.ts:138 | e2e | vacuous not.toHaveProperty on unguarded anonItem | FIX — guard |
| 19 | P3 | db/cloudbase-adapter.ts list ~98 | packages | list pages on createdAt w/o unique tiebreaker (skip/dup on ties); backfill got the fix, adapter didn't | DEFER-batch — low-value defensive nit |
| 20 | P3 | shared/query.ts:132 | packages | in-mem range/bool/null semantics diverge from CloudBase | DEFER-batch |
| 21 | P3 | admin/handler.ts search/value | packages | no length caps on search/filter value (DB-side DoS) | FIX — .max() caps (cheap, pairs with #14) |
| 22 | P3 | local-server/main.ts:134 | e2e | /api/files consumer-less mirror diverges from prod (no prod twin) | DEFER-batch — low risk |
| 23 | P3 | various | admin/astro/e2e | failed-OEM-row sweep, register race/enum, role-clear-to-'', sitemap/robots, hidden-sections test globbing, shop envelope reader, retired-route item 404s | DEFER-batch — nits follow-up |

## Reasoning on DEFERs (critical triage, not dismissal)
- #4 env-merge: real, but the fix lives on a sibling branch; porting risks conflicts when that branch merges. Test env is fully deploy-managed (no console hotfix vars), so exposure is theoretical here. Reconcile at merge.
- #7 generic-remove orphans: real leak, but the right fix (soft-delete status transition + reaper, or delete-object-before-row) is a design decision touching CRUD semantics — spawn a scoped task.
- #13 Google Fonts: real UX for CN audience, but needs downloaded woff2 subsets + a decision on @fontsource vs self-host — spawn task.
- #19–23 batch: low-value defensive nits; spawn one consolidated follow-up so they're not lost.

## FIXED this round (HEAD after fixes)
Commits: fix(security) admin/email · fix(cicd) deploy+workflows · test(e2e) gates · fix(admin-ui) PreviewModal
- #2 recover: send-then-commit + cooldown; #5 completeUpload null→compensate+CONFLICT; #14 filter/sort allowlist + length caps; #15 loginCount→incrementField; #16 stale comment — admin handler (+3 tests)
- email sendMail: never log body (live-password leak)
- #3 deploy secret redaction; #8 static mutex key; #9 artifact denylist +jose/zod/nodemailer/hash-wasm; #17 built-site EMAIL scan
- #10/#11/#18 e2e false-green gates + media-upload-ui wiring/vacuous + public.spec guard
- #12 PreviewModal → getImagePreview
Validation: lint ✅ · full typecheck ✅ · typecheck:e2e ✅ · 254 unit tests ✅ (admin 113 incl. 3 new) · artifact smoke ✅ · site build ✅. Deployed e2e via Deploy Test on push to test (local servers kept stopped per standing instruction).

## DEFERRED → spawned as separate tasks (reasoned, not dropped)
- #1 submitProject rate-limit + legacy-drawingData cap: real email-bomb/abuse, but a clean limiter needs sourceIp threading + a race-safe counting substrate (login/submitProject write no reservation row). Scoped task.
- #6 login brute-force throttle: argon2 already brakes; a naive per-account lock introduces attacker-driven lockout DoS. Needs per-source substrate. Bundled with #1.
- #4 deploy env read-merge (MANAGED_ENV_KEYS): fix exists on dev/SeanCai/cicd-prod-hardening; port at merge to avoid conflict. Test env is fully deploy-managed → theoretical exposure here.
- #7 generic remove/batchRemove orphans storage: needs soft-delete design decision. Task.
- #13 Google Fonts (China-blocked): needs self-hosted woff2 subsets. Task.
- #19–23 batch: adapter list tiebreaker, query.ts edge semantics, /api/files mirror, register race/enum, failed-OEM sweep, sitemap/robots, hidden-sections test globbing, shop envelope reader, retired item-route 404s. Consolidated nit task.
