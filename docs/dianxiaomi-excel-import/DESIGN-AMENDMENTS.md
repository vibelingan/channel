# Amendments to the approved design

The authoritative documents — `APPROVED_DESIGN_SPEC.md` and
`IMPLEMENTATION_HANDOFF.md` — are deliberately NOT committed. This repository is
public, and they carry commercial detail (margin policy, cost figures, the
merchant's export filename) that does not belong in it. They are held with the
reviewer; their checksums are `7cd605da…7459` and `9615166a…8e398`.

This file records where the current `main` demonstrably differs from a
repository fact those documents assumed.

This file records where the current `main` demonstrably differs from a
repository fact the design assumed, and what the implementation does instead.
Every substantive decision in the design is preserved.

---

## A1 — Category model: map to `productFamily`, not the legacy subcategory

**Design §7.3 said:** the `products.category` enum supports only `wired`,
`office`, `bluetooth`, cannot represent toys and phones, and so dynamic website
categories should be introduced through category IDs and mappings, preserving
the legacy field for old products and routes.

**What `main` actually has**, verified at the branch base `78506d5`:

```ts
// packages/shared/src/catalog-product.ts
export const PRODUCT_FAMILY_OPTIONS = ['headphones', 'ai-gadgets', 'toys', 'misc'] as const;
export const LEGACY_HEADPHONES_CATEGORY_OPTIONS = ['wired', 'office', 'bluetooth'] as const;

// packages/shared/src/collections.ts
export const PRODUCT_CATEGORY_OPTIONS = ['wired', 'office', 'bluetooth'] as const;
```

`products.productFamily` was added after the design was written. It already
carries `toys` and `misc`, which is exactly the gap §7.3 identified. The legacy
`products.category` is now scoped to Headphones only — `validateProductPublication`
rejects a non-empty `category` on any other family, and `planCatalogProductSave`
clears a stale one on the next write.

**Amendment.** `sourceCategoryMappings` maps a source category onto a Channel
**product family**, with an optional Headphones subcategory:

| Field | Meaning |
|---|---|
| `provider`, `sourceTaxonomy`, `sourceCategoryId` | the source category, preserved verbatim |
| `sourceCategoryName` | the source label, for the operator |
| `productFamily` | required; one of the four current families |
| `channelCategory` | optional; only meaningful when `productFamily` is `headphones` |

This satisfies every constraint the review restated:

- source categories map to *current* Channel product families;
- the source taxonomy and category ID are preserved on the candidate
  (`CandidateCategory`) and never overwritten;
- no legacy category is forced — a non-Headphones product gets none;
- an unmapped source category leaves the product **unpublished**: the merge
  writes the draft, the publication rules reject it, and the reason is reported.
  Publication never invents a mapping;
- the public projection allowlist is unchanged apart from the additive
  `variants` key, and products with no variants stay byte-identical.

No fallback category such as `other` was introduced, because `misc` already
exists and adding a fifth family would change storefront routing.

**Migration/compatibility.** Nothing migrates. Existing rows are untouched:
Headphones products keep their subcategory; products predating `productFamily`
are still resolved by `productFamilyForDoc`, which falls back to `headphones`
when a legacy `category` value is present. Imported products are simply new
rows carrying a `productFamily` and no `category`.

---

## A2 — Local phase: CloudBase storage and upload transport are out of scope

**Design §7.1, §12.2 and §13** put the original workbook, the normalized
export, the rejected-row report and all migrated media in private CloudBase
Storage, reached through an admin upload intent.

**What this branch does:** the local phase is explicitly local-only (handoff §4,
and the review restates it). Media is written through the same
`MediaStorageAdapter` interface, wired to `LocalDiskMediaStorage`; import runs
from a CLI against a file path. The CloudBase adapter is the same seam and is
unchanged.

**Consequence, tracked in `REMAINING-PRODUCTION-STEPS.md`:** the upload intent,
the CloudBase media migration and the report file IDs are production work. The
design's decision is preserved, not replaced.

---

## A3 — Bulk publish is a CLI action in this phase, not an admin button

**Design §9 and §13 step 9** require the operator to preview a job and click one
bulk action that publishes all valid items.

**What this branch does:** publication is one bounded, idempotent action —
`publishImportedSample`, invoked by the CLI with an explicit limit. The admin
page is read-only preview.

**Why:** the handoff scoped Task 8 to preview only ("Keep the first iteration
functional and plain"), and the local phase has no upload surface for a job to
start from. The merge service already takes the whole job; wiring a button to it
is a small, additive change once an upload transport exists.

**Status:** partially implemented. Recorded as such in the requirement matrix
rather than reported as done.

---

## A4 — `catalogSourceLinks` holds three row kinds

**Design §5.1 and §7.1** specify deterministic identities for the source
channel product, the source channel variant, and the canonical candidates, all
linked through `catalogSourceLinks`.

**What this branch does:** the collection carries a `linkKind` discriminator —
`group` binds a canonical product family to a Channel product id, `variant`
binds a canonical SKU to a Channel variant id, and `store` holds one shop's own
price, stock, listing status and marketplace id.

**Why:** the design's four identities collapse into two questions — "which
Channel entity is this?" and "what did this shop report?" — and separating them
is what lets four shop lines become one website product without losing a shop.
The canonical rows are created with create-if-absent and carry the Channel id
they won, which is what makes a retry after a crash adopt the existing id
instead of minting a second one.

---

## A5 — Source-published requires the id *and* the timestamp

**Design §9** says a populated Lazada product ID and platform-published
timestamp yield source `published`.

**Verified against the real workbook:** `产品id` and `平台刊登时间` are populated
together on exactly 129 rows and absent together on the other 183 — zero rows
carry one without the other. The implementation requires both, so a reserved-
but-unlisted id cannot read as published. Draft rows remain fully eligible for
the Channel website, per §9 and §19.
