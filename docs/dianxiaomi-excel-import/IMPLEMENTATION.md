# Dianxiaomi Excel catalog import — implementation record

Branch: `claude/dianxiaomi-excel-import-fe45ab`, based on `origin/main` (78506d5).
Local-only. Nothing was deployed, no GitHub or CloudBase secret was read, and
no customer file was committed.

## What this is

The merchant's catalog lives in a Dianxiaomi export while the Alibaba OAuth
integration is blocked. This branch makes that catalog importable — but it does
NOT model Dianxiaomi data as Alibaba data, and it does not push spreadsheet rows
straight into `products`.

Instead there is one provider-neutral pipeline with a single provider-specific
adapter at the front:

```
Dianxiaomi .xlsx ──> adapter ──> catalog candidate ──> validate / reconcile /
                                                      review ──> Channel catalog
```

Everything downstream of the adapter — findings, validation, identity, matching,
category mapping, inventory presentation, media, preview, diff, publication,
storefront projection — is written against provider-neutral types. A Shopify,
Lazada, AliExpress or Alibaba connector implements `CatalogSourceAdapter` and
reuses the rest unchanged.

## The four decisions that shape the code

**1. Reject rather than guess.** A stock cell reading `N/A` leaves inventory
UNKNOWN instead of becoming `0`; a price cell reading `abc` leaves the price
unset instead of becoming `0.00`. Both alternatives publish a confidently wrong
number that looks perfectly healthy in a job summary.

**2. Never sum repeated store stock.** The same physical SKU is listed in
several shops, and each shop reports the stock it can see. Those rows usually
mirror one warehouse, so adding them multiplies the real figure by the number of
shops — 40 units in four shops would advertise 160. Reconciliation has four
outcomes and one of them is "we don't know":

| Situation | Result |
|---|---|
| One usable quantity | use it |
| Several shops, all agreeing | use the agreed value ONCE |
| Several shops, disagreeing | conflict — keep every snapshot, invent no total |
| No usable quantity | unknown |

Conflict and unknown produce no number anywhere: not on the variant, not in the
admin preview, not in the public API.

**3. A bad cell costs its own row.** Only a workbook that cannot be identified
at all — no parent SKU, SKU, title or store column — is rejected whole. Three
malformed rows out of 312 yield 309 products and three findings.

**4. Source content and operator content are different things.** A repeat import
moves only source-owned fields. Titles, descriptions, website category,
publication state and image order that an operator edited are read off the
existing row and written back unchanged.

## Layout

| Path | Responsibility |
|---|---|
| `packages/catalog-import/src/contracts.ts` | The normative provider-neutral contract |
| `…/identity.ts` | Identifier normalization, deterministic source keys |
| `…/findings.ts` | Stable finding codes |
| `…/values.ts` | Money, quantity, date and URL parsing |
| `…/descriptions.ts` | Placeholder detection, HTML sanitization, text projection |
| `…/grouping.ts` | Products, variants, store listings, quarantine |
| `…/inventory.ts` | The reconciliation rules above |
| `…/xlsx-zip.ts`, `…/xlsx-sheet.ts` | Hardened `.xlsx` reading |
| `…/providers/dianxiaomi/*` | The only provider-specific code |
| `…/testing/*` | Generated fixtures |
| `apps/functions/admin/src/catalog-import-store.ts` | Deterministic ids, persistence |
| `…/catalog-import-service.ts` | Import run, repeat-import delta |
| `…/catalog-import-publish.ts` | The one merge service |
| `…/catalog-import-media.ts` | SSRF-safe image fetch, local migration |
| `apps/local-server/src/dianxiaomi-import-cli.ts` | Local-only CLI |
| `apps/site/src/islands/admin/catalog-import/*` | Read-only admin preview |

## Collections added

All server-managed. None may hold or write an `alibaba*` field.

| Collection | Purpose | Admin access |
|---|---|---|
| `catalogImportJobs` | File digest, lifecycle, counts, summaries | readOnly |
| `catalogImportItems` | Staged candidates, findings, apply state | readOnly |
| `productVariants` | Canonical variants and exact inventory | none |
| `catalogSourceLinks` | Canonical bindings plus per-shop provenance | none |
| `sourceCategoryMappings` | Operator-owned source category → product family | crud |

`catalogSourceLinks` holds three kinds of row. `group` and `variant` bind a
source key to a Channel id; `store` keeps one shop's own price, stock, listing
status and marketplace id. Separating them is what lets four shop lines collapse
into one website product without losing a shop.

## Idempotence

Ids are derived from the source: the job from the file's SHA-256, the staged
item from job plus family, the links from the source keys. A byte-identical
re-import stops at the job row and returns the original untouched; only an
explicit `--replay` creates a new job, and that job records what it replays.

Channel product and variant ids are independent UUIDs — a Channel product is not
a Dianxiaomi object. The canonical LINK row is created first with
create-if-absent and carries the id it won, so a run that dies between the link
and the product reads its own id back out of the link on retry rather than
minting a second one.

## Deliberate deviations from the handoff

1. **Worktree and branch name.** The session was already given an isolated
   worktree at `origin/main`, so `feature/dianxiaomi-excel-import-local` became
   `claude/dianxiaomi-excel-import-fe45ab`. Same isolation, same base.
2. **The two design-doc commits could not be cherry-picked.** `b0cabe1` and
   `416d3a2` do not exist in this repository's object database and no
   `fix/alibaba-icbu-top-main` branch exists. The handoff document itself was
   used as the normative spec.
3. **No spreadsheet dependency.** The npm `xlsx` package is pinned at 0.18.5
   there and carries CVE-2023-30533 (prototype pollution) and CVE-2024-22363
   (ReDoS), with newer releases published only outside npm; `exceljs` adds a
   ~15-package subtree to a repo whose whole runtime surface is six packages.
   The slice of ZIP and SpreadsheetML an `.xlsx` uses is small and closed, so it
   is implemented directly with explicit limits. Verified against five real
   Excel workbooks as well as the generated fixtures.
4. **Category mapping targets `productFamily`, not `products.category`.** The
   handoff assumed the only registry was `wired | office | bluetooth`. The
   repository has since gained `products.productFamily`
   (`headphones | ai-gadgets | toys | misc`), so the workbook's toys and phones
   need no invented fallback category and the legacy subcategory registry stays
   untouched.
5. **Fixtures are generated, not committed as binaries.** A checked-in
   spreadsheet is unreviewable; the fixture definitions read and diff as code.
6. **The admin preview is read-only.** Importing and publishing run from the
   CLI, so the admin surface is "see what this file would do" and adds no new
   server action or authorization path.

## The real workbook (resolved 2026-08-27)

The customer workbook was supplied in a signed transfer package
(`dianxiaomi_lazada_export_original.xlsx`, SHA-256 `57b29269…6582`, all five
package checksums verified). It was kept outside the repository for the whole
run and is not committed.

**Every authoritative measure reproduced exactly on the first calibrated run:**

| Measure | Expected | Produced |
|---|---:|---:|
| Data rows | 312 | 312 |
| Columns | 44 | 44 |
| Distinct global parent SKUs | 77 | 77 |
| Distinct global SKUs | 289 | 289 |
| Distinct (store, parent SKU) | 100 | 100 |
| Distinct (store, SKU) | 312 | 312 |
| Stores | 4 | 4 |
| Unique image URLs | 452 | 452 |
| Image references | 1,549 | 1,549 |
| Lazada product IDs | 16 | 16 |
| Rows with a Lazada product ID | 129 | 129 |
| SKUs repeated across stores | 23 | 23 |

No test or expectation was changed to reach these numbers. The redacted job
summary is `REAL-WORKBOOK-SUMMARY.json`.

### What the first, uncalibrated run got wrong — and how it showed

On first contact six of the eight printed cardinalities were already exact.
The two image counts came back **zero**, because this template names its
gallery `产品图片主图(URL)` and `附图1…附图7`, which the alias table did not
recognise. The design's "report unknown columns" rule turned that into a named
list of 24 headings rather than silence, so the cause was visible before the
first row was read.

Four alias gaps, all evidence-backed and now pinned by
`providers/dianxiaomi/real-template.test.ts`:

1. the gallery is a main column plus `附图1…附图7`, not `图片N`;
2. option slots are numbered with Chinese numerals (`变种属性名称一`), not digits;
3. `关键属性` is the attributes column;
4. `平台刊登时间` is the platform listing timestamp §9 needs.

`来源URL` was deliberately NOT treated as an image: including it gives 1,697
references over 511 unique URLs, against the authoritative 1,549 / 452. It is a
supplier listing address, and it is one of eight columns the table now
recognises and explicitly declines to import.

### Description fallback on real data

201 of 312 rows carry no usable description of their own — 200 placeholders
plus one genuinely empty cell, which is why the placeholder finding count is
200 and the fallback count is 201. The chain resolved all of them:

| Rung | Rows |
|---|---:|
| 2 — the merchant's short description | 130 |
| 3 — structured copy from title, brand and attributes | 71 |

Before this pass the implementation stopped at "treat placeholder as absent",
which blocked publication. That was a real gap against §11 and is now closed.

### Bounded image validation

Six distinct source images were probed through the full SSRF policy: all six
reachable, 64–292 KB, and — the reason magic-byte sniffing exists — served as
**PNG and WebP** regardless of URL extension. Nothing was stored and no URL was
printed. A separate bounded publish migrated 12 real images with zero failures.
