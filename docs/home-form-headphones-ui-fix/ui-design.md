# Project Form And Headphones UI Design

> Phase 3 specification. Foundation: `DESIGN.md`. Status: G2 approved 2026-07-28; G3 pending. The proposed G3 realization uses a progressively customizable native picker with classic fallback.

## Review Status

This feature has one completed emergency slice and one remaining approved design package. Do not
read future-state screens as already shipped behavior:

| Surface | Status on 2026-07-30 | Evidence / remaining work |
|---|---|---|
| Headphones product visibility after React mount | **Deployed to test/custom domain** at `741b0af` | Async `HeadphonesPage` wrappers no longer depend on `.reveal`; product cards are visibly rendered and basic detail open/return is verified. |
| Site-wide `.reveal` progressive enhancement | **Not implemented** | MIU 5 still changes global CSS to default-visible. This is broader hardening, not a prerequisite for the already-deployed Headphones P0. |
| SY-T8 canonical 18-image re-import | **Operationally verified** | Product/media data is healthy; this is evidence for Gallery design, not a completed frontend MIU. |
| Product Category, hero, catalog decomposition, async states, Load More, bounded Gallery, focus lifecycle, content cleanup | **Designed, not implemented** | MIUs 4 and 6-13 plus the remaining portion of MIU 5. |
| CloudBase `thumb`/`card`/`detail` variants | **Deferred follow-up** | No transform or generated derivative belongs to this delivery. |

G1 and G2 are approved. The revised architecture, screen board, performance boundary, and MIU
execution contract are prepared for explicit G3 approval. G4 test-plan approval follows G3; no
remaining runtime implementation starts before both gates.

## Visual Screen Board

[Open the complete browser-renderable UI screen board](UI-SCREEN-BOARD.html). It is a review
artifact, not application code or a deployed page. `DESIGN.md` remains the token authority and this
document remains the normative interaction contract; the board makes their intended pixels and
composition easier to inspect.

| Screen | Visual intent | Owning MIUs |
|---|---|---|
| [01 - Product Category states](UI-SCREEN-BOARD.html#screen-select) | Shared closed control, capable-browser picker, native fallback, focus and invalid states | MIU 4 |
| [02 - Desktop/mobile product hero](UI-SCREEN-BOARD.html#screen-hero) | Real gated media, shorter hierarchy, compact proof, mobile first-viewport composition | MIUs 7, 8, 12 |
| [03 - Catalog success and Load More](UI-SCREEN-BOARD.html#screen-catalog) | Stable grouped cards, result progress, 12-item request boundary, explicit pagination | MIUs 9, 10, 13 |
| [04 - Loading/error/empty](UI-SCREEN-BOARD.html#screen-states) | Mutually exclusive resilient async states with recovery | MIU 10 |
| [05 - Product media states](UI-SCREEN-BOARD.html#screen-media-states) | Hero loading and terminal hero/card/detail fallbacks with stable geometry | MIUs 8, 12 |
| [06 - Compact product detail](UI-SCREEN-BOARD.html#screen-detail) | In-page detail, contained 520px media, four previews, clear enquiry path | MIUs 8, 11, 13 |
| [07 - Inline View All](UI-SCREEN-BOARD.html#screen-expanded-gallery) | All 18 thumbnails wrap inline; selected and focus states remain distinct | MIU 8 |
| [08 - Responsive and focus storyboard](UI-SCREEN-BOARD.html#screen-responsive-focus) | Explicit 390/768/1024 grids and card -> heading -> card focus return | MIU 13 |
| [09 - Focused page flow](UI-SCREEN-BOARD.html#screen-flow) | Hero -> catalog -> optional detail -> real OEM enquiry; duplicated proof removed | MIUs 11-13 |

The board intentionally shows final target states. Phase 8.2 visual verification must later capture
the implemented page at 390px and 1440px and compare it against these screens plus the responsive
acceptance matrix below. A mockup match never substitutes for DOM geometry, focus, image request,
role-projection, or reduced-motion assertions.

## Design Goal

Make the shared OEM form and restored Headphones catalog feel like one maintained product, not two isolated patches. The form receives a deliberate, reusable single-select interaction; Headphones becomes visibly usable, product-led, responsive, and consistent with the catalog's existing media/pricing language.

## Baseline Evidence

Observed on the public custom-domain test environment on 2026-07-28:

- React hydration succeeds and the anonymous API renders 5 product buttons in the DOM.
- All 6 `.reveal` wrappers inside the client-only island compute to `opacity: 0`, so the hero is followed by apparent empty space.
- Four representative product images load at real dimensions; the SY-T8 representative image has natural size `0x0` because its protected media request fails.
- The current mobile hero puts a low-contrast headphone line icon in a large square frame after both CTAs. It extends the hero well beyond the first viewport and visually detaches product imagery from the headline.
- Existing product cards contain useful data but vary in height because source descriptions are uneven.
- Product Category has always been a browser-native select in repository history; there is no lost custom component to restore.

## Direction

Keep the existing navy/indigo and amber brand language, Poppins/Inter typography, and procurement-oriented copy. Remove visual stand-ins and tighten hierarchy:

- Real product media replaces the hero line icon.
- Product groups render immediately usable after data arrival; reveal motion is optional enhancement, never a visibility gate.
- Cards share the established catalog media/pricing presentation while retaining Headphones category grouping.
- Product Category becomes a branded single-select with complete form and keyboard behavior.

## Surface 1: Shared Product Category Field

### Composition

- Keep the existing label, required marker, hint, and two-column ProjectForm grid.
- Trigger height: 48px; width: 100%; radius: 8px; white surface; slate-300 border.
- Placeholder: `Select a product category…` in muted text.
- Filled value uses normal body contrast. Chevron sits at the trailing edge and rotates only while open.
- Popup matches trigger width, has an 8px offset, 8px radius, slate-200 border, and restrained floating shadow.
- Options use at least 44px row height. Hover/focused option uses brand-50; selected option uses brand-700 text plus a check icon.
- `Other` remains a literal selectable value and does not reveal another field in this delivery.

### States

| State | Visual and behavior |
|---|---|
| Default | Placeholder, slate border, chevron down |
| Hover | Border increases to brand-400 |
| Focus-visible | Brand-600 border plus visible 2-3px ring |
| Open | Brand focus treatment, popup positioned within viewport |
| Selected | Value text plus selected option check; serialized exactly once |
| Invalid | Red border/ring and inline actionable error; first invalid control receives focus on submit |
| Disabled | Muted surface/text and no pointer interaction; retained for primitive completeness |

### Interaction Contract

- Mouse and touch select one option and close the popup.
- Tab enters/leaves the control; Arrow keys move active option; Home/End jump; Enter/Space select; Escape closes and restores trigger focus; typeahead finds matching labels.
- Label activates/focuses the control.
- The actual named form control remains associated with `category`, required, resettable, and visible to `form.elements`.
- Before enhancement or when JavaScript fails, a usable native select remains available. Enhancement must not create duplicate values or a layout jump.

### Responsive

- Same field width and height at every breakpoint.
- Popup uses trigger width on desktop and mobile, constrained to viewport gutters.
- Long option labels wrap to two lines without clipping; the popup scrolls before exceeding available viewport height.

## Surface 2: Headphones Hero

### Desktop At 1024px And Above

- The Headphones hero does not own or restyle `SiteHeader`. Measured hydrated content requires
	1360px as the minimum desktop candidate. A content-fit controller measures the complete legal
	brand, five links, hydrated account controls, fonts, text enlargement, and 32px gutters; if they
	do not fit, the native mobile disclosure remains active even above 1360px. Browser tests prove
	guest containment, long authenticated identity fallback, 125% text enlargement, short-landscape
	menu scrolling, no-JS access, and focus continuity. The hero itself may still use its
	two-column composition from 1024px; header and hero breakpoints have different responsibilities.
- Preserve the established dark category hero and left-aligned sales hierarchy.
- Use a 55/45 composition: copy and actions on the left; a real published headphone product on the right.
- Remove the square glass frame, blur halo, and standalone line icon entirely.
- Product media is unframed on a transparent/quiet stage, uses `object-contain`, and aligns optically with the headline rather than the CTA row.
- Media source is a reviewed image ID rendered through the existing gated catalog-image route, never a copied static derivative or hard-coded current service URL. It must be hero-eligible rather than merely the first HTTP 200 image.
- Hero-eligible media must have sufficient resolution, a product-dominant crop, and a background that can be cleanly integrated with the dark hero. A white marketplace square may sit on a deliberate neutral media stage but must not appear as an accidental white box.
- Replace the 4 promotional badges with at most 3 short, factual proof points in one quiet row. Detailed factory/logistics claims belong on `/oem`.
- Primary CTA remains amber. Secondary CTA remains a clear link/button to the product matrix.

### Mobile Below 640px

- Order: eyebrow → short literal H1 → concise body → real product media → compact proof row → CTA row.
- Use one responsive headline, `OEM Headphones, Built for Your Brand`, at 34px with a tight readable line height on mobile. The longer factory/direct/global value proposition moves into the supporting sentence.
- Product stage reserves a stable 4:3 area between 160px and 180px tall, with no decorative card border. It sits close enough to the copy to read as the product being sold.
- Proof points use at most 3 short factual labels in one compact wrapping row; do not render mini-cards or multi-line promotional chips.
- Primary CTA remains a 48px button; `Browse Products` becomes a compact secondary text link with arrow on mobile. Both stay in one row at 390px.
- Hero vertical padding is reduced so the beginning of Product Line remains visible at the bottom of a common 844px viewport after the fixed header.
- The product visual never appears as an isolated block after both actions.

### Hero Media States

| State | Result |
|---|---|
| Loading | Reserved stage with a low-motion neutral shimmer and accessible loading text outside the image |
| Success | Real product image with meaningful product alt text |
| First image fails | Try the next deterministic valid catalog image without looping |
| No image succeeds | Stable branded fallback containing the line-icon vocabulary and `Product image unavailable`; no glass frame or fake product |
| Reduced motion | No shimmer or entrance transform |

## Surface 3: Product Matrix

### Structure

- Product Line heading and explanatory copy are visible immediately; no client-only reveal dependency.
- Preserve category groups and count badges because they help procurement scanning.
- Each group uses the standard 1/2/3/4-column grid at mobile/sm/lg/xl.
- Cards reuse one shared product media and pricing presentation. Headphones-specific detail navigation may remain an explicit variant.
- Card media is square and `object-contain` for product inspection.
- Identity/description area reserves a consistent track; descriptions clamp to 2 lines so cards align within each group.
- Unit price uses the body/control face at 14px/600 rather than display-heading emphasis. `View
	details` uses 12px/500 so product identity remains the card's strongest text signal.
- Entire card action has a visible `focus-visible` state and remains a semantic button only if it expands in-page. If it navigates, it must be a link.

### Async States

- **Loading:** 4-8 skeleton cards matching final geometry; reduced-motion removes pulsing.
- **Error:** full-width status band with concise message and `Try Again` button; announced politely.
- **Empty:** full-width neutral state explaining that no published models are available and linking to the OEM inquiry section.
- **Success:** category groups, exact result count, and visible cards. Computed opacity must be `1` without manual scrolling.
- Fetch all catalog pages or expose an explicit pagination/load-more contract; silently truncating at 48 is not an accepted design state.

### Product Detail

- Selecting a card expands one detail band below the matrix and moves focus to its heading after render.
- `Back to all models` closes detail and returns focus to the originating card.
- Gallery, spec list, PriceBlock, and inquiry CTA retain their existing hierarchy.
- This is an in-page detail band, not a viewer, modal, or lightbox. It does not add a backdrop, focus trap, body-scroll lock, or full-viewport overlay.
- The main gallery frame uses `object-contain`, remains centered, and is capped at 520x520 CSS pixels on desktop. At smaller widths it uses the available container width without widening the document.
- Automatic hover magnification/panning is removed. Pointer movement alone never changes image scale, position, opacity, or rendering mode. Any future magnifier requires a separately reviewed explicit control.
- Gallery detail initially shows the active image plus at most four thumbnail previews. `View All` reveals the remaining media on explicit user intent in a bounded wrapping layout; closed detail mounts no gallery media.
- The normal document may scroll vertically after detail expands. Thumbnail expansion never creates page-level horizontal overflow or an image-owned scroll trap.
- Image errors use the same media fallback as cards; the detail frame never collapse-shifts.

## Surface 4: Focused Page Composition

The final page flow is `Hero → Product Matrix → Optional Product Detail → Enquiry CTA → Footer`.

- Remove the entire `Factory Strength & Quality Assurance` four-card section. It repeats generic factory, quality, customization, and logistics claims and is not product-discovery content.
- Remove the duplicate standalone Quality & Testing, Certifications, and Global Clients bands from `headphones.astro`.
- `/oem` remains the canonical owner of development capability, real factory media, process, quality, and logistics content.
- `/portfolio` remains the canonical owner of customers, cases, certificates, and test-report proof.
- The bottom enquiry CTA may include one quiet `Explore our OEM capabilities` link to `/oem`; do not reproduce those pages' content as cards.
- Keep one bottom enquiry CTA band. Guest navigation goes to login only where authentication is truly required; no design text claims durable inquiry success while the current dialog is simulated.

## Entitlement And Media Rules

- Anonymous, viewer, member, contributor, and admin see the same published product IDs and public fields.
- Only member, contributor, and admin may receive/show `vipPrice`; locked messaging never embeds or guesses the hidden value.
- The UI does not bypass protected media delivery. A failed authorized public image renders fallback while the counter data is diagnosed and reconciled separately.
- Counter diagnostics have no public visual state in this feature; product-scoped read-only checks and browser evidence must show valid referenced images while known unreferenced media remains unavailable.

## Responsive Acceptance Matrix

| Viewport | Hero | Product grid | Form select |
|---|---|---|---|
| 375/390px | 34px literal H1; 160-180px real media before a compact proof/CTA row; no icon box; Product Line hint visible; no overflow | 1 column, stable card width, detail stacks | Full width; popup inside 16px gutters |
| 768px | Compact 2-part composition or centered stack; no oversized empty region | 2 columns | Matches adjacent field width |
| 1024px | 55/45 unframed product composition | 3 columns | Popup collision-safe |
| 1440px | Media and copy optically balanced inside 80rem container | 4 columns | No visual drift from text inputs |

Every viewport check pairs a screenshot with `scrollWidth <= clientWidth`, card geometry, image natural dimensions, and computed product-group opacity.

## Motion And Reveal

- Static Astro sections may keep the shared reveal treatment.
- Client-fetched headings, states, product groups, advantages, and CTA render visible by default. If the architecture extends the reveal controller to dynamic nodes, visible fallback remains the default when observers fail.
- Reduced-motion mode shows all content immediately and disables skeleton pulse, card lift, image zoom, and smooth scrolling. Detail navigation uses instant/auto scrolling under this preference.

## Audit

Audited against the current Web Interface Guidelines and the installed UI/UX design guidance on 2026-07-28.

| Finding | Resolution in this design |
|---|---|
| Hero uses placeholder line art despite real product media | Replace with deterministic real catalog media; stable factual fallback only |
| Mobile product visual appears after CTAs in a detached oversized frame | Reorder media before trust/CTA and remove frame; cap mobile stage height |
| Client-mounted `.reveal` content can remain transparent | Async content visible by default; reveal cannot gate availability |
| Custom popup would risk incomplete keyboard/focus behavior | Full single-select keyboard, focus-return, typeahead, and form contract specified |
| Existing controls remove outline without universal replacement | Require explicit `focus-visible` ring on all interactive primitives |
| Async error has no recovery action | Add `Try Again` and polite announcement |
| Product images lack a shared failed-media state | Stable fallback, no request loop, no collapse |
| Emoji appear inside generic advantage cards | Remove the entire duplicated advantage section |
| Generic advantage cards duplicate canonical OEM content | Remove the section; link to `/oem` from the enquiry band if needed |
| Cards vary with long content | Stable media/info tracks and line clamping |
| Shared-tab viewport can be host-remapped | Final evidence uses isolated Playwright contexts at exact widths |

### Audit Outcome

No unresolved design blocker. Architecture must still choose the reusable select implementation and catalog/hero data ownership; both choices must satisfy this specification and the current third-party contract gate.

## Visual Done Conditions

- Product Category looks and behaves identically on homepage and `/oem`, including invalid, keyboard, touch, and no-JS paths.
- Desktop Headphones keeps the accepted dark brand hierarchy while showing a real product without a decorative frame.
- Mobile Headphones has no line-icon box, no product visual after the actions, no horizontal overflow, and exposes the next Product Line section in the first viewport.
- The product catalog omits `Factory Strength & Quality Assurance`, standalone quality, certification, and client-logo sections; canonical proof stays on `/oem` and `/portfolio`.
- Five current published products are visibly rendered exactly once; future catalog results are not silently capped.
- Every success screenshot is backed by computed opacity `1`, nonzero card bounds, and image/fallback evidence.
- Role projection and protected-media negative assertions remain green.
