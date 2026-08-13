# MIU-04A: OEM Factory Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The OEM factory poster has reviewed intrinsic dimensions (`1228×718`) in content data and the
poster-only branch rendered them, but the video fallback `<img>` dropped both attributes. The public
OEM HTML therefore exposed the same image without intrinsic dimensions whenever a video source was
configured.

## Change

- Apply the existing `posterWidth` / `posterHeight` props to the fallback image inside `<video>`.
- Add a source-contract test requiring both MediaVideo image branches to consume the same dimensions.

## Rendered evidence

Production-origin build output for `/oem/`:

```html
<img
  src="/media/factory-oem.webp"
  alt="Diversity Innovations production facility"
  width="1228"
  height="718"
  class="aspect-video h-full w-full object-cover"
/>
```

## Scope boundary

This MIU does not change:

- the factory media content or source URL
- `BaseLayout`, OG/Twitter, Schema, or sitemap behavior
- page layout, CSS classes, visible copy, or alt text
- the homepage image collection

The homepage's remaining static-image dimension gaps are reserved for MIU-04B.
