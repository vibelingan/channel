import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@astrojs/compiler';
import type { Node as HtmlNode } from '@astrojs/compiler/types';
import { WebsiteDetailPricingSchema } from '@vibelingan-channel/shared/catalog-detail';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { ProductLanding } from '../../islands/shop/ProductLanding.tsx';
import { productPageDescriptor } from './product-page.ts';
import type { ProductSnapshotEntry } from './product-snapshot.ts';
import { publicProductRichResult, websiteUnitPrice } from './public-offer.ts';

const origin = 'https://example.test';
const fixed = {
  basis: 'website-manual',
  pricing: { mode: 'fixed', currency: 'USD', amountMinor: 320, minimumOrderQuantity: 1 },
};
function entry(): ProductSnapshotEntry {
  const base = detailFixture(2);
  assert.ok(base.revision);
  const detail = {
    ...base,
    revision: base.revision,
    websitePricing: WebsiteDetailPricingSchema.parse(fixed),
  };
  return {
    product: { _id: detail._id, name: detail.name },
    detail,
    revision: detail.revision,
  };
}
const withPricing = (pricing: unknown) => websiteUnitPrice({ basis: 'website-manual', pricing });

test('only approved website prices describe the canonical product offer; source and legacy amounts are not fallbacks', () => {
  const e = entry();
  const supplied = {
    ...e,
    product: { ...e.product, unitPrice: 0.01, wholesalePrice: 0.02, vipPrice: 0.03 },
  };
  const decision = publicProductRichResult(supplied, origin, 'A public headset.');
  assert.equal(decision.status, 'eligible');
  if (decision.status !== 'eligible') return;
  assert.equal(decision.schema.url, `${origin}/products/p-canonical-product/`);
  assert.equal(decision.schema.name, 'Headset');
  assert.equal(decision.schema.offers.url, decision.schema.url);
  assert.equal(decision.schema.offers.priceSpecification.price, '3.20');
  assert.equal(decision.schema.offers.priceSpecification.priceCurrency, 'USD');
  assert.deepEqual(decision.schema.image, [`${origin}/api/images/image-1`]);
  for (const key of [
    'sku',
    'brand',
    'availability',
    'aggregateRating',
    'review',
    'priceValidUntil',
    'vipPrice',
  ]) {
    assert.equal(Object.hasOwn(decision.schema, key), false);
    assert.equal(Object.hasOwn(decision.schema.offers, key), false);
  }
  assert.ok(e.detail);
  assert.deepEqual(
    publicProductRichResult(
      {
        ...e,
        detail: {
          ...e.detail,
          websitePricing: undefined,
          offers: [
            {
              kind: 'supplier',
              basis: 'source-quote',
              pricing: { mode: 'fixed', currency: 'USD', amountMinor: 1, minimumOrderQuantity: 1 },
            },
          ],
        },
      },
      origin,
      '',
    ),
    { status: 'ordinary', reason: 'no-website-price' },
  );
});

test('the real page descriptor includes the approved offer without changing its source revision or breadcrumb', () => {
  const e = entry();
  const page = productPageDescriptor(e, origin, 'Brand');
  const product = page.schemaNodes.find((node) => node['@type'] === 'Product');
  assert.ok(product, 'Approved eligible website price must reach the actual page descriptor');
  assert.equal(product.url, `${origin}/products/p-canonical-product/`);
  assert.equal(page.content.revision, e.revision);
  assert.equal(page.schemaNodes.filter((node) => node['@type'] === 'Product').length, 1);
  assert.equal(page.schemaNodes.filter((node) => node['@type'] === 'BreadcrumbList').length, 1);
});

test('a stated one-piece minimum is required; bulk prices and unknown minimums never masquerade as single-unit offers', () => {
  for (const minimumOrderQuantity of [undefined, 2, 500, 1000])
    assert.deepEqual(withPricing({ ...fixed.pricing, minimumOrderQuantity }), {
      status: 'ordinary',
      reason: 'minimum-order-not-one',
    });
  assert.equal(withPricing({ ...fixed.pricing, minimumOrderQuantity: 0 }).status, 'ordinary');
});

test('all five quote modes keep their meaning instead of using the lowest range or tier', () => {
  assert.deepEqual(
    withPricing({
      mode: 'range',
      currency: 'USD',
      minimumAmountMinor: 100,
      maximumAmountMinor: 500,
      minimumOrderQuantity: 1,
    }),
    { status: 'ordinary', reason: 'range-not-single-price' },
  );
  assert.deepEqual(
    withPricing({
      mode: 'range',
      currency: 'USD',
      minimumAmountMinor: 320,
      maximumAmountMinor: 320,
      minimumOrderQuantity: 1,
    }),
    { status: 'eligible', currency: 'USD', amount: '3.20' },
  );
  assert.deepEqual(withPricing({ mode: 'negotiable' }), {
    status: 'ordinary',
    reason: 'negotiable',
  });
  assert.deepEqual(withPricing({ mode: 'unavailable' }), {
    status: 'ordinary',
    reason: 'unavailable',
  });
  assert.deepEqual(
    withPricing({
      mode: 'tiered',
      currency: 'USD',
      minimumOrderQuantity: 1,
      tiers: [
        { minimumQuantity: 1, maximumQuantity: 9, unitAmountMinor: 500 },
        { minimumQuantity: 10, unitAmountMinor: 100 },
      ],
    }),
    { status: 'ordinary', reason: 'quantity-dependent' },
  );
});

test('constant contiguous tiers qualify only when they cover one piece through every higher quantity', () => {
  const p = {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 1,
    tiers: [
      { minimumQuantity: 1, maximumQuantity: 9, unitAmountMinor: 320 },
      { minimumQuantity: 10, unitAmountMinor: 320 },
    ],
  };
  assert.deepEqual(withPricing(p), { status: 'eligible', currency: 'USD', amount: '3.20' });
  for (const tiers of [
    [
      { minimumQuantity: 1, maximumQuantity: 9, unitAmountMinor: 320 },
      { minimumQuantity: 11, unitAmountMinor: 320 },
    ],
    [{ minimumQuantity: 2, unitAmountMinor: 320 }],
    [{ minimumQuantity: 1, maximumQuantity: 10, unitAmountMinor: 320 }],
  ])
    assert.deepEqual(withPricing({ ...p, tiers }), {
      status: 'ordinary',
      reason: 'quantity-dependent',
    });
});

test('decimal conversion preserves real zero and exact hundredths without borrowing ISO currency exponents', () => {
  for (const [currency, amountMinor, amount] of [
    ['USD', 0, '0.00'],
    ['JPY', 123, '1.23'],
    ['CNY', 101, '1.01'],
    ['EUR', Number.MAX_SAFE_INTEGER, '90071992547409.91'],
  ] as const)
    assert.deepEqual(withPricing({ ...fixed.pricing, currency, amountMinor }), {
      status: 'eligible',
      currency,
      amount,
    });
  for (const currency of ['usd', 'XYZ', 'US', 'USD '])
    assert.equal(withPricing({ ...fixed.pricing, currency }).status, 'ordinary');
});

test('malformed or unsupported website inputs never leak into a rich result', () => {
  for (const input of [
    null,
    {},
    { ...fixed, basis: 'source-quote' },
    { ...fixed, privateSecret: 'never public' },
    { ...fixed, pricing: { ...fixed.pricing, amountMinor: -1 } },
    { ...fixed, pricing: { ...fixed.pricing, amountMinor: 1.2 } },
    { ...fixed, pricing: { ...fixed.pricing, mode: 'future-price' } },
    { ...fixed, pricing: { ...fixed.pricing, currency: 'USD', vipPrice: 1 } },
  ])
    assert.equal(websiteUnitPrice(input).status, 'ordinary');
});

test('missing or mismatched approval and missing public images keep ordinary indexable page markup', () => {
  const e = entry();
  assert.ok(e.detail);
  for (const value of [
    { ...e, detail: undefined },
    { ...e, revision: 'other' },
    { ...e, detail: { ...e.detail, _id: 'other' } },
  ])
    assert.deepEqual(publicProductRichResult(value, origin, ''), {
      status: 'ordinary',
      reason: 'no-approved-detail',
    });
  for (const images of [[], ['https://private.invalid/object']])
    assert.deepEqual(
      publicProductRichResult({ ...e, detail: { ...e.detail, images } }, origin, ''),
      { status: 'ordinary', reason: 'no-public-image' },
    );
});

function text(node: HtmlNode): string {
  return node.type === 'text'
    ? node.value
    : 'children' in node
      ? node.children.map(text).join('')
      : '';
}
test('initial buyer HTML and JSON-LD show the same website amount even when the selected SKU has a different source quote', async () => {
  const e = entry();
  assert.ok(e.detail);
  const first = e.detail.variants.items[0];
  assert.ok(first);
  first.offers = [
    {
      kind: 'supplier',
      basis: 'source-quote',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 111, minimumOrderQuantity: 1 },
    },
  ];
  const source = readFileSync(
    new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
    'utf8',
  );
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m);
  const content: CatalogContent & { sharedDetail: SharedDetailContent } = parseDocument(
    m[1],
  ).toJS();
  const html = renderToStaticMarkup(
    createElement(ProductLanding, {
      product: e.product,
      bootstrap: e.detail,
      content,
      copy: content.sharedDetail,
      canonicalPath: '/products/p-canonical-product/',
    }),
  );
  const { ast } = await parse(html);
  const amounts: string[] = [];
  const visit = (node: HtmlNode) => {
    if (
      node.type === 'element' &&
      node.name === 'li' &&
      node.attributes.some((a) => a.name === 'data-price-tier')
    ) {
      const p = node.children.find((n) => n.type === 'element' && n.name === 'p');
      if (p) amounts.push(text(p));
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(ast);
  const result = publicProductRichResult(e, origin, 'Headset');
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  const price = result.schema.offers.priceSpecification;
  assert.deepEqual(amounts, [`${price.priceCurrency} ${price.price}`]);
  assert.doesNotMatch(html, /USD 1\.11/);
});

test('an explicitly unpublished snapshot cannot emit a public priced Product', () => {
  const e = entry();
  assert.deepEqual(
    publicProductRichResult({ ...e, product: { ...e.product, published: false } }, origin, ''),
    { status: 'ordinary', reason: 'not-public' },
  );
});
