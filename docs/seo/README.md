# SEO / GEO Agent Handoff

This directory is the source of truth for the current `feat/seo-phase-2` branch.

## Active scope

Only SEO/GEO technical work is active:

1. Ship and deploy the `/headphones/` canonical trailing-slash fix.
2. Add Open Graph / Twitter Card support after an approved 1200×630 PNG is available.
3. Audit public-page title, description, canonical, H1, and index intent.
4. Add page-specific structured data only where visible fields support it.
5. Add trustworthy sitemap `lastmod`, image alt/dimensions, Search Console, and Bing validation.
6. Start GEO content work only after facts have owners, evidence, and review dates.

Read [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md) first, then use
[SEO_GEO_AUDIT_AND_PLAN.md](SEO_GEO_AUDIT_AND_PLAN.md) for evidence and acceptance criteria.

## Current branch state

- Branch: `feat/seo-phase-2`
- Implemented in this branch:
  - `apps/site/src/pages/headphones.astro` uses `canonicalPath="/headphones/"`.
  - `apps/site/src/lib/headphones-seo.test.ts` pins that explicit `BaseLayout` canonical override.
- Verified locally on 2026-08-12 (re-run the commands below before merge):
  - Site tests: 124 passed, 0 failed.
  - Full workspace TypeScript/Astro checks: 0 errors; E2E TypeScript passed.
  - Biome: 276 files passed.
  - A production-origin build independently emitted the same Headphones URL in canonical and
    sitemap; this is build evidence, separate from the source-contract test.

## Next action

Review this branch, merge the canonical fix, deploy it, then verify production:

```bash
curl -fsS https://supplychainsai.com/headphones/ | grep -o '<link rel="canonical"[^>]*>'
curl -fsS https://supplychainsai.com/sitemap-0.xml | grep '<loc>https://supplychainsai.com/headphones/</loc>'
```

After production agrees, start OG/Twitter as a separate focused change. Do not begin with page or
brand redesign.

## Validation commands

Run from the repository root and assert the branch to avoid validating another checkout:

```bash
git rev-parse --show-toplevel
[[ "$(git branch --show-current)" == 'feat/seo-phase-2' ]]

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

## Commit boundary

The intended SEO commit contains only:

- `README.md`
- `apps/site/src/pages/headphones.astro`
- `apps/site/src/lib/headphones-seo.test.ts`
- `docs/seo/README.md`
- `docs/seo/CURRENT_EXECUTION.md`
- `docs/seo/SEO_GEO_AUDIT_AND_PLAN.md`

Do not stage the other untracked local research, business documents, DOCX/PDF files, or
`DELIVERABLES/` directories.
