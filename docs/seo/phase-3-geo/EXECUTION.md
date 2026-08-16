# SEO Phase 3 GEO Execution

Branch: `feat/seo-phase-3-geo`

Base: `origin/main@993c7c33a1cf1446b837d44502bcc57082d993f6`

Planning commits replayed: `a7f0b36`, `9b50751`

## MIU 1: Ajv 2020 validation dependency

Status: complete

### What and why

Added exact root development dependency `ajv@8.20.0` for the later repository-only GEO JSON Schema
2020-12 validator. The implementation changed only `package.json`, `pnpm-lock.yaml`, and
`scripts/runtime-contract.test.mjs`.

### Tests written

Extended the runtime contract test to guard the exact root dependency and `ajv/dist/2020` import while
proving Ajv is absent from production workspace manifests and source imports, the function packaging
template, emitted function package manifests, and emitted bundle bytes. TDD first failed because root
Ajv was missing, then passed after the exact dependency was added.

### Build, deploy, and runtime impact

The root development install and lockfile changed. Production workspaces, site/function source imports,
function packaging, emitted manifests, and bundle bytes remain guarded against shipping Ajv. No
CloudBase, provider, publication, or public-runtime mutation occurred.

### Validation

- `corepack pnpm install --frozen-lockfile`: passed.
- `pnpm test:deploy-smoke`: 23/23 passed.
- `pnpm -r test`: all workspaces passed.
- Workspace and E2E typechecks: 0 errors; 7 existing Astro hints.
- `biome`: 279 files passed.
- `SITE_URL=https://supplychainsai.com PUBLIC_CB_PROXY=0` site build: 10 pages passed.
- All three function builds, packaging checks, and artifact smoke checks passed.
- `git diff --check`: passed.
- Engineering-craft gates: 22 baseline findings, 0 new findings, 0 errors.

The root `package:functions` command's `npx` prompt was declined. Its underlying pinned commands were
run directly and passed.

### Result and engineering rationale

Ajv is explicit root validation tooling instead of an accidental transitive dependency. Boundary tests
cover both declarations and emitted artifacts because checking only the root manifest would not detect
a future production import or packaging leak. Reusing exact version `8.20.0` avoids introducing a
second Ajv version while preserving production isolation.

## Deviations

MIU 1: none.