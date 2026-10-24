import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePublicVersion } from './public-version.ts';

const publication = {
  state: 'approved',
  revision: 'r1',
  header: {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p1',
    name: 'Headset',
    images: [],
    facts: [],
    offers: [],
  },
  variantCount: 0,
};
const on = { detailEnabled: true };

test('a product with a valid approved version is served from it, synced or manual', () => {
  for (const product of [
    { _id: 'p1', alibabaPrimarySourceKey: 'source', catalogDetailPublication: publication },
    { _id: 'p1', catalogDetailPublication: publication },
  ]) {
    const version = resolvePublicVersion(product, on);
    assert.equal(version.kind, 'approved');
    if (version.kind === 'approved') assert.equal(version.publication.revision, 'r1');
  }
});

test('feature off, never approved, malformed or mismatched versions fall back to the row', () => {
  const rows = [
    [{ _id: 'p1', catalogDetailPublication: publication }, { detailEnabled: false }],
    [{ _id: 'p1' }, on],
    [{ _id: 'p1', catalogDetailPublication: { ...publication, state: 'draft' } }, on],
    [{ _id: 'other', catalogDetailPublication: publication }, on],
    [null, on],
    ['p1', on],
  ] as const;
  for (const [product, options] of rows) {
    assert.deepEqual(resolvePublicVersion(product, options), { kind: 'row' });
  }
});
