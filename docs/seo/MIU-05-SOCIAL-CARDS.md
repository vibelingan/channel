# MIU-05: Open Graph and Twitter Cards

Status: implemented; pending final delivery verification

Branch: `feat/seo-phase-2-social-cards`

Base: `origin/test@c2061a1`

## Goal

Complete Phase 2 social sharing metadata without changing page content, structure, UI, navigation,
canonical URLs, or Schema.

## Implemented contract

Every public page emits:

- `og:type=website`
- `og:site_name=Diversity Technology`
- page-specific `og:title`, `og:description`, and `og:url`
- absolute `og:image` and `og:image:secure_url`
- image MIME, 1200×630 dimensions, and meaningful alt
- `og:locale=en_US`
- `twitter:card=summary_large_image`
- matching Twitter title, description, image, and image alt

Pages marked `noindex` emit none of the Open Graph/Twitter tags.

## Image decision

Selected attachment: product assembly and packing line.

| Property | Value |
|---|---|
| Source dimensions | 1200×630 |
| Source provenance | Supplied in the 2026-08-14 user message; transient cache is not a repository artifact |
| Shipped dimensions | 1200×630 |
| Shipped format | truecolor PNG |
| Shipped SHA-256 | `06ed099bed2cfb640d115dd8c4b5f10432bee6214e01a16efad8d5c06e5b37c2` |
| Shipped path | `/media/social/oem-manufacturing-og.png` |

The message attachment was already the required aspect ratio, so no crop was needed. Re-encoding with
maximum lossless PNG compression preserved the photograph. A 256-color candidate was rejected because
visible posterization reduced client-facing quality. The shipped file hash above is the durable
repository evidence.

The attachment showing the Bohung Industry gate was rejected because that visible name conflicts with
the site's public entity. The other factory photos are retained as source options but are not forced
onto unrelated pages; future page-specific images can use the typed `socialImage` override.

## Acceptance evidence

- focused social metadata tests pass;
- image bytes decode as PNG at 1200×630;
- production-origin Astro build succeeds;
- four public pages contain each required tag exactly once;
- social title/description/canonical match the actual page metadata;
- social image URL is absolute HTTPS;
- six noindex pages contain zero OG/Twitter tags;
- asset exists in the built output;
- full site/workspace tests, typechecks, Biome, and local browser smoke pass;
- CI, deploy, production pages, social image HTTP response, and platform debugger probes pass before
	changing status to delivered.

## Scope boundary

This MIU does not implement page-specific Product/Article/Breadcrumb Schema, Search Console/Bing,
`lastmod`, `llms.txt`, CDN, redirects, HSTS, brand renaming, social account links, or page content/UI.
