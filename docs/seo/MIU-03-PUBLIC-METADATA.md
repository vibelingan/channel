# MIU-03: Public Page Search Metadata

Status: implemented and locally verified on 2026-08-13

Branch: `feat/seo-phase-3-metadata`

Base: latest `origin/main` at branch creation (`7978369`)

## Scope

Audit the four currently indexable pages after Blue Ocean and Teardown Lab were hidden:

- `/`
- `/oem/`
- `/portfolio/`
- `/headphones/`

Keep page titles and descriptions unique and within review limits:

- title: at most 60 characters
- description: at most 160 characters
- exactly one visible H1 per rendered page

These are editorial review limits, not ranking guarantees.

## Changes

- Added dedicated SEO title/description constants to the home page so visible Hero copy remains unchanged.
- Shortened the existing Headphones SEO title/description while preserving current visible claims.
- Left OEM and Portfolio content unchanged because their rendered metadata was already unique and within limits.
- Added `public-metadata.test.ts` to pin the current four-page source contract.

## Explicit exclusions

This MIU does not touch:

- `BaseLayout.astro`
- Open Graph or Twitter Card metadata
- shared Schema/JSON-LD implementation (the existing `WebPage` output consumes page metadata, so its
  rendered `name` and `description` follow these values)
- navigation, branding, Slogan, Hero, or product scope
- sitemap configuration or URL topology

The exclusions avoid overlap with the concurrent OG/Twitter agent.

## Rendered result

The table below was measured from an independent production-origin Astro build. The source-contract
test enforces metadata length/uniqueness and the current routable page set; it does not claim to
measure rendered H1 output.

| Page | Title length | Description length | H1 count |
|---|---:|---:|---:|
| Home | 52 | 141 | 1 |
| OEM | 46 | 130 | 1 |
| Portfolio | 46 | 148 | 1 |
| Headphones | 57 | 155 | 1 |

Titles and descriptions are unique across all four pages.

## Validation

```bash
corepack pnpm --filter @vibelingan-channel/site test
corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
corepack pnpm typecheck:e2e
corepack pnpm exec biome check .
SITE_URL=https://supplychainsai.com PUBLIC_CB_PROXY=0 \
  corepack pnpm --filter @vibelingan-channel/site build
```

The source contract verifies that each page passes its audited values into `BaseLayout`. The
production-origin build must still be inspected independently for final rendered HTML and H1 output.

## Next non-OG MIU

Page-specific structured data remains next in the sequence, but it likely needs a shared layout contract. Rebase after the concurrent OG/Twitter branch lands, then design that MIU against the merged `BaseLayout` instead of modifying it in parallel.
