import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { advanceCatalogProduct } from './catalog-product-state.ts';
import { runCatalogRowMutation } from './catalog-row-mutation.ts';
const now = '2026-10-14T00:00:00.000Z';
const outputs = {
  catalogPreparationState: 'ready',
  catalogPreparationPolicy: 'forged-policy',
  catalogPreparationReport: { productId: 'other', state: 'ready' },
  catalogDetailPagination: { policyVersion: 'forged', revision: 'other', pageSize: 1 },
};
const original = (): CollectionDoc => ({
  _id: 'p',
  name: 'Website',
  productFamily: 'misc',
  published: false,
  catalogContentGeneration: 3,
  catalogPreparationState: 'blocked',
  catalogPreparationPolicy: 'previous-policy',
  catalogPreparationReport: { productId: 'p', state: 'blocked' },
  catalogDetailPagination: {
    policyVersion: 'catalog-detail-pagination-v1',
    revision: 'kept',
    pageSize: 50,
  },
});
test('ordinary saves cannot replace server-owned preparation policy or report', () => {
  const before = original();
  const saved = advanceCatalogProduct(before, { ...before, ...outputs }, now);
  for (const field of Object.keys(outputs)) assert.deepEqual(saved[field], before[field], field);
});
test('ordinary saves cannot introduce preparation output onto a legacy product', () => {
  const before: CollectionDoc = { _id: 'p', name: 'Website' };
  const saved = advanceCatalogProduct(before, { ...before, ...outputs }, now);
  for (const field of Object.keys(outputs)) assert.equal(Object.hasOwn(saved, field), false, field);
});
test('new product creation starts stale without trusting supplied preparation output', () => {
  const saved = advanceCatalogProduct(null, { _id: 'p', name: 'Website', ...outputs }, now);
  assert.equal(saved.catalogPreparationState, 'stale');
  assert.equal(Object.hasOwn(saved, 'catalogPreparationPolicy'), false);
  assert.equal(Object.hasOwn(saved, 'catalogPreparationReport'), false);
});
test('content saves retain the last report for diagnosis but invalidate its generation and state', () => {
  const before = original();
  const saved = advanceCatalogProduct(before, { ...before, name: 'Edited', ...outputs }, now);
  assert.equal(saved.catalogContentGeneration, 4);
  assert.equal(saved.catalogPreparationState, 'stale');
  assert.equal(saved.detailSourceReady, false);
  assert.deepEqual(saved.catalogPreparationReport, before.catalogPreparationReport);
  assert.equal(saved.catalogPreparationPolicy, before.catalogPreparationPolicy);
  assert.equal(before.catalogContentGeneration, 3);
});
for (const field of Object.keys(outputs))
  test(`ordinary counters cannot write preparation output: ${field}`, async () => {
    const before: CollectionDoc = { ...original(), [field]: 7 };
    let writes = 0;
    await assert.rejects(
      runCatalogRowMutation(
        {
          get: async () => before,
          set: async () => {
            writes++;
          },
          remove: async () => {
            writes++;
          },
        },
        { action: 'increment', collection: 'products', id: 'p', field, delta: 1 },
        now,
      ),
    );
    assert.equal(writes, 0);
    assert.equal(before[field], 7);
  });
test('lifecycle and subcategory-only saves preserve the checked content report', () => {
  const before = original();
  const saved = advanceCatalogProduct(
    before,
    { ...before, published: true, subcategoryIds: ['leaf'] },
    now,
  );
  assert.equal(saved.catalogContentGeneration, 3);
  assert.equal(saved.catalogPreparationState, before.catalogPreparationState);
  assert.deepEqual(saved.catalogPreparationReport, before.catalogPreparationReport);
  assert.equal(saved.catalogLifecycleVersion, 1);
  assert.equal(saved.catalogClassificationRevision, 1);
});

for (const field of ['alibabaPhotosPending', 'alibabaAutoPhotos'] as const) {
  test(`photo preparation ${field} invalidates prior checks and survives ABA`, () => {
    const oldValue =
      field === 'alibabaPhotosPending'
        ? true
        : {
            configurations: {
              sources: ['https://sc04.alicdn.com/a.jpg'],
              imageIds: [],
              unusable: [],
              missing: ['https://sc04.alicdn.com/a.jpg'],
            },
          };
    const newValue =
      field === 'alibabaPhotosPending'
        ? false
        : {
            configurations: {
              sources: ['https://sc04.alicdn.com/a.jpg'],
              imageIds: [],
              unusable: [],
              missing: [],
            },
          };
    const before = {
      ...original(),
      catalogPreparationState: 'ready',
      detailSourceReady: true,
      [field]: oldValue,
    };
    const saved = advanceCatalogProduct(before, { ...before, [field]: newValue }, now);
    assert.equal(saved.catalogContentGeneration, 4);
    assert.equal(saved.catalogPreparationState, 'stale');
    assert.equal(saved.detailSourceReady, false);
    assert.deepEqual(saved.catalogPreparationReport, before.catalogPreparationReport);
    assert.equal(saved.published, before.published);
    assert.equal(saved.productFamily, before.productFamily);
    const replay = advanceCatalogProduct(
      saved,
      { ...saved, [field]: structuredClone(newValue) },
      now,
    );
    assert.equal(replay.catalogContentGeneration, 4);
    const reversed = advanceCatalogProduct(saved, { ...saved, [field]: oldValue }, now);
    assert.equal(reversed.catalogContentGeneration, 5);
    assert.equal(reversed.catalogPreparationState, 'stale');
  });
}

test('absent null and false photo pending flags are the same completed state', () => {
  for (const value of [undefined, null, false]) {
    const before = { ...original(), detailSourceReady: true };
    const saved = advanceCatalogProduct(before, { ...before, alibabaPhotosPending: value }, now);
    assert.equal(saved.catalogContentGeneration, 3);
    assert.equal(saved.detailSourceReady, true);
  }
});
