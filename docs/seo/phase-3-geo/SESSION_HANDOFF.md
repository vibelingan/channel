# SEO Phase 3 GEO - Clean Session Handoff

Prepared: 2026-08-17

## Session Boundary

This handoff replaces chat-history reliance for the SEO Phase 3 GEO planning branch.

- Repository: `vibelingan/channel`
- Branch: `docs/seo-phase-3-geo-plan`
- Remote and local baseline SHA: `baeb75af3f0c9d35120013ea806b2c6cf883a551`
- Commit: `docs(seo): define phase 3 GEO plan`
- Branch URL: `https://github.com/vibelingan/channel/tree/docs/seo-phase-3-geo-plan`
- PR URL if review/promotion is requested: `https://github.com/vibelingan/channel/pull/new/docs/seo-phase-3-geo-plan`
- Status: planning only. No GEO content, Schema, provider calls, funding, public deployment, or production mutation is authorized by this branch.

The branch was pushed after exact-SHA review and blessing. Its pushed SHA is the reliable recovery point. Start new work from that commit; do not rely on the prior chat transcript.

## Read In This Order

1. `AGENTS.md`
2. `.github/copilot-instructions.md`
3. `docs/CICD_DESIGN.md`
4. `docs/seo/phase-3-geo/README.md`
5. `docs/seo/phase-3-geo/ROADMAP.md`
6. `docs/seo/phase-3-geo/MEASUREMENT-AND-EVIDENCE.md`
7. `docs/seo/phase-3-geo/REPORT-AUDIT.md`
8. `docs/seo/phase-3-geo/MIU_BREAKDOWN.md`
9. This file

The five files in `docs/seo/phase-3-geo/` above are the Phase 3 authority. Older SEO documents remain historical evidence only where the new plan says they are superseded.

## Established Facts

- `main` is the code source of truth.
- `test` is the sole current deployment channel and the only publicly usable CloudBase environment. It is not the source of truth.
- The current public origin is `https://supplychainsai.com`.
- Observed 2026-08-16 CloudBase topology:
  - EnvId: `diversity-123-d9grnqfux221323bb`
  - `supplychainsai.com` `/` and `/*` are enabled gateway routes to `STATIC_STORE/staticstore`.
  - The custom domain is a gateway binding, not a `manageHosting domainStatus` binding.
- GEO report identity:
  - File: `GEOreport-0813.pdf`
  - SHA-256: `17ebfe0e4844c5f719e4e5593804b0e3f597c04673b586daafcf2723a8377a87`
  - 76 pages, 1,703,061 bytes.
  - Pages 21-75 have OpenRouter HTTP 402 failures; the GeoLoop 11% and all related 0/5 model scores are invalid as baselines.
- Current entity contract:
  - `Organization.name`: `Diversity Technology`
  - `Organization.legalName`: `Diversity Technology Limited`
  - visible brand/legal copy: `Diversity Technology Limited`

## Non-Negotiable Scope

- Do not use GeoLoop 11% or failed 0/5 model output as any baseline or KPI.
- SEO D0 and AI D0 are separate baselines and may use different dates.
- Failed AI requests are `ERROR`, never numeric zero.
- Required AI baseline set is Q1-Q9 x every selected model x exactly three successful sample slots. Q10 is optional until a later approved question-set revision.
- Product Schema and product-data work are outside the Phase 3 DAG.
- Bing is explicitly excluded.
- Shared layout changes are site-level hypotheses and cannot claim page-level uplift.
- No public content/Schema/`llms.txt` publication before valid SEO D0, AI D0, eligibility, approved evidence, and the planned publication gates.
- Do not implement anything until the user approves the plan and resolves the applicable business/evidence gates.

## Planning Result

The plan contains 40 ordered technical MIUs. The important publication sequence is intentionally conservative:

1. Registry contracts, CI output comparison, CloudBase and GitHub provenance probes.
2. Claim/resource/attestation contracts.
3. Atomic claim helpers, rollback artifact custody, apply writer, rollback writer, public observation, and evidence finalization.
4. Protected stale-claim remediation, environment lock resolution, authorization helper.
5. Only then: guarded public-apply workflow integration.
6. Trusted attestation verification, registry lifecycle import, comparison rules, and report templates.

The publication model is fail-closed:

- A `prepared` claim with verified rollback bytes exists before the EnvId lock and apply authorization.
- The apply writer can change static hosting only after `prepared -> upload-started` succeeds and the EnvId lock belongs to that claim.
- Runner death leaves the EnvId locked. There is no unsafe automatic takeover of a possibly paused runner.
- Protected remediation requires the original GitHub-hosted run to be terminal plus a quarantine interval, fresh signed remediation authority, and exact claim-state CAS.
- Both normal success and incident remediation require public byte/config reconciliation, complete append-only evidence, and an independent unlock approver before the EnvId lock can be removed.

This is a plan, not an implemented control. Never state that the current `deployWebApp()` or current `deploy-test.yml` already has these guards.

## Decisions The User Must Supply

Before implementation, obtain named owners/approvals for:

1. PR #17 merge/rebase timing onto latest `main`.
2. Search Console full-access owner.
3. Funded AI baseline route and approved run budget.
4. Fact approvers for company, certification, case, commercial, and official-profile claims.
5. External evidence location, access owner, redaction reviewer, and retention period.
6. Primary AI evaluator, independent adjudicator, and scoring guide/disagreement rule.
7. Publication executor, incident-remediation executor, and separate lock-resolution approver.
8. Rollback-artifact storage/retention owner and evidence-chain custody owner.
9. Whether conversion attribution is a separate workstream.

## Validation Record

The pushed baseline was reviewed and blessed at its exact SHA.

Validated commands:

```sh
/Users/SeanCai/Desktop/projects/dev-pipeline/tools/validate-miu-breakdown.sh \
  docs/seo/phase-3-geo/MIU_BREAKDOWN.md

corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
corepack pnpm exec tsc --noEmit --project tsconfig.e2e.json
corepack pnpm exec biome check .
git diff --check
```

Results at the reviewed baseline:

- 40 MIUs: required fields, <=3 files, clean DAG, contracts before consumers.
- TypeScript/Astro: no errors; Astro has 7 existing hints in `apps/site/src/layouts/BaseLayout.astro`.
- Biome: 279 files checked, no fixes required.
- Independent exact-SHA reviewers: architecture `APPROVED`, tech lead `PASS`, assumption checker `PASS`.
- Engineering craft gates: executable, with 22 pre-existing baseline findings and 0 new findings.

If the new session changes any file, it must rerun focused validation before claiming the baseline remains reviewed. A new commit invalidates the blessing and needs exact-SHA review again before push.

## Safe Next Actions

Choose exactly one bounded task after reading the authority documents:

- Ask the user for the unresolved named owners/approvals above.
- Review the plan for a newly supplied decision, without implementing it.
- Open a PR for the planning branch only if the user requests review/promotion.
- After explicit user approval, wait for PR #17 to merge and rebase the implementation branch onto the
  latest `origin/main`; only then implement the first approved MIU in dependency order, not the whole plan.

Do not start with public content, Schema, provider spend, CloudBase mutation, or static-hosting changes.

## Paste-Ready New Session Prompt

```text
We are resuming SEO Phase 3 GEO planning in a clean session. Do not rely on prior chat history.

Repository: /Users/SeanCai/Desktop/projects/channel-seo-phase-3-geo-plan
Branch: docs/seo-phase-3-geo-plan
Pushed/reviewed baseline: baeb75af3f0c9d35120013ea806b2c6cf883a551

Read in order:
1. AGENTS.md
2. .github/copilot-instructions.md
3. docs/CICD_DESIGN.md
4. docs/seo/phase-3-geo/README.md
5. docs/seo/phase-3-geo/ROADMAP.md
6. docs/seo/phase-3-geo/MEASUREMENT-AND-EVIDENCE.md
7. docs/seo/phase-3-geo/REPORT-AUDIT.md
8. docs/seo/phase-3-geo/MIU_BREAKDOWN.md
9. docs/seo/phase-3-geo/SESSION_HANDOFF.md

Treat the Phase 3 directory as authoritative. Older SEO files are historical only where the new plan supersedes them.

Hard boundaries:
- main is source of truth; test is only the current public deployment channel.
- This is planning only. Do not implement, deploy, spend on AI, publish content, change Schema, or mutate CloudBase unless I explicitly approve the relevant MIU and all evidence/business gates are satisfied.
- Explicit approval is still insufficient until PR #17 is merged and the implementation branch is rebased onto the latest origin/main.
- Do not use GeoLoop 11% or the report's HTTP 402 model output as a baseline.
- Q1-Q9 x selected models x 3 successful samples are required for AI D0; errors are never zero.
- Bing and Product Schema/product work are outside this Phase 3 DAG.
- Do not claim page-level uplift from a site-level layout change.

First, report:
1. exact branch/HEAD/remote status;
2. whether the worktree is clean;
3. which unresolved user decisions block the next safe action;
4. whether PR #17 is merged and an implementation branch has been rebased onto latest origin/main before proposing implementation.

Then do only one bounded task that I request. Keep observed facts, planned controls, assumptions, and approvals separate. If any edit or commit is made, rerun focused validation and exact-SHA review before pushing.
```
