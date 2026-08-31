# Task 2 Report — SheetJS adapter and shared XLSX preflight

## Status

Implemented Task 2 in this isolated worktree only.
The stable `SourceSheet` contract is unchanged, SheetJS CE 0.20.3 is the sole
workbook decoder, and the security/fidelity preflight runs before SheetJS.

## Baseline RED evidence

Command:

```bash
mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
```

Observed before production changes: 235 tests, 228 passed, 7 failed. The six
archive-wide failures were unreferenced oversized part, unreferenced high-ratio
part, duplicate OPC name, case-colliding OPC name, unreferenced CRC mismatch,
and DTD in an unselected worksheet. The seventh failure was the deliberately
missing `xlsx-sheetjs.ts` module.

## MIU 2A — Archive-wide trust boundary

### Runtime problem

The previous ZIP reader validated only entries requested by the commodity XML
decoder. An ignored part could therefore exceed declared limits, fail CRC, or
carry hostile XML without being observed.

### Data shape and constraints

The input is one customer-supplied in-memory `Buffer`. Central-directory names
are package-scoped OPC part names. Declared per-entry, aggregate, compression
method, and compression-ratio limits are checked before inflation. Each entry
is then inflated separately and checked against its declared length and CRC.

### Design

`readZipDirectory` now rejects duplicate names, case-fold collisions,
unsupported methods, oversized entries, aggregate expansion over the total
ceiling, and excessive ratios. `ZipArchive.verifyAllEntries(visitor)` performs
the mandatory all-entry CRC pass and lets preflight inspect every XML part.
Local and central entry names, methods, and sizes must agree.

### Alternatives rejected

- Trust SheetJS to ignore unneeded parts: rejected because ignored parts would
  bypass the package's resource and XML safety policy.
- Retain cumulative read accounting: rejected because the declared aggregate
  is now checked once in the directory and preflight legitimately rereads a
  few already-verified workbook parts.

### Risk and test

The focused archive/preflight suite went from six expected failures to all
passing. The package suite also covers stored/deflated entries, corrupt CRC,
unsupported methods, truncation, macros, external links, relationship errors,
worksheet limits, and memory behavior.

## MIU 2B — Shared OOXML preflight and SheetJS normalization

### Runtime problem

SheetJS correctly handles the broad XLSX format but normalizes numeric XML to
JavaScript numbers. Channel requires the original numeric lexeme for prices,
stock, IDs, and date serials, while still needing all workbook parts validated
before the library parser runs.

### Data shape and constraints

`xlsx-contract.ts` owns the parser-independent `SourceCell`, `SourceRow`, and
`SourceSheet` types. `xlsx-preflight.ts` returns only the selected sheet name,
its 1-based row numbers, and raw numeric lexemes keyed by cell address. No
SheetJS type crosses the adapter boundary.

### Design

Preflight performs the all-entry CRC pass, scans every `.xml` and `.rels` part
with the DTD/depth/text/attribute guards, rejects refused workbook parts and
the 1904 epoch, resolves and shape-checks every declared worksheet, and retains
the first sheet's numeric `<v>` lexemes. The adapter then calls:

```ts
XLSX.read(bytes, {
  dense: true,
  cellDates: false,
  cellNF: true,
  cellText: true,
  bookVBA: true,
  bookFiles: true,
  WTF: true,
});
```

Dense SheetJS cells are immediately normalized to the stable Channel contract;
numeric values are overlaid from preflight by address, booleans become
`TRUE`/`FALSE`, errors retain display text, and SheetJS number formats determine
`dateFormatted`. The old shared-string/style/cell decoder was removed.

### Alternatives rejected

- Use SheetJS numeric values directly: rejected because `1.2300e+5` would lose
  its stored representation.
- Keep the old decoder as a fallback: rejected because two workbook decoders
  would create divergent behavior and leave the migration incomplete.

### Risk and test

The adapter contract test verifies first-sheet selection, whitespace and
leading-zero text, sparse cells, raw scientific notation, booleans, errors,
formula results, dates, and row numbers. Existing Dianxiaomi acceptance and all
other catalog-import behavior remain covered by the full package suite.

## Dependency and public surface

- Added exact dependency:
  `xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- Independently queried the installed runtime: `XLSX.version` returned
  `0.20.3` under Node 22.13.0.
- Root exports continue to expose only the stable contract and facade; the
  SheetJS workbook/cell types remain private implementation details.

## Final verification

```text
mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
235 passed, 0 failed

mise x node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import typecheck
exit 0

git diff --check
exit 0
```

## Scope and concerns

Pre-existing untracked research/spec/plan paths were not modified or staged.
No sibling worktree was touched. No known Task 2 blocker remains.
