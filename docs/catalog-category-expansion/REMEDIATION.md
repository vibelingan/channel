# Catalog V1.1 — Remediation Record

Defects found after the V1.1 catalog shell reached the `test` environment, their root
causes, the fixes, and the design rules adopted so the same class cannot recur.

Every item below was reproduced against real deployed data or measured in a browser
before it was changed. Nothing here was inferred from a passing unit test alone.

---

## R1 — Published products vanished from the storefront

**Symptom.** `/headphones/` rendered "No products match these filters" while the API
returned HTTP 200 with four published products.

**Root cause.** `CatalogFamilyGrid` rendered `state.products.filter(hasUsableCatalogSlug)`.
Every product in the deployed catalog is a legacy row created before slugs existed, so the
filter deleted all of them. The failure was silent: no error, no empty-state distinction
between "nothing published" and "everything discarded".

**Why tests missed it.** Every fixture written for V1.1 carried a slug. 191 unit tests and
the local E2E lane passed because they described the schema we intended, not the records
that exist.

**Fix.** The grid renders every product the API returns. A slug now decides only whether a
card links to a detail URL.

**Rule adopted.** *A client-side filter over server data is a silent data-loss gate.* If the
server says a record is published, the UI degrades the feature, never the record.

---

## R2 — The product detail experience disappeared for all real data

**Symptom.** Cards rendered but nothing opened. No product on the site had a detail page.

**Root cause.** The V1.1 shell replaced the in-page detail band with navigation to
`/products/item/?slug=…`. That route resolves by slug only (`fetchProductBySlug`), and no
deployed product has a slug, so the entire detail experience was unreachable.

**Fix.** Restored in-page expansion on the shared family pages, keyed by `product._id`:
card → detail band lower on the page → focus moves to the detail heading → Back closes it
and restores focus to the originating card. Identifiers always exist, so this works for
every published product, old or new.

**Rule adopted.** *Never route a core journey exclusively through an optional field.*

---

## R3 — Grey placeholder blocks in the product grid

**Symptom.** A partly filled row showed large grey rectangles beside the cards.

**Root cause.** The grid painted `bg-slate-200` on itself and used `gap-px` so the
container colour showed through as hairline separators. Empty tracks in the last row
therefore rendered as solid grey blocks. The card had no frame of its own.

**Fix.** The card owns a real border; the grid paints nothing and uses ordinary gaps.

**Rule adopted.** *A container must not rely on its own background to draw an item's
borders.* Empty tracks are legitimate; they must be invisible.

---

## R4 — Cards misaligned when copy length varied

**Symptom.** Media, price, and action sat at different heights across a row.

**Root cause.** Card content flowed freely, so a long product name pushed every region
below it down.

**Fix.** The card is a full-height flex column with fixed regions: square media, a reserved
identifier line, a two-line clamped title, then the meta row and action pinned to the
bottom with `mt-auto`.

**Measured at 1440px on an uneven row** — card heights 479/479, media 259×259 both, title
tops 198/198, action bottoms 348/348.

**Rule adopted.** *A card in a grid aligns by structure, not by hoping content matches.*

---

## R5 — Navigation shifted under the cursor on first load

**Symptom.** Clicking the "Electronics & Toys" arrow opened Success Stories.

**Root cause.** Two independent defects.

1. `AccountMenu` is a `client:only` island contributing 0px until React mounts. When it
   appeared (161px) the `justify-between` row rebalanced and the primary nav slid 80px
   left. The chevron sat at x≈1225; after the slide that pixel is inside Success Stories
   (1162–1311).
2. The desktop lane was gated entirely behind a JS measurement, so every cold load painted
   the mobile header first and then swapped the whole navigation in.

**Fix.** Reserve the account control's footprint with `min-width`; choose the lane in CSS at
the same 1360px threshold so first paint already matches the settled layout. JS still
measures and may downgrade to the mobile lane, but can no longer pop content in.

**Verified** — nav x is 796 both before and after the account island hydrates (was
880 → 799), and the desktop lane renders with scripts disabled.

**Rule adopted.** *Responsive lanes are chosen in CSS, never by post-load measurement, and
every async island gets a reserved box the size of its result.*

---

## R6 — Header lane disagreed with its own stylesheet at the boundary

**Symptom.** After a resize across the threshold the mobile disclosure stayed open and
focus was stranded. Reproduced only on the deployed runner.

**Root cause.** Introduced by the R5 fix. The stylesheet asks
`@media (min-width: 1360px)`, which measures the viewport **including** the scrollbar. The
script asked `window.innerWidth >= 1360`, which **excludes** it. At the boundary CSS laid
out the desktop lane and the script then forced the header back to mobile.

**Fix.** The script evaluates `window.matchMedia('(min-width: 1360px)')` — the same
question, the same answer.

**Rule adopted.** *When CSS and JS must agree on a breakpoint, they must evaluate the same
media query. Two different width APIs are two different breakpoints.*

---

## R7 — CI could not discover any specs

**Symptom.** `pnpm test:e2e --list` reported `Total: 0 tests in 0 files`; CI failed.

**Root cause.** Two new specs threw at module scope when their opt-in env flags were unset,
aborting discovery for the whole suite.

**Fix.** Skip on the static opt-in flag, matching `mutation.spec.ts`. Once a flag is set,
missing credentials or a mismatched database still fail rather than skip.

**Rule adopted.** *Spec discovery must succeed with no environment at all.*

---

## R8 — Deployed smoke demanded content that does not exist

**Symptom.** Deploy failed on `ai-gadgets: deployed catalog requires at least one published
product`, and later on a missing product slug.

**Root cause.** The smoke encoded the catalog we planned rather than the one that exists.
New families ship as empty storefronts until the catalog team publishes into them, and
legacy rows have no slug.

**Fix.** Shape and projection are checked for every family; non-emptiness is required only
for families listed in `SMOKE_REQUIRED_FAMILIES` (default `headphones`). The slug detail
probe runs when a slug exists and reports plainly when none does.

**Rule adopted.** *A deployment smoke asserts the contract, not the inventory.*

---

## R9 — Public E2E described the pre-expansion site

Eight deployed browser tests still asserted the old information architecture: Headphones as
a top-level nav link, an admin section named "Headphones", the old back-button wording, the
`Product Line` eyebrow, and an 18-image product cap. Each was pointed at the approved design
rather than deleted. Two genuine component gaps surfaced this way and were fixed rather than
asserted away: the catalog disclosure summary was missing `whitespace-nowrap`, and the card
had lost its action affordance.

**Rule adopted.** *When a design changes, its tests are part of the change. A stale
assertion is an unmigrated requirement, not noise.*

---

## Behaviour change requiring product awareness

V1.1 split the storefront media contract: **a product caps at nine images; Overstock keeps
eighteen** (`packages/shared/src/media.ts`, commit `384dff5`). Admins who previously
attached up to eighteen images to a product can now attach nine. This is intentional and
matches the public catalog contract, but it is a real change to admin capability.

---

## Component contract after remediation

`CatalogFamilyPage` (controller) owns fetching, request generations, abortion, the active
product, and the focus lifecycle. It holds no presentation.

`CatalogFamilyGrid` (presentation) owns filters, states, and the grid. It holds no fetching.

`CatalogProductCard` is the single card definition used by every family. Adding a family
requires content only — no new card, grid, or page component.

`HeadphonesProductDetail` is the shared detail band, driven by the catalog content contract.

The test contract each card must keep emitting: `data-product-card` (product id),
`data-product-card-price`, `data-product-card-action`; the grid emits `data-result-progress`
and `data-load-more`; family pages emit `data-catalog-heading`.
