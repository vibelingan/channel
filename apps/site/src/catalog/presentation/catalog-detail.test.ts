import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import { Children, type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { HeadphonesProductDetail } from '../../islands/shop/HeadphonesProductDetail.tsx';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import {
  createAlibabaCatalogPricing,
  createAlibabaLinkedProduct,
} from '../../test/factories/catalog.ts';
import { CatalogDetail, type CatalogDetailProps } from './CatalogDetail.tsx';

const product = {
  _id: 'legacy-detail-id',
  name: 'Legacy Headphones Without Slug',
  modName: 'HP-100',
  description: 'A complete family-neutral detail fixture.',
};

const facts = {
  categoryLabel: 'True Wireless',
  rows: [
    { key: 'series', label: 'Series', value: 'Legacy Series' },
    { key: 'moq', label: 'Minimum Order Quantity', value: 100 },
    { key: 'code', label: 'Product Code', value: 'HP-100-BLK' },
  ],
  backLabel: 'Back to all models',
  scalarLabels: { wholesalePrice: 'Wholesale price', unitPrice: 'Unit price' },
  quoteLabel: 'Price inquiry',
  inquiryLabel: 'Price inquiry',
  sourcePricingLabels: {
    heading: 'Live source pricing',
    tierQuantityLabel: 'Quantity',
    tierPriceLabel: 'Unit price',
    negotiableLabel: 'Price on request',
    unavailableLabel: 'Pricing unavailable — request a quote',
    moqLabel: 'Source MOQ',
    updatedLabel: 'Updated',
  },
};

const mediaUnavailableLabel = 'Product image unavailable';
const media = createElement(
  'div',
  {
    'data-product-media': 'fallback',
    className: 'aspect-square',
  },
  mediaUnavailableLabel,
);

const detail: HeadphonesContent['detail'] = {
  backLabel: 'Back',
  backToModelsLabel: 'Back to all models',
  seriesLabel: 'Series',
  modelLabel: 'Model',
  typeLabel: 'Type',
  moqLabel: 'Minimum Order Quantity',
  unitPriceLabel: 'Unit price',
  wholesaleLabel: 'Wholesale price',
  inquiryCta: 'Price inquiry',
  oemInquiryCta: 'Start Your OEM Enquiry',
  viewAllLabel: 'View All',
  showLessLabel: 'Show Less',
  imageUnavailableLabel: 'Product image unavailable',
  notFound: 'Product not found.',
};

function render(
  pricing: CatalogPricingDecision,
  overrides: Partial<CatalogDetailProps> = {},
): string {
  return renderToStaticMarkup(
    createElement(CatalogDetail, {
      product,
      pricing,
      facts,
      media,
      onBack: () => {},
      ...overrides,
    }),
  );
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

test('slugless detail preserves _id identity, Gallery geometry, focus target, and Back callback', () => {
  let backCalls = 0;
  const element = CatalogDetail({
    product,
    pricing: { source: 'quote-required' },
    facts,
    media,
    onBack: () => {
      backCalls += 1;
    },
  });
  const back = findElement(element, (candidate) => candidate.props['data-detail-back'] === true);
  assert.ok(back);
  assert.equal(back.type, 'button');
  assert.equal(back.props.type, 'button');
  assert.equal(typeof back.props.onClick, 'function');
  (back.props.onClick as () => void)();
  assert.equal(backCalls, 1);

  const html = render({ source: 'quote-required' });
  assert.ok(html.includes('data-product-detail="legacy-detail-id"'));
  assert.match(html, /<h2[^>]*tabindex="-1"[^>]*data-detail-heading/);
  assert.ok(html.includes('data-product-media="fallback"'));
  assert.ok(html.includes(mediaUnavailableLabel));
  assert.ok(html.includes('aspect-square'));
  assert.match(html, /data-detail-media-column[^>]*class="[^"]*min-w-0/);
  assert.match(html, /data-detail-info-column[^>]*class="[^"]*min-w-0/);
});

test('ordered facts, public scalar pricing, and OEM inquiry semantics render without VIP content', () => {
  const html = render({
    source: 'scalar',
    field: 'wholesalePrice',
    amount: 15.5,
    currency: 'USD',
  });
  assert.ok(html.indexOf('data-detail-fact="series"') < html.indexOf('data-detail-fact="moq"'));
  assert.ok(html.indexOf('data-detail-fact="moq"') < html.indexOf('data-detail-fact="code"'));
  assert.ok(html.includes('Wholesale price'));
  assert.ok(html.includes('$15.50'));
  assert.ok(html.includes(`href="${OEM_INQUIRY_HREF}"`));
  assert.ok(!/VIP|vipPrice|\/login/i.test(html));
});

test('manual, scalar, quote, and every Alibaba decision render exhaustive pricing semantics', () => {
  const cases: Array<[CatalogPricingDecision, string, string]> = [
    [
      {
        source: 'manual-tiered',
        pricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 900 }],
        },
      },
      'data-manual-tier-pricing',
      'From $9.00',
    ],
    [
      { source: 'scalar', field: 'unitPrice', amount: 18.9, currency: 'USD' },
      'Unit price',
      '$18.90',
    ],
    [{ source: 'quote-required' }, 'Price inquiry', 'Price inquiry'],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'fixed',
          currency: 'USD',
          amountMinor: 250,
        },
      },
      'data-alibaba-pricing',
      '$2.50',
    ],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'range',
          currency: 'USD',
          minAmountMinor: 250,
          maxAmountMinor: 499,
        },
      },
      'data-mode="range"',
      '$4.99',
    ],
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'tiered',
          currency: 'USD',
          tiers: [{ minQuantity: 100, unitAmountMinor: 225 }],
        },
      },
      'data-alibaba-tiers',
      '$2.25',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'quote', mode: 'negotiable' },
      },
      'data-alibaba-negotiable',
      'Price on request',
    ],
    [
      {
        source: 'alibaba',
        pricing: { source: 'alibaba', state: 'unavailable', mode: 'unavailable' },
      },
      'data-alibaba-unavailable',
      'Pricing unavailable',
    ],
  ];
  for (const [pricing, marker, expected] of cases) {
    const html = render(pricing);
    assert.ok(html.includes(marker));
    assert.ok(html.includes(expected));
  }
});

test('Headphones wrapper preserves supplier MOQ and source update metadata', () => {
  const html = renderToStaticMarkup(
    createElement(HeadphonesProductDetail, {
      product: createAlibabaLinkedProduct({
        alibabaCatalogPricing: createAlibabaCatalogPricing({
          sourceMoq: 100,
          sourceUpdatedAt: '2026-08-01T02:00:00.000Z',
        }),
      }),
      detail,
      categoryLabel: 'True Wireless',
      onBack: () => {},
    }),
  );
  assert.ok(html.includes('data-alibaba-source-moq'));
  assert.ok(html.includes('data-alibaba-moq'));
  assert.ok(html.includes('data-alibaba-updated'));
  assert.ok(html.includes('Updated: 2026-08-01'));
});

test('presentation and rollback wrapper preserve their dependency boundaries', () => {
  const presentation = readFileSync(
    fileURLToPath(new URL('./CatalogDetail.tsx', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(
    presentation,
    /Headphones|catalog-types|AlibabaCatalogPricing|alibabaPrimarySourceKey|alibabaCatalogPricing/,
  );
  const wrapper = readFileSync(
    fileURLToPath(new URL('../../islands/shop/HeadphonesProductDetail.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(wrapper, /CatalogDetail/);
  assert.match(wrapper, /resolveCatalogPricing/);
});
