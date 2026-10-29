import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { detailFixture } from '../testing/detail-fixture.ts';
import { CatalogQuotePanel } from './CatalogQuotePanel.tsx';
const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(match);
const copy: SharedDetailContent = parseDocument(match[1]).toJS().sharedDetail;
test('a pending SKU cannot open a quote while a selected canonical SKU can', () => {
  const detail = detailFixture();
  const variant = detail.variants.items[0];
  assert.ok(variant);
  const pending = renderToStaticMarkup(
    createElement(CatalogQuotePanel, {
      detail,
      copy,
      selection: { status: 'pending', requestedId: 'missing' },
    }),
  );
  assert.match(pending, /disabled=""[^>]*data-quote-open/);
  const selected = renderToStaticMarkup(
    createElement(CatalogQuotePanel, { detail, copy, selection: { status: 'selected', variant } }),
  );
  assert.match(selected, /data-quote-open/);
  assert.doesNotMatch(selected, /disabled=""[^>]*data-quote-open/);
  assert.doesNotMatch(selected, /<form[^>]*action=|receipt|CH-Q-/);
});

test('unchanged product HTML does not carry the build date, while client and submit date validation remain', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T12:00:00Z') });
  const render = () =>
    renderToStaticMarkup(
      createElement(CatalogQuotePanel, {
        detail: detailFixture(),
        copy,
        selection: { status: 'none' },
      }),
    );
  const first = render();
  t.mock.timers.tick(86400000);
  const second = render();
  assert.equal(first, second);
  assert.match(first, /type="date"/);
  assert.doesNotMatch(first, /min="\d{4}-\d{2}-\d{2}"/);
});
