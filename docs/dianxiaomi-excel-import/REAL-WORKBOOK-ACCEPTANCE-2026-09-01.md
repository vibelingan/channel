# Real-workbook local acceptance — 2026-09-01

## Scope and result

**Observed:** the requested local parser/staging acceptance passed on Node `22.13.0`.
This is not a CloudBase deployment, Node 20 runtime, or production-media acceptance.

The supplied workbook is identified by the fixed SHA-256:

```text
57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582
```

Its observed size was `101210` bytes. The stable staged summary matches
[`REAL-WORKBOOK-SUMMARY.json`](./REAL-WORKBOOK-SUMMARY.json) when the generated timestamp
is omitted.

## Fail-closed hash gate — run before any parser command

```bash
: "${CHANNEL_IMPORT_WORKBOOK:?set CHANNEL_IMPORT_WORKBOOK to the supplied .xlsx file}"
expected_sha256='57b29269f60752efcf0c0f7c3e188b4ff8d80faff82802471049a8f461416582'
actual_sha256="$(shasum -a 256 "$CHANNEL_IMPORT_WORKBOOK" | awk '{print $1}')"
test "$actual_sha256" = "$expected_sha256"
```

This command was re-run before the Node 22 dry-run and stage commands below. It passed:
both `expected_sha256` and `actual_sha256` were the fixed digest above. A missing
environment variable or non-matching digest exits before parsing.

## Node 22 dry-run and isolated stage

```bash
mise exec node@22.13.0 -- node --version
# v22.13.0

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/channel-xlsx-acceptance.XXXXXX")"
DRY_SUMMARY="$RUN_ROOT/dry-run-summary.json"
STAGE_SUMMARY="$RUN_ROOT/stage-summary.json"
LOCAL_DB_FILE="$RUN_ROOT/import-db.json"
LOCAL_MEDIA_DIR="$RUN_ROOT/media"

mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/local-server exec tsx \
  src/dianxiaomi-import-cli.ts --file "$CHANNEL_IMPORT_WORKBOOK" --dry-run \
  --json "$DRY_SUMMARY"

LOCAL_DB_FILE="$LOCAL_DB_FILE" LOCAL_MEDIA_DIR="$LOCAL_MEDIA_DIR" \
  mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/local-server exec tsx \
  src/dianxiaomi-import-cli.ts --file "$CHANNEL_IMPORT_WORKBOOK" --publish-plan \
  --json "$STAGE_SUMMARY"
```

The direct package-local `tsx` invocation is intentional. The documented package-script
form with an additional delimiter passed `--file` as an unexpected positional argument
to Node 22's `parseArgs()` before parsing. The commands above remove that wrapper-only
delimiter; they do not alter code or the parser input.

## Observed results and independent persisted-state checks

| Measure | Dry run | Fresh stage + publish plan |
| --- | ---: | ---: |
| Source rows | 312 | 312 |
| Parent products | 77 | 77 |
| Variants | 289 | 289 |
| Unique source image URLs | 452 | 452 |
| Image references | 1549 | 1549 |
| Quarantined products | 0 | 0 |

The fresh JSON database independently contained one `catalogImportJobs` record, 77
`catalogImportItems`, a sum of 289 item `variantCount` values, and 312 source listings.
The job was `previewReady`. Its publish plan considered 77 staged products, would create
77, would publish 0, and kept all 77 drafts because category mappings were deliberately
not supplied. It reported 452 source URLs that would need migration; no fetch occurred.

The configured fresh `LOCAL_MEDIA_DIR` path remained absent after staging. Therefore it
contained zero media objects; this result is not based on inspecting an existing empty
directory. No `--fetch-images`, category mapping, `--make-public`, or CloudBase command
was used.

## Normalized baseline comparison

The stage summary comparison omits only `generatedAt` and compares every other redacted
field with the checked-in baseline:

```bash
mise exec node@22.13.0 -- node -e '
const fs = require("fs");
const stable = (file) => {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  delete value.generatedAt;
  return JSON.stringify(value);
};
process.exit(stable(process.argv[1]) === stable(process.argv[2]) ? 0 : 1);
' docs/dianxiaomi-excel-import/REAL-WORKBOOK-SUMMARY.json "$STAGE_SUMMARY"
```

**Observed result:** match. The baseline timestamp was refreshed from this rerun; no
stable redacted count, finding code, or delta field changed.

## Comparative local spike and decision boundary

On the customer workbook, the current parser establishes the 313-row by 44-column
normalized-grid baseline. SheetJS `0.20.3` matched it exactly with zero cell mismatches.
`read-excel-file@9.3.10` also had zero mismatches using `trim: false` and its raw-number
`parseNumber` seam, but has an async Node API and a different sheet-name API. ExcelJS
`4.4.0` also matched exactly with zero cell mismatches, but carries the larger package and
transitive-dependency surface.

This supports SheetJS as the branch implementation choice because it keeps the
synchronous contract and provides the typed cell data required by the private adapter.
It is not complete production approval. The exact Node 20 runtime, fully bundled
artifact, and actual CloudBase smoke remain pending because no deployment was authorized.
Any single-run timing or RSS observation is directional only, not acceptance evidence.

## Focused regression check

```text
mise exec node@22.13.0 -- pnpm --filter @vibelingan-channel/catalog-import test
238 passed, 0 failed; duration 1.39 s
```
