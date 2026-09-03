import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { AlibabaProductDetailDraft } from './alibaba-contracts.ts';
import {
  PRODUCT_LEVEL_SKU_SENTINEL,
  alibabaOfferKey,
  alibabaSourceKey,
  gmtLexemeToUtcIso,
  normalizeProductDetail,
} from './alibaba-normalizer.ts';

const NOW = '2026-08-06T10:00:00.000Z';

const emptyDetail: AlibabaProductDetailDraft = {
  imageUrls: [],
  ladderPrices: [],
  skus: [],
};

const detail = (overrides: Partial<AlibabaProductDetailDraft>): AlibabaProductDetailDraft => ({
  ...emptyDetail,
  sourceProductId: '987',
  subject: 'Headphones',
  currencyLexeme: 'USD',
  ...overrides,
});

const normalize = (d: AlibabaProductDetailDraft) => {
  const result = normalizeProductDetail({
    connectionId: 'primary',
    detail: d,
    payloadId: 'payload-1',
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result;
};

test('deterministic keys are stable and sentinel-scoped', () => {
  const a = alibabaSourceKey('primary', '987');
  assert.equal(a, alibabaSourceKey('primary', '987'));
  assert.notEqual(a, alibabaSourceKey('other', '987'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(alibabaOfferKey('primary', '987', 'sku-1'), alibabaOfferKey('primary', '987'));
  assert.equal(alibabaOfferKey('primary', '987'), alibabaOfferKey('primary', '987', undefined));
});

test('gmt lexeme converts from CST to canonical UTC; junk drops', () => {
  assert.equal(gmtLexemeToUtcIso('2026-08-01 10:00:00'), '2026-08-01T02:00:00.000Z');
  assert.equal(gmtLexemeToUtcIso('junk'), undefined);
  assert.equal(gmtLexemeToUtcIso(undefined), undefined);
});

test('SKU prices normalize to fixed offers with provenance', () => {
  const result = normalize(
    detail({
      moqLexeme: '50',
      gmtModified: '2026-08-01 10:00:00',
      skus: [
        {
          sourceSkuId: 'sku-1',
          priceLexeme: '1.15',
          availableQuantity: 500,
          attributes: { Color: 'Black' },
        },
        { sourceSkuId: 'sku-2', attributes: {} },
      ],
    }),
  );
  assert.equal(result.offers.length, 2);
  const [first, second] = result.offers;
  assert.equal(first?.pricing.mode, 'fixed');
  assert.equal(first?.pricing.amountMinor, 115);
  assert.equal(first?.pricing.currency, 'USD');
  assert.equal(first?.pricing.sourceMoq, 50);
  assert.equal(first?.pricing.sourceSkuId, 'sku-1');
  assert.equal(first?.pricing.sourceUpdatedAt, '2026-08-01T02:00:00.000Z');
  assert.equal(first?.sourceAvailability, 500);
  // Price-less SKU degrades to unavailable, never throws or borrows a price.
  assert.equal(second?.pricing.mode, 'unavailable');
});

test('live SKU ladder prices normalize to tiered offers', () => {
  const result = normalize(
    detail({
      moqLexeme: '500',
      skus: [
        {
          sourceSkuId: 'sku-live',
          availableQuantity: 10000,
          attributes: {},
          ladderPrices: [
            { minQuantityLexeme: '500', priceLexeme: '3.50' },
            { minQuantityLexeme: '1000', priceLexeme: '3.17' },
          ],
        },
      ],
    }),
  );
  const offer = result.offers[0];
  assert.equal(offer?.pricing.mode, 'tiered');
  assert.deepEqual(offer?.pricing.tiers, [
    { minQuantity: 500, maxQuantity: 999, unitAmountMinor: 350 },
    { minQuantity: 1000, unitAmountMinor: 317 },
  ]);
  assert.equal(offer?.sourceAvailability, 10000);
});

test('ladder prices become sorted closed tiers with an open final tier', () => {
  const result = normalize(
    detail({
      moqLexeme: '50',
      ladderPrices: [
        { minQuantityLexeme: '500', priceLexeme: '1.15' },
        { minQuantityLexeme: '50', priceLexeme: '2.50' },
      ],
    }),
  );
  const pricing = result.offers[0]?.pricing;
  assert.equal(pricing?.mode, 'tiered');
  assert.deepEqual(pricing?.tiers, [
    { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
    { minQuantity: 500, unitAmountMinor: 115 },
  ]);
  assert.equal(result.offers[0]?.sourceSkuId, PRODUCT_LEVEL_SKU_SENTINEL);
});

test('fob min/max becomes range; equal bounds collapse to fixed', () => {
  const range = normalize(detail({ fobMinLexeme: '1.50', fobMaxLexeme: '2.30' }));
  assert.equal(range.offers[0]?.pricing.mode, 'range');
  assert.equal(range.offers[0]?.pricing.minAmountMinor, 150);
  assert.equal(range.offers[0]?.pricing.maxAmountMinor, 230);

  const fixed = normalize(detail({ fobMinLexeme: '2.00', fobMaxLexeme: '2.00' }));
  assert.equal(fixed.offers[0]?.pricing.mode, 'fixed');
  assert.equal(fixed.offers[0]?.pricing.amountMinor, 200);
});

test('malformed money degrades to unavailable without touching other offers', () => {
  const result = normalize(
    detail({
      skus: [
        { sourceSkuId: 'good', priceLexeme: '3.00', attributes: {} },
        { sourceSkuId: 'bad', priceLexeme: '1,000.00', attributes: {} },
      ],
    }),
  );
  assert.equal(result.offers[0]?.pricing.mode, 'fixed');
  assert.equal(result.offers[1]?.pricing.mode, 'unavailable');
});

test('unsupported currency flags the run input and degrades pricing', () => {
  const result = normalize(
    detail({ currencyLexeme: 'EUR', fobMinLexeme: '1.00', fobMaxLexeme: '2.00' }),
  );
  assert.equal(result.unsupportedCurrency, true);
  assert.equal(result.offers[0]?.pricing.mode, 'unavailable');
  // RMB maps to CNY.
  const rmb = normalize(
    detail({ currencyLexeme: 'RMB', fobMinLexeme: '1.00', fobMaxLexeme: '2.00' }),
  );
  assert.equal(rmb.unsupportedCurrency, false);
  assert.equal(rmb.offers[0]?.pricing.currency, 'CNY');
});

test('a price-less product yields one unavailable product-level offer', () => {
  const result = normalize(detail({}));
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0]?.pricing.mode, 'unavailable');
  assert.equal(result.offers[0]?.pricing.sourceProductId, '987');
});

test('an MOQ below the first tier start is dropped instead of degrading the tiers', () => {
  // Source data inconsistency: MOQ 50 but the cheapest tier starts at 100 —
  // the validator would reject the pair, so the MOQ drops and the tiers stay.
  const result = normalize(
    detail({
      moqLexeme: '50',
      ladderPrices: [{ minQuantityLexeme: '100', priceLexeme: '2.00' }],
    }),
  );
  const pricing = result.offers[0]?.pricing;
  assert.equal(pricing?.mode, 'tiered');
  assert.equal(pricing?.sourceMoq, undefined);
  // The compatible pair keeps the MOQ.
  const compatible = normalize(
    detail({
      moqLexeme: '100',
      ladderPrices: [{ minQuantityLexeme: '50', priceLexeme: '2.00' }],
    }),
  );
  assert.equal(compatible.offers[0]?.pricing.sourceMoq, 100);
});

test('missing product id refuses normalization', () => {
  const result = normalizeProductDetail({
    connectionId: 'primary',
    detail: emptyDetail,
    payloadId: 'p',
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing-product-id' });
});

test('source mirror record carries provenance and active state', () => {
  const result = normalize(
    detail({
      description: '<p>d</p>',
      categoryId: '100200',
      categoryPath: ['a', 'b'],
      imageUrls: ['https://img.alibaba.com/x.jpg'],
      gmtModified: '2026-08-01 10:00:00',
    }),
  );
  assert.equal(result.sourceProduct.sourceKey, alibabaSourceKey('primary', '987'));
  assert.equal(result.sourceProduct.payloadId, 'payload-1');
  assert.equal(result.sourceProduct.active, true);
  assert.equal(result.sourceProduct.parseVersion, 'alibaba-source-product-v1');
  assert.equal(result.sourceProduct.sourceUpdatedAt, '2026-08-01T02:00:00.000Z');
  assert.deepEqual(result.sourceProduct.sourceImageUrls, ['https://img.alibaba.com/x.jpg']);
});
