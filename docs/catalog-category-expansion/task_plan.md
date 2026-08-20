# Catalog Category Expansion — Task Plan

## Goal

Produce a client-reviewable requirements and UI design package for expanding the catalog from a headphones-only experience to:

`Electronics & Toys → Headphones / AI Gadgets / Toys / Misc → SKU`

The requirements/design phase is complete and the client-approved V1.1 scope is now being
implemented on `feat/catalog-category-design`. Alibaba API transport/scheduling remains unchanged.

## Truth Conditions

- The public-site design covers desktop and mobile category navigation, category landing/list states, SKU detail entry, and empty/error states.
- The admin design covers category tabs, filtering, manual product creation/editing, and category assignment.
- The data contract reuses the current headphone product fields where practical and identifies only the category-specific extensions that are required.
- Future Alibaba ingestion can create/update the same canonical product records without owning the storefront UI contract.
- SEO/GEO requirements are compatible with the active Phase 3 plan and do not require another URL migration when categories are implemented.
- Open business decisions are isolated in a short client confirmation checklist.

## Phases

| Phase | Status | Check |
|---|---|---|
| 1. Inspect current headphones implementation | Complete | Current routes, fields, admin flow, and tests are cited in findings |
| 2. Inspect Alibaba and SEO branch contracts | Complete | Integration constraints and URL/metadata constraints are recorded |
| 3. Define requirements and information architecture | Complete | Product hierarchy, scope, roles, states, and acceptance criteria are explicit |
| 4. Define public and admin UI | Complete | Annotated desktop/mobile wireframes and interaction rules are documented |
| 5. Package client decisions and implementation handoff | Complete | Client checklist and technical follow-up work are separated clearly |
| 6. Validate documentation | Complete | Markdown checks, typecheck, lint, and consistency review pass |
| 7. Define low-risk Phase 1 LLD | Complete | Menu/pages/seed scope is separated from deferred customer decisions |
| 8. Decompose Phase 1 MIUs | Complete | Every MIU uses exact files, TDD assertions, dependencies, and runtime impact |
| 9. Review and validate Phase 1 handoff | Complete | Independent architecture/MIU review and document checks pass |
| 10. Implement shared product contracts | Complete | MIU 1-2 tests/typechecks pass and commits are pushed |
| 11. Implement atomic product identities | Complete | Storage transaction, provisioning, probes, and Admin repository pass |
| 12. Implement Admin product invariants | Complete | Atomic lifecycle, authorization, and image-counter races pass |
| 13. Implement public product projection | Complete | MIU 5 identity, archive, legacy, and image contracts pass |
| 14. Implement family filtering | Complete | MIU 6 bounded family query and local transport parity pass |
| 15. Implement slug detail lookup | Complete | MIU 7 canonical and encoded-path contracts pass |
| 16. Implement site catalog client | Complete | MIU 8 DTO, family/slug/related helpers pass |
| 17. Implement full-family local seed | Complete | MIU 9 fixtures, reservations, refcounts, and repair pass |
| 18. Implement catalog content/menu | Complete | MIU 10 registry and accessible disclosures pass |
| 19. Implement catalog hub | Complete | MIU 11 route, family cards, Featured states, metadata, browser checks, and review pass |
| 20. Implement shared family catalog | Complete | MIU 12 generation-safe controller, link grid, states, pricing, and filters pass |
| 21. Implement family route shells | Complete | MIU 13 shared Headphones, AI Gadgets, and Toys routes pass |
| 22. Implement Other Electronics route/indexing | Complete | MIU 14 dynamic metadata and sitemap artifact pass |
| 23. Implement SKU detail shell | Complete | MIU 15 detail, gallery, OEM content, related products, and journeys pass |
| 24. Implement Admin Products family tabs | Complete | MIU 16 URL/query/form/mobile contracts pass |
| 25. Implement Admin product form/media | Complete | MIU 17 grouped fields, nine-image management, and error mapping pass |
| 26. Suppress public/auth VIP presentation | Complete | MIU 18 source, build, pricing, and browser negatives pass |
| 27. Pin Alibaba compatibility | Complete | MIU 19 V1.1 ownership/linking/promotion regressions pass |
| 28. Implement catalog SEO/breadcrumb contract | Complete | MIU 20 structured data, canonical, browser, artifact, and audit gates pass |
| 29. Implement public/Admin E2E workflows | Complete | MIU 21 public, Admin UI, disposable mutation, workflow, and audit gates pass |
| 30. Complete local-seed delivery verification | In progress | MIU 22 full-family seed, compatibility, deploy, and remote-delivery gate active |

## Scope Boundaries

### In scope

- Four second-level categories: Headphones, AI Gadgets, Toys, Misc.
- Public navigation and catalog browsing design.
- Admin category tabs and manual product management design.
- Canonical product/category contract suitable for later Alibaba import.
- SEO/GEO-compatible URL and metadata design.

### Out of scope for this phase

- Alibaba API authentication, polling, webhook, or scheduled synchronization.
- Automated migration/backfill of existing products.
- Production UI or backend implementation.
- Final client-facing category copy, imagery, or translated merchandising content.
