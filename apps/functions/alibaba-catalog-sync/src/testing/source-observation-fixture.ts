/** Complete synthetic observations for mirror/identity tests, never production ingestion. */
import assert from 'node:assert/strict';
import {
  type CatalogSourceObservation,
  type CatalogSourcePricing,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  alibabaCatalogPricingSchema,
  createAlibabaPricingAdapter,
} from '@vibelingan-channel/shared/catalog';
import { z } from 'zod';

function quote(sourceKey: string, input: unknown): CatalogSourcePricing {
  // Mirror pricing carries private provenance beside the public quote fields.
  const pricing = alibabaCatalogPricingSchema.strip().parse(input);
  const decision = createAlibabaPricingAdapter().resolve(sourceKey, pricing);
  const minimum =
    decision.sourceMoq === undefined ? {} : { minimumOrderQuantity: decision.sourceMoq };
  if (decision.state === 'unavailable') return { mode: 'unavailable', ...minimum };
  if (decision.state === 'quote')
    return {
      mode: 'negotiable',
      ...minimum,
      ...(decision.currency ? { currency: decision.currency } : {}),
    };
  if (decision.mode === 'fixed')
    return {
      mode: 'fixed',
      currency: decision.currency,
      amountMinor: decision.amountMinor,
      ...minimum,
    };
  if (decision.mode === 'range')
    return {
      mode: 'range',
      currency: decision.currency,
      minimumAmountMinor: decision.minAmountMinor,
      maximumAmountMinor: decision.maxAmountMinor,
      ...minimum,
    };
  return {
    mode: 'tiered',
    currency: decision.currency,
    ...minimum,
    tiers: decision.tiers.map((tier) => ({
      minimumQuantity: tier.minQuantity,
      unitAmountMinor: tier.unitAmountMinor,
      ...(tier.maxQuantity === undefined ? {} : { maximumQuantity: tier.maxQuantity }),
    })),
  };
}

export function sourceObservationFixture(
  source: CollectionDoc,
  offers: CollectionDoc[] = [],
): CollectionDoc {
  const urls = z.array(z.string()).parse(source.sourceImageUrls ?? []);
  const variants = new Map<string, CatalogSourceObservation['variants'][number]>();
  const sourceOffers: CatalogSourceObservation['offers'] = [];
  for (const offer of offers) {
    if (offer.sourceKey !== source._id || offer.active !== true) continue;
    const sku =
      typeof offer.sourceSkuId === 'string' && offer.sourceSkuId !== '@product'
        ? offer.sourceSkuId
        : undefined;
    if (sku)
      variants.set(sku, {
        sourceVariantKey: sku,
        externalVariantId: sku,
        options: [],
        inventory: [],
        media: [],
      });
    sourceOffers.push({
      sourceOfferKey: offer._id,
      kind: 'supplier',
      pricing: quote(source._id, offer.pricing),
      ...(sku ? { sourceVariantKey: sku } : {}),
    });
  }
  const evidenceId = typeof source.payloadId === 'string' ? source.payloadId : 'a'.repeat(64);
  const observation: CatalogSourceObservation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: source._id,
      externalProductId: z.string().min(1).parse(source.sourceProductId),
      observedAt: '2026-01-01T00:00:00.000Z',
      captureMode: 'selected',
      completeness: 'full-product',
    },
    identity: {
      title:
        typeof source.sourceTitle === 'string' ? source.sourceTitle : 'Synthetic source fixture',
      matchHints: {},
      attributes: [],
    },
    content: {
      media: urls.map((sourceUrl, position) => ({
        sourceUrl,
        position,
        role: position === 0 ? 'primary' : 'gallery',
      })),
      ...(typeof source.sourceDescription === 'string'
        ? {
            description: {
              text: source.sourceDescription,
              placeholder: false,
              sanitized: true,
              provenance: 'provider-description' as const,
            },
          }
        : {}),
    },
    lifecycle: { sourceListingStatus: source.active === false ? 'missing' : 'published' },
    variants: [...variants.values()],
    offers: sourceOffers,
    evidence: [
      {
        kind: 'raw-payload',
        evidenceId,
        ...(/^[a-f0-9]{64}$/.test(evidenceId) ? { sha256: evidenceId } : {}),
      },
    ],
    warnings: [],
  };
  const parsed = validateCatalogSourceObservation(observation);
  assert.ok(parsed.ok, parsed.ok ? undefined : parsed.errors.join('; '));
  return {
    _id: sourceObservationDocumentId('alibaba', source._id),
    provider: 'alibaba',
    sourceProductKey: source._id,
    active: source.active !== false,
    observation: parsed.value,
  };
}
