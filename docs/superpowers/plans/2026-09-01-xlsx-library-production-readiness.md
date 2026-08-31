# XLSX library and production-readiness implementation plan

> **For Codex:** Execute this plan in the isolated
> `codex/xlsx-library-production-readiness` worktree. Do not touch the AI assistant,
> category-expansion, or original Dianxiaomi worktrees.

**Goal:** Replace custom commodity XLSX decoding with a pinned SheetJS adapter without
weakening import fidelity or hostile-file limits, then deliver production CloudBase
topology and deployment gates.

**Architecture:** A Channel-owned ZIP/XML preflight validates every workbook part and
extracts only the narrow metadata that SheetJS cannot preserve (numeric XML lexemes).
SheetJS parses OOXML cells behind a private adapter and emits the existing
`SourceSheet` contract. The production design moves parse/media work into a private
CloudBase Run worker, while this branch changes no live infrastructure.

**Stack:** TypeScript, Node 22, pnpm, SheetJS CE 0.20.3, tsup, Node test runner,
CloudBase Functions/Run/Storage/NoSQL/Hosting, Excalidraw.

---

## Task 1: Lock the behavior with RED tests

**Files:**

- Modify: `packages/catalog-import/src/testing/xlsx-fixture.ts`
- Modify: `packages/catalog-import/src/xlsx-sheet.test.ts`
- Modify: `packages/catalog-import/src/xlsx-limits.test.ts`
- Create: `packages/catalog-import/src/xlsx-sheetjs.test.ts`

1. Add complete `[Content_Types].xml` overrides for worksheets, shared strings, and
   styles so mature parsers consume the generated fixture.
2. Add fixture cell forms for a raw numeric lexeme, boolean, and error.
3. Add an adapter contract test for text whitespace, text-looking identifiers,
   raw numeric lexeme overlay, boolean, error, cached formula, date flag, sparse row,
   and first-sheet selection. Run it and observe a missing-module/function failure.
4. Add preflight tests proving an unreferenced oversized/high-ratio entry, duplicate
   part, case-colliding part, CRC mismatch, and DTD in an unselected worksheet are
   refused. Run and observe the existing reader fail at least the unused-part cases.

Run:

```bash
mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
```

## Task 2: Add the library adapter and shared preflight

**Files:**

- Create: `packages/catalog-import/src/xlsx-contract.ts`
- Create: `packages/catalog-import/src/xlsx-preflight.ts`
- Create: `packages/catalog-import/src/xlsx-sheetjs.ts`
- Modify: `packages/catalog-import/src/xlsx-sheet.ts`
- Modify: `packages/catalog-import/src/xlsx-zip.ts`
- Modify: `packages/catalog-import/src/index.ts`
- Modify: `packages/catalog-import/package.json`
- Modify: `pnpm-lock.yaml`

1. Add exact authoritative dependency
   `xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
2. Move stable `SourceCell`/row/sheet types to `xlsx-contract.ts` and re-export them.
3. Reject duplicate/case-colliding ZIP names and declared aggregate/method/ratio
   violations during central-directory parsing. Add `verifyAllEntries(visitor)` so
   every CRC is checked before SheetJS runs.
4. Extract the current XML scanner and workbook safety/relationship/dimension logic
   into `xlsx-preflight.ts`. Validate all XML/relationship parts, all worksheet shapes,
   and produce selected sheet name, row numbers, and numeric lexemes.
5. Implement `xlsx-sheetjs.ts` with `XLSX.read(..., { dense: true, cellDates: false,
   cellNF: true, cellText: true, bookVBA: true, bookFiles: true, WTF: true })`. Normalize
   cells to the stable contract and overlay raw numeric lexemes by address.
6. Make `xlsx-sheet.ts` a stable facade: content sniff, preflight, then adapter.
7. Run the focused tests and typecheck; refactor only after GREEN.

Run:

```bash
mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import typecheck
```

## Task 3: Prove function packaging

**Files:**

- Modify: `apps/functions/admin/tsup.config.ts`
- Modify: `scripts/smoke-function-artifacts.mjs`
- Modify: `scripts/function-manifest.test.mjs`

1. Add `xlsx` to the admin function's `noExternal` list.
2. Add `xlsx` to the unresolved-import smoke denylist.
3. Add/extend a behavior test that builds/packages the function and cold-starts the
   copied artifact with no installed production dependencies.
4. Run function build, packaging, artifact smoke, and record zipped/unpacked sizes.

Run:

```bash
mise x node@22.13.0 -- pnpm test:deploy-smoke
mise x node@22.13.0 -- pnpm package:functions
mise x node@22.13.0 -- pnpm smoke:functions
```

## Task 4: Real-workbook acceptance

**Files:**

- Modify: `docs/dianxiaomi-excel-import/REAL-WORKBOOK-SUMMARY.json`
- Modify: `docs/dianxiaomi-excel-import/XLSX-TECHNOLOGY-CANDIDATES-2026-09-01.md`
- Create: `docs/dianxiaomi-excel-import/XLSX-TECHNOLOGY-DECISION-2026-09-01.md`

1. Verify the customer workbook SHA-256 before parsing.
2. Parse and import it into a fresh temporary local database/media root.
3. Assert 312 source rows, 77 parent products, 289 variants, and the expected image
   URL/object counts; compare stable normalized output with the baseline.
4. Record exact commands, versions, hashes, counts, discrepancies, and the selected
   adapter rationale. Do not claim CloudBase storage acceptance from local media.

## Task 5: Production infrastructure design

**Files:**

- Create: `docs/dianxiaomi-excel-import/PRODUCTION-INFRASTRUCTURE.md`
- Create: `docs/dianxiaomi-excel-import/diagrams/channel-production-import-topology.excalidraw`
- Modify: `docs/dianxiaomi-excel-import/REMAINING-PRODUCTION-STEPS.md`

1. Document trust zones, static/public/admin routes, private upload and preview flow,
   CloudBase Run worker, NoSQL job/catalog state, private/public media lifecycle,
   observability, secrets, CI/CD, rollback, reconciliation, and cost/environment gates.
2. Generate a compact Excalidraw topology using basic shapes and arrows; every text
   element uses Excalidraw font family 5.
3. Validate JSON, unique element IDs, binding references, and readable labels.
4. List the exact user confirmations and CloudBase identifiers required before any
   future deployment. Do not deploy.

## Task 6: Final verification and delivery

**Files:** all changed files.

1. Run focused tests, full typecheck, lint, CloudBase SDK contract verification,
   function packaging/cold-start smoke, real workbook acceptance, and full tests.
2. Confirm the two known site `localStorage.getItem` failures are unchanged; stop if
   any new failure appears.
3. Review `git diff --check`, exact diff, dependency tree, artifact size, and worktree
   provenance.
4. Request code review, address findings, then commit and push the isolated branch.
5. Open a PR targeting `feat/dianxiaomi-excel-import` and report branch, commit, PR,
   exact verification, and the remaining deployment gates.
