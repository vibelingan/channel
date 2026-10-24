# MIU-04B-2: Factory Gallery Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The homepage factory gallery renders ten meaningful JPEG images with reviewed alt text, but none
exposed intrinsic `width` and `height` attributes. The source assets have different aspect ratios,
so one shared placeholder size would be false metadata.

## Change

- Add measured `width` / `height` values to the local factory photo registry.
- Render those dimensions on each gallery `<img>`.
- Add an exact path, alt, order, dimension, and renderer contract to the media-assets tests.
- Preserve the existing factory-gallery order test while requiring numeric dimension fields.

## Reviewed dimensions

| Asset | Width | Height |
|---|---:|---:|
| `f01.jpg` | 1280 | 651 |
| `f02.jpg` | 1280 | 568 |
| `f03.jpg` | 1280 | 817 |
| `f04.jpg` | 1280 | 713 |
| `f05.jpg` | 1280 | 918 |
| `f06.jpg` | 1280 | 720 |
| `f07.jpg` | 1280 | 590 |
| `f08.jpg` | 1280 | 916 |
| `f09.jpg` | 1280 | 587 |
| `f10.jpg` | 1280 | 588 |

Dimensions were measured from the committed assets with macOS `sips`. An independent
production-origin build confirmed the gallery's ten rendered paths, order, complete alt text, and
numeric dimensions.

## Scope boundary

This MIU does not change image bytes, paths, ordering, alt copy, layout classes, visible text, the
factory video or poster, `BaseLayout`, OG/Twitter, Schema, sitemap behavior, or URL topology.

The remaining homepage media families—team, quality, certification, and customer logos—are handled
in later MIUs so each checkpoint stays independently reviewable and reversible.
