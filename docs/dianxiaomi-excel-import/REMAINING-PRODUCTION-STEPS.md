# What is still needed before this runs in production

Nothing in this branch is deployed, and two of the items below are decisions
rather than code.

## 1. USD pricing is switched off, and must stay off until four questions are answered

Source amounts are CNY, stored as integer minor units on the variant. Nothing
writes `unitPrice`, `wholesalePrice` or `vipPrice`, and the admin preview says
so in words above every price.

Turning it on needs four answers, none of which is a default anyone should
guess:

1. Does "margin" mean **markup on cost** or **target gross margin**, and what
   percentage?
2. Is the input the **regular** price or the **promotion** price?
3. Which **CNY-per-USD rate source**, refreshed how often?
4. What **rounding** — cents, whole dollars, or a `.99` ending?

When they are settled, the stored pricing record must keep the source amount,
source currency, policy version, margin mode and value, the FX snapshot used,
the calculation timestamp, and both the unrounded and rounded USD figures.
Without the snapshot, nobody can explain later why a product was priced the way
it was.

## 2. Images are local-only

Source images are fetched under a full SSRF policy and written to the local
media directory as ordinary `images` rows. Production needs them migrated into
the CloudBase media lifecycle — the same upload/finalize path the admin already
uses — because the storefront must not hotlink a supplier CDN indefinitely:
the merchant does not control those URLs and a supplier can change or remove
them at any time.

The local proof path (`--seed-image`) exists only so the storefront can be
exercised on a machine that cannot reach the supplier CDN. It has no production
call site.

## 3. The header alias table needs one calibration pass

See `CALIBRATION.md`. Roughly one line per unrecognised column, made against
evidence the tool prints rather than against a guess.

## 4. Category mappings are an operator decision

An unmapped source category leaves a product unpublished. That is intended:
the workbook contains toys and phones, and filing them under a headphones
subcategory would be worse than leaving them for review. Someone has to sit
down with `sourceCategoryMappings` once.

## 5. Import is CLI-driven

There is no upload surface. A production import needs a transport for the file
(an admin upload, or the WeCom/CloudRun path already designed in
`docs/wecom-zip-product-import/`) plus a job runner. The pipeline itself does
not change — `runCatalogImport` takes bytes.

## 6. Source-missing records are reported, never acted on

A record absent from a later export is marked, not deleted or unpublished, and
a workbook that could not be fully read marks nothing at all. Whether a
long-missing record should eventually be retired is a policy decision nobody has
made yet.

## Known risks

- **Alias drift.** A future template revision that renames a column will show up
  as unrecognised rather than as silent data loss, but somebody has to look at
  the findings.
- **Inventory is a snapshot.** Stock is whatever the export said. There is no
  real-time synchronisation, so a published count ages.
- **The delta compares against APPLIED state.** Staged-but-unpublished candidates
  are not "accepted source state" and count as additions until published.
