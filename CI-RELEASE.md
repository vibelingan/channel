# CI and release: what runs on a push (channel)

The rule, the same in every repository: a push or merge runs only the work that can find something
for that change. Audit of 25 Nov 2026; the cross-repo table is in coachflow `docs/ops/CI-RELEASE-AUDIT.md`.

No Vercel here: the site, functions and AI services ship to CloudBase / Cloud Run by workflow, and
the deploy workflows already run only by hand, by tag or on the `test` branch.

## What fires (main, 25 Nov 2026)

About 1,000 Actions runs from 15 to 25 Nov, 699 of them pushes to `feat/seo-foundation`, which has
no PR and starts three workflows on every push (they stay that way, see below): SEO release modules (233 runs), SEO Blog isolated
dummy (233) and Blog server HTTP acceptance (233). The repository is public, so the minutes are
free, but the runs queue against the shared `cloudbase-deploy-test` group and fill the run list.

| Workflow | Fires on | Filter today | Change | Expected saving |
| --- | --- | --- | --- | --- |
| `seo-module-1.yml` (calls `ci.yml` and `browser-regression.yml`), `seo-blog-dummy.yml`, `seo-blog-server.yml` | every push `feat/seo-foundation` | none | **none** (see below) | none |
| `assistant-chat.yml`, `assistant-ui.yml`, `sales-contracts.yml` | push (listed branches, paths), PR (paths) | paths, concurrency | draft PRs wait for ready for review | every draft push |
| `ci.yml`, `browser-regression.yml` | PR, push `main` | concurrency only | **none** (see below) | none |
| `deploy-test.yml`, `deploy-ai-cloudrun.yml`, `e2e.yml`, `seo-static-canary.yml`, others | `test` branch, tags, manual, `workflow_call` | already narrow | none | none |

## Why `ci.yml` and `browser-regression.yml` stay as they are

- `scripts/*.test.mjs` read files under `docs/` (for example `docs/CICD_DESIGN.md`,
  `docs/ai-platform/*.md`, `docs/cloud-handoff/*.json`), so a docs-only PR can break CI and has to run it.
- They are the release gate. `deploy-ci-gate.test.mjs` and `catalog-e2e-suites.test.mjs` refuse a
  job-level `if:` on them, because a skipped gate job reads as passed. A draft skip would need that `if:`.

## Why the `feat/seo-foundation` push workflows stay unfiltered (note for the seo lane)

Every cloud step on that branch needs a successful **push** run for the exact branch-tip SHA:

- `scripts/release/github-read.mjs` `requireCI` and `scripts/release/catalog-github-app.mjs`
  `passedCI` need one from `seo-module-1.yml`.
- `scripts/blog/confirm-accepted.ts` needs one from `SEO Blog isolated dummy`.
- `seo-blog-server-stage.yml` needs one from `seo-blog-server.yml`, plus its `blog-server-<sha>` artifact.

A path filter, or a concurrency group that cancels an older SHA's run, leaves a tip with no such
run, and every executor refuses it. A first version of this change filtered those pushes; review
(Codex P2 on #93) caught the stage case and it was reverted. **No cherry-pick is needed on
`feat/seo-foundation`.**

The safe way to save runs there is the one the lane already uses: batch docs commits and push
them together. A tip that is docs-only or `[skip ci]` still has no run, so it can't be staged
until a pushed tip runs CI. A path filter would only be safe once those selectors also accept a
`workflow_dispatch` run of the same SHA. That is a change to the release policy, so it belongs to the seo lane.

## Takes effect when

As soon as this merges (the draft checks are on PR workflows).

## Needs Nina

Nothing. No dashboard, plan or secret change.
