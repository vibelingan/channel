import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlibabaProductDetailDraft } from './alibaba-contracts.ts';
import { alibabaObservationAdapter } from './alibaba-observation-adapter.ts';

const detail = (overrides: Partial<AlibabaProductDetailDraft> = {}): AlibabaProductDetailDraft => ({
  sourceProductId: '10001',
  subject: 'USB headset',
  description: '<div style="color:red" onclick="bad()"><script>bad()</script>Safe copy</div>',
  categoryId: '44',
  imageUrls: ['https://example.com/a.jpg', 'javascript:alert(1)'],
  moqLexeme: '10',
  currencyLexeme: 'USD',
  ladderPrices: [],
  skus: [
    {
      sourceSkuId: 'sku-blue',
      attributes: { Color: 'Blue', Connectors: 'USB + 3.5mm' },
      availableQuantity: 12,
      ladderPrices: [
        { minQuantityLexeme: '10', priceLexeme: '12.00' },
        { minQuantityLexeme: '100', priceLexeme: '11.00' },
      ],
    },
  ],
  gmtModified: '2026-09-03 16:00:00',
  status: 'approved',
  ...overrides,
});

test('Alibaba detail becomes the same validated observation contract', () => {
  const result = alibabaObservationAdapter.toObservations({
    connectionId: 'channeltec',
    detail: detail(),
    payloadId: 'c'.repeat(64),
    observedAt: '2026-09-04T08:00:00.000Z',
    captureMode: 'selected',
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    ['description-sanitized', 'invalid-media-url'],
  );
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0];
  assert.ok(observation);
  assert.equal(observation.source.externalProductId, '10001');
  assert.equal(observation.source.captureMode, 'selected');
  assert.equal(observation.source.sourceUpdatedAt, '2026-09-03T08:00:00.000Z');
  assert.equal(observation.content.description?.sanitizedHtml, 'Safe copy');
  assert.equal(observation.content.description?.text, 'Safe copy');
  assert.deepEqual(observation.variants[0]?.options, [
    { sourceName: 'Color', value: 'Blue' },
    { sourceName: 'Connectors', value: 'USB + 3.5mm' },
  ]);
  assert.equal(observation.variants[0]?.inventory[0]?.quantity, 12);
  assert.deepEqual(observation.offers[0]?.pricing, {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 10,
    tiers: [
      { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 1200 },
      { minimumQuantity: 100, unitAmountMinor: 1100 },
    ],
  });
  assert.equal(observation.evidence[0]?.evidenceId, 'c'.repeat(64));
});

test('missing identity and hostile optional fields degrade to findings, never throw', () => {
  const missingIdentity: AlibabaProductDetailDraft = {
    imageUrls: [],
    ladderPrices: [],
    skus: [],
  };
  const result = alibabaObservationAdapter.toObservations({
    connectionId: 'channeltec',
    detail: missingIdentity,
    payloadId: 'd'.repeat(64),
    observedAt: '2026-09-04T08:00:00.000Z',
    captureMode: 'incremental',
  });
  assert.deepEqual(result.observations, []);
  assert.equal(result.findings[0]?.code, 'missing-product-id');
  assert.equal(result.findings[0]?.severity, 'error');
});

test('an offline but retrievable product is not mislabeled as missing', () => {
  const result = alibabaObservationAdapter.toObservations({
    connectionId: 'channeltec',
    detail: detail({ status: 'offline' }),
    payloadId: 'e'.repeat(64),
    observedAt: '2026-09-04T08:00:00.000Z',
    captureMode: 'incremental',
  });
  const observation = result.observations[0];
  assert.ok(observation);
  assert.equal(observation.lifecycle.sourceListingStatus, 'draft');
});
