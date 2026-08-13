# SEO Phase 3: Monitoring and Technical Optimization Design

Status: design only

Branch: `docs/seo-phase-3-monitoring-plan`

Base: `feat/seo-phase-2@a24ea0c` (requested by the user)

Evidence baseline: production `https://supplychainsai.com` after PR #15 (`c2061a1`), observed 2026-08-13

## 1. Decision

First verify whether Search Console/Bing properties, access, sitemap submissions, and historical data already exist. Define D0 as the date on which required access is available and the first complete baseline record is stored. Start or continue monitoring from that verified state. Use D+14 as a crawl/index health checkpoint and D+28 as the first optimization decision point. Do not wait 28 days to begin data collection, and do not interpret 14-day ranking movement as a stable SEO outcome.

This branch makes no code, page, content, UI, infrastructure, or deployment changes. Future implementation must run `git fetch origin`, branch from a verified `origin/test` SHA, record that SHA, and assert it contains PR #15 merge commit `c2061a1`. Never branch from the potentially stale local `test`. This branch deliberately follows the older phase-2 base and does not contain PR #15 production code or concurrent OG/image work.

## 2. Why image stability works without a CDN

The browser computes an image's intrinsic aspect ratio from HTML `width` and `height` before the bytes arrive. It can therefore reserve the correct box during HTML/layout processing. This reduces content displacement when the image loads and lowers CLS risk.

The completed contract also provides:

- useful `alt` for content images and empty alt for decorative images;
- standard crawlable `<img src>` elements;
- lazy loading where appropriate;
- byte-level width/height verification including EXIF orientation;
- production checks that declared dimensions equal browser natural dimensions.

A CDN affects a different part of the system:

```text
HTML semantics/layout contract
  -> alt, src, width, height, surrounding text, canonical

Delivery performance
  -> compression, geographic edge, cache TTL, revalidation, TTFB, bandwidth
```

The first layer remains necessary with or without a CDN. A CDN may improve LCP and crawl efficiency by reducing latency and transfer size, but it cannot repair missing alt, wrong dimensions, duplicate URLs, weak content, or inaccurate Schema.

### Observed delivery gap

| Resource | Size | Content-Encoding | Cache-Control |
|---|---:|---|---|
| Home HTML | 94,169 B | none | `public, max-age=300, s-maxage=600` |
| Fingerprinted main CSS | 79,974 B | none | `public, max-age=300, s-maxage=600` |

`ETag` and `Last-Modified` are present, which is useful for revalidation, but full responses remain uncompressed and immutable assets are cached for only five minutes in browsers.

## 3. Phase boundaries

### 3.1 Technical, no page/content decision required

These items can be designed now. Some still need account or infrastructure authorization before implementation.

| Item | Design now | Implement gate |
|---|---|---|
| Search Console/Bing monitoring | yes | webmaster owner/full access |
| Crawl/index dashboards and report templates | yes | data available |
| Compression/cache policy | yes | CloudBase billing/topology/rollback approval |
| 301/HSTS | yes | primary-host and rollback approval |
| lastmod data contract | yes | trustworthy content owner/updatedAt source |
| automated metadata/image regressions | already implemented | normal code review |
| PageSpeed/CrUX measurement | yes | sufficient field data for CrUX |
| image sitemap/responsive-image audit | yes | evidence that image discovery/performance is a bottleneck |

### 3.2 Requires an approved asset or shared implementation coordination

- OG/Twitter requires an approved representative 1200x630 bitmap and reconciliation with the concurrent shared-layout owner.
- Page-specific Schema requires the final shared-layout contract and complete visible fields.

### 3.3 Requires business/content decisions

- Headphones procurement content and FAQ.
- Case-detail pages, outcomes, dates, authors, and source approval.
- Brand name strategy: SupplyChainsAI vs Diversity Technology Limited/legalName.
- Social URLs and contact email owner.
- Certification applicability and product-level compliance claims.
- Multilingual markets and hreflang.

## 4. Monitoring model

### 4.1 Baseline cohort

Primary pages:

- `https://supplychainsai.com/`
- `https://supplychainsai.com/oem/`
- `https://supplychainsai.com/portfolio/`
- `https://supplychainsai.com/headphones/`

Exclude private/noindex routes from SEO-performance targets.

### 4.2 Status verification and D0 setup

1. Ask the account owner whether Google/Bing properties already exist and record owner/full-user permissions.
2. Verify the Google domain property; create it only if absent.
3. Verify Bing Webmaster Tools; import from Search Console only if the site is absent and ownership/privacy policy permit.
4. Check existing sitemap status before submitting `https://supplychainsai.com/sitemap-index.xml`; do not create duplicate submissions.
5. URL Inspection for the four primary pages, storing a manual export/screenshot and timestamp because URL Inspection UI evidence is not fully represented by Search Analytics exports:
   - discovered/crawled/indexed state;
   - Google-selected vs user canonical;
   - last crawl time;
   - rendered screenshot/resources;
   - detected structured data.
6. In Bing, record sitemap status, URL Inspection/Index Explorer state for the same four pages, crawl/index exceptions, search-performance baseline, account owner, and export location. Record IndexNow as deferred unless a real freshness need is established.
7. Export initial Google and Bing search-performance data, even if sparse.
8. Record mobile Core Web Vitals and PageSpeed lab results separately.
9. Create a fixed target-query set without claiming ranking outcomes:
   - OEM manufacturing partner;
   - OEM product development;
   - OEM headphone manufacturer;
   - custom headphones manufacturer;
   - selected case/product queries based on existing visible content.

### 4.3 D+14 health checkpoint

Questions:

- Were all four URLs recrawled after 2026-08-13?
- Are all four indexed or is any “Crawled/Discovered - currently not indexed”?
- Did Google select a different canonical?
- Are title links/snippets materially different from the page metadata?
- Are mobile usability, CWV, or structured-data errors present?
- Are sitemap fetch and robots status healthy?
- Are server 4xx/5xx or blocked resources visible?

Allowed response at D+14:

- fix confirmed technical defects;
- resubmit only materially changed/fixed URLs;
- do not rewrite page content from short-term position noise;
- document queries with first impressions for D+28.

### 4.4 D+28 first decision review

Compare Day 1–28 as the initial post-change window. If historical data exists, compare equivalent periods carefully and annotate deployment date.

Metrics by page and query:

- impressions;
- clicks;
- CTR;
- average position;
- indexed status and crawl date;
- search appearance;
- country/device;
- CWV and PageSpeed evidence;
- inquiry/conversion attribution if available.

Interpretation thresholds:

- Do not optimize CTR for a page/query bucket with fewer than 100 impressions in the comparison window; report it as insufficient data.
- Do not treat average position as a deterministic rank. Use it as a directional aggregate and inspect device/country/query mix.
- Do not interpret omitted/anonymized Search Console queries as zero demand.
- Require at least 10 clicks before interpreting a CTR change as actionable; below that, keep observing unless there is a clear snippet defect.
- Annotate all deploy dates and analyze only one material change per page where possible.

Decision buckets:

| Signal | Likely response |
|---|---|
| Position 8–30 with relevant impressions | improve matching page's depth/internal links after client review |
| Good position, low CTR | review title/snippet intent alignment; do not keyword-stuff |
| Wrong page ranks | strengthen internal linking and page differentiation |
| Crawled but not indexed | inspect usefulness, duplication, canonical, rendering, and site signals |
| Slow/LCP or transfer issue | prioritize compression/cache/responsive images after infra approval |
| No impressions | verify indexing first; then reassess query demand, content coverage, and authority |

### 4.5 D+56 effectiveness review

- Compare two 28-day windows.
- Separate branded from non-branded queries.
- Decide whether to implement approved content, case pages, page-specific Schema, external links, or GEO extraction work.
- Retire changes that added maintenance cost without measurable value.
- Attribute each decision to a named change, deploy date, target metric, minimum evidence threshold, and owner.

## 5. Technical optimization backlog

### T1. Search platform integration

Priority: immediate setup

Acceptance:

- Search Console domain property verified;
- Bing site verified;
- sitemap accepted;
- four URL Inspection records stored;
- baseline export and owner documented.
- D0 timestamp and D+14/D+28/D+56 calendar dates recorded.
- Google/Bing export location and repeatable report query documented.

### T2. Compression and immutable asset caching

Priority: prepare now, implement after approval

Design target:

- Brotli/gzip for HTML/CSS/JS/SVG/text responses.
- Fingerprinted `/_astro/*`: `public, max-age=31536000, immutable`.
- HTML: shorter browser TTL with safe revalidation; preserve deploy rollback and cache purge path.
- `Vary: Accept-Encoding` where compression is negotiated.
- No cache of authenticated/private API responses.

Preconditions:

- identify CloudBase Web App/CDN control owner;
- verify with current CloudBase console/API/docs whether the deployed Web App supports per-path cache headers, compression, `Vary`, redirects, and HSTS; platform support is currently unverified;
- record the exact configuration mechanism and a read-back/probe that proves it applied;
- confirm pricing and whether custom-domain CDN activation changes topology;
- document the exact purge command/API and rollback procedure;
- test old/new deploy propagation before enabling long TTL.

Acceptance:

- compressed text responses observed;
- fingerprint assets immutable;
- deploy rollback restores prior HTML without stale asset mismatch;
- response probes show expected `Content-Encoding`, `Vary`, cache headers, and encoded bytes;
- repeat requests demonstrate cache behavior without stale HTML;
- old hashed assets remain available through the rollback window;
- PageSpeed transfer-size/LCP is recorded as supporting evidence, not the only gate.

### T3. Host normalization and HSTS

Priority: design only until approved

Observed today: HTTP and `www` return 200, no Location, no HSTS.

Decisions required:

- canonical host (`supplychainsai.com` is current signal);
- old CloudBase/test-domain rollback route;
- 301/308 policy;
- HSTS max-age and whether subdomains are included.

Rollout:

1. Temporary redirect/probe where supported.
2. Verify certificate and all required hostnames.
3. Enable permanent host/HTTPS redirects.
4. Add HSTS with `max-age=300` after redirect/certificate checks; observe at least 48 hours, then consider `86400`, then `604800`, then a longer value only after an explicit approval.
5. Do not preload initially.

Acceptance matrix:

| Host/scheme | Expected | Required checks |
|---|---|---|
| `http://supplychainsai.com/<path>?<query>` | one-hop redirect to HTTPS apex preserving path/query | no loop; final 200; canonical agrees |
| `https://www.supplychainsai.com/<path>?<query>` | one-hop redirect to HTTPS apex preserving path/query | valid certificate; no loop |
| `https://supplychainsai.com/<path>?<query>` | 200 canonical host | HSTS only after staged rollout |
| retained CloudBase/test host | documented non-indexable operational behavior | no accidental canonical conflict |

HSTS is not immediately reversible in browsers: clients remember it until expiry. A rollback host does not remove an HSTS policy from the apex. `includeSubDomains` is blocked until every affected subdomain is inventoried and HTTPS-ready. Abort rollout on certificate mismatch, redirect loop, path/query loss, inaccessible operational host, or cache preventing rollback.

### T4. Trustworthy lastmod

Do not use build/deploy time as page modification time.

Required model:

```text
route -> content owner -> reviewed updatedAt -> sitemap lastmod
```

Only emit lastmod when the visible, index-relevant content changed. If no owner exists, omit it; omission is more trustworthy than a fabricated fresh date.

Acceptance:

- ISO 8601 timestamp/date accepted by the sitemap format;
- not in the future and backed by an owner-reviewed source field;
- unchanged for deploys, formatting, tests, or non-visible metadata that do not change the page's index-relevant content;
- advances only when reviewed visible content changes;
- sitemap schema and production URL probes pass.

### T5. OG/Twitter

Blocked by approved image and shared-layout coordination.

Plan:

- default site image plus optional page-specific override;
- absolute URL, 1200x630 bitmap, representative content, no generic low-resolution logo;
- `og:title`, `og:description`, `og:url`, `og:type`, `og:image`, dimensions/alt;
- `twitter:card=summary_large_image` and matching title/description/image;
- validate WhatsApp, LinkedIn, Facebook, X/Twitter crawlers after deploy.

Acceptance:

- source image is byte-verified as 1200x630, supported bitmap MIME, and publicly returns 200;
- rendered meta uses absolute URLs and the same canonical URL as the page;
- image response has correct MIME and cache headers;
- default/page overrides have deterministic tests;
- platform debuggers fetch the deployed image successfully.

### T6. Page-specific structured data

Implement only after visible fields and shared-layout contract are stable.

Candidates:

- BreadcrumbList for genuine hierarchy.
- Product for an actual product detail with required fields.
- Article only for a dated/authored editorial case or teardown.
- `primaryImageOfPage` for a reviewed representative image.

Do not add FAQPage unless the FAQ is visible and current. Rich Results Test and URL Inspection are required; valid markup does not guarantee a rich result.

Acceptance:

- URL-to-Schema-type map approved before implementation;
- every property has page-visible provenance and an owner;
- Product work explicitly chooses Product snippet vs merchant-listing requirements and supplies the corresponding required properties;
- Rich Results Test and production URL Inspection show no errors;
- source tests prove Schema is omitted when required fields are absent.

### T7. Image discovery/performance follow-up

Already complete: alt, intrinsic dimensions, standard img elements, layout stability contract.

Measure before implementing:

- LCP image and bytes;
- image transfer volume by viewport;
- cache hit behavior;
- Search Console image search impressions;
- whether important images are discoverable in rendered/source HTML.

Possible later work:

- WebP/AVIF variants;
- `srcset`/`sizes`;
- descriptive filenames for future assets;
- image sitemap for priority media;
- `primaryImageOfPage`/OG image selection.

Proceed thresholds:

- responsive variants: proceed when priority pages transfer more than 1 MB of avoidable image bytes at mobile viewport or an image is a confirmed LCP bottleneck;
- image sitemap: proceed when priority images are not discovered/indexed after normal page crawling or when image search is an approved channel;
- format conversion: proceed when byte reduction is at least 20% at visually reviewed quality;
- do not rename existing indexed image URLs without a redirect/cache migration plan.

## 6. Client content decision backlog

No implementation in this branch.

### Headphones

Ask the client which facts can be published and who owns accuracy:

- product families and intended markets;
- driver/material/cable/battery options;
- logo/color/packaging customization;
- acoustic/drop/bend/battery/RF tests;
- model-level vs company-level CE/FCC/RoHS applicability;
- sampling, MOQ, pilot, and lead-time conditions;
- procurement questions and evidence-backed answers.

### Case studies

- select 3–5 cases;
- client/problem/constraints;
- design/manufacturing process;
- measurable result that is approved for publication;
- date, author/reviewer, images and permission;
- links to relevant OEM/category pages.

### Brand and trust

- public brand vs legal entity naming policy;
- canonical contact email owner;
- official social URLs;
- certification evidence and scope;
- external independent sources for Wikidata/Knowledge Panel eligibility.

## 7. Reporting template

Every checkpoint report should contain:

1. Observed facts and date range.
2. Page/query table.
3. Crawl/index exceptions.
4. CWV/performance exceptions.
5. Changes since previous checkpoint.
6. Technical actions that need no content decision.
7. Content/business options awaiting client input.
8. Explicit non-guarantee: crawl/index/rank outcomes are controlled by search engines.

## 8. Exit criteria for planning-only phase

- Client receives the v1.2 status update.
- Monitoring access owner and setup date are assigned.
- D+14 and D+28 review dates are scheduled.
- D+56 review date is scheduled.
- Infrastructure decisions are recorded before CDN/redirect implementation.
- Client chooses whether to prepare Headphones/case content.
- Any implementation starts in a fresh branch from latest `test`, with its own review and deployment gates.
