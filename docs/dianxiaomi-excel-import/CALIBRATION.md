# Calibrating the header table against the real export

## Why this step exists

Columns are located by NAME, never by position, so a reordered template still
parses. What cannot be derived is what the merchant's template actually CALLS
each column. The alias table in
`packages/catalog-import/src/providers/dianxiaomi/headers.ts` covers the Chinese
headers a Dianxiaomi Lazada "global product" export is known to use plus their
English equivalents — but the exact header row of a given template revision is a
fact about that file, and the file was not available when this was written.

The adapter is built so this costs one line per column and nothing else.

## The one-minute version

```bash
pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \
  --file "/absolute/path/to/<merchant-export>.xlsx" --headers
```

That reads the file, prints every column heading it contains, and exits. It
writes nothing — no database, no media directory, no job row.

Three outcomes:

**All four required columns matched.** The command prints the columns and a list
of unrecognised ones. Add an alias for any unrecognised column that matters.

**A required column is missing.** The command exits non-zero and names both what
is missing (`parentSku`, `sku`, `title`, `store`) and every heading that WAS
present. Match them up and add the aliases.

**The file is not a spreadsheet.** `WORKBOOK_UNREADABLE`, with the reason.

## Adding an alias

One line in `HEADER_ALIASES`, in normalized form (lower-case, NFKC-folded,
whitespace collapsed). A test asserts every alias is already normalized, so a
typo cannot become an alias that silently never matches, and a second test
asserts no alias is claimed by two fields.

```ts
regularPrice: ['价格', '售价', '原价', '销售价', 'price', /* ← add here */],
```

Numbered image columns (`图片1`, `image 3`) are matched by pattern and need no
entry. A heading with a trailing unit — `价格(元)`, `weight (kg)` — is retried
with the qualifier stripped, so those need no entry either.

## Then run it for real

```bash
LOCAL_DB_FILE=./data/db.dianxiaomi-spike.json \
LOCAL_MEDIA_DIR=./data/media-dianxiaomi-spike \
pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \
  --file "/absolute/path/to/export.xlsx" --dry-run
```

Compare the printed cardinalities against the verified ones:

```
rows=312  parentSkus=77  skus=289  storeProducts=100  storeVariants=312
stores=4  uniqueImageUrls=452  imageReferences=1549
```

A mismatch here is informative rather than alarming — it usually means a column
alias is still missing (for example, no `store` match collapses 100 store
listings into fewer) rather than that grouping is wrong.

Drop `--dry-run` to stage the job, then open **Catalog Import** in the admin.

## Local files never leave the machine

`./data/` under `apps/local-server` is already git-ignored, so the local
database, the downloaded images and any workbook copied there cannot be
committed. `--json <path>` writes a summary that is safe to attach to a review:
counts and finding codes only — no titles, SKUs, shop names, image URLs or
descriptions.
