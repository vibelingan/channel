import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createAlibabaCatalogPricing,
  createAlibabaLinkedProduct,
  createProduct,
} from '../../test/factories/catalog.ts';
import {
  AlibabaCatalogPricingBlock,
  alibabaPriceSummary,
  formatMinorAmount,
} from './AlibabaCatalogPricingBlock.tsx';
import { publicManualPrice, validAlibabaTiers, validMinorAmount } from './catalog-pricing.ts';
import type { AlibabaCatalogPricing, Product } from './catalog-types.ts';

const renderBlock = (props: Parameters<typeof AlibabaCatalogPricingBlock>[0]): string =>
  renderToStaticMarkup(createElement(AlibabaCatalogPricingBlock, props));

// --- formatter ---------------------------------------------------------------

test('formatMinorAmount renders integer minor units with the correct currency symbol', () => {
  assert.equal(formatMinorAmount(115, 'USD'), '$1.15');
  assert.equal(formatMinorAmount(1999, 'USD'), '$19.99');
  assert.equal(formatMinorAmount(50, 'CNY'), 'CN¥0.50');
  assert.equal(formatMinorAmount(0, 'USD'), '$0.00');
});

test('alibabaPriceSummary summarizes each displayable mode and nulls the rest', () => {
  assert.equal(alibabaPriceSummary(createAlibabaCatalogPricing({ amountMinor: 250 })), '$2.50');
  assert.equal(
    alibabaPriceSummary(
      createAlibabaCatalogPricing({
        mode: 'range',
        minAmountMinor: 150,
        maxAmountMinor: 230,
      }),
    ),
    '$1.50 – $2.30',
  );
  assert.equal(
    alibabaPriceSummary(
      createAlibabaCatalogPricing({
        mode: 'tiered',
        tiers: [
          { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
          { minQuantity: 500, unitAmountMinor: 115 },
        ],
      }),
    ),
    'From $1.15',
  );
  assert.equal(alibabaPriceSummary(createAlibabaCatalogPricing({ mode: 'negotiable' })), null);
  assert.equal(alibabaPriceSummary(createAlibabaCatalogPricing({ mode: 'unavailable' })), null);
  assert.equal(alibabaPriceSummary(undefined), null);
});

test('malformed source amounts fail closed in summaries and blocks', () => {
  const invalidPricing = [
    createAlibabaCatalogPricing({ amountMinor: -1 }),
    createAlibabaCatalogPricing({
      mode: 'range',
      minAmountMinor: 300,
      maxAmountMinor: 200,
    }),
    createAlibabaCatalogPricing({
      mode: 'tiered',
      tiers: [{ minQuantity: 1, unitAmountMinor: 1.5 }],
    }),
    createAlibabaCatalogPricing({
      mode: 'tiered',
      tiers: [{ minQuantity: 100, maxQuantity: 50, unitAmountMinor: 250 }],
    }),
    createAlibabaCatalogPricing({
      mode: 'tiered',
      tiers: [
        { minQuantity: 1, maxQuantity: 100, unitAmountMinor: 250 },
        { minQuantity: 100, unitAmountMinor: 200 },
      ],
    }),
  ];

  for (const pricing of invalidPricing) {
    assert.equal(alibabaPriceSummary(pricing), null);
    const html = renderBlock({ pricing });
    assert.ok(html.includes('data-alibaba-unavailable'));
    assert.doesNotMatch(html, /\$-?0\.01|\$2\.00|\$3\.00|\$0\.02/);
  }
});

// --- block rendering per mode ------------------------------------------------

test('fixed and range modes render amounts with currency labels', () => {
  const fixed = renderBlock({ pricing: createAlibabaCatalogPricing({ amountMinor: 250 }) });
  assert.ok(fixed.includes('$2.50'));
  assert.ok(fixed.includes('data-mode="fixed"'));

  const range = renderBlock({
    pricing: createAlibabaCatalogPricing({
      mode: 'range',
      minAmountMinor: 150,
      maxAmountMinor: 230,
      currency: 'CNY',
    }),
  });
  assert.ok(range.includes('CN¥1.50'));
  assert.ok(range.includes('CN¥2.30'));
});

test('tiered mode renders a quantity/price table with an open final tier', () => {
  const html = renderBlock({
    pricing: createAlibabaCatalogPricing({
      mode: 'tiered',
      tiers: [
        { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
        { minQuantity: 500, unitAmountMinor: 115 },
      ],
    }),
  });
  assert.ok(html.includes('data-alibaba-tiers'));
  assert.ok(html.includes('50 – 499'));
  assert.ok(html.includes('500+'));
  assert.ok(html.includes('$2.50'));
  assert.ok(html.includes('$1.15'));
});

test('negotiable, unavailable, and MISSING pricing all render quote states — never legacy values', () => {
  const negotiable = renderBlock({
    pricing: createAlibabaCatalogPricing({ mode: 'negotiable' }),
  });
  assert.ok(negotiable.includes('data-alibaba-negotiable'));

  const unavailable = renderBlock({
    pricing: createAlibabaCatalogPricing({ mode: 'unavailable' }),
  });
  assert.ok(unavailable.includes('data-alibaba-unavailable'));

  const missing = renderBlock({});
  assert.ok(missing.includes('data-alibaba-unavailable'), 'absent object = same quote state');
  assert.ok(missing.includes('data-mode="unavailable"'));
});

test('source MOQ and updated stamp render when present; labels are overridable', () => {
  const html = renderBlock({
    pricing: createAlibabaCatalogPricing({ sourceMoq: 100 }),
    labels: { heading: 'Quoted from source' },
  });
  assert.ok(html.includes('data-alibaba-moq'));
  assert.ok(html.includes('<strong>100</strong>'));
  assert.ok(html.includes('data-alibaba-updated'));
  assert.ok(html.includes('2026-08-01'));
  assert.ok(html.includes('Quoted from source'));
});

// --- factories stay branch-honest -------------------------------------------

test('factory defaults: createProduct is unlinked, createAlibabaLinkedProduct is linked', () => {
  assert.equal(createProduct().alibabaPrimarySourceKey, undefined);
  const linked = createAlibabaLinkedProduct();
  assert.equal(linked.alibabaPrimarySourceKey?.length, 64);
  assert.equal(linked.alibabaCatalogPricing?.mode, 'fixed');
});

test('compatibility helpers preserve legacy amount and tier validation outputs', () => {
  const legacyMinor = (value: unknown): boolean =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER, -1, 1.5, Number.NaN, '1', null]) {
    assert.equal(validMinorAmount(value), legacyMinor(value), String(value));
  }

  const validTiered = createAlibabaCatalogPricing({
    mode: 'tiered',
    sourceMoq: 50,
    tiers: [
      { minQuantity: 50, maxQuantity: 499, unitAmountMinor: 250 },
      { minQuantity: 500, unitAmountMinor: 115 },
    ],
  });
  const invalidTiered = [
    { ...validTiered, tiers: [] },
    { ...validTiered, tiers: [{ minQuantity: 1, unitAmountMinor: 1.5 }] },
    {
      ...validTiered,
      tiers: [
        { minQuantity: 1, unitAmountMinor: 250 },
        { minQuantity: 10, unitAmountMinor: 200 },
      ],
    },
  ];
  assert.equal(validAlibabaTiers(validTiered), true);
  for (const pricing of invalidTiered) assert.equal(validAlibabaTiers(pricing), false);
});

test('publicManualPrice preserves unlinked scalar compatibility', () => {
  const legacy = (product: Product): number | undefined => {
    for (const amount of [product.wholesalePrice, product.unitPrice]) {
      if (amount !== undefined && Number.isFinite(amount) && amount >= 0) return amount;
    }
    return undefined;
  };
  for (const product of [
    createProduct({ wholesalePrice: 0, unitPrice: 12.5 }),
    createProduct({ wholesalePrice: -1, unitPrice: 12.5 }),
    createProduct({ wholesalePrice: Number.NaN, unitPrice: Number.POSITIVE_INFINITY }),
    createProduct({ wholesalePrice: undefined, unitPrice: undefined }),
    createProduct({
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
      },
      wholesalePrice: 9,
    }),
  ]) {
    assert.equal(publicManualPrice(product), legacy(product));
  }
});

test('linked missing or unavailable pricing never exposes manual or scalar display', () => {
  for (const product of [
    createAlibabaLinkedProduct({
      alibabaCatalogPricing: undefined,
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
      },
      wholesalePrice: 9,
      unitPrice: 12,
    }),
    createAlibabaLinkedProduct({
      alibabaCatalogPricing: createAlibabaCatalogPricing({ mode: 'unavailable' }),
      wholesalePrice: 9,
      unitPrice: 12,
    }),
  ]) {
    assert.equal(publicManualPrice(product), undefined);
  }
});
