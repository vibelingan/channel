# MIU 16 SDK Probe

Status: full local validation PASS; MIU 16 ACTIVE, not released; final review and feature publication pending.
Recorded: 2026-09-07.
Scope: Astro/Vite test loading for the Headphones adapter; no route, environment, or business SDK change.

## Sources

- Installed Astro `apps/site/node_modules/astro/dist/config/entrypoint.d.ts` exports `getViteConfig`
  from `./index.js`; `apps/site/node_modules/astro/dist/config/index.js` implements and exports it.
  Both were inspected during the prior documentation synchronization, not re-inspected in this pass.
- The parent reports fetching the official
  [astro:config module reference](https://docs.astro.build/en/reference/modules/astro-config/)
  through Context7 library `/withastro/docs`. This records that supplied probe evidence; Context7
  was not available to the doc-writer and the fetch was not independently repeated here.
- The harness in `apps/site/src/catalog/families/headphones.test.ts` was read directly during the prior
  synchronization. The subsequent test-only strengthening and all application validation results below
  are parent-reported, not independently rerun during this doc-only pass.

## Verified Contract

`getViteConfig(userViteConfig, inlineAstroConfig)` returns an async configuration function. The installed
implementation resolves the inline Astro configuration, creates Astro's Vite configuration, and merges
the user Vite configuration into it. The harness supplies the site root in both user Vite config and
inline Astro config, then evaluates the function with `{ mode: 'test', command: 'serve' }`.

`configFile: false` belongs on Vite `createServer({ ...config, configFile: false })`, not in the first
parameter to `getViteConfig`. The parent reports that TypeScript rejected the latter placement and
confirmed the corrected placement; the final `typecheck:test` passes.

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
- Parent-reported results after the two P3 test-only coverage corrections: focused 7/7 and
  `typecheck:test` pass. The exact focused commands are in
  [EXECUTION.md](EXECUTION.md#miu-16-local-implementation-validation).

## Full Local Validation And Review

Parent-observed final production code passed `corepack pnpm -r test` (including site 251/251),
workspace typechecks, E2E TypeScript check, Astro check (0 errors, 0 warnings, 7 existing hints),
production Astro build (15 pages), and repository-wide Biome (356 files). These full checks precede
the later test-only strengthening; production code did not change in those corrections. The subsequent
focused 7/7 and `typecheck:test` PASS are separate evidence. Before implementation commit `d7fd55f`,
the complete site suite was also rerun (251/251), followed by repository-wide Biome (356 files clean).

Read-only assumption and deep/TypeScript reviews found no code defects; no P1/P2 findings were reported.
The two P3 coverage gaps are patched and checked locally, and this packet update resolves the P3
documentation-freshness gap. Craft gates against exact diff base `5fb1a55` report 14 existing baseline
findings (pipeline-causality 1, form-degradation 6, skip-policy 5, trust-boundary-decoding 2), ZERO NEW
findings, and ZERO execution errors; async-child passed, probe-sensitivity and family-registry were N/A.
This is not a clean total and does not clear release. The concise finalized disposition and the checked
owner/test-scope cross-file YAML PASS are retained in
[EXECUTION.md](EXECUTION.md#miu-16-finalized-review-disposition).

## Evidence Limits

Full local validation is PASS and actual local Astro module integration was tested. No browser E2E was
run for this isolated config adapter; the E2E TypeScript check is not browser execution. The focused SSR
harness and successful 15-page production build do not establish default-adapter route/browser or
production-build integration: adapters are not wired into routes yet. MIU 20 registration and MIU 22
composition remain future work; no user-visible route/controller behavior change is delivered here.
The checked-scope cross-file PASS is not release clearance. MIU 16 remains ACTIVE, not released; its
source is not yet pushed, and final review and feature publication remain pending. No CloudBase operation,
test-branch merge, workflow dispatch, or deployment occurred; `main` was not touched. The denominator
remains 49, and owners, lifecycle states, D1, and D2 are unchanged.