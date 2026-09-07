import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import {
  createOldestHeadphonesPublicProduct,
  createPublicProduct,
} from '../../test/factories/catalog.ts';
import { assertCatalogFamilyAdapter } from './catalog-family-adapter.ts';
import { createHeadphonesAdapter } from './headphones.ts';

const markdown = readFileSync(
  new URL('../../i18n/content/headphones/en-US.md', import.meta.url),
  'utf8',
);
const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter);
const document = parseDocument(frontmatter[1], { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const content = document.toJS() as HeadphonesContent;

test('Headphones adapter uses real copy and legacy category order', () => {
  const adapter = createHeadphonesAdapter(content);
  assertCatalogFamilyAdapter(adapter);
  assert.equal(adapter.family, 'headphones');
  assert.deepEqual(adapter.filterCapabilities, content.list.categories);
  assert.equal(adapter.labels.heading, content.list.heading);
  assert.equal(adapter.emptyCopy, content.list.emptyStateLabel);
  for (const category of content.list.categories) {
    assert.equal(adapter.group(createPublicProduct({ category: category.key })), category.label);
  }
});

test('oldest, unknown, and uncategorized products retain grouping without mutation', () => {
  const adapter = createHeadphonesAdapter(content);
  const oldest = createOldestHeadphonesPublicProduct();
  Object.freeze(oldest);
  assert.equal(adapter.group(oldest), 'Wired Headphones');
  assert.deepEqual(adapter.facts(oldest), []);
  assert.equal(oldest.slug, undefined);
  assert.equal(
    adapter.group(createPublicProduct({ category: 'historic-category' })),
    'historic-category',
  );
  assert.equal(adapter.group(createPublicProduct({ category: undefined })), 'uncategorized');
  assert.equal(adapter.group(createPublicProduct({ category: '' })), 'uncategorized');
});

test('facts project ordered identity fields only and ignore price and media changes', () => {
  const adapter = createHeadphonesAdapter(content);
  const product = createPublicProduct({
    series: 'SY',
    modName: 'T8',
    modType: 'TWS',
    productCode: 'SY-T8',
  });
  const expected = [
    { key: 'series', label: content.detail.seriesLabel, value: 'SY' },
    { key: 'model', label: content.detail.modelLabel, value: 'T8' },
    { key: 'type', label: content.detail.typeLabel, value: 'TWS' },
    { key: 'product-code', label: 'Product Code', value: 'SY-T8' },
  ];
  assert.deepEqual(adapter.facts(product), expected);
  assert.deepEqual(
    adapter.facts({
      ...product,
      moq: 100,
      unitPrice: 99,
      wholesalePrice: 88,
      alibabaPrimarySourceKey: 'linked',
      images: ['image'],
    }),
    expected,
  );
  assert.equal(adapter.group(product), adapter.group({ ...product, slug: undefined }));
});
