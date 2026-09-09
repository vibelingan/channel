import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { startDetailPages } from '../application/catalog-detail-pages.ts';
import { CatalogLocalPreviewContext } from '../application/catalog-quote-transport.ts';
import { resolveVariantSelection } from '../application/catalog-variant-state.ts';
import { detailFixture } from '../testing/detail-fixture.ts';
import { CatalogDetail } from './CatalogDetail.tsx';
import { CatalogQuoteConditions, formatCatalogQuoteAmount } from './CatalogQuoteConditions.tsx';
import { CatalogSpecifications } from './CatalogSpecifications.tsx';
import { CatalogVariantSelector } from './CatalogVariantSelector.tsx';

const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(match);
const copy: SharedDetailContent = parseDocument(match[1]).toJS().sharedDetail;

test('production presentation excludes development notices and preview opts in explicitly', () => {
  const pages = startDetailPages(detailFixture(), 1000);
  assert.ok(pages.status === 'ready');
  const component = createElement(CatalogDetail, {
    pages: pages.value,
    selection: { status: 'unselected' },
    copy,
    media: null,
    onSelect: () => {},
    onClear: () => {},
  });
  const production = renderToStaticMarkup(component);
  assert.doesNotMatch(production, /Local preview|sample database|publish or sync|not connected/);
  assert.match(production, /Request a quote/);
  assert.match(production, /Availability, shipping and final terms require confirmation/);
  const local = renderToStaticMarkup(
    createElement(CatalogLocalPreviewContext.Provider, { value: true }, component),
  );
  assert.match(local, /Local preview/);
  assert.match(local, /no email, order or payment is sent/);
});

test('source amount rendering preserves exact hundredths and separate currency labels', () => {
  assert.equal(formatCatalogQuoteAmount(570, 'USD'), 'USD 5.70');
  assert.equal(formatCatalogQuoteAmount(0, 'JPY'), 'JPY 0.00');
  assert.equal(formatCatalogQuoteAmount(570, 'CNY'), 'CNY 5.70');
  assert.equal(formatCatalogQuoteAmount(Number.MAX_SAFE_INTEGER, 'EUR'), 'EUR 90071992547409.91');
  for (const invalid of [
    -1,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(formatCatalogQuoteAmount(invalid, 'USD'), '—');
});

test('quote UI keeps product and selected configuration scopes separate without price fallback', () => {
  const html = renderToStaticMarkup(
    createElement(CatalogQuoteConditions, {
      copy,
      productOffers: [
        {
          kind: 'supplier',
          basis: 'source-quote',
          pricing: { mode: 'fixed', currency: 'EUR', amountMinor: 1200 },
        },
      ],
      variantOffers: [
        { kind: 'supplier', basis: 'source-quote', pricing: { mode: 'unavailable' } },
      ],
    }),
  );
  assert.match(html, /data-quote-scope="product"/);
  assert.match(html, /data-quote-scope="variant"/);
  const variant = html.split('data-quote-scope="variant"')[1] ?? '';
  assert.doesNotMatch(variant, /EUR|12\.00/);
  assert.match(html, /inputmode="numeric"/i);
});
test('structured content separates specifications packaging and collapsed supplier notes', () => {
  const result = startDetailPages(
    {
      ...detailFixture(),
      facts: [],
      schemaVersion: 'catalog-product-detail-v2',
      content: {
        schemaVersion: 'catalog-content-v1',
        specifications: [{ name: 'Material', value: 'ABS' }],
        packaging: [{ name: 'Package', value: 'AUX cable' }],
        notes: ['Supplier statement <script>unsafe()</script>'],
      },
    },
    1000,
  );
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('fixture');
  const html = renderToStaticMarkup(
    createElement(CatalogDetail, {
      pages: result.value,
      selection: resolveVariantSelection(result.value),
      copy,
      media: null,
      onSelect: () => undefined,
      onClear: () => undefined,
    }),
  );
  assert.match(html, /data-catalog-key-facts/);
  assert.match(html, /data-catalog-packaging/);
  assert.match(html, /data-catalog-notes/);
  assert.doesNotMatch(html, /<details open=""[^>]*data-catalog-notes/);
  assert.doesNotMatch(html, /No structured specifications|<script|fixed bottom/);
  assert.match(html, /Supplier statement &lt;script&gt;/);
});
test('legacy descriptions remain paragraph text, never inferred key value rows', () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSpecifications, { facts: [], description: 'Material\nABS', copy }),
  );
  assert.match(html, />Material<\/p>/);
  assert.match(html, />ABS<\/p>/);
  assert.doesNotMatch(html, /<dt[^>]*>Material/);
});

test('conflicting legacy facts stay available in notes instead of silently disappearing', () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSpecifications, {
      facts: [
        { name: 'Material', value: 'ABS' },
        { name: 'material', value: 'Metal' },
      ],
      description: 'Legacy description',
      copy,
    }),
  );
  assert.match(html, /Material — ABS/);
  assert.match(html, /material — Metal/);
  assert.match(html, /Legacy description/);
});
function render(total = 2, missing = false) {
  const detail = detailFixture(total);
  detail.name = '<script>Unsafe source title</script>';
  if (missing) {
    detail.images = [];
    detail.facts = [];
  }
  const result = startDetailPages(detail, 1000);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('fixture');
  return renderToStaticMarkup(
    createElement(CatalogDetail, {
      pages: result.value,
      selection: resolveVariantSelection(result.value),
      copy,
      media: createElement('div', { 'data-media-test': true }),
      onSelect: () => undefined,
      onClear: () => undefined,
    }),
  );
}
test('real fields render as text; no source HTML or prototype phone defaults', () => {
  const html = render();
  assert.match(html, /&lt;script&gt;Unsafe source title&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|Xiaomi|Storage|256GB|Demo reference|vipPrice/);
  assert.match(html, /Color 1/);
  assert.match(html, /USB-C/);
  assert.match(html, /data-shared-catalog-detail/);
});
test('missing facts images category and zero variants still permit a truthful product view', () => {
  const html = render(0, true);
  assert.match(html, /Specifications are not available yet/);
  assert.match(html, /No variant configuration/);
  assert.match(html, /data-media-test/);
  assert.doesNotMatch(html, /Color 1|Headphones|undefined/);
});
test('RFQ preparation is available without a submission action and selection stays visible', () => {
  const html = render();
  assert.match(html, /data-quote-open/);
  assert.match(html, /This is an inquiry, not an order/);
  assert.doesNotMatch(html, /<form[^>]*action=/);
  assert.match(html, /Selected configuration/);
  assert.doesNotMatch(html, /<fieldset[^>]*class="[^"]*hidden/);
});

test('identical source labels still expose distinct visible canonical references', () => {
  const detail = detailFixture(2);
  for (const row of detail.variants.items) {
    row.options = [{ name: 'Color', value: 'Black' }];
    row.sku = 'DUPLICATE';
  }
  const result = startDetailPages(detail, 1000);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('fixture');
  const html = renderToStaticMarkup(
    createElement(CatalogVariantSelector, {
      pages: result.value,
      selection: resolveVariantSelection(result.value),
      copy,
      onSelect: () => undefined,
    }),
  );
  assert.match(html, />variant-1<\/span>/);
  assert.match(html, />variant-2<\/span>/);
});
