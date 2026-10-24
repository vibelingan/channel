import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCatalogDetailView, decodeCatalogProductDetail } from './product-detail.ts';
const base = {
  schemaVersion: 'catalog-product-detail-v1',
  _id: 'p1',
  name: 'Headset',
  images: [],
  facts: [],
  offers: [],
  variants: { items: [], page: 1, pageSize: 50, total: 0, hasMore: false },
};
const content = {
  schemaVersion: 'catalog-content-v1',
  specifications: [],
  packaging: [],
  notes: ['Supplier notes'],
};
test('strict v1 stays unchanged while the new decoder accepts explicitly versioned content', () => {
  assert.equal(decodeCatalogProductDetail(base).ok, true);
  assert.equal(decodeCatalogProductDetail({ ...base, content }).ok, false);
  const v2 = { ...base, schemaVersion: 'catalog-product-detail-v2', content };
  assert.equal(decodeCatalogProductDetail(v2).ok, false);
  assert.equal(decodeCatalogDetailView(v2).ok, true);
  for (const invalid of [
    null,
    { ...content, notes: ['x'.repeat(2001)] },
    { ...content, raw: 'private' },
  ])
    assert.equal(decodeCatalogDetailView({ ...v2, content: invalid }).ok, false);
});
test('both versions enforce the identical variant page constraints', () => {
  for (const detail of [base, { ...base, schemaVersion: 'catalog-product-detail-v2', content }]) {
    for (const variants of [
      { ...base.variants, hasMore: true },
      { ...base.variants, total: 1 },
      { ...base.variants, page: 0 },
    ])
      assert.equal(decodeCatalogDetailView({ ...detail, variants }).ok, false);
  }
});

test('v3 note blocks are explicit, bounded and match approved text without changing v2', () => {
  const v3 = {
    ...base,
    schemaVersion: 'catalog-product-detail-v3',
    content,
    noteBlocks: [{ kind: 'heading', text: 'Supplier notes' }],
  };
  assert.equal(decodeCatalogDetailView(v3).ok, true);
  assert.equal(
    decodeCatalogDetailView({ ...v3, schemaVersion: 'catalog-product-detail-v2' }).ok,
    false,
  );
  for (const noteBlocks of [
    null,
    [],
    [{ kind: 'subtitle', text: 'Supplier notes' }],
    [{ kind: 'heading', text: 'Other text' }],
    [{ kind: 'heading', text: 'Supplier notes', rawHtml: 'private' }],
    [{ kind: 'heading', text: 'x'.repeat(201) }],
  ])
    assert.equal(decodeCatalogDetailView({ ...v3, noteBlocks }).ok, false);
  assert.equal(
    decodeCatalogDetailView({ ...v3, variants: { ...base.variants, hasMore: true } }).ok,
    false,
  );
});
