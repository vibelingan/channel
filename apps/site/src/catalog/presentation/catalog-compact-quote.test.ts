import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { startDetailPages } from '../application/catalog-detail-pages.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';
import { detailFixture } from '../testing/detail-fixture.ts';
import { CatalogDetail } from './CatalogDetail.tsx';
import { CatalogQuotePanel } from './CatalogQuotePanel.tsx';
import { CatalogQuoteSheet } from './CatalogQuoteSheet.tsx';

const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(match);
const copy: SharedDetailContent = parseDocument(match[1]).toJS().sharedDetail;
type Pricing = CatalogProductDetail['offers'][number]['pricing'];

function pricedDetail(overrides: Partial<CatalogProductDetail> = {}): CatalogProductDetail {
  return {
    ...detailFixture(1),
    offers: [
      {
        kind: 'supplier',
        basis: 'source-quote',
        pricing: { mode: 'fixed', currency: 'EUR', amountMinor: 1200 },
      },
    ],
    ...overrides,
  };
}

function renderPanel(
  detail = pricedDetail(),
  selection: VariantSelection = { status: 'selected', variant: detail.variants.items[0] },
  inquiryEnabled = true,
) {
  return renderToStaticMarkup(
    createElement(
      CatalogQuotePanel,
      { detail, selection, copy, inquiryEnabled },
      createElement('fieldset', { 'data-test-selector': true }, 'Configurations'),
    ),
  );
}

function primaryArea(html: string) {
  return html.split('<dialog')[0];
}

test('primary quote area orders compact price, composed selector, and one CTA without quantity controls', () => {
  const html = renderPanel();
  const primary = primaryArea(html);
  const price = primary.indexOf('data-catalog-compact-price');
  const selector = primary.indexOf('data-test-selector');
  const quote = primary.indexOf('data-quote-open');
  assert.ok(price >= 0 && selector > price && quote > selector);
  assert.match(primary, /EUR 12\.00/);
  assert.doesNotMatch(
    primary,
    /<input|<table|data-catalog-quote-conditions|Ask about customization/,
  );
  assert.equal((primary.match(/<button/g) ?? []).length, 1);
  const dialog = html.slice(html.indexOf('<dialog'));
  assert.match(dialog, /inputmode="numeric"/i);
  assert.match(dialog, /Ask about customization/);
  assert.match(dialog, /type="checkbox"/);
});

test('website fixed, range and tier amounts are visible before quantity, overriding every source scope', () => {
  const prices: Pricing[] = [
    { mode: 'fixed', currency: 'USD', amountMinor: 310, minimumOrderQuantity: 1000 },
    {
      mode: 'range',
      currency: 'USD',
      minimumAmountMinor: 310,
      maximumAmountMinor: 570,
      minimumOrderQuantity: 1000,
    },
    {
      mode: 'tiered',
      currency: 'USD',
      minimumOrderQuantity: 1000,
      tiers: [
        { minimumQuantity: 1000, maximumQuantity: 1999, unitAmountMinor: 570 },
        { minimumQuantity: 2000, unitAmountMinor: 310 },
      ],
    },
  ];
  for (const pricing of prices) {
    const detail = pricedDetail({ websitePricing: { basis: 'website-manual', pricing } });
    detail.variants.items[0].offers = [
      {
        kind: 'regular',
        basis: 'source-quote',
        pricing: { mode: 'fixed', currency: 'CNY', amountMinor: 8800 },
      },
    ];
    const primary = primaryArea(renderPanel(detail));
    assert.match(primary, /USD 3\.10/);
    if (pricing.mode !== 'fixed') assert.match(primary, /USD 5\.70/);
    assert.match(primary, /[Rr]eference/);
    assert.doesNotMatch(primary, /EUR|CNY|Enter a quantity|<table|<input/);
    assert.equal((primary.match(/USD 3\.10/g) ?? []).length, 1);
  }
});

test('product and selected configuration offers keep independent labels and currencies', () => {
  const detail = pricedDetail();
  detail.variants.items[0].offers = [
    {
      kind: 'regular',
      basis: 'source-quote',
      pricing: { mode: 'fixed', currency: 'CNY', amountMinor: 570 },
    },
    {
      kind: 'promotion',
      basis: 'source-quote',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 80 },
    },
  ];
  const primary = primaryArea(renderPanel(detail));
  const product = primary.split('data-quote-scope="product"')[1]?.split('</section>')[0] ?? '';
  const variant = primary.split('data-quote-scope="variant"')[1]?.split('</section>')[0] ?? '';
  assert.match(product, /Product-level quotes/);
  assert.match(product, /EUR 12\.00/);
  assert.doesNotMatch(product, /CNY|USD/);
  assert.match(variant, /Selected configuration quotes/);
  assert.match(variant, /CNY 5\.70/);
  assert.match(variant, /USD 0\.80/);
  assert.doesNotMatch(variant, /EUR/);
});

test('unknown configuration prices never inherit a product price and authoritative unknown prices never fall back', () => {
  for (const pricing of [{ mode: 'unavailable' }, { mode: 'negotiable' }] satisfies Pricing[]) {
    const detail = pricedDetail();
    detail.variants.items[0].offers = [{ kind: 'supplier', basis: 'source-quote', pricing }];
    const variant = primaryArea(renderPanel(detail)).split('data-quote-scope="variant"')[1] ?? '';
    assert.match(variant, /Request a quote/);
    assert.doesNotMatch(variant, /EUR|12\.00|0\.00/);
    detail.websitePricing = { basis: 'website-manual', pricing };
    const website = primaryArea(renderPanel(detail));
    assert.match(website, /Request a quote/);
    assert.doesNotMatch(website, /EUR|12\.00|0\.00/);
  }
});

test('compact prices retain zero, exact hundredths, and a single amount for equal tier prices', () => {
  const prices: Pricing[] = [
    { mode: 'fixed', currency: 'JPY', amountMinor: 0 },
    { mode: 'fixed', currency: 'EUR', amountMinor: Number.MAX_SAFE_INTEGER },
    {
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minimumQuantity: 1, maximumQuantity: 9, unitAmountMinor: 570 },
        { minimumQuantity: 10, unitAmountMinor: 570 },
      ],
    },
  ];
  for (const [index, pricing] of prices.entries()) {
    const html = primaryArea(
      renderPanel(pricedDetail({ websitePricing: { basis: 'website-manual', pricing } })),
    );
    assert.ok(html.includes(['JPY 0.00', 'EUR 90071992547409.91', 'USD 5.70'][index]));
    if (pricing.mode === 'tiered') assert.equal((html.match(/USD 5\.70/g) ?? []).length, 1);
  }
});

test('no-SKU products enable one product customization quote while unselected variants stay disabled', () => {
  const detail = pricedDetail({ variants: detailFixture(0).variants });
  for (const selection of [
    { status: 'none' },
    { status: 'unselected' },
    { status: 'selected', variant: detailFixture(1).variants.items[0] },
  ] satisfies VariantSelection[]) {
    const html = renderPanel(detail, selection);
    const primary = primaryArea(html);
    assert.equal((primary.match(/data-quote-open/g) ?? []).length, 1);
    assert.doesNotMatch(primary, /disabled=""[^>]*data-quote-open/);
    assert.match(primary, />Request a quote<\/button>/);
    assert.doesNotMatch(primary, /<input|Ask about customization/);
    const dialog = html.slice(html.indexOf('<dialog'));
    assert.match(dialog, /data-configuration-id="canonical-product"/);
    assert.match(dialog, /Customization needs/);
    assert.match(dialog, /Describe the customization/);
    assert.match(dialog, /name="quantity"/);
    assert.doesNotMatch(dialog, /SKU:|variant-1/);
    assert.doesNotMatch(dialog, /<button[^>]*type="submit"[^>]*disabled/);
  }
  assert.match(
    renderPanel(pricedDetail(), { status: 'unselected' }),
    /disabled=""[^>]*data-quote-open/,
  );
});

test('product-level customization cannot toggle to a variant quote without a variant', () => {
  const detail = pricedDetail({ variants: detailFixture(0).variants });
  const html = renderToStaticMarkup(
    createElement(CatalogQuoteSheet, {
      open: true,
      onClose: () => undefined,
      target: {
        productId: detail._id,
        revision: detail.revision ?? '',
        intent: 'customization',
      },
      detail,
      blocked: false,
      quantity: '1250',
      onQuantityChange: () => undefined,
      onIntentChange: () => undefined,
      copy,
    }),
  );
  const toggle = html.match(/<input[^>]*type="checkbox"[^>]*>(?=Ask about customization)/)?.[0];
  assert.ok(toggle, 'customization intent toggle is present');
  assert.match(toggle, /checked=""/);
  assert.match(toggle, /disabled=""/);
  assert.match(html, /Customization needs/);
});

test('no-SKU quotes still block disabled inquiry, missing revision, pending and invalid selection', () => {
  const detail = pricedDetail({ variants: detailFixture(0).variants });
  for (const selection of [
    { status: 'pending', requestedId: 'missing' },
    { status: 'invalid', requestedId: 'missing' },
  ] satisfies VariantSelection[]) {
    assert.match(renderPanel(detail, selection), /disabled=""[^>]*data-quote-open/);
  }
  assert.match(
    renderPanel(detail, { status: 'unselected' }, false),
    /disabled=""[^>]*data-quote-open/,
  );
  assert.match(
    renderPanel({ ...detail, revision: undefined }, { status: 'unselected' }),
    /disabled=""[^>]*data-quote-open/,
  );
});

test('disabled inquiry, missing revision, unselected, pending and invalid selection remain blocked', () => {
  const detail = pricedDetail();
  for (const selection of [
    { status: 'none' },
    { status: 'unselected' },
    { status: 'pending', requestedId: 'missing' },
    { status: 'invalid', requestedId: 'missing' },
  ] satisfies VariantSelection[]) {
    assert.match(renderPanel(detail, selection), /disabled=""[^>]*data-quote-open/);
  }
  assert.match(renderPanel(detail, undefined, false), /disabled=""[^>]*data-quote-open/);
  assert.match(
    renderPanel(pricedDetail({ revision: undefined })),
    /disabled=""[^>]*data-quote-open/,
  );
  assert.doesNotMatch(renderPanel(detail), /disabled=""[^>]*data-quote-open/);
});

test('disabled inquiries block both the panel and an already-open quote sheet', () => {
  for (const total of [0, 1]) {
    const detail = pricedDetail({ variants: detailFixture(total).variants });
    const variant = detail.variants.items[0];
    const selection: VariantSelection = variant
      ? { status: 'selected', variant }
      : { status: 'none' };
    const panel = renderPanel(detail, selection, false);
    assert.match(panel, /disabled=""[^>]*data-quote-open/);
    assert.match(panel, /<button[^>]*type="submit"[^>]*disabled=""/);
    const sheet = renderToStaticMarkup(
      createElement(CatalogQuoteSheet, {
        open: true,
        onClose: () => undefined,
        target: {
          productId: detail._id,
          revision: detail.revision ?? '',
          intent: variant ? 'variant_quote' : 'customization',
          ...(variant ? { variantId: variant.id } : {}),
        },
        detail,
        variant,
        blocked: true,
        quantity: '1250',
        onQuantityChange: () => undefined,
        onIntentChange: () => undefined,
        copy,
      }),
    );
    assert.match(sheet, /<button[^>]*type="submit"[^>]*disabled=""/);
    const toggle = sheet.match(/<input[^>]*type="checkbox"[^>]*>(?=Ask about customization)/)?.[0];
    assert.ok(toggle);
    assert.match(toggle, /disabled=""/);
  }
});

test('detail mobile document order is gallery, title, price, options, quote and desktop widths stay fixed', () => {
  const detail = pricedDetail({
    categoryLabel: 'Category eyebrow',
    descriptionText: 'Detailed notes',
  });
  const pages = startDetailPages(detail, 1000);
  assert.equal(pages.status, 'ready');
  if (pages.status !== 'ready') throw new Error('fixture');
  const html = renderToStaticMarkup(
    createElement(CatalogDetail, {
      pages: pages.value,
      selection: { status: 'selected', variant: detail.variants.items[0] },
      copy,
      media: createElement('div', { 'data-test-gallery': true }),
      pagination: createElement('nav', { 'data-test-pagination': true }),
      onSelect: () => undefined,
      onClear: () => undefined,
    }),
  );
  const markers = [
    'data-test-gallery',
    'data-shared-detail-heading',
    'data-catalog-compact-price',
    'data-catalog-variant-selector',
    'data-test-pagination',
    'data-quote-open',
  ];
  for (const [index, marker] of markers.entries()) {
    assert.ok(html.includes(marker), marker);
    if (index > 0) assert.ok(html.indexOf(markers[index - 1]) < html.indexOf(marker), marker);
  }
  assert.match(html, /lg:grid-cols-\[minmax\(0,\.46fr\)_minmax\(0,\.54fr\)\]/);
  assert.doesNotMatch(
    primaryArea(html),
    /Category eyebrow|data-catalog-key-facts|At a glance|Selected configuration<|Ask about customization/,
  );
  assert.match(html, /USB-C/);
  assert.match(html, /Detailed notes/);
});

test('customization remains editable in the dialog with requested quantity preserved', () => {
  const detail = pricedDetail();
  const html = renderToStaticMarkup(
    createElement(CatalogQuoteSheet, {
      open: true,
      onClose: () => undefined,
      target: {
        productId: detail._id,
        revision: detail.revision ?? '',
        intent: 'customization',
        variantId: detail.variants.items[0].id,
      },
      detail,
      variant: detail.variants.items[0],
      blocked: false,
      quantity: '1250',
      onQuantityChange: () => undefined,
      onIntentChange: () => undefined,
      copy,
    }),
  );
  assert.match(html, /name="quantity"/);
  assert.match(html, /Customization needs/);
  assert.match(html, /Describe the customization/);
  assert.match(html, /data-configuration-id="variant-1"/);
  const toggle = html.match(/<input[^>]*type="checkbox"[^>]*>(?=Ask about customization)/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /checked=""/);
  assert.doesNotMatch(toggle, /disabled/);
});
