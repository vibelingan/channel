# CI and release: what runs on a push (channel)

The rule, the same in every repository: a push or merge runs only the work that can find something
for that change. Audit of 25 Nov 2026; the cross-repo table is in coachflow `docs/ops/CI-RELEASE-AUDIT.md`.

No Vercel here: the site, functions and AI services ship to CloudBase / Cloud Run by workflow, and
the deploy workflows already run only by hand, by tag or on the `test` branch.

## What fires (main, 25 Nov 2026)

About 1,000 Actions runs from 15 to 25 Nov, 699 of them pushes to `feat/seo-foundation`, which has
no PR and starts three workflows on every push: SEO release modules (233 runs), SEO Blog isolated
dummy (233) and Blog server HTTP acceptance (233). The repository is public, so the minutes are
free, but the runs queue against the shared `cloudbase-deploy-test` group and fill the run list.

| Workflow | Fires on | Filter today | Change | Expected saving |
| --- | --- | --- | --- | --- |
| `seo-module-1.yml` (calls `ci.yml` and `browser-regression.yml`) | push `feat/seo-foundation` | none | `paths-ignore` docs, root Markdown, `.learnings/` | ~31% of its push runs (78 of 249 CI-running commits since 15 Nov were docs-only) |
| `seo-blog-dummy.yml` (offline job) | push `feat/seo-foundation` | none | same `paths-ignore` | ~31% of its push runs |
| `seo-blog-server.yml` | push `feat/seo-foundation`, PR (paths) | push: none | push uses the PR's own paths; concurrency added | ~55% of its push runs (about 45% of commits since 15 Nov touched its paths) |
| `assistant-chat.yml`, `assistant-ui.yml`, `sales-contracts.yml` | push (listed branches, paths), PR (paths) | paths, concurrency | draft PRs wait for ready for review | every draft push |
| `ci.yml`, `browser-regression.yml` | PR, push `main` | concurrency only | **none** (see below) | none |
| `deploy-test.yml`, `deploy-ai-cloudrun.yml`, `e2e.yml`, `seo-static-canary.yml`, others | `test` branch, tags, manual, `workflow_call` | already narrow | none | none |

## Why `ci.yml` and `browser-regression.yml` stay as they are

- `scripts/*.test.mjs` read files under `docs/` (for example `docs/CICD_DESIGN.md`,
  `docs/ai-platform/*.md`, `docs/cloud-handoff/*.json`), so a docs-only PR can break CI and has to run it.
- They are the release gate. `deploy-ci-gate.test.mjs` and `catalog-e2e-suites.test.mjs` refuse a
  job-level `if:` on them, because a skipped gate job reads as passed. A draft skip would need that `if:`.

## Takes effect when

- PR workflows: as soon as this merges.
- The three `feat/seo-foundation` workflows run from that branch's own copy of each file. The saving
  starts only when that lane merges main or cherry-picks the commit
  "ci(seo): skip docs-only pushes on feat/seo-foundation" (its trigger blocks match main's, so it applies cleanly).

## Needs Nina

Nothing. No dashboard, plan or secret change.
