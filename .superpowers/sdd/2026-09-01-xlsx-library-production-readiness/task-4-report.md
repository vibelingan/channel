# Task 4 report — real-workbook acceptance

**Outcome:** passed for the requested local parser/staging acceptance on Node `22.13.0`.

## Scope and safety boundary

The source workbook was read through the caller-provided `CHANNEL_IMPORT_WORKBOOK`
path (the supplied filename was
`lazada_quanqiuchanpin_20260826112504669_1920532.xlsx`):

```text
$CHANNEL_IMPORT_WORKBOOK
```

Its SHA-256 was checked before either parser command ran:

```text
57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582
```

Observed byte size: `101210` bytes. This matched the required digest and the checked-in
baseline's source digest.

All import state was isolated under fresh `mktemp -d` roots:

```text
/tmp/channel-xlsx-task4-dry.Rzs62t
/tmp/channel-xlsx-task4-stage.PtQ9xt
```

No CloudBase service, credentials, category mapping, image fetch, publication, or
`--make-public` operation was invoked.

## Environment and commands

```text
mise exec node@22.13.0 -- node --version
# v22.13.0

mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/local-server exec tsx \
  src/dianxiaomi-import-cli.ts --file <workbook> --dry-run --json <tmp>/dry-run-summary.json

LOCAL_DB_FILE=<tmp>/import-db.json LOCAL_MEDIA_DIR=<tmp>/media \
  mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/local-server exec tsx \
  src/dianxiaomi-import-cli.ts --file <workbook> --publish-plan --json <tmp>/stage-summary.json

mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
```

The package script form documented with an additional `--` was first tried under Node
22 and failed before parsing: Node's `parseArgs()` received `--file` as an unexpected
positional argument. Directly invoking the same package-local `tsx` entrypoint removed
that wrapper-only delimiter and succeeded. This was a CLI invocation issue, not a
workbook or parser rejection.

## Observed acceptance results

| Measure | Dry run | Fresh stage + publish plan | Required |
| --- | ---: | ---: | ---: |
| Source rows | 312 | 312 | 312 |
| Parent products | 77 | 77 | 77 |
| Variants | 289 | 289 | 289 |
| Unique source image URLs | 452 | 452 | 452 |
| Image references | 1549 | 1549 | 1549 |
| Quarantined products | 0 | 0 | 0 |
| Media objects written | n/a | 0 | 0 for this parser-only run |

The persisted temporary database independently contained one `catalogImportJobs` record
and 77 `catalogImportItems`; the item `variantCount` values summed to 289 and their
source listings totaled 312.

The stage job was `previewReady`. Its publish plan considered 77 staged products, would
create 77, would publish 0, and would keep 77 as drafts solely because all source
categories were intentionally unmapped. It reported 452 distinct source URLs that would
need migration, but no image migration was requested or performed. The new local media
directory had no files, so its media-object count was 0.

## Baseline comparison

The stage output was normalized by omitting `generatedAt`, then compared with checked-in
`docs/dianxiaomi-excel-import/REAL-WORKBOOK-SUMMARY.json`. Result: **MATCH**. The only
baseline update is the evidence timestamp (`2026-08-31T16:44:15.197Z`); all stable,
redacted fields are unchanged. The dry-run form intentionally has no `delta` field, so
it is not an equal JSON shape to the staged baseline; its common stable fields match.

## Test result

`pnpm --filter @vibelingan-channel/catalog-import test` under Node `22.13.0` passed
`238/238` tests with zero failures in `1.43 s`.

## Decision and remaining boundary

SheetJS is selected for the private XLSX adapter because it preserves the synchronous
pipeline and exposes the typed cell information the adapter needs. `read-excel-file`
would require an asynchronous contract change and loses required cell-kind detail;
ExcelJS adds a larger package/dependency surface with no measured real-workbook benefit.
See `docs/dianxiaomi-excel-import/XLSX-TECHNOLOGY-DECISION-2026-09-01.md`.

This proves local parsing and staging only. It does not prove CloudBase storage,
CloudBase deployment, public media delivery, category approval, or publication. No claim
is made that 447 media objects were downloaded in this run; that number, when mentioned
elsewhere, is prior-run evidence and is outside this parser-only acceptance.
