# Home Form And Headphones UI Repair - Architecture

> Phase 4 proposal for G3 approval. Inputs: approved `DESIGN.md`, `ui-design.md`, public custom-domain test-environment evidence, installed package source, and current repository contracts.

## Decision Summary

1. **Select:** adopt a progressively customizable native public select. It styles the picker with `base-select` where supported and falls back to a classic native picker elsewhere. Do not add Radix, Headless UI, React Aria, or a local listbox state machine.
2. **Hero:** pin an ordered set of reviewed product `imageId` records in typed content and render them through the existing protected public image route. Do not choose hero media from runtime catalog order, issue a second catalog request, or copy gated bytes into static hosting.
3. **Island:** render Headphones with `client:load` instead of `client:only`; browser-only session and fetch work stays in effects.
4. **Reveal:** make reveal CSS default-visible and animation-only. React catalog nodes do not depend on `.reveal`; no global `MutationObserver` is introduced.
5. **Catalog:** give public catalog pages a stable order and expose explicit `Load More` pagination with cancellation and ID deduplication. Do not describe offset pages as a consistent snapshot.
6. **Content:** remove generic advantage, quality, certification, and client bands. Link the persistent inquiry CTA to `/#oem-inquiry` and stop opening the simulated inquiry modal from Headphones.
7. **Media:** keep the public image gate unchanged; verify affected product references read-only and quarantine unrelated historical counter drift. No global backfill belongs to this feature.
8. **Performance scope:** ship the measured baseline with the existing gated originals. CloudBase/Data万象 variants and a separately governed static marketing hero are follow-up decisions, not hidden implementation work.

## Deliberate G2 Realization

The approved design described custom option-row chrome. Architecture deliberately narrows that part:

- The closed Product Category control is fully branded: 48px height, shared border/ring states, placeholder, value, and chevron.
- The opened option picker is browser/platform native. Exact popup radius, row colors, and selected check placement are not cross-platform guarantees.
- This is the only approach that preserves one control, native `name`/`required`, reset, autofill, mobile picker behavior, visible validation focus, and no-JavaScript operation without adding a dual-control hydration protocol.

G3 approval includes this trade-off. If pixel-identical popup chrome is mandatory, architecture must return to G2 and design a separate progressive-enhancement/validation protocol before adding a library.

Current browser capabilities improve this trade-off: Chrome/Edge 135+ support customizable native selects (`appearance: base-select`, `::picker(select)`, `:open`, and `::checkmark`). Firefox and current Safari stable retain the classic native picker. The control therefore has full custom picker styling where supported and functional native degradation elsewhere. See `SELECT-OPTIONS.md`.

## Component Boundaries

| Boundary | Responsibility |
|---|---|
| `components/form/PublicSelect.astro` | One real native select with its reusable Tailwind control contract, custom closed-control wrapper/chevron, typed options, `name`, `required`, `form`, description and error references. |
| `components/ProjectForm.astro` | Data-driven field composition, generic invalid/error synchronization, existing `form.elements` serialization and upload/submission flow. |
| `i18n/headphones.ts` and Headphones markdown | Typed source of hero, matrix, detail, error/empty/retry, and CTA copy. Route-local `PageStrings` is removed. |
| `pages/headphones.astro` | Static responsive hero shell, SSR-first `ProductMedia client:load` with ordered gated sources, `<noscript>` recovery, catalog `client:load` mount, persistent inquiry CTA, no duplicated proof sections. |
| `islands/shop/api.ts` | AbortSignal support and explicit page fetches for `Load More`; each request uses the current session token. |
| `islands/shop/ProductMedia.tsx` | Stable aspect ratio, ordered source failure handling, terminal branded fallback, and consistent alt behavior. |
| `islands/shop/HeadphonesPage.tsx` | Thin state/controller boundary: session readiness, request lifecycle, active product and focus origin. |
| `HeadphonesCatalog.tsx` | Loading, actionable error/retry, empty and grouped success states; polite announcements and exact result count. |
| `HeadphonesProductCard.tsx` | Semantic in-page expansion button using shared media and pricing primitives. |
| `HeadphonesProductDetail.tsx` | Gallery/spec/pricing composition, focusable heading, close and focus return. |
| `global.css` / `BaseLayout.astro` | Reveal animation that defaults content to visible; the existing one-time observer remains sufficient for optional animation. |
| `functions/public-api/handler.ts` | Existing allowlisted projection plus fixed stable catalog sort; no response-shape or entitlement change. |
| Existing admin/DB diagnostics | Product-scoped read-only reference verification, public URL/browser smoke, and quarantined unrelated drift. No write, action, or schema change. |

## Data And Event Flows

### Product Category

`OEM markdown FormField -> ProjectForm -> PublicSelect -> native category select -> form.elements -> existing submitProject`

- `Other` remains a literal option.
- There is exactly one successful control named `category` at every lifecycle stage.
- JavaScript enhances inline errors and performs the existing JSON/upload submission. Without JavaScript the native control remains visible, labelled and selectable, but the existing form has no non-JavaScript transport.
- Both homepage `#oem-inquiry` and `/oem#submit` consume the same `ProjectForm` component.

### Catalog And VIP Projection

1. Astro emits hero, Product Line heading, stable loading geometry, and a no-JavaScript recovery link.
2. `client:load` hydrates immediately.
3. `useSession` resolves the current user; the request effect loads page 1 with the current token and resets when the local auth identity changes.
4. Each Headphones request uses `pageSize=12` and stable server order `_id asc`; the endpoint's existing maximum of 48 remains available to other callers.
5. When `loadedUniqueCount < total`, the UI renders a `Load More` button. Each activation fetches the next page, appends only unseen IDs and exposes progress.
6. Offset pagination is eventual consistency. Concurrent publish/unpublish or role revocation can change later responses; the client never promises a snapshot or uniform entitlement across time. Local auth changes reset to page 1, while the server revalidates the user row on every request.
7. For any single response, the server returns published product IDs for all roles and attaches `vipPrice` only for currently entitled member/contributor/admin users. The UI also gates VIP rendering on current local entitlement.

### Product Detail Focus

`card button -> record origin -> set active product -> detail mounts -> focus detail heading -> Back closes -> focus origin card`

The action remains a `<button>` because it expands in-page content. Any future routed detail variant must use an `<a>` instead.

### Persistent Inquiry

Headphones detail and bottom CTA use the existing `OEM_INQUIRY_HREF` (`/#oem-inquiry`). The Headphones page no longer presents `InquiryForm`'s simulated delay as a durable submission. Wiring product preselection into the form is explicitly out of scope.

### Product-Scoped Media Verification

`read affected product -> resolve its image IDs -> compare each aggregate published reference -> smoke projected URLs/browser -> record unrelated global drift as quarantined baseline`

No public image condition is relaxed and no global counter write occurs. A broken product image renders the shared UI fallback while the data issue remains visible to operations.

## Hero Media Contract

The sources are independently observed from the same live public product and remain in reviewed fallback order:

| Order | Image ID | Visual role | MIME/dimensions | Source SHA-256 |
|---:|---|---|---|---|
| 1 | `0e0afdc26a68209e00523aa031e56460` | Primary reviewed product view | JPEG, 800x800 | `c214432ede60268b25c7001dc06873240a533094c3adc89760df95c2f4e7179c` |
| 2 | `7b76ee416a68209d0110670520562928` | Black/white product backup | JPEG, 800x800 | `154a9b12ac090bcb8330c5ec968077caf90eaece14cbdc8ce87d8fc477062241` |
| 3 | `0e0afdc26a68209c00523a7b50cb8647` | Red/white product backup | JPEG, 800x800 | `e4480b78b451261611e74a373ab84048dded0fe255803315247d444bf41c1de6` |

All three records belong to product `0e0afdc26a6820b900523bfb27a9a5cd` (High Quality Wired Headphones BT Noise Cancellation Foldable with pop-up Window Headphones). Typed Headphones content stores the reviewed ordered records, product name/alt and provenance. `headphones.astro` maps each ID through `apiMediaUrl('/api/images/<id>')` and passes the URLs to the shared `ProductMedia` component. The first source is present in SSR HTML; `client:load` advances to the next reviewed gated source on error. No current absolute service URL or image bytes are stored in the site.

The original white product canvases are treated as an intentional neutral media stage; they are not presented as transparent cutouts or wrapped in the removed glass/halo frame. If all three gated sources fail, ProductMedia renders the branded `Product image unavailable` terminal fallback without retry loops.

Each image route is governed by the image document, not by ownership of the pinned source product. Unpublishing that product reaches the terminal fallback only when the image's aggregate `publishedRefCount` becomes non-positive. An image that is still referenced by another published record remains public by design. An inactive storage row, a non-positive/invalid aggregate count, or unavailable bytes returns 404 and advances the ordered fallback. This preserves the existing status/refcount gate without claiming source-product ownership revocation.

The current wide orange `Beats Pro 3` artwork is explicitly ineligible for the hero because it is abstract campaign art, not inspectable headphone product media.

## Stable Page And Load-More Contract

The existing API caps every page at 48. Fetch-all is safe only after the server supplies a total order. `listCatalog` therefore passes:

```ts
sort: [{ field: '_id', dir: 'asc' }]
```

This changes the endpoint's previous implicit newest-first order to an explicit stable identifier order. Headphones has no approved newest-first merchandising contract, while `_id` is unique and is already the repository's canonical sort for absolute counter reconciliation. The simpler order also avoids silently introducing a CloudBase compound-index dependency.

Tests with more than 48 stable fixture items prove that sequential user-triggered pages append each fixture ID once. This does not create a snapshot: concurrent publication changes may shift offsets. ID deduplication prevents duplicate cards; the visible `Load More` contract prevents silent truncation; a later cursor/revision API is deferred until snapshot consistency is a real product requirement.

The Headphones controller requests 12 items per page rather than the API maximum of 48. This bounds initial product/image discovery to three desktop rows while retaining explicit Load More. The API cap remains 48 for other callers.

## Performance Contract

The page remains an Astro static/prerendered shell with a `client:load` catalog. Dynamic server SSR is rejected because catalog responses vary by Authorization and current identity lives in browser storage; changing Astro output mode would add a server runtime without fixing the measured API/media latency.

Baseline implementation requirements:

- hero media is discoverable in initial HTML and is the only high-priority image;
- cross-origin API/media origin receives one preconnect;
- cards render one primary image with native lazy loading, asynchronous decoding, and fixed geometry;
- gallery media does not mount before detail selection; active media loads first, at most four thumbnail previews mount initially, and `View All` explicitly reveals the remaining lazy/low-priority thumbnails;
- the controller issues one initial 12-item request, aborts stale requests, and loads later pages only on command;
- no automatic retry, speculative anonymous catalog preload, image prefetch fan-out, TanStack Query migration, service worker, or unverified CDN claim is added.

Measured baseline and performance budgets are in `PERFORMANCE.md`. G3 chooses exact gated revocation for the hero despite its measured LCP risk. A static marketing derivative requires an explicit content-governance change and revised hero MIU before implementation. CloudBase image variants are deferred under `IMAGE-VARIANTS.md`; no transform or derivative is enabled by this delivery.

## Reveal Contract

- `.reveal` has no hidden default state.
- `.reveal.is-visible` runs a one-time `reveal-in` keyframe from opacity/translation to the normal visible state.
- With JavaScript disabled, observer unavailable, observer late, or content mounted asynchronously, content stays visible.
- Reduced-motion mode applies no reveal or skeleton animation.
- Headphones React components omit `.reveal` to make the ownership boundary explicit.

## Third-Party Surfaces

Full evidence is in `SDK-PROBE.md`.

| Surface | Decision |
|---|---|
| Astro 6.4.6 `client:load` | Use: static/server HTML plus immediate hydration. |
| Astro 6.4.6 `client:only` | Replace on Headphones: it intentionally skips server rendering. |
| `@astrojs/react` 5.0.7 + React 19.2.7 | Use: installed versions explicitly support React 19. |
| Radix Select 2.3.7 | Reject for this change: verified form bridge, but no installed dependency or no-JavaScript native fallback. |

## Cloud Pattern Audit

- Selected: Static Content Hosting, existing Anti-Corruption Layer, existing Materialized View (`publishedRefCount`).
- Rejected: Cache-Aside, automatic Retry, Gateway Aggregation, CQRS, Strangler Fig and global MutationObserver.
- No cloud-pattern blocker remains. See `.claude/docs/adr-phase4-home-form-headphones-ui-fix.md`.

## Cross-File Seams

- [ ] OEM options, placeholder and literal `Other` reach homepage and `/oem` through the same component.
- [ ] With JavaScript disabled, the one native `category` control remains visible, labelled, selectable and natively valid; no whole-form submission claim is made.
- [ ] Expanded Headphones markdown exactly satisfies `HeadphonesContent`.
- [ ] Hero product/ordered image IDs, source hashes, gated URL construction, intrinsic dimensions and fallback progression agree across content, code and provenance tests.
- [ ] `client:load` SSR output contains Product Line and loading/recovery content before hydration.
- [ ] Stable server sort and client page/load-more/deduplication checks agree without claiming snapshot semantics.
- [ ] Local auth changes reset to page 1; every request still relies on server-side row revalidation.
- [ ] Anonymous/viewer/member/contributor/admin product IDs are equal; only VIP field presence differs.
- [ ] No Headphones React node depends on `.reveal`; site-wide no-JavaScript content is visible.
- [ ] Product card/detail media share terminal fallback behavior without request loops.
- [ ] Detail open mounts only the active image plus at most four lazy thumbnail previews; remaining thumbnails require `View All`.
- [ ] Card -> detail -> back focus lifecycle works with keyboard and reduced motion.
- [ ] Public projection and image authorization predicates remain unchanged.
- [ ] Product-scoped reference reads and positive/negative image/browser smokes are recorded; unrelated historical drift remains quarantined with no global apply.

## Build, Deploy And Runtime Impact

- **Site:** adds an Astro form primitive and decomposed React modules; the hero continues to fetch through the existing gated media API. Site build and CloudBase static app update required.
- **Public API function:** fixed `_id` ordering is a user-visible order change and a code change, so function build/package/deploy and artifact smoke are required before the site deploy. No new index is assumed.
- **Admin/DB:** no code or schema change and no counter mutation. Product-scoped reads plus public/browser verification are recorded; unrelated historical drift remains quarantined.
- **Dependencies/env:** no package, lockfile, environment variable, collection, index, route or response-shape addition.
- **Hosting:** no new copied product-media asset is published. No existing public asset is retired by this work.
- **Image processing:** no Data万象 feature is enabled and no `card`/`thumb`/`detail` object is generated. `IMAGE-VARIANTS.md` defines the separate contract/billing probe required before that work.

## Phased File Boundaries

The exact units and file sets live in `home-form-headphones-ui-fix-miu-breakdown.md`. Implementation is grouped into nine approval phases, each touching at most five distinct files:

1. Step 0 cleanup: MIU 1, mandatory separate commit.
2. Build/runtime and public ordering: MIUs 2-3.
3. Public select and reveal safety: MIUs 4-5.
4. Catalog client and typed content: MIUs 6-7.
5. Product media and deterministic page state: MIUs 8-9.
6. Catalog/card/detail presentation: MIUs 10-11.
7. Headphones shell and controller: MIUs 12-13.
8. Deployment smoke and current deployment docs: MIUs 14-15.
9. Canonical production-readiness gate: MIU 16.

Each phase ends with focused validation and an explicit user approval before the next phase. Product-scoped media verification is a read-only post-deploy acceptance gate; any future counter cleanup is a separate exact-list design.

## Strongest Attack

The styled-native select cannot reproduce the approved custom popup pixel-for-pixel. That is a real design compromise, not an implementation detail. The selected architecture values the stronger requirements: one form value, browser validation focus, no-JavaScript operation, mobile-native picker, reset/autofill and zero new state-machine dependency. G3 must explicitly accept this realization; otherwise the work returns to design rather than silently installing Radix.

A second attack is hero staleness: the pinned image ID may stop being public. That is intentional fail-closed behavior, not a reason to copy the bytes. The provenance record makes the selection reviewable and the UI fallback keeps the page coherent until content owners select another eligible image.

A third attack is catalog ordering and consistency: `_id asc` is stable but not editorial, and offset pages are not a transaction snapshot. If merchandising or snapshot consistency becomes a product requirement, add an explicit `sortOrder` plus cursor/revision contract in a separate schema/resource change rather than inferring intent from creation time.