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
