# Catalog Category Expansion — V1.1 Low-Level Design

> Status: implementation baseline
> Requirement source: client PDF V1.1, SHA-256 `b3804c067e947e8447ac6fed4eae0d1207345c1479a415f44e8e0a87fcc05d56`
> Branch: `feat/catalog-category-design` (requirements, design, MIUs, implementation, tests, and execution records)

## 1. Scope

Implement the complete client-confirmed catalog experience:

- Electronics & Toys menu and hub.
- Product families: Headphones, AI Gadgets, Toys, and Other Electronics & Toys (`misc`).
- Data-backed family listing pages with filters, pagination, loading, empty, error, and image-fallback states.
- Stable independent SKU detail pages with up to nine images, primary image first, enquiry CTA, and related products.
- One Admin Products workspace with All plus four family tabs and manual CRUD/draft/publish/archive behavior.
- VIP hidden in public UI and Admin input while legacy storage/API compatibility remains.
- Alibaba API integration remains out of scope, but its read-only source fields and curated-field ownership are preserved.
- No video, cart, payment, order, inventory reservation, reviews, ratings, or variants.

## 2. Canonical Data Contract

```ts
export const PRODUCT_FAMILY_OPTIONS = ['headphones', 'ai-gadgets', 'toys', 'misc'] as const;
export type ProductFamily = (typeof PRODUCT_FAMILY_OPTIONS)[number];

interface ProductCatalogIdentity {
  productFamily: ProductFamily;
  category?: string;   // optional subcategory; wired/office/bluetooth remain Headphones values
  skuCode: string;     // operator-visible unique identity
  slug: string;        // unique public URL identity
  archived?: boolean;  // hides product from active Admin/public flows without hard deletion
}
```

Products remain in the existing `products` collection. No separate collection per family.

### Legacy compatibility

- A stored product missing `productFamily` but carrying `category` in `wired|office|bluetooth` is projected as `productFamily: 'headphones'` at the public read boundary.
- Reads never mutate storage.
- Existing Headphones rows remain valid while Admin edits/publish operations require the new identity fields.
- Existing `category` remains compatible with `alibabaCategoryMappings.channelCategory`; Alibaba integration can later add a separate family mapping without rewriting source data.

### Write and publish rules

- Create defaults: `published=false`, `archived=false`.
- `slug`: lowercase kebab-case, unique; reject reserved/static paths.
- `skuCode`: trimmed, unique, case-insensitive uniqueness check.
- Publication requires `productFamily`, `name`, `slug`, `skuCode`, `description`, and at least one image.
- Archived products cannot be published and are absent from public list/detail responses.
- `vipPrice` remains deprecated storage compatibility: hidden from generic Admin create/edit and ignored by new public UI.

### Atomic slug and SKU uniqueness

Use deterministic reservation documents owned by one atomic
`saveCatalogProductWithIdentities` storage operation:

```text
catalogProductIdentities/{kind}:{normalizedValue}
  kind: slug | sku
  normalizedValue: lowercase slug or lowercase trimmed SKU
  productId: products._id
```

- CloudBase reads the product and all affected reservation rows, writes the product and new
  reservations, and releases owner-matched old reservations inside one `runTransaction` callback.
- The local JSON adapter performs the same state transition inside one `withMutationLock` critical
  section and persists it with one atomic file replacement.
- A reservation owned by another product or with a malformed deterministic shape rejects the
  transaction before any write.
- Identity changes reserve the new value, update the product, then release old reservations owned
  by that product in the same transaction.
- A callback failure rolls back the whole operation; CloudBase transaction conflicts retry the pure
  callback. No process-local compensation or recoverable lease object is required.
- Concurrent attempts for the same identity have exactly one storage-level winner.
- The identity collection is server-managed and hidden from generic Admin CRUD.

## 3. Media Contract

- `PRODUCT_IMAGE_MAX_COUNT = 9` for the `products` collection and product UI/API paths.
- Existing `CATALOG_IMAGE_MAX_COUNT = 18` remains for Overstock and legacy shared normalization until a separately approved Overstock migration.
- `imageIds[0]` is primary.
- Remaining images preserve order in the detail gallery.
- Allowed MIME and upload lifecycle remain unchanged.
- No video field or video upload path is introduced.

## 4. Public API Contract

### List

`GET /api/products`

Query:

```ts
interface CatalogQuery {
  productFamily?: ProductFamily;
  categories?: readonly string[];
  search?: string;
  page?: number;
  pageSize?: number;
}
```

Behavior:

- Always filters `published=true` and `archived!=true`.
- Applies `productFamily` and optional subcategory filters independently.
- Legacy missing-family Headphones rows are included only for `productFamily=headphones` through a server-side compatibility query/merge, deduped by `_id`, and stably sorted.
- Response projects `productFamily`, `category`, `skuCode`, `slug`, curated fields, images, and existing Alibaba public fields.
- VIP is not required by new UI; server-side legacy gated projection remains unchanged until Alibaba cleanup.

### Detail

`GET /api/products/slug/:slug` is the canonical detail lookup. Existing ID detail remains for compatibility but new pages use slug.

- Returns only published, non-archived products.
- Applies the same legacy-family projection and public allowlist.
- Unknown/unpublished/archived slugs return the existing uniform not-found contract.

### URL

- Existing family route remains `/headphones/`.
- New families: `/ai-gadgets/`, `/toys/`, `/misc/`.
- Hub: `/electronics-toys/`.
- SKU detail shell: `/products/item/?slug={slug}`.

The query-based SKU shell is selected because the site is static-hosted; it preserves a stable category-independent address without introducing SSR or enumerating CloudBase records at build time. A later server-rendering migration may introduce clean path URLs with redirects.

## 5. Public Site Architecture

### Content registry

A typed catalog content loader owns family labels, copy, category imagery, metadata, and menu destinations. Product records remain API-owned.

### Header

- Replace the flat Headphones link with one native disclosure.
- Desktop: click/Enter/Space opens; Escape returns focus; outside/focus-leave closes without focus theft.
- Mobile: nested native disclosure inside current hamburger menu.
- Same links available with JavaScript disabled; 44px targets; active destination indicated semantically and visually.

### Hub

- Four category cards with approved/fallback category media and summaries.
- Featured Products consumes published API data; never invents products.
- Request Quote CTA.

### Family pages

A shared React controller receives `productFamily`, optional subcategory options, and content. It reuses the existing catalog state machine, ProductMedia, cards, error/retry, pagination, and focus behavior.

- Headphones retains wired/office/bluetooth filters.
- Other families render only configured subcategories; no empty filter bar.
- Cards link to SKU URL instead of establishing a second detail state for new families.
- Existing Headphones in-page detail remains compatibility behavior until the SKU shell is complete, then cards use the stable SKU URL.

### SKU detail

- Reads slug from URL query and calls slug detail API.
- Renders ordered gallery (maximum nine), product identity, MOQ, public/Alibaba price or `Request a quote`, product facts, OEM enquiry CTA, and same-family related products.
- Missing fields suppress sections; no fabricated inventory/review/warranty/certification.

## 6. Admin Architecture

Keep one `Products` sidebar section. `CollectionView` adds a product-only family-tab layer:

- Tabs: All, Headphones, AI Gadgets, Toys, Misc.
- Tab value is stored in URL query and combined with search/filter/sort/pagination.
- Tab switch resets page and row selection.
- New product from a family tab pre-fills family; All requires selection.
- Moving family clears an incompatible Headphones category and tells the operator where the row moved.
- Mobile uses scrollable tabs/select and compact rows/cards without page overflow.

`RecordForm` remains registry-driven with product-specific presentation rules:

- Show productFamily, category/subcategory, name, skuCode, slug, description, images, MOQ, public prices, published, archived.
- Hide `vipPrice` and all read-only Alibaba fields from editable controls.
- Show Alibaba status/source/sync time in a separate read-only section when present.
- ImageManager receives max 9.
- Publish validation is enforced server-side, not only in the form.
- Preserve the existing authorization model: `admin` and `contributor` may create/edit/publish/unpublish/archive products; `viewer`, `member`, blank, anonymous, suspended, and invalid sessions cannot mutate products. Only `admin` manages user roles.

## 7. Alibaba Compatibility

- Do not call Alibaba APIs or change sync scheduling/auth.
- Keep all `alibaba*` fields read-only.
- Sync-created products remain drafts.
- Unmapped source categories create no Channel product and never default to Misc.
- Sync never overwrites `name`, `description`, `productFamily`, `category`, `slug`, `skuCode`, `imageIds`, `published`, or `archived`.
- Manual and imported products use the same public contract after operator curation.

Regression tests pin that unmapped sources create no product, sync drafts remain unpublished, and promotion patches contain only Alibaba-owned fields. This work adds no Alibaba API call, scheduler, or auth behavior.

## 8. VIP Retirement Boundary

Implement now:

- Remove public VIP values, labels, locked chips, and registration-benefit copy.
- Hide `vipPrice` from product Admin form.

Defer:

- Remove `vipPrice` storage/type/API projection, `member` role, and entitlement functions only after Alibaba pricing is stable and legacy consumers are audited.

## 9. SEO Integration

- Preserve `/headphones/` canonical.
- Every family/SKU page has unique title, description, and one H1.
- Visible breadcrumb hierarchy: Home / Electronics & Toys / Family / SKU.
- BreadcrumbList mirrors visible hierarchy after rebasing current SEO metadata work.
- Product/Offer schema only from real published data; no ratings/reviews/inventory claims.
- Empty families use `noindex,follow` and remain out of sitemap until real products/content exist.
- Sitemap includes the hub and populated family routes. Query-based SKU URLs are not enumerated in static sitemap until a trustworthy product feed is available.

SEO is an explicit implementation unit after rebasing `feat/seo-phase-3-metadata`: visible breadcrumbs, matching BreadcrumbList, unique bounded metadata, one H1, real-data-only Product/Offer schema, and sitemap/noindex behavior are tested together. Placeholder or empty data never emits Product/Offer schema.

## 10. Testing And Delivery

- Contract/unit tests for family identity, slug/SKU validation, 9-image maximum, publication invariants, public projection, filters, legacy fallback, and Admin tab state.
- React/static render tests for menu, family pages, cards, detail, VIP absence, Admin field visibility, and responsive states.
- Local seed includes at least one product per family plus existing six Headphones, all clearly synthetic/local-only.
- E2E covers menu keyboard/mobile/no-JS, hub, all families, filters/pagination, SKU detail/gallery, Admin CRUD/publish/archive, VIP absence, error/retry, and 320/390/768/1024/1360/1440 containment.
- Rebase current `main`, Alibaba, and SEO metadata changes before touching shared conflict surfaces.
- Validate typecheck, lint, unit/integration tests, production build, local E2E, deploy-preview E2E, and post-deploy smoke before delivery.

## 11. Cross-File Traces

```yaml
cross-file-reasoning:
  scope: full catalog V1.1
  symbols-traced:
    - name: productFamily/category/skuCode/slug/archived
      trace: shared registry -> write schema -> Admin form -> public projection/query -> site DTO -> routes/tests
      verdict: required
    - name: PRODUCT_IMAGE_MAX_COUNT=9
      trace: shared product schema -> Admin slots -> product API projection -> product gallery -> seed/tests
      verdict: required
    - name: slug detail route
      trace: HTTP adapter -> handler lookup -> client fetch -> static SKU shell -> E2E
      verdict: required
    - name: Alibaba curated ownership
      trace: category mappings/linking/promotion -> product write guard -> Admin read-only UI -> regression tests
      verdict: preserve
    - name: VIP hidden/deprecated
      trace: content -> public components -> AuthShell -> Admin field policy -> build/E2E scans
      verdict: hide now, delete later
  verdict: proceed in MIU order
```
