# P0 Headphones Product Visibility

Status: implementation, full local validation, review, and commit complete; pending test deployment.

Approved priority: restore visible products and existing product-detail interaction before every other UI or performance change.

## Scope

- Remove `.reveal` from every wrapper rendered by the asynchronous `HeadphonesPage` React island.
- Keep the site-wide static Astro reveal behavior unchanged.
- Add stable product-card/detail test anchors.
- Add browser coverage at 390px and 1440px that proves:
  - at least one product card renders after the real catalog load;
  - no product-card ancestor has opacity below 1, `visibility:hidden`, or `display:none`;
  - product-card geometry is non-zero;
  - clicking a card opens product detail;
  - returning to the matrix removes detail and leaves the card visible.

## Root Cause Evidence

The deployed custom domain renders five product buttons and successfully loads catalog data. The failing pre-fix browser assertion identifies exactly one hidden ancestor:

```text
div.reveal mt-12 first:mt-12
```

`BaseLayout.astro` queries `.reveal` only once at page load. Product groups mount later after the React catalog request, so they are never observed and retain the global `opacity: 0` style. This is a frontend lifecycle defect, not an empty API response, role gate, or CloudBase image-domain failure.

## Deferred Until After P0 Test Deployment

- global default-visible reveal hardening;
- Product Category styling;
- Headphones hero/mobile recomposition;
- remaining page-content cleanup;
- 12-item Load More and gallery/image performance;
- CloudBase image variants;
- admin table modernization;
- API/media same-origin normalization;
- separate production CloudBase environment and gated production workflow.

## Domain Findings

- `supplychainsai.com` is already bound to CloudBase with a valid certificate and CNAME.
- CloudBase gateway routes wildcard `/api` to `public-api` SCF and `/api/admin` to `admin` SCF, so `https://supplychainsai.com/api/*` works.
- The current test build sets `PUBLIC_API_BASE_URL` to `https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`; browser catalog and image requests therefore remain cross-origin.
- The public API also uses `PUBLIC_API_BASE_URL` when projecting image URLs, so domain normalization must update both site build configuration and function response contracts.
- The CloudBase `*.webapps.tcloudbase.com` alias does not route same-origin `/api`; it needs the absolute service origin unless its gateway topology changes.
- There is no configured GitHub `prod` Environment or separate production EnvId. `supplychainsai.com` currently fronts the same `diversity-123...` environment deployed by the test workflow.

Domain normalization and real test/prod separation are important, but neither causes the current invisible-product symptom and neither belongs in this two-file P0 behavior fix.

## Validation So Far

- Red against `https://supplychainsai.com`: five products render, but the test fails on the category group's `.reveal` ancestor.
- Green against the exact local worktree with the live CloudBase catalog: mobile and desktop visibility plus detail open/return pass.
- Workspace and E2E TypeScript: 0 errors.
- Repository Biome: 194 files pass.
- Site tests: 44 pass.
- Production static build: 18 pages, including `/headphones`, pass with the current custom-domain/API-origin contract.
- Temporary local dev server stopped and temporary `localhost:4322` CloudBase safe-domain entry removed after validation.
