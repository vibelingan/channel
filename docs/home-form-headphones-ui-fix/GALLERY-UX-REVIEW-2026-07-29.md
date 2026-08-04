# Headphones Gallery UX Review - 2026-07-29

Status: design review implemented in MIU 8; deployment verification pending.

The diagnosis and findings below are the **pre-MIU-8 snapshot captured on 2026-07-29**. They remain
as the rationale for the decision, not a description of current `HEAD`. The post-implementation
status is recorded after the findings.

## Executive Summary

The SY-T8 import is healthy. The newly visible problem is in the existing Headphones detail UI,
not in the imported image files or public media route.

Clicking a product does not open a viewer, lightbox, or modal. `HeadphonesPage` mounts an in-page
detail section below the product matrix and smoothly scrolls that section into view. The document
therefore becomes taller and shows a normal vertical page scrollbar.

The image-only movement under the pointer was intentional pre-MIU-8 behavior: `Gallery` automatically
replaces the base image with a 200% background image on fine-pointer hover, then changes its
background position on every mouse move. This hover zoom feels like an image-owned scrollbar even
though neither the page nor a thumbnail strip is being scrolled by the pointer.

The pre-MIU-8 implementation also mounted all 18 SY-T8 thumbnail controls in one non-wrapping flex
row. That contradicts the approved four-preview plus `View All` design and increases both overflow
risk and unnecessary image discovery.

## What Is Already Proven

- The SY-T8 product retained its existing product ID and now projects 18 canonical image IDs.
- All 18 public image responses returned HTTP 200 with decodable JPEG bytes.
- Browser verification selected and decoded all 18 gallery images successfully.
- The closed product detail mounts no gallery.
- The detail is an ordinary section: there is no dialog role, backdrop, focus trap, fixed
  full-viewport overlay, or body scroll lock in this path.

These facts separate the media-import result from the gallery UX defect. Re-uploading or changing
image metadata would not fix the observed pointer interaction or layout.

## Findings

### P0 - Automatic hover zoom is disorienting

Before MIU 8, `Gallery.tsx` activated zoom merely because a fine pointer entered the frame. It hid the base
image, renders the same source at 200%, and pans it with pointer position. There is no explicit zoom
command, persistent mode indicator, or reduced-motion check.

Decision: remove automatic hover zoom in this delivery. Keep one stable inspection image. A future
magnifier must be an explicit control with its own focus, Escape, touch, reduced-motion, and
accessibility design; it is not part of this fix.

### P0 - Main image has no explicit desktop maximum

Before MIU 8, the square gallery occupied half of the 80rem content container and could approach 600x600 CSS pixels
on desktop. On smaller layouts it becomes a full-width square above the product information. The
current `object-cover` presentation can also crop tall source images and amplify the perceived
scale.

Decision: use `object-contain`, center the frame, and cap its desktop size at 520px while preserving
stable responsive geometry. At smaller widths it may use the available container width but must
never widen the document.

### P0 - All thumbnails mount at once

The pre-MIU-8 implementation rendered all image buttons immediately after detail opened. For SY-T8
that means 18 thumbnails in a single non-wrapping row. This was already identified before the
re-import in `ui-design.md`, `PERFORMANCE.md`, `IMAGE-VARIANTS.md`, and MIUs 8/13.

Decision: initially mount the active image plus at most four lazy thumbnail previews. When more
images exist, render `View All`. Expanding keeps thumbnails inline in a bounded wrapping grid; it
does not open a viewer and never creates page-level horizontal overflow.

### P1 - Detail navigation and reduced motion are incomplete

Before MIU 8, smooth `scrollIntoView` did not move keyboard focus to the detail heading, Back did
not restore focus to the originating card, and reduced-motion users still received smooth scrolling
and hover zoom. MIU 8 fixed reduced-motion scrolling and removed hover zoom; MIU 13 still owns the
detail-heading and Back-to-origin focus cycle.

Decision: implement the already-approved card -> detail heading -> originating card focus cycle.
Use instant/auto scroll under `prefers-reduced-motion: reduce`; with automatic zoom removed, pointer
movement no longer changes the image.

### P1 - Media fallback and intrinsic sizing were pending

Before MIU 8, Gallery images did not use the planned shared terminal fallback and did not declare intrinsic
dimensions. The frame reserved space through CSS, but failed images did not produce the
approved branded product-media state.

Decision: complete the existing `ProductMedia` contract in MIU 8. Keep all media behind the current
gated `/api/images/:id` route. Do not add CloudBase transforms or generated variants in this phase.

## Post-Implementation Status

MIU 8 resolved automatic hover zoom, the 520px/object-contain frame, four-preview request gating,
inline `View All`, terminal fallback/intrinsic sizing, selected/disclosure focus visuals, and
reduced-motion scrolling. The public Playwright suite preserves these behaviors across 390, 768,
1024, and 1440px viewports. MIU 13 still owns detail-heading focus after card selection and Back
focus restoration to the originating card.

## Reviewed Design

The detail remains an in-page band, not a modal:

```text
Product Matrix
  -> select one product
  -> focusable in-page Product Detail
       -> contained main image (max 520px desktop)
       -> 4 initial thumbnails
       -> View All -> bounded wrapping thumbnail grid
       -> product data and enquiry action
  -> Back to all models -> close and restore card focus
```

The main frame is stable, uses `object-contain`, and does not react to pointer movement. Thumbnail
selection changes only the active source and selected state. `View All` is an ordinary button with
visible focus and an accessible expanded state.

Image variants remain deferred. The immediate waste comes from discovering unnecessary originals,
so interaction-gated mounting, native lazy loading, async decoding, and stable geometry are the
current fix. A separately verified `thumb`/`card`/`detail` transform can reduce bytes later without
weakening the publication/refcount gate.

## Acceptance Gates

### Layout and interaction

- At 390x844, 768x1024, 1024x768, and 1440x900, `scrollWidth <= clientWidth` before and after
  `View All`.
- The main frame is no larger than 520x520 CSS pixels on desktop and never exceeds its container.
- Main media uses `object-contain`; tall and square source images remain fully inspectable.
- Pointer enter and movement do not hide, magnify, pan, transform, or reposition the main image.
- Opening detail creates no dialog, overlay, backdrop, or body scroll lock.
- Vertical document scrolling remains available; a normal vertical page scrollbar is acceptable.

### Gallery and network

- Closed detail mounts no gallery media.
- Initial detail mounts/requests no more than the active image plus four thumbnail previews.
- Products with one to four images do not show `View All`; five or more do.
- `View All` reveals every remaining thumbnail inline without widening the document.
- Thumbnails use lazy loading and async decoding; only the hero may use high fetch priority.
- Failed media terminates at a stable fallback without a retry loop or frame collapse.

### Accessibility

- The selected thumbnail exposes a programmatic state, not border color alone.
- Every thumbnail and `View All` has a visible, unclipped `focus-visible` treatment.
- Selecting a card focuses the detail heading after render.
- Back closes the detail and restores focus to the selected card.
- Reduced motion disables smooth scrolling and all nonessential gallery motion.

## Scope and Sequence

This review does not reopen the completed P0 product-visibility or SY-T8 import work. The next
runtime phase is MIU 9. MIU 8 implements the media/fallback/size/request gates above and preserves
them in the public Playwright suite. Product pagination, the product-led hero, duplicated-section
removal, and the complete card -> detail heading -> Back focus cycle remain in MIUs 9-13.
