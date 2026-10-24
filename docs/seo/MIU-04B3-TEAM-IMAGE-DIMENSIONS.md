# MIU-04B-3: Team Gallery Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The homepage team gallery renders six meaningful JPEG images with reviewed alt text, but none
exposed intrinsic `width` and `height` attributes. The source assets have different aspect ratios,
so one shared placeholder size would be false metadata.

## Change

- Add measured `width` / `height` values to the six-photo team registry.
- Render those dimensions on each gallery `<img>`.
- Add an exact path, alt, order, dimension, and renderer contract to the media-assets tests.
- Reuse the TypeScript AST contract helper proven by the factory-gallery MIU so commented entries
  and whitespace changes in string values cannot false-pass.
- Parse the Astro template with the official compiler so attributes must belong to the real gallery
  `<img>`, the registry must be mapped directly, and an extra image cannot hide behind source text.

## Reviewed dimensions

| Asset | Width | Height |
|---|---:|---:|
| `t01.jpg` | 1100 | 749 |
| `t02.jpg` | 1100 | 850 |
| `t03.jpg` | 1100 | 822 |
| `t04.jpg` | 1100 | 822 |
| `t05.jpg` | 1100 | 618 |
| `t06.jpg` | 1100 | 825 |

Dimensions were measured from the committed assets with macOS `sips`. An independent
production-origin build confirmed exactly six rendered team paths, their order, complete alt text,
and numeric dimensions.

## Scope boundary

This MIU does not add the unused `team.jpg` asset to the page and does not change image bytes,
paths, ordering, alt copy, layout classes, visible text, `BaseLayout`, OG/Twitter, Schema, sitemap
behavior, or URL topology.

The remaining homepage media families—quality, certification, and customer logos—are handled in
later MIUs so each checkpoint stays independently reviewable and reversible.
