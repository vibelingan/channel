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

## Blocked deliverable: the customer workbook

`<merchant-export>.xlsx` is **not present on
this machine** (searched `~/Downloads`, `~/Desktop` and the wider home
directory; the only 2026 `.xlsx` files are unrelated sprint trackers). So the
real-workbook run in handoff §14 Task 5, §17 and §20.4 could not be performed.

What was done instead: a generated fixture reproduces the workbook's VERIFIED
SHAPE exactly — 312 rows, 77 parent SKUs, 289 SKUs, 100 store-products, 312
store-variants, 4 stores, 452 unique images over 1,549 references, 16
marketplace ids on 129 rows, and 23 SKUs repeated across shops with equal stock
in both. Parsing it yields exactly 77 products and 289 variants.

That proves the grouping, reconciliation and identity logic against the
documented shape. It does NOT prove the header alias table, which is the one
thing that genuinely depends on the file. See `CALIBRATION.md`.
