# SEO / GEO Agent Handoff

This directory is the source of truth for the current SEO/GEO sequence.

## Active scope

Only SEO/GEO technical work is active:

1. Keep the deployed `/headphones/` canonical trailing-slash contract green.
2. Keep the deployed Open Graph / Twitter Card default and per-page override
  contract green.
3. Keep public-page title, description, canonical, H1, and index intent within the audited contract.
4. Add page-specific structured data only where visible fields support it.
5. Add trustworthy sitemap `lastmod`, image alt/dimensions, Search Console, and Bing validation.
6. Start GEO content work only after facts have owners, evidence, and review dates.

Read [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md) first, then use
[SEO_GEO_AUDIT_AND_PLAN.md](SEO_GEO_AUDIT_AND_PLAN.md) for evidence and acceptance criteria.

## Current sequence state

- Completed:
  - `/headphones/` canonical fix merged through PR #9.
  - MIU-03 public metadata implemented on `feat/seo-phase-3-metadata`.
  - MIU-04A OEM factory video poster intrinsic dimensions.
  - MIU-04B-1 through MIU-04B-5 homepage process, factory, team, quality, certificate, and client
    image dimensions.
  - Metadata/image MIUs through MIU-04B-5.
- Deployed and verified on the sole current CloudBase environment (`test`):
  - Phase 2 Open Graph / Twitter Card metadata and reviewed 1200×630 default image.
  - Four public pages expose complete, unique metadata; six noindex pages expose no social tags.
  - The production-visible image URL returns `200 image/png` with the reviewed bytes.
- Pending main promotion:
  - Independent review and merge of `feat/seo-phase-2-main-delivery` into the authoritative `main`
    branch. The promotion branch is based on `main` and contains the two reviewed Phase 2
    implementation commits plus one promotion-status documentation commit.
- Verified locally on 2026-08-14 (re-run the commands below before merge):
  - Site tests: 135 passed, 0 failed.
  - Full workspace TypeScript/Astro checks: 0 errors; E2E TypeScript passed.
  - Biome: 279 files passed.
  - Production-origin build: public metadata contracts are green; all images across the ten built
    routes have alt text and numeric intrinsic dimensions.
  - Homepage assembly: all 44 process, factory, team, quality, certificate, and client images emit
    dimensions measured from the committed assets.

## Next action

Independently review the Phase 2 promotion pull request and merge it into `main` when approved.
The sole deployed environment has already passed CI, CloudBase smoke, public E2E, direct page-tag
checks, and social-image HTTP verification.
Page-specific structured data remains a separate follow-up that must use visible, owned facts.

Sitemap `lastmod` is blocked on a trustworthy content-update field and owner; the current content
model exposes neither. Search Console and Bing submission are blocked on external webmaster access.

## Validation commands

Run from the repository root and assert the branch to avoid validating another checkout:

```bash
git rev-parse --show-toplevel
[[ "$(git branch --show-current)" == feat/seo-phase-* ]]

pnpm --filter @vibelingan-channel/site test
pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
pnpm typecheck:e2e
pnpm exec biome check .
SITE_URL=https://supplychainsai.com PUBLIC_CB_PROXY=0 \
  pnpm --filter @vibelingan-channel/site build
```

Do not use the root scripts that shell through `npx pnpm`; use the direct `pnpm` commands above.

## Explicitly excluded

The following are business/brand work and must use a separate future branch/MIU:

- Slogan and Hero copy.
- Brand, homepage, or navigation redesign.
- Phase 1 product categories.
- Logistics or Facebook tools.
- Marketplace, suppliers, pricing, commissions, payments, messaging, or transactions.
- Existing public URL migration.

CDN activation, compression, HSTS, and hostname 301 changes also require separate billing,
topology, and rollback approval.

Deferred business materials are intentionally not part of this SEO branch commit.

## Current MIU boundary

This branch contains MIU-03, MIU-04A, and MIU-04B-1 through MIU-04B-5. The image series adds
measured dimensions and executable source/rendering contracts without changing image bytes, paths,
alt copy, layout classes, visible text, navigation, or URL topology. It does not modify
Schema implementation. Phase 2 changes `BaseLayout` only to add public-only OG/Twitter tags and a
typed social-image override. The existing `WebPage` JSON-LD reads each page's title and description,
so its rendered `name` / `description` values follow the MIU-03 metadata changes.
