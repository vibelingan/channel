import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planSourceInvalidation, sourceInputDigest } from './catalog-source-invalidation.ts';

function source(title = 'Before'): CollectionDoc {
  return {
    _id: 'obs',
    provider: 'alibaba',
    sourceProductKey: 'key',
    active: true,
    observation: {
      source: {
        provider: 'alibaba',
        sourceProductKey: 'key',
        observedAt: '2026-10-13T00:00:00.000Z',
      },
      identity: { title },
      evidence: [{ evidenceId: 'first' }],
    },
  };
}
function store(product: CollectionDoc) {
  return {
    get: async (collection: string, id: string) =>
      collection === 'alibabaProductLinks' && id === 'key'
        ? { _id: 'key', sourceKey: 'key', productId: product._id }
        : collection === 'products' && id === product._id
          ? product
          : null,
  };
}
const product = (): CollectionDoc => ({
  _id: 'p',
  alibabaPrimarySourceKey: 'key',
  detailSourceReady: true,
  published: true,
  archived: false,
  productFamily: 'misc',
  updatedAt: '2026-10-13T00:00:00.000Z',
});

test('capture metadata and object key order do not invalidate identical effective source data', async () => {
  const before = source();
  const next = {
    ...source(),
    updatedAt: 'later',
    lastSeenOperationId: 'other',
    observation: {
      evidence: [{ evidenceId: 'second' }],
      identity: { title: 'Before' },
      source: {
        observedAt: '2026-10-13T00:01:00.000Z',
        sourceProductKey: 'key',
        provider: 'alibaba',
      },
    },
  };
  assert.equal(sourceInputDigest(before), sourceInputDigest(next));
  assert.equal(
    await planSourceInvalidation(store(product()), before, next, '2026-10-13T00:01:00.000Z'),
    null,
  );
});

test('same observedAt with changed content and later ABA transitions advance a monotonic generation', async () => {
  const initial = product();
  const first = await planSourceInvalidation(
    store(initial),
    source(),
    source('Changed'),
    initial.updatedAt as string,
  );
  assert.ok(first);
  assert.equal(first.catalogContentGeneration, 1);
  assert.equal(first.updatedAt, '2026-10-13T00:00:00.001Z');
  const second = await planSourceInvalidation(
    store(first),
    source('Changed'),
    source(),
    initial.updatedAt as string,
  );
  assert.equal(second?.catalogContentGeneration, 2);
  assert.equal(second?.updatedAt, '2026-10-13T00:00:00.002Z');
  assert.equal(second?.published, true);
  assert.equal(second?.productFamily, 'misc');
  assert.equal(initial.detailSourceReady, true, 'plan is read-only');
});

test('tombstones invalidate, but an old link cannot invalidate a different current primary source', async () => {
  const before = source();
  const tombstone = { ...before, active: false };
  assert.equal(
    (await planSourceInvalidation(store(product()), before, tombstone, '2026-10-13T00:01:00.000Z'))
      ?.detailSourceReady,
    false,
  );
  assert.equal(
    await planSourceInvalidation(
      store({ ...product(), alibabaPrimarySourceKey: 'other' }),
      before,
      tombstone,
      '2026-10-13T00:01:00.000Z',
    ),
    null,
  );
});

for (const generation of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER]) {
  test(`invalid generation ${generation} cannot wrap or partially invalidate`, async () => {
    await assert.rejects(
      planSourceInvalidation(
        store({ ...product(), catalogContentGeneration: generation }),
        source(),
        source('Changed'),
        '2026-10-13T00:01:00.000Z',
      ),
      /generation/,
    );
  });
}

test('a corrupt existing link cannot silently allow a source write with an old ready flag', async () => {
  await assert.rejects(
    planSourceInvalidation(
      { get: async () => ({ _id: 'key', productId: 'p' }) },
      source(),
      source('Changed'),
      '2026-10-13T00:01:00.000Z',
    ),
    /source link/,
  );
});

test('adding or changing a capture pairing proof invalidates readiness even with identical observation', async () => {
  const before = source();
  const result = await planSourceInvalidation(
    store(product()),
    before,
    { ...before, sourceContentHash: 'a'.repeat(64) },
    '2026-10-13T00:01:00.000Z',
  );
  assert.equal(result?.detailSourceReady, false);
});

test('a valid unclaimed legacy source has no primary product to invalidate', async () => {
  const result = await planSourceInvalidation(
    { get: async () => ({ _id: 'key', sourceKey: 'key', productId: '' }) },
    source(),
    source('Changed'),
    '2026-10-13T00:01:00.000Z',
  );
  assert.equal(result, null);
});

test('wrapper-only source identity changes are refused even when the observation digest is unchanged', async () => {
  await assert.rejects(
    planSourceInvalidation(
      store(product()),
      source(),
      { ...source(), provider: 'dianxiaomi' },
      '2026-10-13T00:01:00.000Z',
    ),
    /identity/,
  );
});
