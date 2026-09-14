# MIU-04B-4: Quality Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The homepage quality section renders eight meaningful JPEG images with reviewed labels used as alt
text and captions, but none exposed intrinsic `width` and `height` attributes. The source images
vary significantly in aspect ratio, so one shared placeholder size would be false metadata.

## Change

- Add measured `width` / `height` values to the eight quality-test registry entries.
- Render those dimensions on each quality `<img>`.
- Add an exact path, label, order, dimension, and renderer contract to the media-assets tests.
- Use TypeScript AST for registry data and the official Astro compiler AST for the real image node,
  exact attribute bindings, direct map order, and extra-image detection.

## Reviewed dimensions

| Asset | Width | Height |
|---|---:|---:|
| `q1.jpg` | 545 | 345 |
| `q2.jpg` | 205 | 345 |
| `q3.jpg` | 205 | 345 |
| `q4.jpg` | 322 | 345 |
| `q5.jpg` | 325 | 285 |
| `q6.jpg` | 285 | 285 |
| `q7.jpg` | 368 | 285 |
| `q8.jpg` | 305 | 285 |

Dimensions were measured from the committed assets with macOS `sips`. An independent
production-origin build confirmed exactly eight rendered quality paths, their order, complete alt
text, and numeric dimensions.

## Scope boundary

This MIU does not change image bytes, paths, ordering, labels, captions, layout classes, visible
text, certifications, customer logos, `BaseLayout`, OG/Twitter, Schema, sitemap behavior, or URL
topology.

Certification images and customer logos remain a separate later MIU so each checkpoint stays
independently reviewable and reversible.
