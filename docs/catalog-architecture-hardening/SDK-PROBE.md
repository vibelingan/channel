# MIU 16 SDK Probe

Status: full local validation PASS; MIUs 01-16 released; no active exact reservations; MIU 17 planned/inactive; implementation continues; MIU 16 source published and verified; closure publication requires live Git equality verification.
Recorded: 2026-09-07.
Scope: Astro/Vite test loading for the Headphones adapter; no route, environment, or business SDK change.

## Sources

- Installed Astro `apps/site/node_modules/astro/dist/config/entrypoint.d.ts` exports `getViteConfig`
  from `./index.js`; `apps/site/node_modules/astro/dist/config/index.js` implements and exports it.
  Both were inspected in the recorded probe.
- The recorded probe fetched the official
  [astro:config module reference](https://docs.astro.build/en/reference/modules/astro-config/)
  through Context7 library `/withastro/docs` and inspected the harness in
  `apps/site/src/catalog/families/headphones.test.ts`.

These are historical probe and validation results supplied in the MIU 16 handoff. This docs-only update
does not repeat the SDK inspection or application tests; Context7 is unavailable in this session.

## Verified Contract

`getViteConfig(userViteConfig, inlineAstroConfig)` returns an async configuration function. The installed
implementation resolves the inline Astro configuration, creates Astro's Vite configuration, and merges
the user Vite configuration into it. The harness supplies the site root in both user Vite config and
inline Astro config, then evaluates the function with `{ mode: 'test', command: 'serve' }`.

`configFile: false` belongs on Vite `createServer({ ...config, configFile: false })`, not in the first
parameter to `getViteConfig`. TypeScript rejected the latter placement in the recorded probe and
accepted the corrected placement; the final `typecheck:test` passes.

Vite `ssrLoadModule` exposes a dynamic export record, not a statically proven adapter module. The harness
receives it as `Record<string, unknown>`, checks that `createHeadphonesAdapter` is a function, then
assigns it using the imported function signature. This checks function shape, not all runtime parameter
or return semantics. The default `headphonesAdapter` stays `unknown` until
`assertCatalogFamilyAdapter` validates its object shape in the focused test; the guard does not execute
callbacks to validate their results.

## Focused Runtime Evidence

- The real harness uses Astro `getViteConfig` and Vite `createServer`/`ssrLoadModule` to load
  `/src/catalog/families/headphones.ts`. The default adapter calls the existing `getHeadphonesContent`
  loader, whose eager Markdown glob loads actual family content. It is not replaced by a test stub.
- The independent comparison reads `apps/site/src/i18n/content/headphones/en-US.md`, parses its
  frontmatter with YAML `parseDocument` using `uniqueKeys: true`, and asserts no YAML parse errors.
  The `toJS() as HeadphonesContent` assertion supplies a TypeScript type only; it is not a runtime
  schema check of the full Markdown content. Strengthened assertions compare the entire flattened
  labels map as well as filter order/copy against that source. The real default adapter is also checked
  for `family: 'headphones'`, grouping, and facts across known-category, unknown-category,
  missing-category, and oldest-product inputs, beyond the guard's object-shape checks.
- The `after` hook awaits `server?.close()` so the test owns teardown of the Vite server it creates.
- Results after the two P3 test-only coverage corrections: focused 7/7 and
  `typecheck:test` pass. The exact focused commands are in
  [EXECUTION.md](EXECUTION.md#miu-16-release-validation).

## Full Local Validation And Review

Final production code passed `corepack pnpm -r test` (including site 251/251),
workspace typechecks, E2E TypeScript check, Astro check (0 errors, 0 warnings, 7 existing hints),
production Astro build (15 pages), and repository-wide Biome (356 files). These full checks precede
the later test-only strengthening; production code did not change in those corrections. The subsequent
focused 7/7 and `typecheck:test` PASS are separate evidence. Before implementation commit `d7fd55f`,
the complete site suite was also rerun (251/251), followed by repository-wide Biome (356 files clean).

Final review audited committed `5fb1a55..2eef322` and found 0 P1/P2/P3; the previous two P3 coverage gaps
and one P3 documentation-freshness gap are resolved. Craft gates against exact diff base `5fb1a55`
report 14 existing baseline
findings (pipeline-causality 1, form-degradation 6, skip-policy 5, trust-boundary-decoding 2), ZERO NEW
findings, and ZERO execution errors; async-child passed, probe-sensitivity and family-registry were N/A.
This is not a clean total. The finalized disposition and the checked
owner/test-scope cross-file YAML PASS are retained in
[EXECUTION.md](EXECUTION.md#miu-16-finalized-review-disposition).

Activation `8ff32fb`, implementation `d7fd55f8dc13ffdd0966176f4985468624fb1ae7`, and the historical reviewed ACTIVE
source checkpoint `2eef3220a79cb53da764ccba11ee2b0e23854d1e` were pushed to
`origin/refactor/catalog-architecture-hardening` and verified. Push-hook craft, review, and doc guards passed.
Pre-push scripts were 92/93 solely because of `local-only-completion`, not fully green; post-push
architecture verification reported 0 issues and scripts passed 93/93. MIU 16 is RELEASED after these checks.
The registry release transition was recorded by `801d8712e3abb9a0fe05adcd31328eb37523b054`; handoff
document snapshot `48405b23bcb43d9207e8b2a856768da45704719f` followed, then this correction.

## Evidence Limits

Full local validation is PASS and actual local Astro module integration was tested. No browser E2E was
run for this isolated config adapter; the E2E TypeScript check is not browser execution. The focused SSR
harness and successful 15-page production build do not establish default-adapter route/browser or
production-build integration: adapters are not wired into routes yet. MIU 20 registration and MIU 22
composition remain future work; no user-visible route/controller behavior change is delivered here.
Source publication was completed and verified at historical checkpoint `2eef322`; release transition
`801d871` and handoff snapshot `48405b2` were recorded before this correction; they do not prove its publication.
Use `git rev-parse HEAD` and live `origin/refactor/catalog-architecture-hardening` to confirm closure publication before continuing.
Require local/remote equality evidence; no publication of this correction is claimed. MIUs 01-16 are
released; no active exact reservations remain; MIU 17 is planned/inactive; the task remains in implementation.
No merge into `test` or `main`, CloudBase operation, workflow dispatch, or browser E2E occurred for MIU 16. The denominator
remains 49; D1 and D2 are unchanged.