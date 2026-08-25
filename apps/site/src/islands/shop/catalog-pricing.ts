import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import type { AlibabaCatalogPricing, Product, ProductFamily } from './catalog-types.ts';

type PublicationCompleteCatalogProduct = Product & {
  productFamily: ProductFamily;
  slug: string;
  skuCode: string;
  description: string;
  images: string[];
};

const alibabaAdapter = createAlibabaPricingAdapter();
const VALIDATION_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export function validMinorAmount(value: unknown): value is number {
  const decision = alibabaAdapter.resolve('validation', {
    schemaVersion: 'alibaba-catalog-pricing-v1',
    source: 'alibaba',
    mode: 'fixed',
    currency: 'USD',
    amountMinor: value,
    syncedAt: VALIDATION_TIMESTAMP,
  });
  return decision.state === 'available' && decision.mode === 'fixed';
}

export function validAlibabaTiers(pricing: AlibabaCatalogPricing): boolean {
  const decision = alibabaAdapter.resolve('validation', {
    schemaVersion: pricing.schemaVersion,
    source: pricing.source,
    mode: 'tiered',
    currency: pricing.currency,
    tiers: pricing.tiers,
    sourceMoq: pricing.sourceMoq,
    sourceUpdatedAt: pricing.sourceUpdatedAt,
    syncedAt: pricing.syncedAt,
  });
  return decision.state === 'available' && decision.mode === 'tiered';
}

export function publicManualPrice(product: Product): number | undefined {
  const decision = resolveCatalogPricing(product, alibabaAdapter);
  if (decision.source === 'scalar') return decision.amount;
  if (decision.source !== 'manual-tiered') return undefined;

  const scalarDecision = resolveCatalogPricing(
    { ...product, manualCatalogPricing: undefined },
    alibabaAdapter,
  );
  return scalarDecision.source === 'scalar' ? scalarDecision.amount : undefined;
}

export function isPublicationCompleteCatalogProduct(
  product: Product,
): product is PublicationCompleteCatalogProduct {
  return Boolean(
    product.name.trim() &&
      product.productFamily &&
      product.slug?.trim() &&
      product.skuCode?.trim() &&
      product.description?.trim() &&
      product.images?.some(Boolean),
  );
}
