# XLSX parser: custom reader vs. a maintained library

**Decision: retain the custom reader.** Not because it has fewer dependencies —
that argument was correctly rejected — but because the measurement below shows
the maintained alternative does not reduce risk on this path, and on the one
dimension that matters most for a merchant-supplied file it materially
increases it.

Everything here was measured on 2026-08-27 against `exceljs@4.4.0` and the real
customer workbook. No claim in this document is an estimate.

## The candidates

`xlsx` (SheetJS) is excluded up front, per the review: the npm distribution is
pinned at 0.18.5 with CVE-2023-30533 (prototype pollution) and CVE-2024-22363
(ReDoS), and newer releases are published outside npm.

That leaves `exceljs@4.4.0` versus the reader in
`packages/catalog-import/src/xlsx-zip.ts` and `xlsx-sheet.ts`.

## Measured comparison

| Dimension | Custom reader | exceljs 4.4.0 |
|---|---|---|
| Transitive packages installed | 0 | **76** |
| Last published | n/a (in-repo) | 2024-12-20 (~20 months) |
| Advisories in the installed tree | none | 2 moderate (`exceljs`, `uuid`) |
| **250 MB decompression bomb from a 250 KB file** | **rejected in 3 ms** | **accepted; 788 MB RSS in 2.6 s** |
| Explicit entry-count limit | 512 | none by default |
| Explicit per-entry byte limit | 128 MiB | none by default |
| Explicit total byte limit | 256 MiB | none by default |
| Compression-ratio limit | 200:1 | none by default |
| Row / column ceilings | 200,000 / 2,048 | none by default |
| CRC verification per entry | yes | not surfaced |
| Zip64 | refused | supported |
| Encrypted archive | refused | refused |
| Unknown compression method | refused | refused |
| Entry-name traversal / NUL | refused | n/a (names not used as paths) |
| DTD in a part | refused outright | rejected on entity *use* (safe) |
| External entity (`SYSTEM "file:///…"`) | unreachable — no DTD processing | rejected as undefined entity |
| Attribute prototype pollution | attributes held in a `Map` | not exercised |
| **Real workbook (44 cols × 312 rows)** | reads correctly, 71 MB RSS, 86 ms | reads correctly |
| SKU string fidelity on the real file | preserved | preserved |
| Format coverage | documented subset (below) | substantially broader |
| 1904 date system | refused explicitly | supported |

### The finding that decides it

```
exceljs        ACCEPTED the bomb in 2623ms; rss 788 MB
custom reader  REJECTED after 3ms: ZIP entry xl/worksheets/sheet1.xml declares 262144202 bytes
```

A 250 KB upload turning into 788 MB of resident memory is a denial of service
against an import running in a memory-capped cloud function. exceljs applies no
decompression limits of its own; adding them would mean wrapping or forking it,
at which point the maintenance argument in its favour largely evaporates.

Two corrections to assumptions made before measuring, recorded because they cut
against the conclusion: exceljs's dependency subtree is **76** packages, not the
"~15" claimed in an earlier commit message; and exceljs preserves this file's
SKUs as strings exactly as the custom reader does, so there is **no** SKU
fidelity advantage on this template.

### Where exceljs is genuinely better

Format coverage, and it is not close. It handles Zip64, the 1904 epoch, rich
text, styles, shared formulas, streaming reads and writing. If the requirement
were "read arbitrary spreadsheets users upload", exceljs would be the answer.
The requirement here is narrower: read one known export template from one
authenticated admin path, and fail closed on everything else.

## Complete fail-closed limit table

Every limit is exercised by a test that supplies a file actually violating it
(`packages/catalog-import/src/xlsx-limits.test.ts`, 20 tests). A documented
limit nobody tested is a limit that does not exist.

| Limit | Value | Behaviour when exceeded | Test |
|---|---|---|---|
| ZIP entries | 512 | refuse archive | "too many entries" |
| Per-entry expansion | 128 MiB | refuse on the DECLARED size, before allocating | "per-entry ceiling" |
| Total expansion across all parts read | 256 MiB | refuse archive | accumulated in `ZipArchive` |
| Compression ratio, per entry | 200:1 | refuse archive | "compression-ratio ceiling" |
| Worksheet rows | 200,000 | refuse worksheet | "declares more rows" |
| Worksheet columns | 2,048 | refuse worksheet | "declares more columns" |
| Declared `<dimension>` extent | as above | refuse BEFORE parsing rows | "refused up front" |
| XML nesting depth | 64 | refuse part | "nests deeper" |
| XML text node | 1,000,000 chars | refuse part | "oversized text node" |
| XML attribute value | 8,192 chars | refuse part | "oversized attribute" |
| Shared strings | 1,000,000 | refuse part | ceiling in `parseSharedStrings` |
| DTD / entity declaration | any | refuse part | "DTD is refused outright" |
| Macros (`xl/vbaProject.bin`) | any | refuse workbook | "macro-enabled workbook" |
| External links (`xl/externalLinks/`) | any | refuse workbook | "external link parts" |
| `externalReferences` in workbook.xml | any | refuse workbook | "declares external references" |
| ActiveX / embeddings / customXml | any | refuse workbook | "ActiveX, embedded objects" |
| Encrypted archive | flag bit 0 | refuse archive | flag check in `readZipDirectory` |
| Zip64 | any | refuse archive | locator + sentinel check |
| Compression method other than 0/8 | any | refuse entry | "unsupported compression method" |
| CRC mismatch | any | refuse entry | "fails its CRC check" |
| Entry name absolute, `..`, or NUL | any | refuse archive | `assertSafeEntryName` |
| Unresolvable worksheet relationship | any | refuse, never guess `sheet1.xml` | "does not resolve" |
| Relationship target escaping the package | any | refuse | "not a package part" |
| Missing worksheet part | any | refuse | "is missing" |
| 1904 date system | any | refuse workbook | "uses the 1904 date system" |

Two of these deserve their reasoning stated.

**Unresolvable relationships fail closed rather than defaulting.** Falling back
to the conventional `worksheets/sheet1.xml` when a named relationship does not
resolve would silently import a *different sheet* than the workbook pointed at.

**Macros and external links refuse the whole workbook, not just the part.**
Ignoring them would let the file import as though it were a plain data export
while actually being macro-enabled, or having values that depend on a file the
checksum never covered.

**Resource cleanup.** The reader takes a `Buffer` and returns plain objects. It
opens no file handle, spawns nothing, and registers no listener, so there is
nothing to leak; a test reads the same workbook 25 times and asserts external
memory does not grow.

## Supported subset, and what fails closed

Per the review's decision rule, the custom reader's intentionally supported
subset is documented here and everything outside it is refused rather than
guessed at.

**Container.** ZIP with stored (method 0) or deflate (method 8) entries; a
single-disk archive; CRC-32 verified on every entry read. Refused: Zip64,
encrypted archives, any other compression method, split archives, entry names
that are absolute or contain `..` or a NUL, archives over the entry/byte/ratio
limits, and any archive whose central directory is truncated or malformed.

**Parts read.** `[Content_Types].xml` (presence only), `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, `xl/styles.xml`, and the
first worksheet part. Other parts are ignored.

**Worksheets.** The FIRST worksheet only, resolved through the workbook
relationships. A multi-sheet file does not silently contribute rows nobody
reviewed.

**Cells.** Shared strings (including multi-run and phonetic-annotated),
inline strings, formula cells (the cached `<v>`, never the formula), booleans,
error cells (read as empty), and numbers — carried as their stored LEXEME, so
`0012300` and `1e5` survive. Date detection uses the built-in numeric formats,
including the CJK ranges 27–36 and 50–58, plus custom formats whose code
contains a date or time token.

**XML.** No DTD processing at all: a part that declares one is refused, which is
why entity expansion and external entities are absent rather than mitigated.
Only the five predefined entities and numeric character references are decoded.
Attributes are collected into a `Map`, so a part carrying `__proto__="…"`
cannot reach `Object.prototype`.

**Refused outright, by design:** the 1904 date system (added during this
review — every serial in such a file is 1,462 days off, and a silently
four-year-wrong date is worse than a refused file), Zip64, encrypted archives,
DTDs, and any workbook exceeding the size ceilings.

## Testing

62 tests cover the reader and its fixtures: round-trips through both
compression methods, CRC corruption, unsupported methods, truncation, DTD
refusal, prototype-pollution attributes, entity decoding, lexeme preservation,
date-style detection, sparse rows, multi-sheet selection, CJK text, the 1904
refusal, and the full real-template regression suite.

Beyond the synthetic fixtures the reader was verified against **six real Excel
files**: five unrelated workbooks on this machine (multi-sheet with tables and
no shared-strings part, a 10,013-row CJK workbook, CJK sheet names, embedded
CRLF, float lexemes) and the customer workbook itself. Date handling was
confirmed against known serials — 36526 → 2000-01-01 and 42856 → 2017-05-01.

There is no fuzzing harness. That is the honest gap in this decision, and it is
the thing to add if the input surface ever widens beyond this template.

## When to revisit

Switch to a maintained parser if any of these becomes true:

- the import stops being an authenticated admin path and accepts files from
  untrusted users;
- a template appears that needs Zip64, the 1904 epoch, streaming reads, or
  styles;
- the reader needs changes more than about twice a year;
- a maintained library ships configurable decompression limits, which would
  remove the one measured advantage the custom reader has.
