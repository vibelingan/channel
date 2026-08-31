# XLSX technology decision — 2026-09-01

## Decision

Use **SheetJS Community Edition `xlsx@0.20.3`** as the XLSX cell-decoding core,
behind Channel's private `xlsx-sheetjs.ts` adapter.

This is a narrow library decision. It does not transfer input-security policy,
provider mapping, product grouping, staging, media ingestion, or publication policy to
SheetJS.

## Evidence

On Node `22.13.0`, after verifying the customer workbook SHA-256
`57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582`, the adapter
produced 312 source rows, 77 parent products, 289 variants, 452 unique image URLs and
1,549 image references. It quarantined no products. The fresh staged run's normalized,
redacted summary matched the checked-in real-workbook baseline after omitting its
timestamp.

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

`read-excel-file` has a useful `parseNumber` seam, but its Node API is asynchronous and
would force an import-pipeline contract change unrelated to the product requirement. Its
public result is intentionally narrow and does not retain the typed cell distinctions
needed by this adapter, especially where an error, a formula cache result, and an empty
cell must remain distinguishable. The shared preflight would still be required for
macro/external-link and resource policy.

## Why not ExcelJS `4.4.0`

ExcelJS was a valid compatibility reference, but did not show a real-workbook advantage
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
with no category mappings, image fetch, publication, or `--make-public`. It created zero
media objects. CloudBase storage remains a separately authenticated server-side adapter
and needs its own deployment and live-acceptance gates.

## Revisit trigger

Re-evaluate this decision if a supported customer workbook is rejected or normalized
output diverges, if SheetJS's pinned distribution/update policy becomes untenable, or if
the import contract becomes genuinely asynchronous/streaming and measured production
constraints show a material benefit from another adapter.
