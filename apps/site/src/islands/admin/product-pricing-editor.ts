import {
  type ManualCatalogPricing,
  validateManualCatalogPricing,
} from '@vibelingan-channel/shared';
import {
  type CatalogPricingInput,
  createAlibabaPricingAdapter,
} from '@vibelingan-channel/shared/catalog';

/** Admin documents contain private provenance absent from the public pricing contract. */
export function adminCatalogPricingInput(doc: Record<string, unknown>): CatalogPricingInput {
  const raw = doc.alibabaCatalogPricing;
  const pricing: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of [
      'schemaVersion',
      'source',
      'currency',
      'mode',
      'amountMinor',
      'minAmountMinor',
      'maxAmountMinor',
      'tiers',
      'sourceMoq',
      'sourceUpdatedAt',
      'syncedAt',
    ]) {
      if (Object.hasOwn(raw, key)) pricing[key] = Reflect.get(raw, key);
    }
  }
  return {
    ...(Object.hasOwn(doc, 'alibabaPrimarySourceKey')
      ? { alibabaPrimarySourceKey: doc.alibabaPrimarySourceKey, alibabaCatalogPricing: pricing }
      : {}),
    ...(doc.catalogPricingMode === undefined || doc.catalogPricingMode === ''
      ? {}
      : { catalogPricingMode: doc.catalogPricingMode }),
    manualCatalogPricing: doc.manualCatalogPricing,
    wholesalePrice: doc.wholesalePrice,
    unitPrice: doc.unitPrice,
  };
}

/** Explicit user command only; never called to populate persistent form state on load. */
export function manualPricingSeed(input: CatalogPricingInput): ManualCatalogPricing | undefined {
  const existing = validateManualCatalogPricing(input.manualCatalogPricing);
  if (existing.ok) return existing.value;
  const source = createAlibabaPricingAdapter().resolve(
    input.alibabaPrimarySourceKey,
    input.alibabaCatalogPricing,
  );
  if (source.state !== 'available') return undefined;
  const tiers =
    source.mode === 'tiered'
      ? source.tiers
          .filter(
            (tier) => tier.maxQuantity === undefined || tier.maxQuantity >= (source.sourceMoq ?? 1),
          )
          .map((tier) => ({
            ...tier,
            minQuantity: Math.max(tier.minQuantity, source.sourceMoq ?? tier.minQuantity),
          }))
      : source.mode === 'fixed' && source.sourceMoq !== undefined
        ? [{ minQuantity: source.sourceMoq, unitAmountMinor: source.amountMinor }]
        : undefined;
  const parsed = validateManualCatalogPricing({
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: source.currency,
    tiers,
  });
  return parsed.ok ? parsed.value : undefined;
}
