# Catalog Category Expansion - Compatibility Gate

MIU 22 cross-file and release-readiness checklist for `feat/catalog-category-design`.

## Compatibility Matrix

| Area | Required invariant | Evidence | Status |
|---|---|---|---|
| Product family | Closed set is Headphones, AI Gadgets, Toys, Misc; legacy missing-family Headphones remains readable without mutation | Shared contract tests, public API tests, exact local seed E2E | Passed |
| Identity | Slug/SKU normalization and reservations remain atomic and owner-bound | Shared/Admin/DB/local race tests | Passed |
| Publication | Published products require family, slug, SKU, name, description, image, and non-archived state | Admin transaction tests and disposable lifecycle E2E | Passed |
| Public API | Family/filter/search/page composition, slug detail, archive suppression, max-nine images, and allowlist projection remain aligned | Public/local tests, catalog browser suite, local seed E2E | Passed |
| Admin UI | Products tabs/form/media states remain registry-driven; VIP and Alibaba-owned fields are not editable | Site tests and six deployed-safe Admin browser journeys | Passed |
| Media | Product maximum is nine; Overstock remains eighteen; visible galleries preserve bounded order | Shared/media tests and SKU browser coverage | Passed |
| Alibaba | Sync does not own family/category/slug/SKU/images/publication; promotion modifies Alibaba fields only | MIU 19 Alibaba/shared regression suites | Passed |
| Pricing | Linked products never fall back to manual/VIP; fixed uses Offer, ranges use AggregateOffer, malformed values fail closed | MIU 18/20 focused and browser tests | Passed |
| VIP retirement | No public/auth/Admin presentation exposes VIP copy or values; storage/type compatibility remains | MIU 18 tests, catalog/Admin E2E, public projection negatives | Passed |
| SEO | Canonical trailing slashes, visible/structured breadcrumbs, bounded metadata, SKU noindex, and sitemap exclusions remain aligned | MIU 20 tests, browser checks, production artifact parser | Passed |
| Menu | Native no-JS disclosure exposes hub/four families; keyboard/focus/mobile and active-state behavior remain correct | Header source tests and 16 public browser journeys | Passed |
| Local seed | Exact raw/public 6/2/2/2 population, one legacy row, raw non-Headphones safety, public projection, and real SKU detail | `catalog-local-seed.spec.ts` and local-server seed tests | Passed |
| Mutation isolation | Shared environments are archive-only; real lifecycle runs only against nonce/exact-DB-verified loopback temporary storage | Runner/spec guards and successful whole-DB teardown | Passed |
| Workflow secrets | Public suites receive no secrets; credentialed suites receive only required values; bootstrap token is bootstrap-only | Workflow YAML review and parse check | Passed |
| Dependencies | No new runtime dependency added for catalog delivery | Package/lockfile review | Passed |

## Cross-File Traces

```yaml
cross-file-reasoning:
  scope: catalog V1.1 delivery
  symbols-traced:
    - name: productFamily
      trace: shared registry -> atomic write -> Admin query/form -> public query/projection -> site DTO -> family routes/E2E
      verdict: PASS
    - name: slug/skuCode
      trace: normalization -> identity reservation -> Admin errors -> public slug route -> runtime canonical/schema -> seed/E2E
      verdict: PASS
    - name: PRODUCT_IMAGE_MAX_COUNT
      trace: shared product contract -> Admin capacity -> public projection -> gallery -> deployed/local smoke
      verdict: PASS
    - name: Alibaba pricing
      trace: provider validator -> public sub-projection -> browser decoder -> visible pricing -> Product schema
      verdict: PASS
    - name: catalog routes
      trace: content registry -> header links -> Astro routes/canonicals -> sitemap -> Playwright/deployed smoke
      verdict: PASS
    - name: local mutation boundary
      trace: package script -> nonce readiness -> loopback API/site -> exact health DB -> Playwright -> process cleanup -> directory deletion
      verdict: PASS
  verdict: PASS
```

## Deployment Readiness

| Gate | Requirement | Status |
|---|---|---|
| Type safety | All packages/apps/E2E compile | Passed |
| Unit/integration | Shared, DB, functions, site, local server, scripts pass | Passed |
| Function artifacts | Build/package/cold-start smoke | Passed |
| CloudBase SDK contract | Installed SDK/runtime probes pass | Passed |
| Static site | Explicit production origin build and secret-name scan pass | Passed |
| Local E2E | Exact seed plus real lifecycle on deleted temporary DB | Passed |
| Preview E2E | Public catalog and non-mutating Admin UI on deployed test SHA | Passed: public 37/37 and catalog 16/16 on run `32359898758` |
| Deployed smoke | Release SHA, routes, declared stocked families, optional slug detail, negatives, protected Admin read | Passed: run `32359898758` |
| Independent review | No open assumption/cross-file findings | Passed; remediation findings closed and recorded |
| Remote delivery | Reviewed final SHA pushed to one feature branch | Passed: `8f64659`; PR #27 open, mergeable, CI green |
| Production | Explicit approval before live smoke/deploy | Not authorized |

## Risk Register

| Risk | Mitigation | Residual state |
|---|---|---|
| Static SKU metadata cannot be fully server-rendered | Generic `noindex,follow`, no sitemap enumeration, runtime schema only after complete published DTO | Accepted static-hosting trade-off |
| Shared test environment accumulates mutation records | Real catalog lifecycle is prohibited remotely and runs on a deleted temporary DB | Closed |
| Long-lived Vite server loses hydration after config reload | Browser evidence always uses fresh worktree-bound process | Operational constraint |
| Family route slash drift breaks active state/canonicals | Canonical href tests plus browser active-state assertions | Closed |
| Provider pricing shape drifts | Strict schema/key/time/mode/tier decoder and visible/schema parity tests | Closed |
| Production differs from test environment | Release-ID smoke and explicit production approval gate | Open until approved |
| Test preview branch policy | Delivered by merging into the `test` branch, which triggers Deploy Test directly; no environment-policy change or admin rights required | Resolved |

## Sign-Off

- [x] Cross-file compatibility matrix has no open implementation finding.
- [x] Exact local full-family verification passes.
- [x] Disposable mutation lifecycle and teardown pass.
- [x] Final full repository/function/SDK gates pass.
- [x] Test deploy, smoke, and E2E pass for final SHA.
- [x] Final MIU 22–25 review/validation evidence is recorded.
- [x] Final SHA is blessed and pushed.
- [x] PR status is recorded: <https://github.com/vibelingan/channel/pull/27>.
- [x] Production smoke is explicitly recorded as not authorized; no production claim is made.
