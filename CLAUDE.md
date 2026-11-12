# Channel Portal — Diversity Technology Limited Website

Astro 6 + TailwindCSS 4 + React 19 frontend, CloudBase (wx-server-sdk) backend,
pnpm monorepo. Includes admin portal, product catalog, inquiry cart.

## Agent skills

### Issue tracker

GitHub issues for `vibelingan/channel`. PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### CloudBase and production

One environment serves supplychainsai.com and is the owner's test environment; deploy by fast-forwarding `test`. Release ids, deploy timing and failure modes, gateway latency, SDK result shapes, provisioning, admin calls from the signed-in page. See `docs/agents/cloudbase.md`.

### Site assistant and public knowledge

The "Ask our AI" widget: which services run it, how the read-only knowledge key and the public workspace decide what it may read, how to question the live assistant without a browser, how to replay with the real model, and the failures already diagnosed. See `docs/agents/assistant.md`.

### Intermittent CI test failures

A test that fails on CI and passes on rerun: start with the symptom table (what the failed log shows, the likely cause, how to confirm it), then the known causes, the signals that misled earlier investigations, and the steps (failed-attempt log, CI loop with monitors, probes, A/B) that find a new cause. Keep scratch files out of `apps/site` while its browser unit tests run. See `docs/agents/ci-test-flakes.md`.

### Domain docs

Single-context repo — `CONTEXT.md` at root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.

### What not to commit

No local run products (`output/`, screenshots, PDFs, reports, evidence JSON) and no `git add -f` past `.gitignore`; CI enforces it. One design doc and one execution record per feature, updated in place. See `AGENTS.md` → "What not to commit".

## OEM Website 2.0 Upgrade

Phase 1 (current): Homepage restructure + Company Cases (CMS) + Market Case Teardown Lab + Blue Ocean Product Showcase.
Brand name: **Diversity Technology Limited** (per PRD).
Tech stack unchanged: Astro 6 + TailwindCSS 4 + React 19 + CloudBase + pnpm monorepo.
