/**
 * Parity for the "changed since approval" digest (MIU-16): the db path hashes the
 * stored observation, the sync path hashes `validateCatalogSourceObservation`'s
 * result. If they differed, every product would look changed on its first sync.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicSourceDigest } from '@vibelingan-channel/shared/catalog-source-digest';
import {
  CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
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

test('a stored observation and its validated copy have the same public digest', () => {
  const observation = baseObservation();
  const stored = JSON.parse(JSON.stringify({ observation })).observation;
  const validated = validateCatalogSourceObservation(stored);
  assert.ok(validated.ok);
  if (!validated.ok) return;
  const digest = publicSourceDigest(observation);
  assert.equal(publicSourceDigest(stored), digest);
  assert.equal(publicSourceDigest(validated.value), digest);
});

test('a re-observation with only a new capture time and stock keeps the digest', () => {
  const first = baseObservation();
  const later = baseObservation();
  later.source.observedAt = '2026-10-08T08:00:00.000Z';
  later.source.captureMode = 'full' as never;
  const variant = later.variants[0];
  assert.ok(variant);
  variant.inventory = [{ quantity: 0, semantics: 'sellable' as const }];
  assert.equal(publicSourceDigest(later), publicSourceDigest(first));
});
