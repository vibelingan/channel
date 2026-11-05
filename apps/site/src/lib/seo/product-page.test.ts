import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { ProductLanding } from '../../islands/shop/ProductLanding.tsx';
import { SkuDetailView } from '../../islands/shop/SkuDetailPage.tsx';
import { isPlainProductClick, productPath } from './product-identity.ts';
import { productPageDescriptor } from './product-page.ts';

const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(match);
const content: CatalogContent & { sharedDetail: SharedDetailContent } = parseDocument(
  match[1],
).toJS();
const product = { _id: 'canonical-product', name: 'Headset', description: 'Legacy public body.' };
test('initial HTML uses the existing detail view for both canonical and no-slug legacy products', () => {
  for (const bootstrap of [
    undefined,
    { ...detailFixture(), revision: 'approved-r1', descriptionText: 'Approved public body.' },
  ]) {
    const html = renderToStaticMarkup(
      createElement(ProductLanding, {
        product,
        bootstrap,
        content,
        copy: content.sharedDetail,
        canonicalPath: productPath(product._id),
      }),
    );
    assert.match(html, /<h1[^>]*>Headset<\/h1>/);
    assert.match(html, bootstrap ? /Approved public body\./ : /Legacy public body\./);
    assert.doesNotMatch(html, /Loading product|data-catalog-schema/);
  }
});
test('one stable identity drives metadata schema and breadcrumbs without inferring variant-wide offers', () => {
  const detail = {
    ...detailFixture(51),
    revision: 'approved-r1',
    descriptionText: 'Public summary.',
  };
  const page = productPageDescriptor(
    { product, detail, revision: detail.revision ?? '' },
    'https://example.com',
    'Brand',
  );
  assert.equal(page.canonicalPath, '/products/p-canonical-product/');
  assert.match(page.description, /Public summary/);
  assert.doesNotMatch(JSON.stringify(page.schemaNodes), /localhost|products\/item|Offer/);
  assert.equal(page.schemaNodes[0]?.url, 'https://example.com/products/p-canonical-product/');
});
test('plain clicks expand in place and modifier clicks retain native link navigation', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(isPlainProductClick(click), true);
  for (const field of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])
    assert.equal(isPlainProductClick({ ...click, [field]: true }), false);
  assert.equal(isPlainProductClick({ ...click, button: 1 }), false);
  assert.throws(() => productPath('../admin'));
});

test('legacy refresh errors retain public body and expose a retry instead of failing silently', () => {
  const html = renderToStaticMarkup(
    createElement(SkuDetailView, {
      content,
      canonicalPath: productPath(product._id),
      state: { status: 'ready', product, related: [], refreshError: true },
      onRetry: () => {},
    }),
  );
  assert.match(html, /Legacy public body/);
  assert.match(html, /role="alert"/);
  assert.ok(html.includes(content.list.retryLabel));
});

test('first delivery uses the existing dynamic route and later acceptance restores its stable URL', async () => {
  const { productBrowserPath } = await import('./product-identity.ts');
  assert.equal(
    productBrowserPath({ ...product, publicPageReady: false }),
    '/products/item/?id=canonical-product',
  );
  assert.equal(productBrowserPath({ ...product, publicPageReady: true }), productPath(product._id));
  assert.equal(productBrowserPath(product), productPath(product._id));
  const page = productPageDescriptor(
    {
      product,
      revision: 'legacy',
      publicVersion: { sequence: 1, semanticHash: 'a'.repeat(64), changedAt: null },
    },
    'https://example.com',
    'Brand',
  );
  assert.equal(page.content.updatedAt, undefined);
  const updated = productPageDescriptor(
    {
      product,
      revision: 'legacy',
      publicVersion: {
        sequence: 2,
        semanticHash: 'b'.repeat(64),
        changedAt: '2026-10-30T00:00:00.000Z',
      },
    },
    'https://example.com',
    'Brand',
  );
  assert.equal(updated.content.updatedAt, '2026-10-30T00:00:00.000Z');
});
