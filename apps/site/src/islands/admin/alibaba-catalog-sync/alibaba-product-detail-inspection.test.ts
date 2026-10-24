import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaProductDetailInspection } from './AlibabaProductDetailInspection.tsx';
import {
  type ProductDetailInspectionSummary,
  decodeProductDetailInspectionSummary,
} from './alibaba-api.ts';

const validSummary: ProductDetailInspectionSummary = {
  sourceProductId: 'AAGmBBhgAOVTpOOZBg7MoZq_',
  payloadId: '1'.repeat(64),
  deduplicated: false,
  rawByteLength: 23_050,
  hasSubject: true,
  hasCategory: true,
  hasMoq: true,
  description: { kind: 'html', characterCount: 12_345 },
  imageCount: 6,
  skuCount: 3,
  skusWithAttributes: 3,
  attributeNameCount: 2,
  attributeNames: ['Color', 'Connectors'],
  productTierCount: 0,
  skuTieredPriceCount: 3,
  normalizedOfferCount: 3,
  normalizedPriceModes: ['tiered'],
  currency: 'USD',
  sourceStatus: 'published',
};

test('inspection summary decoder accepts the allowlisted live shape', () => {
  assert.deepEqual(decodeProductDetailInspectionSummary(validSummary), validSummary);
});

test('inspection summary decoder rejects malformed or inconsistent shapes', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    '',
    {},
    { ...validSummary, rawByteLength: -1 },
    { ...validSummary, description: null },
    { ...validSummary, description: { kind: 'script', characterCount: 1 } },
    { ...validSummary, skuCount: 2, skusWithAttributes: 3 },
    { ...validSummary, skuCount: 2, skuTieredPriceCount: 3 },
    { ...validSummary, attributeNames: ['Color', 42] },
    { ...validSummary, normalizedPriceModes: ['unknown'] },
    { ...validSummary, payloadId: '../not-a-hash' },
  ];
  for (const value of malformed) {
    assert.equal(decodeProductDetailInspectionSummary(value), null);
  }
});

test('inspection control renders bounded input, disconnected state, and safe summary only', () => {
  const disconnected = renderToStaticMarkup(
    createElement(AlibabaProductDetailInspection, {
      connected: false,
      busy: false,
      result: null,
      onInspect: () => {},
    }),
  );
  assert.ok(disconnected.includes('data-inspect-product-id'));
  assert.match(disconnected, /maxlength="128"/i);
  assert.ok(disconnected.includes('disabled'));

  const pending = renderToStaticMarkup(
    createElement(AlibabaProductDetailInspection, {
      connected: true,
      busy: true,
      inspecting: true,
      result: null,
      onInspect: () => {},
    }),
  );
  assert.ok(pending.includes('Inspecting…'));
  assert.ok(pending.includes('disabled'));

  const result = renderToStaticMarkup(
    createElement(AlibabaProductDetailInspection, {
      connected: true,
      busy: false,
      result: validSummary,
      syncResult: {
        sourceProductId: validSummary.sourceProductId,
        productId: 'draft-1',
        draftCreated: true,
        offerCount: 3,
      },
      onInspect: () => {},
      onSync: () => {},
    }),
  );
  assert.ok(result.includes('data-detail-inspection-result'));
  assert.ok(result.includes('23,050'));
  assert.ok(result.includes('3 / 3'));
  assert.ok(result.includes('tiered'));
  assert.ok(result.includes('Color'));
  assert.ok(result.includes('Sync to Products'));
  assert.ok(result.includes('Created product draft'));
  assert.ok(result.includes('It remains unpublished'));
  assert.ok(!result.includes('<script>'));
  assert.ok(!result.includes('Bearer '));
  assert.ok(!result.includes('access-token'));
});
