import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogImportBundle } from '../../contracts.ts';
import type { StoreListingRecord } from '../../grouping.ts';
import { dianxiaomiObservationAdapter } from './observations.ts';

test('Dianxiaomi candidates cross the common observation seam without losing source facts', () => {
  const bundle: CatalogImportBundle = {
    schemaVersion: '1',
    provider: 'dianxiaomi',
    templateId: 'template-1',
    sourceFileSha256: 'b'.repeat(64),
    findings: [],
    ignoredHeaders: [],
    products: [
      {
        identity: {
          provider: 'dianxiaomi',
          sourceProductKey: 'dianxiaomi|lazada||PARENT-1',
          externalProductId: '9988',
        },
        matchHints: { parentSku: 'PARENT-1', brand: 'Acme' },
        parentSku: 'PARENT-1',
        title: 'Headset',
        brand: 'Acme',
        descriptionHtml: '<p>Prepared copy</p>',
        descriptionText: 'Prepared copy',
        descriptionSource: 'description',
        attributes: { Material: 'ABS' },
        media: [
          {
            sourceUrl: 'https://example.com/product.jpg',
            role: 'primary',
            position: 0,
          },
        ],
        variants: [
          {
            identity: {
              provider: 'dianxiaomi',
              sourceProductKey: 'dianxiaomi|lazada||PARENT-1',
              sourceVariantKey: 'dianxiaomi|lazada|hk-store|SKU-1',
              externalVariantId: 'variant-9988',
            },
            matchHints: { sku: 'SKU-1' },
            sku: 'SKU-1',
            optionValues: { Color: 'Black' },
            sourceRegularPrice: { amountMinor: 12900, currency: 'CNY' },
            sourcePromotionPrice: { amountMinor: 9900, currency: 'CNY' },
            inventory: [
              {
                storeKey: 'hk-store',
                quantity: 7,
                semantics: 'sellable',
                capturedAt: '2026-09-04T08:00:00.000Z',
              },
            ],
            media: [],
          },
        ],
        sourceListingStatus: 'published',
      },
    ],
  };

  const result = dianxiaomiObservationAdapter.toObservations({
    bundle,
    observedAt: '2026-09-04T09:00:00.000Z',
  });

  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.findings, []);
  const observation = result.observations[0];
  assert.ok(observation);
  assert.equal(observation.source.provider, 'dianxiaomi');
  assert.equal(observation.source.captureMode, 'import');
  assert.equal(observation.content.description?.sanitizedHtml, '<p>Prepared copy</p>');
  assert.deepEqual(observation.identity.attributes, [{ sourceName: 'Material', value: 'ABS' }]);
  assert.deepEqual(observation.variants[0]?.options, [{ sourceName: 'Color', value: 'Black' }]);
  assert.equal(observation.variants[0]?.inventory[0]?.quantity, 7);
  assert.deepEqual(
    observation.offers.map((offer) => [offer.kind, offer.pricing]),
    [
      ['regular', { mode: 'fixed', currency: 'CNY', amountMinor: 12900 }],
      ['promotion', { mode: 'fixed', currency: 'CNY', amountMinor: 9900 }],
    ],
  );
  assert.equal(observation.evidence[0]?.sha256, 'b'.repeat(64));
});

test('Dianxiaomi store-scoped prices remain separate offers', () => {
  const productKey = 'dianxiaomi|lazada||PARENT-1';
  const variantKey = 'dianxiaomi|lazada||SKU-1';
  const bundle: CatalogImportBundle = {
    schemaVersion: '1',
    provider: 'dianxiaomi',
    templateId: 'template-1',
    sourceFileSha256: 'e'.repeat(64),
    findings: [],
    ignoredHeaders: [],
    products: [
      {
        identity: { provider: 'dianxiaomi', sourceProductKey: productKey },
        matchHints: { parentSku: 'PARENT-1' },
        parentSku: 'PARENT-1',
        title: 'Headset',
        attributes: {},
        media: [],
        variants: [
          {
            identity: {
              provider: 'dianxiaomi',
              sourceProductKey: productKey,
              sourceVariantKey: variantKey,
            },
            matchHints: { sku: 'SKU-1' },
            sku: 'SKU-1',
            optionValues: {},
            inventory: [],
            media: [],
            // This aggregate is only the compatibility fallback. Store rows
            // below are the authoritative per-store observations.
            sourceRegularPrice: { amountMinor: 1000, currency: 'CNY' },
          },
        ],
        sourceListingStatus: 'published',
      },
    ],
  };
  const listing = (
    storeKey: string,
    amountMinor: number,
    rowNumber: number,
  ): StoreListingRecord => ({
    rowNumber,
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    storeKey,
    sourceProductKey: `dianxiaomi|lazada|${storeKey}|PARENT-1`,
    sourceVariantKey: `dianxiaomi|lazada|${storeKey}|SKU-1`,
    candidateGroupKey: productKey,
    candidateSkuKey: variantKey,
    parentSku: 'PARENT-1',
    sku: 'SKU-1',
    sourceListingStatus: 'published',
    sourceRegularPrice: { amountMinor, currency: 'CNY' },
  });

  const result = dianxiaomiObservationAdapter.toObservations({
    bundle,
    storeListings: [listing('hk', 1000, 2), listing('sg', 1100, 3)],
    observedAt: '2026-09-04T09:00:00.000Z',
  });
  assert.equal(result.observations.length, 1);
  assert.deepEqual(
    result.observations[0]?.offers.map((offer) => [offer.storeKey, offer.kind, offer.pricing]),
    [
      ['hk', 'regular', { mode: 'fixed', currency: 'CNY', amountMinor: 1000 }],
      ['sg', 'regular', { mode: 'fixed', currency: 'CNY', amountMinor: 1100 }],
    ],
  );
});
