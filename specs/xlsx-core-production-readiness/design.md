# XLSX core production-readiness design

Date: 2026-09-01

## Technology decision

Use SheetJS Community Edition `xlsx@0.20.3` from its authoritative distribution,
pinned by URL and lockfile integrity, behind `xlsx-sheetjs.ts`.

The decision is based on the complete deployable system, not a naked parser:

- On the customer workbook, SheetJS, ExcelJS, and the current parser produced the
  same 313-row by 44-column normalized grid.
- `read-excel-file@9.3.10` can preserve numeric lexemes with `parseNumber`, but its
  Node API is asynchronous, loses some cell-kind detail, and would force an unrelated
  synchronous import-pipeline rewrite.
- ExcelJS matched the workbook but has the largest package and dependency surface and
  current unresolved transitive security/deprecation reports.
- SheetJS keeps the existing synchronous contract, exposes typed/error/formula/date
  cell information, has no runtime dependencies, and fully bundles into the function.
- SheetJS normalizes numeric values to JavaScript numbers, so the Channel preflight
  extracts numeric `<v>` lexemes for the selected sheet and the adapter overlays them.

The package is not a security boundary. `xlsx-zip.ts` and the XML preflight remain
Channel-owned. The old general-purpose shared-string/style/cell decoding code is
removed once the adapter has equivalent tests.

## Module boundaries

```text
Buffer
  -> xlsx-zip.ts (container limits, names, CRC, all-entry verification)
  -> xlsx-preflight.ts (forbidden parts, XML limits, sheet/relationship/shape,
                        selected-sheet numeric lexeme sidecar)
  -> xlsx-sheetjs.ts (SheetJS parse and SourceCell normalization)
  -> xlsx-sheet.ts (stable public facade and SourceSheet types)
  -> providers/dianxiaomi/workbook.ts (headers and domain values)
  -> grouping / diff / publish
```

Only `xlsx-sheetjs.ts` imports `xlsx`. The admin function build lists `xlsx` in
`noExternal`, while the artifact smoke refuses a residual `require("xlsx")`.

## Production runtime boundary

The production target moves heavy import work to a private CloudBase Run worker.
The admin function validates authorization and upload claims, then creates a job.
The worker owns preflight, parsing, media fetch, staged writes, retry/lease, and
reconciliation. Operators review staged results before publish. Public media routes
serve only publish/ref-count-eligible objects; authenticated previews return bytes
that the browser renders through object URLs.

## Explicit non-goals

- No spreadsheet editing or export API.
- No formula calculation.
- No support for macro-enabled or externally linked workbooks.
- No production deployment or CloudBase resource mutation in this branch.
- No change to category mapping, parent/variant grouping, or image policy semantics.
