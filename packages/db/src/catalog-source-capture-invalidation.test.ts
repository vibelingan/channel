import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { sourceCaptureMatches, sourceInputDigest } from './catalog-source-inputs.ts';
import { planSourceInvalidation } from './catalog-source-invalidation.ts';
const now = '2026-10-14T00:00:00.000Z';
const source: CollectionDoc = {
  _id: 'source',
  connectionId: 'connection',
  sourceProductId: 'external',
  contentHash: 'a'.repeat(64),
  payloadId: 'raw-old',
  active: true,
};
const observation: CollectionDoc = {
  _id: sourceObservationDocumentId('alibaba', 'source'),
  provider: 'alibaba',
  sourceProductKey: 'source',
  evidenceId: 'raw-old',
  observation: {
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source',
      externalProductId: 'external',
      observedAt: now,
    },
    identity: { title: 'Clock' },
  },
};
const product: CollectionDoc = {
  _id: 'p',
  alibabaPrimarySourceKey: 'source',
  catalogContentGeneration: 3,
  detailSourceReady: true,
  catalogPreparationState: 'ready',
  published: true,
  catalogDetailPublication: { revision: 'retained' },
};
const store = (observed: CollectionDoc | null) => ({
  get: async (collection: string, id: string) =>
    collection === 'catalogSourceObservations' && id === observation._id
      ? observed
      : collection === 'alibabaProductLinks'
        ? { _id: 'source', sourceKey: 'source', productId: 'p' }
        : collection === 'products'
          ? product
          : null,
});
test('changing the raw capture of a paired legacy source invalidates its bound product', async () => {
  assert.equal(sourceCaptureMatches(source, observation), true);
  const next = { ...source, payloadId: 'raw-new' };
  assert.equal(sourceCaptureMatches(next, observation), false);
  const invalidated = await planSourceInvalidation(store(observation), source, next, now, 'mirror');
  assert.ok(invalidated);
  assert.equal(invalidated.catalogContentGeneration, 4);
  assert.equal(invalidated.catalogPreparationState, 'stale');
  assert.equal(invalidated.detailSourceReady, false);
  assert.equal(invalidated.published, true);
  assert.deepEqual(invalidated.catalogDetailPublication, product.catalogDetailPublication);
});
test('legacy evidence identity participates in the observation input version', () => {
  assert.notEqual(
    sourceInputDigest(observation),
    sourceInputDigest({ ...observation, evidenceId: 'raw-new' }),
  );
});
test('modern content-paired recaptures keep readiness even when their raw IDs change', async () => {
  const modern = { ...observation, sourceContentHash: source.contentHash };
  assert.equal(sourceCaptureMatches({ ...source, payloadId: 'raw-new' }, modern), true);
  assert.equal(
    await planSourceInvalidation(
      store(modern),
      source,
      { ...source, payloadId: 'raw-new' },
      now,
      'mirror',
    ),
    product,
  );
  assert.equal(sourceInputDigest(modern), sourceInputDigest({ ...modern, evidenceId: 'raw-new' }));
});
test('unrelated capture metadata is not a new input for a paired legacy source', async () => {
  assert.equal(
    await planSourceInvalidation(
      store(observation),
      source,
      { ...source, lastSeenRunId: 'new-run', fetchedAt: now },
      now,
      'mirror',
    ),
    null,
  );
  assert.equal(
    sourceInputDigest(observation),
    sourceInputDigest({ ...observation, rawMetadata: 'new' }),
  );
});
test('raw identity remains a legacy input even while its pairing is already invalid', async () => {
  const unpaired = { ...observation, evidenceId: 'unpaired' };
  const invalidated = await planSourceInvalidation(
    store(unpaired),
    source,
    { ...source, payloadId: 'raw-new' },
    now,
    'mirror',
  );
  assert.equal(invalidated?.catalogContentGeneration, 4);
});
test('recovering a legacy capture pairing invalidates a previously blocked check', async () => {
  const old = { ...source, payloadId: 'unpaired' };
  const invalidated = await planSourceInvalidation(store(observation), old, source, now, 'mirror');
  assert.equal(invalidated?.catalogContentGeneration, 4);
});

test('a capture metadata write keeps a physical product fence while an observation is missing', async () => {
  const fenced = await planSourceInvalidation(
    store(null),
    source,
    { ...source, payloadId: 'raw-new' },
    now,
    'mirror',
  );
  assert.deepEqual(fenced, product);
});
