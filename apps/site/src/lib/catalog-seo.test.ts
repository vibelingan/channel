import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Product } from '../islands/shop/catalog-types.ts';
import {
  catalogBreadcrumbSchema,
  catalogProductSchema,
  familyBreadcrumbs,
  hasAddressableProductDetail,
  serializeCatalogSchema,
  skuBreadcrumbs,
} from './catalog-seo.ts';

const origin = 'https://example.test';

const product: Product = {
  _id: 'p-1',
  name: 'VisionClip Camera',
  productFamily: 'ai-gadgets',
  slug: 'visionclip-camera',
  skuCode: 'AI-100',
  description: 'Compact connected camera.',
  wholesalePrice: 15.5,
  unitPrice: 18.9,
  images: ['/media/camera.jpg'],
};

test('family visible breadcrumbs and BreadcrumbList share labels, positions, and URLs', () => {
  const breadcrumbs = familyBreadcrumbs('AI Gadgets', '/ai-gadgets/');
  assert.deepEqual(breadcrumbs, [
    { label: 'Home', href: '/' },
    { label: 'Electronics & Toys', href: '/electronics-toys/' },
    { label: 'AI Gadgets', href: '/ai-gadgets/' },
  ]);
  const schema = catalogBreadcrumbSchema(breadcrumbs, origin);
  assert.equal(schema['@type'], 'BreadcrumbList');
  assert.deepEqual(schema.itemListElement, [
    { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.test/' },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Electronics & Toys',
      item: 'https://example.test/electronics-toys/',
    },
    {
      '@type': 'ListItem',
      position: 3,
      name: 'AI Gadgets',
      item: 'https://example.test/ai-gadgets/',
    },
  ]);
});

test('SKU breadcrumbs add the validated product as level four with its stable query URL', () => {
  assert.deepEqual(skuBreadcrumbs(product), [
    { label: 'Home', href: '/' },
    { label: 'Electronics & Toys', href: '/electronics-toys/' },
    { label: 'AI Gadgets', href: '/ai-gadgets/' },
    { label: 'VisionClip Camera', href: '/products/item/?slug=visionclip-camera' },
  ]);
  assert.deepEqual(skuBreadcrumbs({ ...product, productFamily: undefined }), []);
  assert.deepEqual(skuBreadcrumbs({ ...product, slug: undefined }), []);
});

test('slug detail addressability does not require SKU', () => {
  assert.equal(hasAddressableProductDetail({ ...product, skuCode: undefined }), true);
  assert.equal(hasAddressableProductDetail({ ...product, slug: undefined }), false);
});

test('Product schema emits approved real fields and wholesale Offer only', () => {
  const schema = catalogProductSchema(product, origin, { published: true });
  assert.ok(schema);
  assert.equal(schema['@type'], 'Product');
  assert.equal(schema.name, product.name);
  assert.equal(schema.description, product.description);
  assert.equal(schema.sku, product.skuCode);
  assert.deepEqual(schema.image, ['https://example.test/media/camera.jpg']);
  assert.deepEqual(schema.offers, {
    '@type': 'Offer',
    priceCurrency: 'USD',
    price: '15.50',
    url: 'https://example.test/products/item/?slug=visionclip-camera',
  });
  for (const forbidden of [
    'aggregateRating',
    'review',
    'inventoryLevel',
    'warranty',
    'availability',
  ]) {
    assert.equal(Object.hasOwn(schema, forbidden), false, forbidden);
  }
});

test('Product schema uses Alibaba real pricing, omits Offer for quote, and never falls back', () => {
  const linked = catalogProductSchema(
    {
      ...product,
      wholesalePrice: 99,
      alibabaPrimarySourceKey: 'source-1',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'CNY',
        amountMinor: 250,
        syncedAt: '2026-08-20T00:00:00.000Z',
      },
    },
    origin,
    { published: true },
  );
  assert.deepEqual(linked?.offers, {
    '@type': 'Offer',
    priceCurrency: 'CNY',
    price: '2.50',
    url: 'https://example.test/products/item/?slug=visionclip-camera',
  });
  const quote = catalogProductSchema(
    { ...product, alibabaPrimarySourceKey: 'source-1', alibabaCatalogPricing: undefined },
    origin,
    { published: true },
  );
  assert.equal(Object.hasOwn(quote ?? {}, 'offers'), false);

  const range = catalogProductSchema(
    {
      ...product,
      alibabaPrimarySourceKey: 'source-1',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'range',
        currency: 'USD',
        minAmountMinor: 150,
        maxAmountMinor: 230,
        syncedAt: '2026-08-20T00:00:00.000Z',
      },
    },
    origin,
    { published: true },
  );
  assert.deepEqual(range?.offers, {
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '1.50',
    highPrice: '2.30',
    url: 'https://example.test/products/item/?slug=visionclip-camera',
  });
});

test('Product schema uses manual tier AggregateOffer before scalar pricing', () => {
  const schema = catalogProductSchema(
    {
      ...product,
      skuCode: undefined,
      unitPrice: 99,
      wholesalePrice: 88,
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'CNY',
        tiers: [
          { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
          { minQuantity: 13, unitAmountMinor: 11_831 },
        ],
      },
    },
    origin,
    { published: true },
  );
  assert.ok(schema);
  assert.equal(Object.hasOwn(schema, 'sku'), false);
  assert.deepEqual(schema.offers, {
    '@type': 'AggregateOffer',
    priceCurrency: 'CNY',
    lowPrice: '118.31',
    highPrice: '134.18',
    url: 'https://example.test/products/item/?slug=visionclip-camera',
  });

  const linked = catalogProductSchema(
    {
      ...product,
      manualCatalogPricing: schema.offers as never,
      alibabaPrimarySourceKey: 'source-1',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        syncedAt: '2026-08-20T00:00:00.000Z',
      },
    },
    origin,
    { published: true },
  );
  assert.equal((linked?.offers as { price?: string }).price, '2.50');
});

test('empty, malformed, or unpublished-looking data emits no Product schema', () => {
  assert.equal(
    catalogProductSchema({ _id: 'x', name: '', slug: 'x' }, origin, { published: true }),
    null,
  );
  assert.equal(catalogProductSchema({ _id: 'x', name: 'X' }, origin, { published: true }), null);
  assert.equal(
    catalogProductSchema({ ...product, productFamily: undefined }, origin, { published: true }),
    null,
  );
  assert.equal(catalogProductSchema({ ...product, images: [] }, origin, { published: true }), null);
  assert.equal(
    catalogProductSchema({ ...product, description: '' }, origin, { published: true }),
    null,
  );
  assert.equal(catalogProductSchema({ ...product, slug: '' }, origin, { published: true }), null);
  assert.equal(catalogProductSchema(product, origin, { published: false }), null);
});

test('Offer schema falls through invalid manual values and rejects malformed source values', () => {
  const manualFallback = catalogProductSchema({ ...product, wholesalePrice: -1 }, origin, {
    published: true,
  });
  assert.deepEqual(manualFallback?.offers, {
    '@type': 'Offer',
    priceCurrency: 'USD',
    price: '18.90',
    url: 'https://example.test/products/item/?slug=visionclip-camera',
  });
  const invalidManual = catalogProductSchema(
    { ...product, wholesalePrice: -1, unitPrice: Number.NaN },
    origin,
    { published: true },
  );
  assert.equal(Object.hasOwn(invalidManual ?? {}, 'offers'), false);
  const fractional = catalogProductSchema(
    {
      ...product,
      alibabaPrimarySourceKey: 'source-1',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250.5,
        syncedAt: '2026-08-20T00:00:00.000Z',
      },
    },
    origin,
    { published: true },
  );
  assert.equal(Object.hasOwn(fractional ?? {}, 'offers'), false);
  const incompleteRange = catalogProductSchema(
    {
      ...product,
      alibabaPrimarySourceKey: 'source-1',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'range',
        currency: 'USD',
        minAmountMinor: 100,
        syncedAt: '2026-08-20T00:00:00.000Z',
      },
    },
    origin,
    { published: true },
  );
  assert.equal(Object.hasOwn(incompleteRange ?? {}, 'offers'), false);
});

test('runtime JSON-LD serialization escapes script-closing input', () => {
  const serialized = serializeCatalogSchema([{ '@type': 'Product', name: '</script><script>' }]);
  assert.doesNotMatch(serialized, /<\/script>/i);
  assert.match(serialized, /\\u003c\/script>/i);
});
