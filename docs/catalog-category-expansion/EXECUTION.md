# Catalog Category Expansion - Execution And Delivery

Status: implementation and test deployment complete; PR #27 is open for normal review/merge to `main`.
Branch: `feat/catalog-category-design`.
Final reviewed implementation SHA: `8f64659deda11a2651afebcb38ca241bf15bc5a4`.
Final test-branch merge SHA: `a4d0bc5`.
Pull request: <https://github.com/vibelingan/channel/pull/27>.

The PR head and checks change whenever this handoff document is updated. Query GitHub at review
time (`gh pr view 27`) rather than freezing a self-invalidating "current head/green" claim here.

## Handoff Contract

This file is the **portable source of truth for current status and next action**. Agents must
use the following precedence instead of inferring state from filenames or creating a second plan:

1. `EXECUTION.md` — completed work, validation evidence, current phase, and next action.
2. `MIU_BREAKDOWN.md` — approved MIU scope and dependencies; it is not a progress tracker.
3. `REMEDIATION.md` — defect/root-cause and architectural rationale.
4. `task_plan.md` and `progress.md` — historical planning/log detail; they must not override this file.
5. `.claude/pipeline-state.json` — disposable local pointer regenerated from these tracked docs.

**Current phase:** `deliver`.

**Current/next MIU:** none. MIUs 1–25 are complete. Do not invent P1–P6, a new refactor plan,
or another implementation branch for this feature.

**Next action by role:**

| Agent role | Action |
|---|---|
| Implementer | No implementation work remains. Only address a new, explicit review finding. |
| Reviewer | Review PR #27 / final feature SHA `8f64659`; verify the diff against this execution record and `REMEDIATION.md`. |
| Designer | No redesign is pending. Audit only if the user requests a new design change. |
| Validator | Re-run the recorded full validation/deployed smoke when requested; report only, do not create a new plan. |
| Delivery | Query PR #27's current head/checks, then merge to `main` through the normal PR gate when green. |

## Post-Delivery Queue (Not An Active MIU)

After PR #27 is reviewed/merged, run a separate serious retrospective/design task covering:

- why the initial V1.1 architecture replaced proven Headphones behaviour instead of extracting it;
- whole-repository dependency and historical-data impact analysis before additive design approval;
- role-separated design → implementation → review → validation handoff quality;
- a durable debugging/solutions knowledge system that preserves detailed reproduction methods,
	verification evidence, expiry/refresh policy, and reusable interview-quality explanations.

This queue item is intentionally **not** MIU 26 and does not reopen catalog implementation.

## Delivered Units

| MIU | Outcome | Commit |
|---|---|---|
| 1-10 | Product/media contracts, atomic identities, public projection, family queries, slug lookup, DTOs, deterministic seed, and catalog menu | See `progress.md` |
| 11-15 | Catalog hub, shared family grid/routes, sitemap policy, and SKU detail | `c8287f2` through `9c38036` |
| 16-19 | Admin family/form workflows, VIP suppression, and Alibaba compatibility | `63e87eb` through `7f9f01d` |
| 20 | Breadcrumbs, structured data, canonical/robots/sitemap, and strict pricing projection | `9eddc36` |
| 21 | Public/Admin E2E workflows and disposable local mutation runner | `7c8a709` |
| 22 | Full-family local seed, compatibility, and release verification | `7252af0`, final delivery evidence below |
| 23 | Restore legacy-product visibility and the in-page detail journey | `65ba453`, `25d06f6` |
| 24 | Self-contained catalog cards, stable header layout, and Admin table clamp | `d6972a5`, `182ff6d`, `d63138e`, `1b16b74`, `8f64659` |
| 25 | Align CI, deployed smoke, and browser E2E with the approved catalog design | `1e4f3ff`, `2dcce50`, `b897b7b`, `b06c17c`, `dcbc8f2` |

## MIU 22 Local Integration

The local integration runner owns the complete destructive boundary:

1. Creates a private temporary directory and database.
2. Starts the local API on an OS-assigned loopback port.
3. Verifies a nonce-bound readiness artifact and exact database path through `/api/health`.
4. Starts Astro on an OS-assigned loopback port and captures that live child URL.
5. Runs exact full-family seed verification.
6. Runs create/move/duplicate/publish/public/unpublish/archive Admin lifecycle verification.
7. Terminates Playwright, Astro, and API process groups with bounded TERM-to-KILL escalation.
8. Deletes the temporary directory and verifies it no longer exists.

Observed local results:

| Check | Result |
|---|---|
| Exact seed families | Passed: Headphones 6, AI Gadgets 2, Toys 2, Misc 2 |
| Legacy compatibility | Passed: exactly one raw missing-family Headphones row (`AuraBeat Pro Studio`) projects as Headphones |
| Raw seed safety | Passed: six non-Headphones rows omit VIP/video and contain at most nine image IDs |
| Public projection | Passed: exact family results, max-nine resolved images, no image IDs/VIP/video/archive/timestamps |
| Seeded SKU browser | Passed: VisionClip detail, two gallery thumbnails, quote CTA, no VIP/video |
| Admin lifecycle | Passed: draft, family move/filter, duplicate identity conflict, publish, public detail/fallback, unpublish/not-found, archive |
| Cleanup | Passed: runner reported and verified removal of the complete temporary database directory |

## Final Validation Ledger

| Gate | Status | Evidence |
|---|---|---|
| Site tests | Passed | 191/191 |
| Local-server tests | Passed | 23/23 |
| Deployment-contract tests | Passed | 25/25, including API/site spawn-failure teardown |
| Site typecheck | Passed | Astro 0 errors; 7 existing hints |
| Local-server typecheck | Passed | `tsc --noEmit` |
| E2E typecheck | Passed | `tsc --noEmit --project tsconfig.e2e.json` |
| Public catalog browser | Passed | 16/16 |
| Non-mutating Admin browser | Passed | 6/6 |
| Disposable seed/lifecycle | Passed | 2/2 specs; whole temporary DB removed |
| Production site build | Passed | 15 static pages with explicit `SITE_URL` |
| Repository lint | Passed | Biome 317 files |
| Assumption/cross-file audit | Passed | MIU 22 final audit passed; remediation traces are recorded in `REMEDIATION.md` |
| Function builds/packages/smoke | Passed | Admin, Public API, and Alibaba build/package/cold-start smoke |
| CloudBase SDK contract | Passed | Installed runtime/type/transaction/upload probes |
| Test-environment deploy | Passed | Final feature SHA merged into `test` as `a4d0bc5`; CI run `32359898730` passed; Deploy Test run `32359898758` passed |
| Deployed public browser E2E | Passed | 37/37 on run `32359898758` |
| Deployed catalog E2E | Passed | 16/16 on run `32359898758` |
| Safari/WebKit compatibility | Passed | 6/6 header/catalog behavioural checks |
| Production smoke | Not run | Requires separate explicit production approval |

## Deployment Boundary

- Delivery to the `test` environment happens by **merging into the `test` branch**, which the
	Deploy Test workflow triggers on directly. No environment-policy change and no admin rights are
	needed. The earlier `workflow_dispatch` attempts from the feature branch (`32324413709`,
	`32324519611`) were rejected only because a feature branch is not in the environment allowlist;
	that was the wrong delivery route, not a genuine blocker.
- Production deployment or production smoke is not authorized by this task. It must not be inferred from test-environment approval.
- The deployed smoke verifies release identity, all catalog routes, family-filtered API response
	shape/projection, optional slug detail when present, max-nine images, internal/VIP/video field
	absence, and an Admin token authorizing a protected catalog read.

## Defects Found By CI And Deploy, And Fixed

Two real defects in this branch's own test tooling were caught only on the runner:

1. **Spec discovery aborted the whole suite.** CI runs `pnpm test:e2e --list` to enumerate specs.
	`catalog-admin.spec.ts` and `catalog-local-seed.spec.ts` threw at module scope when their opt-in
	environment flags were unset, so discovery reported `Total: 0 tests in 0 files` and CI failed
	(runs `32324569630`, `32324701605`). Fixed by skipping on the **static** opt-in flag, matching
	`mutation.spec.ts` and `admin-auth.spec.ts`; once a flag IS set, missing credentials, a
	non-loopback URL, or a mismatched temporary database still fail rather than skip.
2. **Deployed smoke required content that does not exist.** The smoke demanded at least one
	published product in every family, but `ai-gadgets`, `toys`, and `misc` ship as empty storefronts
	until the catalog team publishes into them, so the first `test` deploy failed on
	`ai-gadgets: deployed catalog requires at least one published product`. Every other spec already
	treated empty families as valid (`catalog-hub.spec.ts` asserts the empty state explicitly), so the
	smoke was the inconsistent one. It now checks response shape and projection for every family and
	requires non-emptiness only for families listed in `SMOKE_REQUIRED_FAMILIES` (default
	`headphones`). Add a family to that list once it has published products.

## Residual Risks

- Runtime Product JSON-LD remains a JavaScript-enhanced, `noindex,follow` static-hosting trade-off documented in MIU 20.
- The real Admin mutation lifecycle is intentionally local-disposable because products are archive-only in shared environments.
- Production behavior remains unobserved until explicit production approval is granted.

## Delivery Checklist

- [x] MIUs 1-25 committed and pushed to the single feature branch.
- [x] Exact local full-family and lifecycle verification passes.
- [x] Temporary local database is removed after success and failure.
- [x] Final package/function validation passes.
- [x] Compatibility checklist is complete.
- [x] Test-environment deploy, deployed smoke, and public/catalog E2E pass for the final SHA.
- [x] Final SHA is independently reviewed, blessed, and pushed.
- [x] PR status is recorded: PR #27 open against `main`.
- [x] Production smoke is explicitly recorded as not authorized; no production claim is made.
