# Catalog Category Expansion — Findings

## Authoritative Client Baseline — V1.1

- **Source**: `CLIENT_REQUIREMENTS_AND_UI_DESIGN.pdf` supplied via WeCom on 2026-08-19.
- **SHA-256**: `b3804c067e947e8447ac6fed4eae0d1207345c1479a415f44e8e0a87fcc05d56`.
- **Page count**: 10 pages from the PDF page tree.
- **Precedence**: This PDF supersedes the earlier Phase 1 scope reduction in this branch. The full V1.1 requirements below are now the implementation contract.

### Confirmed full scope

- Electronics & Toys hub with Headphones, AI Gadgets, Toys, and Misc/Other Electronics & Toys.
- Desktop and mobile catalog menu.
- Shared family listing UI with product images, model/SKU identity, description, MOQ, public price or `Request a quote`, filters, pagination, loading/empty/error states.
- Independent SKU detail pages with stable addresses, gallery, product facts, OEM/ODM content, enquiry CTA, and related products.
- One Admin Products workspace with All plus four family tabs, search/filter/status, manual create/edit, draft/publish/unpublish/archive behavior, and responsive list UI.
- One product record equals one SKU for this release; variants are deferred.
- Maximum nine product images; first image is primary and remaining images enter the gallery. Product video is explicitly out of scope.
- VIP price is hidden from public pages and Admin forms; the legacy field remains only for compatibility until Alibaba pricing is stable.
- Alibaba API integration is not implemented in this work, but future source fields remain read-only, imported products default to draft, unmapped categories do not become Misc, and sync must not overwrite curated fields.
- Existing `/headphones/` remains; English only for this release.

### V1.1 decisions that replace the earlier Phase 1 plan

- Category pages are real data-backed pages, not preparation-only placeholders.
- Hub includes category imagery and Featured Products.
- SKU detail route and stable slug are in scope now.
- Admin family tabs and manual CRUD are in scope now.
- Data/schema/API work required to support these surfaces is in scope now.
- Breadcrumb and SEO integration must support real family/SKU pages; temporary noindex-only preview behavior is no longer the final contract.

### Compatibility decisions

- Add a dedicated `productFamily` field with stable values `headphones`, `ai-gadgets`, `toys`, `misc`.
- Keep the existing `category` field as an optional subcategory. Existing `wired`, `office`, and `bluetooth` values remain valid Headphones subcategories and remain compatible with current Alibaba category mappings.
- Treat legacy products with no `productFamily` and a known Headphones category as `headphones` at the public read boundary. Do not rewrite storage during reads.
- Add unique public `slug` and operator-visible `skuCode`; preserve `_id` as storage identity.
- New products default to draft/unpublished. Publication requires product family, name, slug, SKU code, description, and at least one image.
- Use `imageIds[0]` as the primary image and enforce a maximum of nine throughout schema, Admin selection, API projection, seed fixtures, and tests.
- Alibaba-linked products continue using Alibaba pricing. Manual/unlinked products show permitted public price or quote; VIP is not rendered or newly editable.

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
- The static query-SKU shell remains generic `noindex,follow` and absent from the sitemap. After the
	published-slug endpoint returns a runtime-validated publication-complete product, the hydrated
	detail may emit Product/Offer data and a slug-qualified canonical; placeholder price, rating,
	inventory, warranty, and review claims remain forbidden.
- Titles must remain at most 60 characters, descriptions at most 160 characters, and each public page must render one visible H1.
- Sitemap `lastmod` may only use a reviewed content timestamp, never build time or Alibaba sync time.
- Catalog frontmatter is the reviewed family-content publication manifest for static builds. A family
	href in that registry means the route has approved real content and may be indexable even when the
	runtime product query is empty; removing the href removes that family from the sitemap contract.
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

The family URL contract is:

- Preserve `/headphones/` as the existing canonical.
- Add `/electronics-toys/`, `/ai-gadgets/`, `/toys/`, and `/misc/`.

SKU address syntax is defined only in `SKU URL Clarification` below. The PDF confirms stability and category independence, not a specific clean-path shape. Migrating `/headphones/` to `/products/headphones/` remains rejected because it creates SEO and integration work without user benefit.

Independent requirements and design reviews agreed that only the Headphones visual components should be reused. The current same-page detail interaction must not be copied because it has no crawlable/shareable SKU URL.

The existing VIP pricing path is not part of this feature. Registration creates a blank base role, while VIP visibility requires an administrator to assign `member`; there is no customer application or approval journey. The catalog expansion therefore hides VIP pricing and its sign-in prompt, hides `vipPrice` from Admin forms, and retains the underlying field only as deprecated storage compatibility until Alibaba pricing is stable.

## Remaining Evidence To Collect

- Client decisions listed in `CLIENT_CONFIRMATION.md`.
- Authenticated Admin screenshots can be captured during implementation; the runtime correctly redirected the unauthenticated inspection to login, so current Admin behavior is grounded in source contracts.

## MIU 11 Implementation Findings

- The hub's effective Astro URL is `/electronics-toys/`; catalog family destinations use canonical
	trailing slashes from the shared registry.
- Hub labels and SEO metadata are registry-owned; the public metadata test validates title and
	description limits while the route test validates BaseLayout bindings.
- Featured Products uses one persistent polite announcer across loading, error, empty, and result
	transitions. Error remains an immediate alert, retry starts a fresh abortable request, rows without
	usable slugs are omitted, and `productFamily` is never presented as a SKU fallback.
- Focused Playwright must set `E2E_SITE_URL` to an isolated worktree server. The default port may be
	occupied by another checkout and produce a plausible but unrelated 404.

## MIU 12 Implementation Findings

- The existing pure `headphonesCatalogState` reducer is the shared pagination authority. It already
	enforces request generations, stale-result no-ops, first-seen dedupe, and terminal empty-page
	behavior, so the family controller reuses it instead of introducing a parallel state machine.
- Family, category, and deferred-search changes abort the prior request, increment the generation,
	and restart at page 1. Headphones with no selected subcategories terminates locally; unconfigured
	families omit the filter fieldset and send only the family/search/page query.
- Family cards are canonical slug links. Rows without a usable slug are omitted; linked Alibaba
	pricing takes precedence over legacy values, unlinked products prefer wholesale then unit price,
	and missing public pricing renders the registry-owned quote label. VIP and video have no rendering
	path in the shared grid.

## MIU 13 Implementation Findings

- `/headphones/` retains its reviewed gated-media hero, canonical, product-matrix anchor, and OEM
	enquiry target while replacing only the old list/detail controller with the shared family island.
- `/ai-gadgets/` and `/toys/` are static registry-driven shells with one H1, visible breadcrumb,
	canonical metadata, quote CTA, and no route-local merchandising copy.
- Browser interception verified that each route requests its exact `productFamily` at page 1/size 12;
	Headphones exposes three configured filters while AI Gadgets and Toys omit an empty filter bar.

## MIU 14 Implementation Findings

- `/misc/` uses the public heading “Other Electronics & Toys” while retaining the stable internal
	`misc` family key and registry-owned SEO/content contract.
- Public metadata auditing now compares discovered top-level route files to the complete audited
	metadata set, so adding an unaudited route fails without maintaining a second filename allowlist.
- Astro derives indexable family paths from structured catalog frontmatter. Known family routes not
	present in published catalog content are excluded; private, auth, form-result, and redirect paths
	remain excluded by the existing noindex set.
- A real `SITE_URL=https://example.test` build produced 14 pages and sitemap XML containing the hub
	plus all four family routes while excluding sampled private/redirect URLs.

## MIU 15 Implementation Findings

- `/products/item/?slug={slug}` remains the approved category-independent static-host address. The
	shell uses generic bounded metadata; product facts are API-owned and rendered only after runtime
	DTO validation.
- Detail, missing/unknown, retryable error, and loaded states are exclusive. The Gallery now enforces
	the product-specific nine-image ceiling independently of the public API; primary/order and stable
	fallback behavior remain in the shared media components.
- Linked Alibaba pricing suppresses legacy values; unlinked products prefer wholesale then unit
	price, otherwise render the registry quote label. No VIP or video surface is present.
- The product commits as soon as detail resolves. Related products load afterward with abort and
	current-product guards, are restricted to same-family valid-slug rows, and can fail without hiding
	the main detail. Registry-owned OEM/ODM copy and the canonical enquiry CTA complete the detail flow.

## MIU 16 Implementation Findings

- Products replaces the Headphones-only Admin section label and exposes All plus four fixed family
	controls only in that collection. URL state is closed-set, push/back recoverable, and switches reset
	page and selection; New receives the active family as a real form default.
- The existing flat user filter cannot safely absorb a family clause when its combinator is OR.
	Therefore family is an independent closed-set Admin list argument applied by the repository adapters
	as `family AND search AND (user filter)`, preserving legacy missing-family Headphones semantics.
- Unknown family input and family input on non-products reject before storage. CloudBase, local, and
	Admin test adapters all implement the same optional query member.
- Mobile Admin stacks navigation/content, keeps Back/Sign out available, uses a full-width native
	family select, bounds body width, and delegates wide-table horizontal scrolling to the table wrapper.

## MIU 17 Implementation Findings

- The generic form now enforces registry `hideInForm`, fixing the previous gap where deprecated VIP
	fields were hidden in schema metadata but still rendered/submitted. Product forms group identity,
	content, media, pricing/order, and lifecycle while non-product forms retain the ordinary field loop.
- Family changes clear legacy Headphones subcategories when moving to another family and announce the
	change. The selected Admin tab remains the New-product default from MIU 16.
- Alibaba-owned fields remain non-editable and appear only as a read-only source summary on existing
	linked products. Product identity/publication server messages map to slug, SKU, image, family,
	description, name, or archived controls with `aria-invalid`/`aria-describedby` linkage.
- Image management counts committed plus pending uploads against nine, labels the first image Primary,
	preserves submitted order through deterministic reorder logic, disables over-limit selection, and
	associates server image errors with the file input. The form is a native named modal dialog.

## MIU 18 Implementation Findings

- Headphones/auth presentation no longer contains VIP values, labels, locks, or unlock-pricing copy.
- The legacy DTO/storage/API/role fields remain intact; Overstock remains outside this catalog scope.
- Manual Headphones detail pricing is viewer-independent and selects public wholesale, then unit price,
	then quote. Legacy compatibility detail follows the same rule. Alibaba-linked detail still routes by
	link identity and never falls back to any legacy price.
- Focused tests cover wholesale/unit/quote branches, loaded `vipPrice` suppression, anonymous/member
	parity, and Alibaba missing/unavailable modes. Source and built HTML scans cover Headphones/auth;
	browser checks cover family/SKU plus login/register negative presentation.

## MIU 20 Implementation Findings

- The hub and four family routes render one visible breadcrumb hierarchy and one matching
	`BreadcrumbList` each. Catalog frontmatter remains the reviewed static family-content publication
	manifest used by sitemap filtering.
- The query-SKU shell stays generic `noindex,follow`, contains no static Product pricing schema, and
	remains absent from the sitemap. Runtime canonical promotion occurs only after the published-slug
	endpoint returns a publication-complete product; missing, unknown, and transport-error states keep
	the generic `/products/item/` canonical.
- Product schema requires the public equivalent of the server publication contract: family, name,
	slug, SKU, description, and at least one resolved image. The published/non-archived slug endpoint
	is the publication authority; no placeholder ratings, reviews, inventory, warranty, or availability
	claims are emitted.
- Manual visible and schema pricing share one selector: valid wholesale, then valid unit, otherwise
	quote/no Offer. Alibaba-linked products never fall back to manual or VIP values. Fixed source
	pricing emits `Offer`; validated source ranges emit `AggregateOffer`; tiered, negotiable,
	unavailable, and malformed source pricing emit no structured price claim.
- The browser trust boundary mirrors the canonical public Alibaba pricing contract: exact schema
	version, canonical UTC timestamps, known public keys only, safe integer minor units, strict
	per-mode fields, positive ordered non-overlapping tiers, final-only open tiers, and source-MOQ
	compatibility. Invalid payloads fail closed before rendering.
- A long-lived Astro/Vite server can lose hydration after a failed config full reload
	(`astro:server-app.js` resolution). Browser evidence is accepted only from a fresh guarded
	worktree-bound server; unchanged tests passed on the clean process.

## MIU 19 Implementation Findings

- Alibaba implementation remains unchanged; the MIU is test-only and touches no endpoint, scheduler,
	authentication, configuration, worker, or production source file.
- Unmapped source categories create no product and never default to Misc. Mapped sources create only
	unpublished suggestion drafts and do not invent product family, slug, SKU, or image selection.
- Explicit link/unlink preserves family, subcategory, slug, SKU, images, publication, and archive state.
	Promotion fixtures populate all curated V1.1 fields and assert the exact fenced patch key set contains
	only Alibaba materialization fields.
- Shared registry tests pin family/category/identity/media/lifecycle as operator-writable and every
	Alibaba product field, including the operator pin, as generic-Admin read-only.

## Superseded Planning Note

The earlier menu-only Phase 1 scope was superseded by client PDF V1.1. Implementers must use the V1.1 baseline at the top of this file and the current V1.1 LLD/MIU documents; the removed Phase 1 constraints no longer apply.

## SKU URL Clarification

The PDF requires a stable independent SKU address but does not prescribe one exact path syntax. Because the current site is statically hosted and product records live in CloudBase at runtime, V1.1 uses `/products/item/?slug={slug}` as the first stable implementation. It is independent of product family and shareable. A future clean-path migration to `/products/{slug}/` requires a server-rendering/static-feed contract plus redirects and is not silently assumed here.