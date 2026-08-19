# Catalog Category Expansion — Task Plan

## Goal

Produce a client-reviewable requirements and UI design package for expanding the catalog from a headphones-only experience to:

`Electronics & Toys → Headphones / AI Gadgets / Toys / Misc → SKU`

This phase defines behavior, information architecture, admin workflows, and integration boundaries. It does not implement the catalog expansion or Alibaba synchronization.

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
