# MIU-04B-1: OEM Process Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The homepage OEM process renders ten meaningful JPEG images with reviewed alt text, but none exposed
intrinsic `width` and `height` attributes. The assets have different aspect ratios, so a shared
placeholder size would be false metadata.

## Change

- Add required `imageWidth` / `imageHeight` fields to `WorkflowStepItem`.
- Record the measured dimensions for all ten process images in the site content frontmatter.
- Render those dimensions on each process `<img>`.
- Extend the existing media-assets test with the exact content-to-renderer contract.

## Reviewed dimensions

| Asset | Width | Height |
|---|---:|---:|
| `p01.jpg` | 720 | 518 |
| `p02.jpg` | 720 | 690 |
| `p03.jpg` | 720 | 623 |
| `p04.jpg` | 540 | 720 |
| `p05.jpg` | 662 | 720 |
| `p06.jpg` | 720 | 412 |
| `p07.jpg` | 720 | 549 |
| `p08.jpg` | 720 | 657 |
| `p09.jpg` | 720 | 697 |
| `p10.jpg` | 720 | 464 |

Dimensions were measured from the committed assets with macOS `sips`. An independent
production-origin build confirmed all ten rendered paths, dimensions, and `Step N:` alt prefixes.

## Scope boundary

This MIU does not change image bytes, paths, alt copy, layout classes, visible text, `BaseLayout`,
OG/Twitter, Schema, sitemap behavior, or URL topology.

The remaining homepage media families—factory, team, quality, certification, and customer logos—are
handled in later MIUs so each checkpoint stays independently reviewable and reversible.
