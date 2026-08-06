# Architecture Review Report — Additive Compatibility Revision

## 1. Verdict

The previous V3 documentation was too destructive for the current project stage. It proposed removing `vipPrice`, replacing `unitPrice` and `wholesalePrice`, deleting role-gated pricing logic, and cutting the entire catalog over to a new generic `catalogPrice` model.

That direction was not required to deliver Alibaba synchronization and created unnecessary regression risk across the completed Headphones work, existing catalog components, public API authorization, fixtures, and future manual catalog use.

This revision freezes a better design:

> Add a provider-specific Alibaba pricing path alongside existing pricing. Preserve legacy fields and logic. Route only Alibaba-linked products to the new path.

**Result:** this package is implementation-ready and may be handed directly to an agent after independent review.

## 2. Repository facts preserved by this design

At the reviewed baseline:

- `products` and `overstock` define `unitPrice`, `wholesalePrice`, and/or `vipPrice`.
- `catalog-types.ts` exposes those fields.
- `PriceBlock.tsx` renders the legacy wholesale/VIP model.
- public catalog routes verify an optional bearer token and attach `vipPrice` for entitled roles.
- current product and Headphones components already depend on portions of this behavior.
- function packaging and deployment still hardcode `admin` and `public-api`.
- the DB adapter has provider-neutral CRUD plus a proven transaction pattern for image mutation ownership.

The Alibaba feature must integrate with those facts rather than deleting them.

## 3. Corrections from the prior documentation

| Area | Prior V3 direction | Final additive decision |
|---|---|---|
| Existing pricing fields | Physically remove `unitPrice`, `wholesalePrice`, `vipPrice` | Preserve all fields and database values |
| Existing pricing code | Delete `PriceBlock`, VIP entitlement, bearer-token pricing | Preserve unchanged for unlinked/legacy products |
| New product price field | Generic `catalogPrice` | Provider-specific `alibabaCatalogPricing` |
| New collections | Generic `integrationConnections`, `sourceProducts`, `syncRuns` | Alibaba-prefixed collection names |
| Package/function names | Generic `alibaba-sync` / integration storage abstractions | `alibaba-catalog-sync` and `packages/alibaba-catalog-sync` |
| Linked product display | Global cutover | New Alibaba branch only when `alibabaPrimarySourceKey` exists |
| Missing Alibaba price | Remove stale fields | Keep legacy fields untouched but do not render them for linked products |
| Migration | Destructive field-removal migration | Additive compatibility and activation plan |
| Overstock | Remove its VIP pricing | Completely out of scope and unchanged |
| Future cleanup | Included in Phase 2 | Separate future project requiring explicit approval and usage evidence |

## 4. Why `alibabaCatalogPricing` is still needed

Preserving legacy fields does not mean writing Alibaba data into ambiguous flat fields.

Alibaba pricing may be:

- fixed;
- a range;
- quantity-tiered;
- negotiable;
- unavailable;
- denominated in CNY or USD;
- tied to a product-level offer or SKU.

Therefore Alibaba synchronization uses a structured, provider-specific field while leaving legacy fields intact.

## 5. Final precedence decision

For a linked product, Alibaba is the current commercial source. The UI and API expose `alibabaCatalogPricing`. Existing legacy price values may still exist in the document but are ignored by the linked-product rendering branch.

This avoids both destructive migration and misleading fallback:

- legacy values remain available for rollback and old workflows;
- Alibaba-linked buyers do not see stale manual values when the source is unavailable;
- unlinking a product restores the existing legacy rendering path without reconstructing deleted data.

## 6. No hidden cleanup scope

An implementation agent must not interpret comments such as “legacy” or “not used by Alibaba” as permission to remove code. Optional documentation comments may identify compatibility ownership, but code deletion is explicitly excluded.
