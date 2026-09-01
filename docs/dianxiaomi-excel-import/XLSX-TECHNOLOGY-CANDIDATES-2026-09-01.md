# XLSX core technology candidates — production-readiness research

**Research snapshot:** 2026-09-01
**Status:** SheetJS is the implemented branch choice, based on the controlled local
spike below. Existing Cloud Function artifacts cold-started in a dependency-empty
Node 20.19 environment, but their current entry graphs do not reach the XLSX parser;
that result is not SheetJS packaging evidence. This is not production approval: the
private import worker and its positive parse smoke do not exist yet, and no deployment
was authorized.
**Scope:** the XLSX core behind one shared security boundary and one provider-neutral
adapter. This document does not compare a naked third-party parser with the hardened
current reader.

## Executive finding

The controlled spike compared all four candidates. Its result supports implementing
SheetJS for this branch; it does not replace the separate production-approval gates.

- **SheetJS Community Edition `xlsx@0.20.3`** is a real candidate, not the obsolete
  npm-registry `xlsx@0.18.5`. It has the broadest format model of the small-dependency
  candidates and no runtime dependencies, but its normal cell model converts numeric
  XML values to JavaScript numbers, its stable package is distributed from the SheetJS
  CDN rather than the public npm registry, and its Node ESM path has explicit setup
  caveats.
- **`read-excel-file@9.3.10`** is the smallest currently published npm candidate and
  uniquely exposes a supported `parseNumber(string)` seam that can retain non-date
  numeric lexemes. It is deliberately a data reader rather than a workbook model:
  formula source is not exposed, formula errors can become empty cells, and its public
  result cannot be used to enforce macro/external-link policy.
- **ExcelJS `4.4.0`** has the richest workbook API here and a streaming reader, but its
  stable release is older, the package and dependency surface are materially larger,
  numeric lexemes are converted with `parseFloat`, and streaming does not itself impose
  the resource ceilings required by this import path.
- **The current custom reader** is the safety and fidelity control. It preserves numeric
  lexemes and has explicit fail-closed limits, but it implements only a documented XLSX
  subset, refuses the 1904 epoch, has no fuzzing harness, and leaves Channel responsible
  for long-term OOXML compatibility.

The spike must compare these deployable systems:

```text
upload byte limit
  -> identical ZIP/OPC preflight and forbidden-part policy
  -> isolated worker (deadline + memory + output caps)
  -> candidate parser adapter
  -> identical SourceSheet / SourceCell contract
  -> existing Dianxiaomi domain adapter
```

The previous ExcelJS decompression-bomb measurement remains useful evidence that a
parser must not be the safety boundary. It is not a fair reason to reject ExcelJS once
all candidates receive the same preflight and process isolation.

## Sources and verification method

Claims below use first-party documentation, package metadata, tagged source, or this
repository's code and tests:

- [SheetJS official Node installation and release-source guidance](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
- [SheetJS official `0.20.3` package metadata](https://cdn.sheetjs.com/xlsx-0.20.3/package/package.json)
- [SheetJS cell model](https://docs.sheetjs.com/docs/csf/cell/),
  [parse options](https://docs.sheetjs.com/docs/api/parse-options/),
  [formulae](https://docs.sheetjs.com/docs/csf/features/formulae/),
  [dates](https://docs.sheetjs.com/docs/csf/features/dates/), and
  [VBA/macro detection](https://docs.sheetjs.com/docs/csf/features/vba/)
- [`read-excel-file` first-party repository and README](https://github.com/catamphetamine/read-excel-file),
  [`9.3.10` npm metadata](https://registry.npmjs.org/read-excel-file/latest), and
  commit-pinned source for
  [`parseCell`](https://github.com/catamphetamine/read-excel-file/blob/20720d515dc4b3255b21d65e7ad267e77aecfa85/source/xlsx/parseCell.js),
  [ZIP entry filtering](https://github.com/catamphetamine/read-excel-file/blob/20720d515dc4b3255b21d65e7ad267e77aecfa85/source/export/filterZipArchiveEntry.js), and
  [Node unzip collection](https://github.com/catamphetamine/read-excel-file/blob/20720d515dc4b3255b21d65e7ad267e77aecfa85/source/zip/unzipFromStream.js)
- [ExcelJS repository](https://github.com/exceljs/exceljs),
  [stable `4.4.0` release](https://github.com/exceljs/exceljs/releases/tag/v4.4.0),
  [`4.4.0` npm metadata](https://registry.npmjs.org/exceljs/latest),
  [streaming workbook reader source](https://github.com/exceljs/exceljs/blob/v4.4.0/lib/stream/xlsx/workbook-reader.js),
  [streaming cell conversion](https://github.com/exceljs/exceljs/blob/v4.4.0/lib/stream/xlsx/worksheet-reader.js), and
  [non-streaming cell conversion](https://github.com/exceljs/exceljs/blob/v4.4.0/lib/xlsx/xform/sheet/cell-xform.js)
- Channel's current reader:
  [`xlsx-zip.ts`](../../packages/catalog-import/src/xlsx-zip.ts),
  [`xlsx-sheet.ts`](../../packages/catalog-import/src/xlsx-sheet.ts),
  [`xlsx-limits.test.ts`](../../packages/catalog-import/src/xlsx-limits.test.ts), and
  [`xlsx-sheet.test.ts`](../../packages/catalog-import/src/xlsx-sheet.test.ts)

Package tarballs were downloaded to temporary directories without adding dependencies.
The sizes and SHA-256 values in this document were measured from those exact URLs.
Channel's current catalog-import package tests were also run without source changes:
227/227 passed, plus typecheck. The active shell was Node `25.6.1`, **not Node 22**;
therefore Node 22 compatibility remains an explicit spike gate rather than a completed
claim.

## Fair comparison boundary

### Shared safety layer — mandatory for every candidate

No candidate's public API documents all of Channel's required guarantees. The shared
preflight/worker system must own:

- upload byte ceiling;
- ZIP entry count, per-entry expanded bytes, total expanded bytes, and compression
  ratio;
- entry-name/path, encryption, compression-method, Zip64 and CRC policy;
- whole-workbook rejection for VBA, macrosheets, external workbook references,
  ActiveX, embedded objects and custom XML;
- DTD rejection and XML/row/column/text/depth ceilings;
- worker wall-clock deadline, process memory ceiling, kill path and IPC result-size
  ceiling;
- an allowlist for the exact OOXML parts the adapter may consume.

The safety implementation itself still needs a technology decision and adversarial
tests. Replacing the worksheet parser while silently retaining a large custom ZIP/XML
security implementation would not satisfy the build-vs-buy objective.

### Shared parser interface

No library-specific type should escape its adapter:

```ts
interface SourceCell {
  text: string;
  kind: 'text' | 'number' | 'boolean' | 'error';
  dateFormatted: boolean;
  formula?: string;
}

interface SourceRow {
  rowNumber: number;
  cells: Array<SourceCell | undefined>;
}

interface SourceSheet {
  name: string;
  rows: SourceRow[];
}
```

The spike must decide whether `formula` is required or intentionally omitted. The
current domain path consumes cached values, not formula source, so adding it is not a
reason to distort the first migration.

## Capability comparison

| Capability | SheetJS CE `xlsx@0.20.3` | `read-excel-file@9.3.10` | ExcelJS `4.4.0` | Current custom reader |
|---|---|---|---|---|
| Text and shared strings | Resolves shared strings into text; rich-text fields are available in the cell model | Resolves shared strings and concatenates rich-text runs | Document and streaming readers support shared strings; streaming allows `cache`, `emit`, or `ignore` | Resolves shared, inline and multi-run strings; intentionally drops phonetic annotations |
| Original numeric XML lexeme | **No public cell field.** `cell.v` is a JS number; `cell.w` is formatted display text, not the stored lexeme | **Yes for non-date numeric cells** with `parseNumber: value => value`; date-formatted cells are converted before that callback and need separate treatment | **No.** Tagged source uses `parseFloat` in document and streaming paths | **Yes.** Carries numeric `<v>` as a string |
| Dates | Supports 1900/1904, numeric date cells, ISO date cells, `cellDates`, number formats and `WBProps.date1904` | Detects standard formats, supports an explicit custom `dateFormat`, and source handles `epoch1904`; returns `Date` | Supports styles, `Date` values and `date1904`; streaming must use `styles: 'cache'` for style-based date conversion | Preserves serial lexeme plus `dateFormatted`; deliberately refuses 1904 workbooks |
| Formula source | `cell.f` when `cellFormula` is enabled (default true for XLSX) | Not exposed | Exposes `formula` / `sharedFormula` | Ignores `<f>` |
| Cached formula result | `cell.v`; CE does not calculate formulae | Returns only the cached value; absent/error results can become empty | Exposes `{ formula, result }`; streaming also parses a cached result | Reads cached `<v>` as the cell value; does not calculate |
| Macro discovery | `bookVBA: true` exposes `vbaraw`; macrosheets are flagged | Node entry filters to `.xml` / `.xml.rels`, so `vbaProject.bin` is discarded and cannot drive rejection | No documented whole-workbook macro refusal surface for this use case | Rejects `vbaProject.bin` case-insensitively before sheet parsing |
| External references | Exposes cell hyperlinks; `bookFiles` can expose ZIP part names. Cell hyperlinks are not the same as external-workbook dependencies, so preflight remains required | Does not expose a policy surface for external workbook dependencies | Can expose cell hyperlinks, but not a complete import security policy for external workbook parts | Rejects external-link parts and `<externalReferences>` |
| Streaming read | Main XLSX parse is an in-memory workbook parse; `sheetRows` limits rows but is not a decompression cap | Accepts a Node stream, but source collects selected decompressed XML entries before returning sheet data | Yes, row-oriented `WorkbookReader`; shared strings/styles can still be cached and worksheets may be temporarily buffered | Buffer-in / objects-out; not streaming |
| Library-provided ZIP bomb guarantee | No documented expanded-byte, entry-count, ratio or total-output ceiling in parse options | No documented ceilings; source accumulates selected XML contents, so stream input is not a memory cap | No documented ceilings in the streaming options; tagged reader creates `unzipper.Parse({forceStream:true})` without Channel's caps | Explicit 512-entry / 128 MiB-entry / 256 MiB-total / 200:1 limits plus CRC checks |
| XML/row/column limits | `sheetRows` limits returned rows; no complete Channel policy | No complete Channel policy documented | `ignoreNodes` can skip features, but no complete Channel policy | 200k rows, 2,048 columns, depth/text/attribute/shared-string ceilings and DTD refusal |

### Important semantic distinctions

1. **“Raw value” is not “raw lexeme.”** SheetJS calls `v` the underlying value,
   but for a numeric cell that value is a JavaScript number. `1e5`, `100000`, and
   `100000.0` can therefore become indistinguishable. Its `w` field is formatted display
   text and cannot substitute for the source XML lexeme.
2. **Formula support is not calculation.** SheetJS and ExcelJS can retain the formula
   and cached result; neither should be treated as a calculation engine here.
   `read-excel-file` intentionally exposes the cached value only.
3. **External hyperlinks are not external workbook dependencies.** A URL attached to a
   cell and an `xl/externalLinks/*` dependency have different policy implications. The
   shared preflight must inspect package parts and relationships regardless of what the
   parser returns.
4. **A stream is not a resource limit.** Streaming can lower peak retention for rows,
   but without expanded-byte, ratio, deadline and process-memory ceilings it does not
   close the decompression-bomb boundary.

## Candidate details

### A. SheetJS CE `xlsx@0.20.3`

**Current distribution and maintenance evidence**

- Official docs identify `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
  as the current Node package, state that public npm's `0.18.5` is stale, and call the
  SheetJS CDN authoritative.
- The same docs strongly recommend vendoring and advise watching the authoritative repo
  or RSS feed for releases. This means Channel must own update monitoring and checksum
  rotation; npm-only Dependabot/audit workflows are insufficient.
- The official repository shows code activity after `0.20.3`, while the stable download
  remains `0.20.3`. The spike must distinguish unreleased `main` behavior from the exact
  vendored tarball and must not cite `main` fixes as present in `0.20.3`.
- Package metadata: Apache-2.0, zero runtime dependencies, CommonJS and ESM exports.
- Measured official tarball: 2,409,319 bytes compressed, 8,076,339 file bytes unpacked,
  SHA-256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`.

**Runtime fit hypothesis**

- The package exports both `xlsx.js` and `xlsx.mjs`. Official Node docs recommend CJS
  because the ESM build requires explicit injection for optional filesystem, stream and
  legacy-codepage features. Buffer-based `XLSX.read` may not need those features, but
  that must be proven in the adapter bundle.
- Channel source is ESM while the planned CloudBase Run worker will target Node 20.
  This candidate therefore needs native ESM parsing in exact Node 22 now and a positive
  dependency-empty worker parse smoke once that worker entry point exists.

**Spike hypothesis**

SheetJS is likely to provide the best general XLSX compatibility per runtime dependency,
but the adapter must prove that Dianxiaomi identifiers never depend on a numeric XML
lexeme. If they do, SheetJS needs a narrowly scoped lexeme sidecar or fails the fidelity
gate; `cell.w` is not an acceptable workaround.

### B. `read-excel-file@9.3.10`

**Current distribution and maintenance evidence**

- npm `latest` is `9.3.10`, published 2026-08-10. The package declares Node `>=18`,
  `type: module`, and explicit import/require exports for `/node`, `/browser`,
  `/universal`, and `/web-worker`.
- MIT licensed; four direct runtime dependencies: `saxen`, `fflate`, `worker-f`, and
  `unzipper-esm`.
- npm tarball metadata reports 2,474,410 bytes unpacked. Measured tarball size is
  464,676 bytes; SHA-256
  `785f5667126995df05ecd4fb0b4e69beef0b3ee7423ea25b76bc57397ce0f111`.
- The first-party repository was active immediately before the npm release. It does not
  publish formula/workbook features it does not support; that narrowness is useful if the
  output matches Channel's contract.

**Runtime and fidelity hypothesis**

- `parseNumber: value => value` is the cleanest documented seam in the candidate set for
  retaining non-date numeric strings. The spike must verify dates separately because
  date-formatted numeric cells are converted to `Date` before the number callback.
- Node streams are accepted, but the first-party source states that the Node unzip stage
  ultimately produces a map of decompressed entries for the XML parser. Its entry filter
  keeps only `.xml` and `.xml.rels`; this avoids images but does not cap a hostile sheet
  XML part.
- The public API's deliberate simplicity also means it cannot be the macro/external-link
  gate. `vbaProject.bin` is filtered out, not reported.

**Spike hypothesis**

This may be the smallest sufficient core for Dianxiaomi if the shared preflight handles
container policy and Channel does not require formula source. Its silent empty-cell
behavior for absent/error cached formula results needs an explicit fail-closed adapter
test.

### C. ExcelJS `4.4.0`

**Current distribution and maintenance evidence**

- npm `latest` and the latest GitHub release are `4.4.0`, published 2023-10-19.
- MIT licensed; nine direct runtime dependencies. npm metadata reports 21,825,509 bytes
  unpacked. Measured tarball size is 4,716,975 bytes; SHA-256
  `8adac13d192ce80e11304732d3ab96708b2c64bb54771b5da4f946e5eea55a18`.
- The package exposes a CommonJS main entry and no package `exports` map. Channel's
  TypeScript configuration enables CJS interop, but exact ESM import/typecheck and tsup
  behavior still require tests.
- The stable streaming reader supports per-feature handling for worksheets, shared
  strings, hyperlinks, styles and entry events. These are feature controls, not resource
  ceilings.

**Known test-sensitive limitations**

- Tagged document and streaming source converts numeric cells with `parseFloat`, so
  source lexemes are not retained.
- The streaming reader defaults to `styles: 'ignore'`; Channel must explicitly cache
  styles before expecting date conversion.
- A first-party open issue reports that `4.4.0` streaming mode mishandles cached formula
  results whose type is an Excel error. This exact case belongs in the spike rather than
  being generalized to all formula support:
  [issue #3074](https://github.com/exceljs/exceljs/issues/3074).
- The streaming implementation calls `unzipper.Parse({forceStream: true})` without the
  entry/expanded-byte/ratio limits required here. The previous Channel bomb measurement
  therefore validates the need for the shared preflight; it does not compare the final
  hardened systems.

**Spike hypothesis**

ExcelJS is the broad-coverage and streaming reference. It must earn its larger deployment
surface by demonstrating a compatibility or memory advantage on real and edge-case files
that the smaller candidates cannot provide.

### D. Current custom reader

**Observed repository scope**

- 267 lines of ZIP code plus 707 lines of worksheet/XML code; no parser runtime
  dependency.
- Reads the first worksheet through workbook relationships; supports stored/deflated
  ZIP entries, shared/inline/formula-result strings, numbers, booleans, errors, CJK text
  and common date styles.
- Preserves every numeric source lexeme and marks date formatting without eagerly
  converting the serial.
- Rejects macros, external links, ActiveX, embeddings, custom XML, DTDs, 1904 date
  workbooks, unsupported compression and declared resource excess.
- The two focused parser test files contain 40 tests; the whole catalog-import package
  currently passes 227 tests. The earlier review truthfully records that there is no
  fuzzing harness.

**Maintenance hypothesis**

The custom reader is not automatically the safest production choice merely because its
current attack tests pass. The strongest objection is unmeasured compatibility drift:
valid OOXML variations outside six observed workbooks can be silently misread or refused,
and Channel owns discovery and repair. Keep it as the behavioral/safety control until a
third-party system has produced equivalent output and passed the attack corpus.

## Node, ESM and CloudBase deployment gate

The repository currently has three different facts that must not be collapsed into a
single “Node compatible” statement:

1. Root [`package.json`](../../package.json) requires Node `>=22.12.0`.
2. Existing Cloud Functions target Node 20 and emit CJS, but the admin entry graph does
   not expose or import `catalog-import-service.ts`.
3. [`package-functions.mjs`](../../scripts/package-functions.mjs) writes those existing
   function artifacts with an empty dependency map and copies only `index.js`.

Therefore the current admin artifact cannot prove parser packaging: absence of a residual
`require('xlsx')` is vacuous when the entry graph contains no XLSX code. The production
topology deliberately places parsing in a future private CloudBase Run worker. That
worker must bundle or install the exact pinned parser and prove the positive behavior by
parsing a canonical workbook in a dependency-empty image/runtime smoke. The existing
unresolved-import denylist remains a tripwire, not proof of parser presence.

Required compatibility evidence for each candidate:

- exact Node `22.x` ESM import, parse and adapter tests;
- repository typecheck with `moduleResolution: bundler` and `verbatimModuleSyntax`;
- future worker build targeting Node 20 contains the selected adapter;
- worker artifact/image has no unresolved parser dependency;
- dependency-empty worker cold start succeeds and positively parses a canonical fixture;
- resulting worker image/artifact fits the selected CloudBase Run limits with margin;
- actual private CloudBase Run smoke parses the same fixture after deployment.

The earlier Node `25.6.1` research result did not satisfy the Node 22 gate. The branch
adapter has since passed real-workbook local acceptance under Node `22.13.0`. Existing,
parser-free Cloud Function artifacts also cold-started under exact Node `20.19.0`, but
that is separate evidence. Worker packaging and actual CloudBase smoke remain pending.

## Controlled spike matrix

All four adapters must run the exact same corpus and emit the same normalized result or
an intentional, classified refusal.

### Fidelity corpus

- customer workbook SHA-256
  `57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582`:
  312 source rows, 77 parent products, 289 variants;
- the five previously collected independent real workbooks;
- text SKU `0012300`, text SKU `1e5`, numeric `1e5`, numeric `100000.0`, 20+ digit
  identifiers and two-decimal/sub-cent prices;
- shared, inline, rich and phonetic strings; CJK names and whitespace;
- 1900 and 1904 date systems, built-in/custom CJK formats and ISO `d` cells;
- formula string/numeric/boolean/error cached results, formula without cached result,
  shared formula and array formula;
- sparse rows, empty styled cells, multiple sheets and relationship reordering.

### Safety corpus — preflight/worker result must be candidate-independent

- declared and actual oversized entries, aggregate expansion and high ratios;
- unknown-size data descriptors, Zip64, encryption, unsupported compression, CRC
  mismatch, truncation, duplicate/case-variant/path-traversal names;
- macro, macrosheet, external workbook link, external cell hyperlink, ActiveX,
  embedding and custom XML as separate cases;
- DTD/entity declaration, oversized XML text/attribute/depth;
- row, column, shared-string and worker-output limits;
- deadline kill and memory-limit kill with cleanup verification.

### Measurements

- normalized-output diff and exact finding codes;
- peak RSS, heap, wall time and CPU time for preflight and parser separately;
- cold-start time;
- bundled/uncompressed and zipped CloudBase artifact size;
- resolved production dependency count, licenses and current advisories from the actual
  lockfile—not package-level estimates;
- repeatability across three runs.

## Production-approval gate after branch selection

The local comparison is sufficient to choose the branch implementation, but it is not a
complete production approval. Before a deployed third-party core is approved, it must:

1. produces the same accepted real-workbook counts and all required source identifiers;
2. preserves required lexemes or proves from the real/domain contract that those lexemes
   are never needed;
3. cannot bypass the shared forbidden-part and resource policy;
4. passes exact Node 22 plus the future Node 20 worker build, positive parse, artifact,
   and CloudBase smoke gates;
5. has an explicit version/checksum/update-monitoring policy; and
6. reduces owned OOXML code without moving equivalent undocumented complexity into its
   adapter.

If more than one mature candidate passes these production gates, prefer the smallest deep
interface and lowest ongoing operational burden. If none passes, retaining custom code is
permitted only with the acknowledged compatibility budget, a fuzzing plan and a scheduled
reassessment.

## Pre-spike hypotheses (historical)

1. **SheetJS hypothesis:** best compatibility-to-dependency ratio; likely blocked only if
   raw numeric lexemes cannot be preserved or the future worker artifact is too large.
2. **`read-excel-file` hypothesis:** best narrow-reader fit and cleanest numeric-lexeme
   seam; likely blocked if formula/error semantics or date-source fidelity cannot be made
   fail-closed.
3. **ExcelJS hypothesis:** best streaming/broad-workbook reference; likely blocked if its
   package/dependency/artifact cost brings no measured benefit on the Channel corpus.
4. **Custom hypothesis:** best current safety/fidelity control; likely blocked as the
   long-term default if valid-workbook compatibility or maintenance evidence shows the
   project is reimplementing a growing share of OOXML.

The branch implementation now follows the recorded local choice. It remains ineligible
for production approval until every gate above is independently satisfied.

## Controlled-spike outcome and selection — 2026-09-01

**Branch implementation choice: SheetJS CE `xlsx@0.20.3`, behind the private Channel
adapter. This is not complete production approval.**

The controlled spike was executed under Node `22.13.0` against the customer workbook
only after its SHA-256 was verified as
`57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582`.
The SheetJS-backed branch reader produced the expected 312 source rows, 77 parent
products, 289 variants, 452 unique source image URLs and 1,549 image references, with
zero quarantined products. A fresh local stage then persisted 77 import items and 289
variants; its normalized, redacted summary matched
[`REAL-WORKBOOK-SUMMARY.json`](./REAL-WORKBOOK-SUMMARY.json) after excluding the
run timestamp.

The comparative local spike also recorded the following normalized-grid result on this
customer workbook (313 rows by 44 columns):

| Reader | Result | Decision-relevant limitation |
| --- | --- | --- |
| Current parser | Baseline grid | Retained as the comparison baseline. |
| SheetJS CE `0.20.3` | Exact match; 0 cell mismatches | Numeric lexemes need the preflight sidecar. |
| `read-excel-file@9.3.10` | Exact match; 0 cell mismatches with `trim: false` and its raw-number `parseNumber` seam | Async Node API and different sheet-name API; weaker typed-cell contract. |
| ExcelJS `4.4.0` | Exact match; 0 cell mismatches | Larger package and transitive-dependency surface. |

This result selects SheetJS for the commodity cell-decoding layer in this branch, not as
a replacement for Channel's trust boundary or as production approval. The all-entry
ZIP/OPC and XML preflight still runs before SheetJS, including forbidden-part and
resource-limit checks; the preflight numeric lexeme sidecar overlays SheetJS numeric
values where the source contract needs the original lexeme. Single-run timing and RSS
observations are directional only, not acceptance evidence.

`read-excel-file` did not win because its asynchronous Node API would change the
existing synchronous parser contract and its public output loses typed-cell detail that
the adapter needs to distinguish text, number, boolean and error cells. ExcelJS did not
win because it delivered no demonstrated real-workbook advantage sufficient to justify
its larger package and transitive-dependency surface. SheetJS preserves the required
synchronous call shape, exposes the typed/error/formula/date cell information needed by
the private adapter, and has no runtime dependencies.

The parser-only acceptance deliberately supplied neither `--fetch-images` nor category
mapping nor publication flags. The configured fresh `LOCAL_MEDIA_DIR` path remained
absent, therefore it held **0 media objects**; an existing empty directory was not
inspected. The publish plan's 452 “would need migrating” entries are source URLs, not
downloaded media. This is local file-backed staging evidence only; it does not establish
CloudBase media-storage or deployment acceptance. Earlier evidence of 447
content-deduplicated media objects, if consulted, is a **prior-run result** and was not
re-downloaded here.

See [`XLSX-TECHNOLOGY-DECISION-2026-09-01.md`](./XLSX-TECHNOLOGY-DECISION-2026-09-01.md)
for the decision record and
[`REAL-WORKBOOK-ACCEPTANCE-2026-09-01.md`](./REAL-WORKBOOK-ACCEPTANCE-2026-09-01.md)
for durable reproducible acceptance evidence.
