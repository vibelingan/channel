# Catalog Category Expansion — Findings

## User Intent

- The catalog must no longer present Headphones as the only product family.
- Required hierarchy: Electronics & Toys, then Headphones / AI Gadgets / Toys / Misc, then individual SKUs.
- Other categories can initially reuse the current Headphones page detail pattern.
- The public site needs an explicit category menu and a designed category browsing experience.
- Admin needs matching category tabs and manual add/edit capability using mostly shared fields.
- The design must leave a clean path for the active SEO/GEO work.
- Alibaba data synchronization is reference context only in this phase; the future importer should write into the same product model without forcing storefront-specific API coupling.

## Initial Hypothesis

The safest design is one canonical product model with a required product-family key and shared merchandising fields, rather than one model or admin workflow per category.

This hypothesis is supported, with one important correction: the current `category` field already means a Headphones subcategory (`wired`, `office`, or `bluetooth`). Reusing that field for `headphones`, `ai-gadgets`, `toys`, and `misc` would collapse two hierarchy levels. The design should introduce a stable second-level `productFamily` and retain a separate optional `subcategory` dimension.

## Visual Baseline From Shared Page

- Desktop navigation currently exposes `Headphones` as a first-level header item alongside OEM Development and Success Stories.
- The shared page uses a white global header over a dark navy OEM hero.
- A category expansion should replace the single Headphones item with a discoverable product menu while preserving the current brand/navigation density.

## Current Main Contract

- `packages/shared/src/collections.ts`: `products` is the canonical catalog collection. Shared fields include name, series, model name/type, description, MOQ, legacy prices, image IDs, publish state, and Alibaba-owned read-only fields.
- The existing `category` enum contains `wired`, `office`, and `bluetooth`; these are Headphones subcategories, not peers of Headphones.
- `apps/functions/public-api/src/handler.ts`: public catalog listing already accepts category filters and projects an allowlisted product response. The API is otherwise category-agnostic.
- `apps/site/src/pages/headphones.astro` and `apps/site/src/islands/shop/HeadphonesPage.tsx`: `/headphones/` is a hardcoded storefront route and fetches the full `products` listing.
- `apps/site/src/islands/admin/sections.ts`: Admin currently exposes one `Headphones` section backed by `products`.
- `apps/site/src/islands/admin/CollectionView.tsx` and `RecordForm.tsx`: generic list, filter, create, and edit primitives can be reused; category-specific duplication is unnecessary.

## Alibaba Reference Contract

- The implementation lives on `feature/alibaba-linked-catalog-sync`; the named worktree is currently checked out on `deploy-test`, so provenance must be taken from the feature ref/docs rather than the worktree branch label.
- Alibaba source and SKU identities are deterministic provider-prefixed keys. Source mirrors, offers, category mappings, and sync runs remain separate from curated Channel products.
- Promotion into `products` is additive. It preserves curated name, description, category, images, publication state, and legacy prices while materializing only Alibaba-owned pricing/status/link fields.
- Draft creation is gated by explicit `alibabaCategoryMappings`; there is no fuzzy category assignment and no automatic publication.
- Design consequence: `productFamily` and `subcategory` belong to Channel's canonical product contract. Alibaba mappings target those keys; storefront components must never parse Alibaba source categories or IDs.
- Manual and imported products must use the same create/update contract. Import metadata is read-only and provider-prefixed so removing or changing an integration does not rewrite the public information architecture.

## SEO/GEO Compatibility Contract

- Public canonicals use trailing slashes. The category design should avoid a later URL migration by reserving stable routes now.
- Global Organization, WebSite, and WebPage schema comes from `BaseLayout.astro`; category/SKU pages should extend, not duplicate, that graph.
- Visible three-level hierarchy warrants visible breadcrumbs and matching `BreadcrumbList` data.
- Product schema remains blocked until real server-rendered product data exists. Placeholder price, rating, inventory, warranty, and review claims are forbidden.
- Titles must remain at most 60 characters, descriptions at most 160 characters, and each public page must render one visible H1.
- Sitemap `lastmod` may only use a reviewed content timestamp, never build time or Alibaba sync time.
- English is the only approved locale today. Do not add hreflang or translated URLs until translated content and locale strategy are approved.

## UI Constraints

- Preserve the current white global header and navy brand language rather than introducing a separate visual system for the catalog.
- Desktop product navigation must be keyboard-operable and expose the four product families without requiring hover alone.
- Mobile navigation uses a full-width accordion/drill-down with at least 44×44 px targets and predictable browser Back behavior.
- Category and SKU pages use visible breadcrumbs because the information architecture is three levels deep.
- Admin category controls use tabs/segmented navigation for the four fixed families, with an `All products` view for operations across families.
- Focus states, heading order, reduced-motion behavior, and 375/768/1024/1440 px responsive checks are required.

## Decision From Evidence

Do not namespace or overload the existing category enum as the permanent model. That shortcut makes Headphones subtype data ambiguous and forces the future importer to infer hierarchy from strings. Use explicit product-family and subcategory keys, with display labels and SEO copy kept separate from identifiers.

The selected compatibility-first URL contract is:

- Preserve `/headphones/` as the existing canonical.
- Add `/electronics-toys/`, `/ai-gadgets/`, `/toys/`, and `/misc/`.
- Give each SKU a category-independent `/products/{slug}/` URL.

This rejects a clean-looking `/products/{family}/{slug}/` hierarchy because family reassignment would change SKU URLs. It also rejects migrating `/headphones/` to `/products/headphones/`, which would create SEO and integration work without user benefit.

Independent requirements and design reviews agreed that only the Headphones visual components should be reused. The current same-page detail interaction must not be copied because it has no crawlable/shareable SKU URL.

The existing VIP pricing path is not part of this feature. Registration creates a blank base role, while VIP visibility requires an administrator to assign `member`; there is no customer application or approval journey. The catalog expansion therefore hides VIP pricing and its sign-in prompt, hides `vipPrice` from Admin forms, and retains the underlying field only as deprecated storage compatibility until Alibaba pricing is stable.

## Remaining Evidence To Collect

- Client decisions listed in `CLIENT_CONFIRMATION.md`.
- Authenticated Admin screenshots can be captured during implementation; the runtime correctly redirected the unauthenticated inspection to login, so current Admin behavior is grounded in source contracts.

## Phase 1 Scope Lock — Menu And Basic Pages

The first implementation phase intentionally stops before any customer decision that would harden a data, permission, integration, or permanent URL contract.

### Implement now

- Replace the single Headphones global-nav item with an accessible `Electronics & Toys` disclosure on desktop and nested disclosure on mobile.
- Add the Electronics & Toys hub plus basic sibling pages for Headphones, AI Gadgets, Toys, and Other Electronics & Toys.
- Reuse the current Headphones seed and catalog UI to validate the populated Headphones state.
- Render honest empty/in-preparation states and an OEM enquiry CTA for the other three families.
- Keep the current Headphones in-page detail interaction, data fetching, and controller behavior unchanged while suppressing its VIP presentation.
- Remove VIP marketing copy from active Headphones/auth presentation; keep VIP storage, API, roles, Admin, and Alibaba compatibility unchanged.
- Validate navigation and responsive UI locally with the existing local API and seed dataset.

### Explicitly defer

- `productFamily` or any replacement schema field, migration, public API filter, or Alibaba mapping.
- Admin category tabs, CRUD form changes, publication permissions, deletion behavior, or bulk actions.
- Breadcrumb hierarchy/JSON-LD, SKU detail routes, slug persistence, redirects, permanent URL guarantees, or Product schema; these re-enter after the active SEO metadata work and client URL approval.
- Alibaba source/pricing branches and VIP backend/Admin/Alibaba cleanup work.
- VIP storage/API/role/Admin cleanup (presentation-only suppression is in scope now).
- Synthetic AI Gadget/Toys products presented as real catalog inventory.

### Why this is the lowest-risk slice

The current seed has six real demo Headphones records and no confirmed cross-family field. Static family navigation plus truthful empty pages proves the complete menu/page interaction without prematurely turning the proposed `productFamily` name into a database contract. New route names are local/test-preview only until the client confirms them; noindex alone is not treated as permission to publish unstable URLs. The later data/API/Admin phase can then adopt the client-approved taxonomy without migrating a speculative Phase 1 schema.