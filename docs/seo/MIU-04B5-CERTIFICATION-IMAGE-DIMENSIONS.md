# MIU-04B-5: Certification and Client Image Dimensions

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

## Problem

The homepage certification section renders four certificate scans and six client logos, but none
exposed intrinsic `width` and `height` attributes. The two families have very different aspect
ratios, so shared placeholder dimensions would be false metadata.

## Change

- Add measured `width` / `height` values to four compliance certificate entries.
- Add measured `width` / `height` values to six client-logo entries.
- Render each family's dimensions on its own mapped `<img>`.
- Add exact path, name, description, order, dimension, alt-template, and renderer contracts.
- Require the component to retain exactly two image templates, each attached to its direct registry
  map expression, so the certificate and client families cannot be reordered or cross-wired.

## Reviewed dimensions

| Asset | Width | Height |
|---|---:|---:|
| `certs/ce.jpg` | 706 | 1000 |
| `certs/emc.jpg` | 707 | 1000 |
| `certs/fcc.jpg` | 706 | 1000 |
| `certs/jd.jpg` | 772 | 1000 |
| `clients/artcoustic.png` | 400 | 65 |
| `clients/audio-diversity.png` | 400 | 124 |
| `clients/coremee.png` | 400 | 87 |
| `clients/di.png` | 400 | 120 |
| `clients/pabobo.jpg` | 400 | 400 |
| `clients/as.png` | 400 | 400 |

Dimensions were measured from the committed assets with macOS `sips`. An independent
production-origin build confirmed both rendered families, their order, complete alt text, and
numeric dimensions.

## Series assembly check

The production homepage was parsed after this change. All 44 images covered by MIU-04B-1 through
MIU-04B-5—process, factory, team, quality, certificates, and client logos—render numeric intrinsic
`width` and `height` attributes.

## Scope boundary

This MIU does not change image bytes, paths, ordering, names, descriptions, alt templates, layout
classes, visible text, `BaseLayout`, OG/Twitter, Schema, sitemap behavior, or URL topology.
