# SEO Phase 3 Findings

Evidence date: 2026-08-13

## Source documents and branch facts

- Client baseline: `supplychainsai-网站修正与升级方案-v1.2.docx`, dated 2026-08-12.
- v1.2 is a mixed website/business/SEO proposal. Its check marks describe the understanding at document time; they are not all current production facts.
- Requested planning base: local `feat/seo-phase-2` at `a24ea0c`.
- Completed SEO implementation was independently delivered by PR #15 and is live from merge commit `c2061a1` on `test`.
- This planning branch intentionally does not contain PR #15 code. It records production evidence only.

## Production SEO evidence

- Four indexable routes: `/`, `/oem/`, `/portfolio/`, `/headphones/`.
- Each has a unique title/description, one H1, a canonical URL, and matching `WebPage` JSON-LD.
- Title lengths: 52, 46, 46, 57. Description lengths: 141, 130, 148, 155.
- `robots.txt`: 200. `sitemap-0.xml`: four public URLs, zero `lastmod` values.
- `llms.txt`: 404.
- OG/Twitter on all four public pages: no `og:title`, `og:image`, or `twitter:card` tags observed.
- Page-specific `Article`/`Product` JSON-LD: not observed. Current types are `Organization`, `WebSite`, `WebPage`.
- Production browser and deployed E2E verified all rendered images have `alt`, `width`, and `height` attributes. The 44 homepage business images match their natural dimensions.

## Current delivery/performance evidence

- Home HTML: 94,169 bytes, no `Content-Encoding` for `Accept-Encoding: br, gzip`.
- Main fingerprinted CSS: 79,974 bytes, no `Content-Encoding`.
- HTML and CSS cache policy: `public, max-age=300, s-maxage=600`.
- `ETag` and `Last-Modified` are present.
- `http://supplychainsai.com/` and `https://www.supplychainsai.com/` return 200 without redirect.
- No HSTS header observed.

## Corrected v1.2 assumptions

- Brand is not unified as “SupplyChainsAI”: live titles still use “Diversity Technology Limited”. This is a business/brand decision, not an SEO-only edit.
- Live contact email is `info@supplychainsai.com`, not the v1.2 target `hello@supplychainsai.com`. Ownership/copy must be confirmed before change.
- Facebook/Instagram/YouTube links are not present in the footer.
- Certifications are visible in existing sections, but the independent certification evidence page described by v1.2 is not implemented.
- Success Stories are not marked with `Article` Schema.
- Search Console/Bing ownership, access, and submitted-sitemap state are unverified from available evidence. The account owner must confirm existing properties and permissions before creating or changing anything.
- PR #15 tests use TypeScript/Astro AST checks for metadata and image wiring, Sharp byte-header checks with EXIF orientation, and direct package dependencies for the parsers/readers.
- Current image contracts distinguish content-image alt from intentionally empty decorative alt and preserve the existing lazy-loading behavior; production E2E verifies browser rendering separately.
- Headphones has crawlable static intent content, but deeper procurement content remains a client-content opportunity, not an approved implementation.

## Timing decision

- Monitoring should start immediately after access is available; waiting 14 days loses baseline data.
- D+14: crawl/index health checkpoint, not a ranking verdict.
- D+28: first performance decision using query/page data.
- D+56: stronger effectiveness review; content and authority changes usually need a longer observation window.
