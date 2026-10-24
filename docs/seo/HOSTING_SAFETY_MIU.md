# Hosting safety and explicit snapshot delivery

2026-10-20. Branch: `feat/seo-foundation`; starting commit: `f5150e5`. Existing uncommitted SSG design documents are preserved. Pricing `3d157ac4` is read-only and has active backend edits.

## Runtime problem and observed evidence

The deployed website configuration uses `errorDocument: 'index.html'`. Live GETs of a missing root route and missing product route already return **HTTP 404**, with exactly the homepage body. This is a misleading error document, not an observed HTTP-200 soft 404. Home/category HTML advertises `public, max-age=300, s-maxage=600`. The custom domain uses an HTTP gateway `DIRECT` route to `STATIC_STORE`; it is not a legacy hosting CDN domain. Therefore `manageHosting domainStatus` cannot inspect this custom domain, and a CDN rule/API must not be selected from its name alone.

Risky existing shape:

```js
setWebsiteDocument({indexDocument: 'index.html', errorDocument: 'index.html'});
// Deployment build implicitly reads the live inventory during astro build.
```

## Data, ownership and constraints

| Value | Lifetime and owner |
| --- | --- |
| 404.html | Static site artifact; noindex; existing shell and tokens |
| Public product snapshot | One acquisition; validated public fields only; exact build input |
| Site recovery artifact | Code SHA + run ID; saved before upload; site files and public snapshot |
| Hosting audit | Bounded anonymous GETs; records status/headers/body hashes, no credentials |
| Pricing requests | Owned by another workstream; design notes only |

Astro generates a special 404.html output. This must stay out of sitemap and use an explicit noindex policy. A genuine HTTP status can only be accepted against the actual hosting target. A request with a cache-busting parameter cannot prove an ordinary cached URL is fresh. The current uploader has no verified atomic activation/rollback; retained artifacts provide recovery inputs, not a completed recovery mechanism.

## Implementation flow

1. Add a noindex 404 page using SiteHeader, BaseLayout, SiteFooter and existing styles. Change the next deployment's error document to 404.html; no live mutation in this work unit.
2. Add an executable read-only hosting contract check for real 404 status/body and HTML cache policy, using normal URLs and a revalidation comparison, bounded by the shared smoke HTTP reader.
3. Make deployment acquisition an explicit step and build from its saved snapshot. Keep ordinary CI's synthetic local fixture. Store the complete site/snapshot artifact before deployment, and the hosting audit after deployment. Read-only cache preflight must stop before any cloud write when policy is unsafe. Release checks include a canonical product URL, all sitemap shards, both manifests and the base HTML/error routes. No continue-on-error and no empty-inventory fallback.
4. Document current transport/React Query inventory and a common transport → domain client → query options → business hook design. Do not implement the shared layer or change pricing.

## Alternatives and limits

- Returning the homepage body with a 404 is currently SEO-status-correct but misleading to people; fix the body without changing existing catalog flows.
- Do not enable acceleration, replace the domain, upgrade a deployment SDK, or blindly set a CDN policy while its exact applicability is unverified.
- Do not claim cached CLI's safe/prune flags exist from new online docs alone. Inspect the pinned installed runtime. Never enable broad remote pruning as a shortcut to product withdrawal.
- No Tunnel or elaborate local hosting simulation. Use focused automated checks/builds, a screenshot of the 404 treatment, then real-target acceptance after release.

## Tests and business correction

Failing checks first: 404 cannot be indexed or enter sitemap; hosting audit rejects a homepage body with HTTP 404, a friendly page with HTTP 200, positive cache TTL and ordinary/revalidated body mismatch; deployment snapshot must precede build, build reads the file, and recovery input must be archived before any upload. Restore these negative cases after implementation to prove the guards detect regressions.

Focused commands use Node 22.13.0: site SEO page tests, hosting-contract tests, deploy workflow tests; then build with the preserved validated public snapshot. Audit the real site read-only and retain its expected failures until deployment/configuration fixes them. No customer data, inquiry notifications or credentials are changed.

State labels: implemented locally / verified locally / observed live / pending deployment / unverified provider capability. A saved artifact is not evidence of a successful rollback.

## Follow-through at bf8434e0

The actual live baseline is now backed up and content-verified: 1,032 files, 77,019,288 bytes, two stable inventories/configurations. The directory download returned success while missing two files; exact retries and independent content checks closed that gap. Three multipart videos require independent HTTP ETag/size/SHA-256 evidence rather than a false MD5 assertion.

Normal delivery now captures and archives that current-hosting backup before the first cloud mutation. Tests pin this ordering and preserve the existing deployment conditions and shared lock. The workflow change has not run remotely. A local restore of the real baseline exercises ordered uploads/read-back and exact removal while preserving platform/search-verification paths and old hashed assets.

Cache patch generation, a read-only recovery-plan CLI and the recovery execution kernel are implemented. The live cache patch is not applied. The kernel has no cloud adapter or environment-locked restore job yet; current publication/ownership evidence and mid-operation withdrawal coordination remain integration requirements. Backout parameters restore the observed HTTP policy, not the exact absence of a prior route-header field. No live recovery, atomic-activation guarantee or recovery-time commitment is claimed.
