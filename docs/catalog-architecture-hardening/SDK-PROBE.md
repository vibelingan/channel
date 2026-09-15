# MIU 16 SDK Probe

Status: MIUs 01-17 released; no active exact reservations; MIUs 18-19 planned; implementation continues; verify final closure publication with live Git refs.

**HISTORICAL MIU 16 snapshot (through Evidence Limits):** full local validation PASS; MIUs 01-16 released; no active exact reservations; MIU 17 planned/inactive; MIU 16 source published and verified.
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
document snapshot `48405b23bcb43d9207e8b2a856768da45704719f` followed, then a historical handoff correction.

## Evidence Limits

Full local validation is PASS and actual local Astro module integration was tested. No browser E2E was
run for this isolated config adapter; the E2E TypeScript check is not browser execution. The focused SSR
harness and successful 15-page production build do not establish default-adapter route/browser or
production-build integration: adapters are not wired into routes yet. MIU 20 registration and MIU 22
composition remain future work; no user-visible route/controller behavior change is delivered here.
Source publication was completed and verified at historical checkpoint `2eef322`; release transition
`801d871` and handoff snapshot `48405b2` preceded a historical handoff correction; these snapshots do not establish final closure publication.
Use live `git rev-parse HEAD` and `origin/refactor/catalog-architecture-hardening` to verify final closure publication before continuing.
HISTORICAL MIU 16 lifecycle: MIUs 01-16 were released; no active exact reservations remained;
MIU 17 was planned/inactive; the task remained in implementation.
No merge into `test` or `main`, CloudBase operation, workflow dispatch, or browser E2E occurred for MIU 16. The denominator
remains 49; D1 and D2 are unchanged.

## MIU 17 Addendum

The preceding MIU-16 record is historical. MIU 17 is RELEASED; full local PASS and supplied publication evidence are recorded in [EXECUTION.md](EXECUTION.md#miu-17-implementation-record), not independently rerun by this doc-writer.
Installed Astro **6.4.6** and Vite **7.3.5** contracts were confirmed by the independent read-only cross-file reviewer:
- `apps/site/node_modules/astro/dist/config/index.d.ts:13`; implementation `apps/site/node_modules/astro/dist/config/index.js:24/36/41` (`getViteConfig`).
- `apps/site/node_modules/vite/dist/node/index.d.ts`: `createServer` 2607, `ssrLoadModule` 2553, `close` 2576;
  options `root` 3217, `configFile` 3431, `middlewareMode` 2392, `watch` 2387, `hmr` 2363, `noDiscovery` 838.
- Actual new harness imports/calls: `apps/site/src/catalog/families/ai-gadgets.test.ts:5,7,19,27,28,36/37`.
The parent fetched official [testing](https://docs.astro.build/en/guides/testing/) and [astro:config](https://docs.astro.build/en/reference/modules/astro-config/) docs through Context7 `/withastro/docs`, using the library ID resolved earlier in the session.
These confirm `getViteConfig` merges the actual Astro configuration. Actual reads supersede the incorrect execution-helper "no API references" summary.
Teardown awaits server closure. Dynamic-module/function type assertions and parsed-frontmatter casts are not runtime schema validation;
the adapter guard checks object shape without executing callbacks. Focused behavior assertions supply separate runtime evidence.
`aiGadgetsAdapter` is a named-exported default instance, not an ESM default export. Bounded reviewer traces cover all new exports and unchanged existing catalog-type consumers;
shared `rootProductFamily` and the `canonicalPublicProduct` family union both use unchanged `PRODUCT_FAMILY_OPTIONS`.
MIUs 18/19 shared content, 20 registry, and 22 controller remain future consumers. No new browser E2E, route integration, merge into `test`/`main`, or deployment is established.
Implementation checkpoint: `d54fc71641022df167f71a70bfcf07887ecacaa6`; the complete site suite passed again after the test-only review correction (258/258), followed by repository-wide Biome.
Final review at `134e62d` found 0 P1/P2/P3 after post-mutation `facts()` coverage and documentation freshness were resolved; focused 7/7 and test types passed.
Historical source checkpoint `134e62d0b6a371e663f8c0ca9ebe5162a065c448` was pushed feature-only and verified; release recorded here.
Push-hook craft/review/doc guards passed. Pre-push scripts were 92/93 solely on `local-only-completion`, not green; post-push canonical architecture reported 0 issues and scripts passed 93/93.
Use live `git rev-parse HEAD` and `origin/refactor/catalog-architecture-hardening` to verify final closure publication before continuing.
The generic pipeline validator's three baseline issues remain non-green; 49 MIUs and D1/D2 are unchanged. MIUs 18-19 remain planned; registry MIU 20 and controller MIU 22 remain future work.

## MIU 18 Addendum

The MIU17 lifecycle above is a historical checkpoint. MIU18 tests use the same real Astro 6.4.6 /
Vite 7.3.5 Markdown loader; the content module and real routes remain unchanged. Official Astro
testing and astro:config documentation was queried through Context7 `/websites/astro_build_en`.
Installed `astro/dist/config/index.d.ts:13` confirms `getViteConfig`; Vite's
`dist/node/index.d.ts:2553/2576/2607` confirms `ssrLoadModule`, `close` and `createServer`.

Vite's installed `ServerOptions` declares experimental `ws?: false` next to `hmr`. Bundle inspection
confirmed it disables WebSocket binding independently of `hmr: false`. The inherited two-harness
test reproduced the collision without Toys: 14 assertions passed but port 24678 logged an error.
Toys uses `ws: false`; separate correction `5e2f5d7` applies it to the two older test harnesses.
All three assert the resolved option and await server closure. Site 266/266 then passed with an
explicit log scan containing no `[ERROR]`, WebSocket server error or port-24678 message. The setting
is experimental and must be rechecked on Vite upgrades; it is test-only, not production server config.

Toys focused tests pass 8/8. Full workspace tests/typechecks, E2E TypeScript, build15 and Biome361
passed; production code was unchanged by the later test-harness fix. Built-HTML checks preserved
both headings/canonicals and the hub's four family links. This is not browser E2E or proof that the
new selector is wired into live routes. No deployment or test/main merge occurred.
Final post-correction workspace run passed 814/814 tests, including site266, with no test-server
error logs. Reviewed source checkpoint `fc01b488ce167a5514ba9c8ee6a7eee344bcab2a` was pushed and
verified with live equality, architecture 0 issues and scripts 93/93. MIU18 is released; MIU19 is
planned. Confirm final closure publication with live local/remote Git equality before continuing.