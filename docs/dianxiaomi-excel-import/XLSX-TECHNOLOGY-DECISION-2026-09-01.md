# XLSX technology decision — 2026-09-01

## Decision

Use **SheetJS Community Edition `xlsx@0.20.3`** as the XLSX cell-decoding core in this
branch, behind Channel's private `xlsx-sheetjs.ts` adapter. This is an implementation
choice, not complete production approval.

This is a narrow library decision. It does not transfer input-security policy, provider
mapping, product grouping, staging, media ingestion, or publication policy to SheetJS.
Exact Node 20 runtime execution, the fully bundled artifact gate, and an actual
CloudBase smoke are pending; no deployment was authorized for this work.

## Evidence

On Node `22.13.0`, after verifying the customer workbook SHA-256
`57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582`, the adapter
produced 312 source rows, 77 parent products, 289 variants, 452 unique image URLs and
1,549 image references. It quarantined no products. The fresh staged run's normalized,
redacted summary matched the checked-in real-workbook baseline after omitting its
timestamp.

The local comparative spike was exact on the same 313-row by 44-column normalized grid:
the current parser was the baseline; SheetJS `0.20.3` and ExcelJS `4.4.0` each had zero
cell mismatches; and `read-excel-file@9.3.10` also had zero with `trim: false` and its
raw-number `parseNumber` seam. This is compatibility evidence from one customer
workbook, not a broad format-coverage or production-readiness claim. Any single-run
timing or RSS measurement is directional only and is not an acceptance gate.

## Why SheetJS

SheetJS keeps the current synchronous in-process contract, so the existing domain reader
and import pipeline do not need an unrelated asynchronous rewrite. Its cell model gives
the adapter the typed information it needs for text, numbers, booleans, errors, dates
and cached formulas. Channel preserves raw numeric XML lexemes independently in the
preflight sidecar, because a JavaScript numeric value alone cannot retain that source
representation.

The package has no runtime dependencies and is fully isolated from the public import
contract. This makes the adapter boundary small and keeps future replacement possible.

## Why not `read-excel-file@9.3.10`

`read-excel-file` achieved the same grid only with `trim: false` and its raw-number
`parseNumber` seam. Its Node API is asynchronous and its sheet-name API differs, which
would force an unrelated import-pipeline contract change. Its public result is
intentionally narrow and does not retain the typed cell distinctions needed by this
adapter, especially where an error, a formula cache result, and an empty cell must remain
distinguishable. The shared preflight would still be required for macro/external-link and
resource policy.

## Why not ExcelJS `4.4.0`

ExcelJS also exactly matched the customer-workbook grid, but did not show an advantage
that justified its substantially larger package and transitive-dependency surface. Its
streaming API is not itself a ZIP/XML resource policy, and it does not preserve original
numeric lexemes. Adding it would increase deployment and update burden without improving
the accepted customer-workbook result.

## Security and media boundary

The SheetJS adapter receives bytes only after Channel's all-entry ZIP/OPC and XML
preflight has enforced path, duplicate-name, expansion, CRC, forbidden-part and XML
limits. SheetJS is therefore not the security boundary.

This decision also does not constitute a CloudBase acceptance. The recorded real-workbook
run staged catalog data against a temporary local JSON database and local media root,
with no category mappings, image fetch, publication, or `--make-public`. The configured
fresh media path remained absent, so it held zero media objects; an existing empty
directory was not inspected. CloudBase storage remains a separately authenticated
server-side adapter and needs its own deployment and live-acceptance gates.

## Revisit trigger

Re-evaluate this decision if a supported customer workbook is rejected or normalized
output diverges, if SheetJS's pinned distribution/update policy becomes untenable, or if
the import contract becomes genuinely asynchronous/streaming and measured production
constraints show a material benefit from another adapter.
