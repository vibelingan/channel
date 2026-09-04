import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from './source-observations.ts';

const baseObservation = () => ({
  schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
  source: {
    provider: 'alibaba' as const,
    sourceProductKey: 'source-key',
    externalProductId: '10001',
    observedAt: '2026-09-04T08:00:00.000Z',
    sourceUpdatedAt: '2026-09-03T08:00:00.000Z',
    captureMode: 'incremental' as const,
    completeness: 'full-product' as const,
  },
  identity: {
    title: 'USB headset',
    matchHints: {},
    attributes: [],
  },
  content: {
    description: {
      sanitizedHtml: '<p>Safe copy</p>',
      text: 'Safe copy',
      placeholder: false,
      sanitized: true,
      provenance: 'provider-description' as const,
    },
    media: [
      {
        sourceUrl: 'https://example.com/headset.jpg',
        role: 'primary' as const,
        position: 0,
      },
    ],
  },
  lifecycle: { sourceListingStatus: 'published' as const },
  variants: [
    {
      sourceVariantKey: 'variant-key',
      externalVariantId: 'sku-1',
      options: [{ sourceName: 'Color', value: 'Blue' }],
      inventory: [{ quantity: 12, semantics: 'sellable' as const }],
      media: [],
    },
  ],
  offers: [
    {
      sourceOfferKey: 'offer-key',
      sourceVariantKey: 'variant-key',
      kind: 'supplier' as const,
      pricing: {
        mode: 'tiered' as const,
        currency: 'USD',
        minimumOrderQuantity: 10,
        tiers: [
          { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 1200 },
          { minimumQuantity: 100, unitAmountMinor: 1100 },
        ],
      },
    },
  ],
  evidence: [
    {
      kind: 'raw-payload' as const,
      evidenceId: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      sourcePath: 'alibaba_icbu_product_get_response.product',
    },
  ],
  warnings: [],
});

describe('catalog source observation runtime contract', () => {
  test('document identity is deterministic and provider-scoped', () => {
    assert.equal(
      sourceObservationDocumentId('alibaba', 'same-key'),
      sourceObservationDocumentId('alibaba', 'same-key'),
    );
    assert.notEqual(
      sourceObservationDocumentId('alibaba', 'same-key'),
      sourceObservationDocumentId('dianxiaomi', 'same-key'),
    );
  });

  test('accepts a complete tiered observation', () => {
    const result = validateCatalogSourceObservation(baseObservation());
    assert.equal(result.ok, true);
  });

  test('rejects invalid tier windows, unsafe media protocols, and unknown keys', () => {
    const invalid = baseObservation();
    invalid.content.media[0] = {
      sourceUrl: 'javascript:alert(1)',
      role: 'primary',
      position: 0,
    };
    const firstOffer = invalid.offers[0];
    assert.ok(firstOffer);
    firstOffer.pricing.tiers[1] = {
      minimumQuantity: 50,
      unitAmountMinor: 1100,
    };
    const withUnknown = { ...invalid, rawProviderResponse: { secret: true } };
    const result = validateCatalogSourceObservation(withUnknown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('sourceUrl')));
    assert.ok(result.errors.some((error) => error.includes('overlap')));
    assert.ok(result.errors.some((error) => error.includes('unrecognized')));
  });

  test('amount-bearing prices require a currency and canonical instants', () => {
    const invalid = baseObservation() as Record<string, unknown>;
    const source = invalid.source as Record<string, unknown>;
    source.observedAt = '09/04/2026 08:00';
    const offers = invalid.offers as Array<Record<string, unknown>>;
    offers[0] = {
      sourceOfferKey: 'fixed',
      kind: 'supplier',
      pricing: { mode: 'fixed', amountMinor: 100 },
    };
    const result = validateCatalogSourceObservation(invalid);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('observedAt')));
    assert.ok(result.errors.some((error) => error.includes('currency')));
  });
});
