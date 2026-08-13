# SEO / GEO Agent Handoff

This directory is the source of truth for the current SEO/GEO sequence.

## Active scope

Only SEO/GEO technical work is active:

1. Keep the deployed `/headphones/` canonical trailing-slash contract green.
2. Let the concurrent Open Graph / Twitter Card MIU finish without touching its shared layout files.
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
- In progress elsewhere:
  - Open Graph / Twitter Card metadata (concurrent agent; shared layout is off-limits here).
- Verified locally on 2026-08-13 (re-run the commands below before merge):
  - Site tests: 126 passed, 0 failed.
  - Full workspace TypeScript/Astro checks: 0 errors; E2E TypeScript passed.
  - Biome: 277 files passed.
  - Production-origin build: four public pages have unique titles/descriptions within reviewed
    limits and one H1 each.

## Next action

Review and merge `feat/seo-phase-3-metadata`. After the concurrent OG/Twitter MIU lands, rebase
before starting page-specific structured data so the next MIU designs against the merged layout
contract.

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

MIU-03 changes only the home and Headphones page metadata, its source-contract test, and
[MIU-03-PUBLIC-METADATA.md](MIU-03-PUBLIC-METADATA.md). It does not modify `BaseLayout`, OG/Twitter,
Schema, content frontmatter, navigation, or URL topology.
