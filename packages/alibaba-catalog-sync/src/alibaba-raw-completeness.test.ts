import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import { extractProductDetail, parseAlibabaApiResponse } from './alibaba-contracts.ts';
import { alibabaObservationAdapter } from './alibaba-observation-adapter.ts';

// Redacted wire shape from the 2026-09-03 camping-light product.get response.
// Never start this regression at an already-normalized observation.
function observeRaw(product: unknown) {
  const response = parseAlibabaApiResponse(
    JSON.stringify({ alibaba_icbu_product_get_response: { product } }),
  );
  assert.equal(response.kind, 'success');
  if (response.kind !== 'success') throw new Error('Invalid test envelope');
  const result = alibabaObservationAdapter.toObservations({
    connectionId: 'fixture-account',
    detail: extractProductDetail(response.root),
    payloadId: 'a'.repeat(64),
    observedAt: '2026-09-03T07:51:00.841Z',
    captureMode: 'selected',
  });
  assert.equal(result.observations.length, 1, JSON.stringify(result.findings));
  const observation = result.observations[0];
  assert.ok(observation);
  return observation;
}

const invalidSkuProduct = {
  product_id: 'fixture-light',
  subject: 'Camping light',
  wholesale_trade: { min_order_quantity: 1 },
  product_sku: {
    skus: {
      sku_definition: [
        {
          sku_id: 'fixture-white',
          bulk_discount_prices: { bulk_discount_price: [{ start_quantity: -1, price: '7.67' }] },
        },
      ],
    },
  },
};

test('raw invalid SKU tier keeps independently known MOQ without inventing a quantity', () => {
  const observation = observeRaw(invalidSkuProduct);
  assert.deepEqual(observation.offers[0]?.pricing, {
    mode: 'unavailable',
    minimumOrderQuantity: 1,
  });
  assert.ok(observation.warnings.some((w) => w.code === 'invalid-source-pricing'));
});

test('raw FOB product quote survives invalid SKU tiers and remains product-scoped', () => {
  const observation = observeRaw({
    ...invalidSkuProduct,
    product_type: 'sourcing',
    wholesale_trade: undefined,
    sourcing_trade: {
      fob_min_price: '7.75',
      fob_max_price: '9.0',
      fob_currency: 'USD',
      fob_unit_type: 'Piece',
      min_order_unit_type: 'Piece',
      min_order_quantity: '2',
    },
  });
  assert.deepEqual(observation.offers.find((o) => !o.sourceVariantKey)?.pricing, {
    mode: 'range',
    currency: 'USD',
    minimumAmountMinor: 775,
    maximumAmountMinor: 900,
    minimumOrderQuantity: 2,
  });
  assert.deepEqual(observation.offers.find((o) => o.sourceVariantKey)?.pricing, {
    mode: 'unavailable',
    minimumOrderQuantity: 2,
  });
});

test('FOB and SKU prices retain independent scopes even when the SKU price is usable', () => {
  const observation = observeRaw({
    product_id: 'independent-FOB',
    product_type: 'sourcing',
    sourcing_trade: {
      fob_min_price: '14.9',
      fob_max_price: '14.9',
      fob_currency: 'USD',
      fob_unit_type: 'Piece',
      min_order_unit_type: 'Piece',
      min_order_quantity: '2',
    },
    product_sku: { skus: { sku_definition: [{ sku_id: 'red', price: '15.00' }] } },
  });
  assert.equal(observation.offers.length, 2);
  assert.deepEqual(observation.offers.find((o) => !o.sourceVariantKey)?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 1490,
    minimumOrderQuantity: 2,
  });
  assert.deepEqual(observation.offers.find((o) => o.sourceVariantKey)?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 1500,
    minimumOrderQuantity: 2,
  });
});

test('explicit non-piece FOB units never become per-piece prices, with or without SKUs', () => {
  for (const unit of ['Acre', 'Set', 'Pole']) {
    for (const sku of [
      undefined,
      { skus: { sku_definition: [{ sku_id: 'one', price: '5.18' }] } },
    ]) {
      const observation = observeRaw({
        product_id: 'non-piece-FOB',
        product_type: 'sourcing',
        sourcing_trade: {
          fob_min_price: '5.18',
          fob_max_price: '5.18',
          fob_currency: 'USD',
          fob_unit_type: unit,
          min_order_unit_type: unit,
          min_order_quantity: '1',
        },
        product_sku: sku,
      });
      assert.ok(
        observation.offers.every((o) => o.pricing.mode === 'unavailable'),
        unit,
      );
    }
  }
});

test('raw product attributes preserve repeated names and stay separate from SKU options', () => {
  const observation = observeRaw({
    product_id: 'attributes',
    attributes: {
      product_attribute: [
        { attribute_name: 'Application', value_name: 'Hiking' },
        { attribute_name: 'Application', value_name: 'Camping' },
        { attribute_name: 'Power', value_name: '20W' },
        { attribute_name: '', value_name: 'unlabeled' },
        { attribute_name: 'Bad value', value_name: null },
      ],
    },
  });
  assert.deepEqual(observation.identity.attributes, [
    { sourceName: 'Application', value: 'Hiking' },
    { sourceName: 'Application', value: 'Camping' },
    { sourceName: 'Power', value: '20W' },
  ]);
  assert.deepEqual(observation.variants, []);
  assert.ok(observation.warnings.some((w) => w.code === 'invalid-product-attribute'));
});

test('wholesale USD quote is product-scoped, tolerates only decimal serialization noise, not an invented SKU tier', () => {
  const observation = observeRaw({
    ...invalidSkuProduct,
    product_type: 'wholesale',
    wholesale_trade: {
      min_order_quantity: 1,
      sale_type: 'normal',
      unit_type: 'Piece',
      price: '7.6699999999999999289457264239899814128875732421875',
    },
  });
  const productOffer = observation.offers.find((o) => o.sourceVariantKey === undefined);
  assert.deepEqual(productOffer?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 767,
    minimumOrderQuantity: 1,
  });
  assert.equal(observation.offers.find((o) => o.sourceVariantKey)?.pricing.mode, 'unavailable');
  for (const price of ['7.671', '7.675', 'garbage', '-1', '0', '10000000']) {
    const invalid = observeRaw({
      product_id: 'invalid',
      product_type: 'wholesale',
      wholesale_trade: { price, min_order_quantity: 1, sale_type: 'normal', unit_type: 'Piece' },
    });
    assert.equal(invalid.offers[0]?.pricing.mode, 'unavailable', price);
    assert.equal(invalid.offers[0]?.pricing.minimumOrderQuantity, 1, price);
  }
});

test('MOQ below the first quoted tier remains known, without filling the unquoted gap', () => {
  const observation = observeRaw({
    product_id: 'tier-gap',
    moq: 1,
    currency: 'USD',
    ladder_prices: [{ min_quantity: 100, price: '3.50' }],
  });
  assert.deepEqual(observation.offers[0]?.pricing, {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 1,
    tiers: [{ minimumQuantity: 100, unitAmountMinor: 350 }],
  });
});

test('image-only descriptions retain ordered description media separately from the gallery', () => {
  const observation = observeRaw({
    product_id: 'image-description',
    subject: 'Image description',
    main_image: { images: { string: ['https://sc04.alicdn.com/main.jpg'] } },
    description:
      '<p>&nbsp;<img src="http://sc04.alicdn.com/detail.jpg" onerror="bad()"></p><img src="https://sc04.alicdn.com/second.jpg"><img src="javascript:bad()"><script><img src="https://sc04.alicdn.com/hidden.jpg"></script>',
  });
  assert.equal(observation.content.description?.placeholder, false);
  assert.deepEqual(observation.content.description?.imageUrls, [
    'http://sc04.alicdn.com/detail.jpg',
    'https://sc04.alicdn.com/second.jpg',
  ]);
  assert.deepEqual(
    observation.content.media.map((m) => m.sourceUrl),
    ['https://sc04.alicdn.com/main.jpg'],
  );
  assert.equal(observation.content.description?.text, undefined);
  const candidate = buildCatalogDetailCandidate(observation, {
    productId: 'image-description',
    variants: new Map(),
    images: new Map([['http://sc04.alicdn.com/detail.jpg', 'owned-detail']]),
  });
  assert.ok(candidate.ok);
  assert.deepEqual(candidate.value.descriptionImages, ['/api/images/owned-detail']);
  assert.deepEqual(candidate.value.images, []);
});

test('captured wire regression retains 47 attributes, 17 description images and both price scopes', () => {
  const raw = readFileSync(
    new URL('../../../tests/fixtures/alibaba-camping-light-wire.json', import.meta.url),
    'utf8',
  );
  const observation = observeRaw(JSON.parse(raw).alibaba_icbu_product_get_response.product);
  assert.equal(observation.identity.attributes.length, 47);
  assert.equal(observation.content.media.length, 6);
  assert.equal(observation.content.description?.imageUrls?.length, 17);
  assert.equal(observation.content.description?.placeholder, false);
  assert.equal(observation.variants[0]?.options.length, 3);
  assert.deepEqual(observation.offers.find((o) => !o.sourceVariantKey)?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 767,
    minimumOrderQuantity: 1,
  });
  assert.deepEqual(observation.offers.find((o) => o.sourceVariantKey)?.pricing, {
    mode: 'unavailable',
    minimumOrderQuantity: 1,
  });
});

test('active trade MOQ wins over stale flat and other-trade values; no per-piece quote for lots', () => {
  const product = {
    product_id: 'mixed-trade',
    product_type: 'wholesale',
    moq: 1000,
    sourcing_trade: { min_order_quantity: 500 },
    wholesale_trade: {
      min_order_quantity: 1,
      price: '7.67',
      sale_type: 'normal',
      unit_type: 'Piece',
    },
  };
  assert.equal(observeRaw(product).offers[0]?.pricing.minimumOrderQuantity, 1);
  for (const trade of [
    { sale_type: 'batch', unit_type: 'Piece' },
    { sale_type: 'normal', unit_type: 'Kilogram' },
  ]) {
    assert.equal(
      observeRaw({ ...product, wholesale_trade: { ...product.wholesale_trade, ...trade } })
        .offers[0]?.pricing.mode,
      'unavailable',
    );
  }
});

test('unsupported description media is a retained-data warning, not falsely absent source content', () => {
  const observation = observeRaw({
    product_id: 'bad-media',
    description: '<img src="javascript:alert(1)">',
  });
  assert.equal(observation.content.description?.placeholder, false);
  assert.ok(observation.warnings.some((w) => w.code === 'invalid-description-media'));
  assert.equal(observation.content.description?.imageUrls, undefined);
});
