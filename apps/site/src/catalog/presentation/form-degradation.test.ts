import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { AlibabaProductDetailInspection } from '../../islands/admin/alibaba-catalog-sync/AlibabaProductDetailInspection.tsx';
import { detailFixture } from '../testing/detail-fixture.ts';
import { CatalogQuoteSheet } from './CatalogQuoteSheet.tsx';

function assertPostForm(html: string) {
  const forms = html.match(/<form\b[^>]*>/g) ?? [];
  assert.equal(forms.length, 1, 'the rendered component must contain its form');
  assert.match(forms[0] ?? '', /\bmethod="post"/, 'native submission must not default to GET');
}

test('quote sheet renders POST even when its JavaScript submit handler is unavailable', () => {
  const source = readFileSync(
    new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
    'utf8',
  );
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter);
  const copy: SharedDetailContent = parseDocument(frontmatter[1]).toJS().sharedDetail;
  const detail = detailFixture();
  const variant = detail.variants.items[0];
  assert.ok(variant);
  assert.ok(detail.revision);
  const html = renderToStaticMarkup(
    createElement(CatalogQuoteSheet, {
      open: true,
      onClose: () => {},
      target: {
        intent: 'variant_quote',
        productId: detail._id,
        revision: detail.revision,
        variantId: variant.id,
      },
      detail,
      variant,
      blocked: false,
      quantity: '500',
      onQuantityChange: () => {},
      copy,
    }),
  );
  assert.match(html, /name="email"/);
  assert.match(html, /name="contactName"/);
  assertPostForm(html);
});

test('Alibaba inspection renders POST for its enabled form', () => {
  const html = renderToStaticMarkup(
    createElement(AlibabaProductDetailInspection, {
      connected: true,
      busy: false,
      result: null,
      onInspect: () => {},
    }),
  );
  assert.match(html, /data-inspect-product-id/);
  assert.doesNotMatch(html, /disabled=""/);
  assertPostForm(html);
});
