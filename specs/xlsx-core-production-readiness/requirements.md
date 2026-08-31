# XLSX core production-readiness requirements

Date: 2026-09-01

## Scope

Replace the commodity XLSX cell-decoding portion of the Dianxiaomi import with a
mature library behind a Channel-owned adapter. Preserve the existing provider and
catalog contracts. Keep hostile-file policy, business validation, grouping, and
publishing in Channel code. Prepare, but do not execute, the production CloudBase
deployment.

## Functional requirements

1. The supplied customer workbook (SHA-256
   `57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582`)
   must still produce 312 data rows, 77 parent products, and 289 variants.
2. Text, leading/trailing whitespace, numeric source lexemes, booleans, errors,
   cached formula values, date-format detection, row numbers, and the first-sheet
   name must remain representable by `SourceSheet` / `SourceCell`.
3. The parser library must remain private to its adapter; no library type may leak
   into provider or catalog code.
4. The generated XLSX fixtures must be standards-compliant OPC packages that a
   mature parser can open.
5. The admin Cloud Function artifact must fully bundle the parser and cold-start
   with an empty production dependency map.

## Security and operational requirements

1. A shared preflight must run before the library sees bytes.
2. Preflight must fail closed on entry count, per-entry and aggregate expansion,
   compression ratio, unsupported compression, encryption, Zip64, duplicate or
   case-colliding part names, traversal, CRC mismatch, DTD, XML depth/text/attribute
   limits, row/column limits, macros, external workbook links, ActiveX, embeddings,
   and custom XML.
3. Every archive entry must be validated, including unreferenced parts, because a
   third-party parser can inspect parts the first-sheet domain adapter does not use.
4. The production design must isolate parsing and media ingestion from public HTTP
   request lifetimes, keep original uploads/private media private, and require an
   authenticated publish path before public delivery.
5. No CloudBase resource, DNS record, certificate, secret, or billable service is
   created in this change.

## Acceptance evidence

- Focused parser and package tests pass on Node 22.
- Adversarial ZIP/XML tests pass.
- Real workbook counts and normalized output are recorded.
- Typecheck, lint, function build/package, unresolved-import check, and dependency-
  empty cold-start smoke pass.
- Full-repository tests introduce no failure beyond the two captured baseline site
  tests involving `localStorage.getItem`.
- Production topology is documented in Markdown and a valid Excalidraw source.
