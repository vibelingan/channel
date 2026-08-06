# Channel Alibaba Open Platform Linked Catalog Sync — Implementation Documentation

**Document language:** English only  
**Status:** implementation-ready for independent review and agent execution  
**Repository:** `vibelingan/channel`  
**Reviewed baseline:** `main@5c14193b93cf023ed791086902bc4423fd077198`  
**Feature branch:** `feature/alibaba-linked-catalog-sync`  
**Documentation folder:** `docs/alibaba-linked-catalog-sync/`  
**Cloud function:** `alibaba-catalog-sync`

This package is the authoritative implementation contract for Alibaba Open Platform catalog synchronization in Channel.

It is intentionally **additive and compatibility-preserving**:

- existing `products.unitPrice`, `products.wholesalePrice`, and `products.vipPrice` fields remain;
- existing `PriceBlock`, role-gated pricing, catalog bearer-token logic, fixtures, and legacy product behavior remain;
- the new Alibaba-linked path does not write to or depend on those legacy fields;
- linked products use a new, clearly named `alibabaCatalogPricing` field and renderer;
- unlinked products continue to use the current pricing path unchanged;
- no data cleanup, field removal, schema deletion, or broad pricing refactor belongs to this feature.

## Authoritative reading order

1. `START_HERE.md` — exact instructions for the implementation agent.
2. `REVIEW_REPORT.md` — final review decisions and corrections from the prior version.
3. `DESIGN_CHARTER.md` — frozen scope, invariants, and ownership boundaries.
4. `ARCHITECTURE.md` — exact modules, collections, data contracts, workflows, security, and deployment.
5. `COMPATIBILITY_AND_ACTIVATION_PLAN.md` — additive rollout, precedence rules, rollback, and legacy protection.
6. `ISSUE.md` — implementation objective and acceptance criteria.
7. `MIU_BREAKDOWN.md` — ordered implementation units with dependencies and done conditions.
8. `EXECUTION_HANDOFF.md` — branch setup, commands, evidence, review, and deployment loop.
9. `AGENT_REVIEW_CHECKLIST.md` — independent review lenses.

## Frozen headline decisions

- Alibaba Open Platform is the commercial source for Alibaba-linked product pricing, MOQ, SKU, and availability.
- Existing legacy pricing fields and logic are preserved and remain active for unlinked products.
- The sync service never writes `unitPrice`, `wholesalePrice`, or `vipPrice`.
- Alibaba-linked products use `products.alibabaCatalogPricing` as a source-owned materialized field.
- A linked product never falls back to stale legacy prices when Alibaba pricing is unavailable; it shows an unavailable/quote-required state.
- A product without an Alibaba link continues through the existing legacy UI/API path exactly as before.
- New source products are never published automatically.
- Curated product name, description, Channel category, public media, merchandising, and publication state remain operator-owned.
- Exact source response bytes, normalized source records, deterministic links, resumable checkpoints, fencing leases, encrypted OAuth tokens, SSRF-safe media import, and deployment manifest parity are mandatory.
- No scraping, FX conversion, markup, checkout, payment, payout, or Medusa implementation is included.

## No open architecture branches

External permissions, real API fixtures, and CloudBase trigger availability are execution gates. They may stop implementation or deployment with evidence, but they do not authorize an agent to invent a different architecture, scrape web pages, overwrite legacy pricing fields, or remove existing behavior.
