import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { readCurrentCatalogPreparationRequest } from '@vibelingan-channel/shared/catalog-preparation';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import {
  approvedVariantDocumentId,
  persistStagedApprovalInCloud,
  prepareStagedApproval,
} from './catalog-detail-staging.ts';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';
import { registerLiveSaveStorageContract } from './catalog-live-save-contract.fixture.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { catalogPreparationImageHold } from './catalog-preparation-image-hold.ts';
import { readCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import {
  acquireImageMutationInCloudBase,
  claimAlibabaSyncRunInCloudBase,
  incrementCatalogImageReferenceInCloudBase,
  manageCatalogPreparationJobInCloudBase,
  manageImageDeletionInCloudBase,
  manageSourceMediaImportInCloudBase,
  mutateCatalogRowInCloudBase,
  preparingProductHiddenWhere,
  removeImageInCloudBase,
  saveCatalogProductInCloudBase,
  unclassifiedProductWhere,
  updateDocWithAlibabaLeaseInCloudBase,
  updateImageInCloudBase,
  upsertCatalogSourceObservationInCloudBase,
  upsertDocWithAlibabaLeaseInCloudBase,
  wxRemovedCount,
} from './cloudbase-adapter.ts';

test('unclassified native query includes absent families without capturing legacy headphone categories', () => {
  const query = unclassifiedProductWhere({
    and: (items) => ({ $and: items }),
    or: (items) => ({ $or: items }),
    exists: (value) => ({ $exists: value }),
    nin: (values) => ({ $nin: values }),
  });
  assert.deepEqual(query, {
    $and: [
      { productFamily: { $nin: ['headphones', 'ai-gadgets', 'toys', 'misc'] } },
      {
        $or: [
          { productFamily: { $exists: true } },
          { category: { $nin: ['wired', 'office', 'bluetooth'] } },
        ],
      },
    ],
  });
});

test('drafts waiting for photos are hidden explicitly, whether or not the field exists (PT-G)', () => {
  const query = preparingProductHiddenWhere({
    or: (items) => ({ $or: items }),
    exists: (value) => ({ $exists: value }),
    neq: (value) => ({ $ne: value }),
  });
  assert.deepEqual(query, {
    $or: [{ alibabaPhotosPending: { $exists: false } }, { alibabaPhotosPending: { $ne: true } }],
  });
});

function fakeDatabase(initial: Record<string, CollectionDoc[]>) {
  const store = new Map<string, Map<string, CollectionDoc>>(
    Object.entries(initial).map(([name, docs]) => [
      name,
      new Map(docs.map((doc) => [doc._id, structuredClone(doc)])),
    ]),
  );
  const controls = {
    failWrite: '',
    silentWrite: '',
    codedWrite: '',
    wrongUpsertId: '',
    failRemove: '',
    silentRemove: '',
    codedRemove: '',
    afterWrite: (_key: string): void => {},
    afterRead: (_key: string): void => {},
    maximumOperations: 0,
    maximumConcurrentReads: 0,
  };
  type Scope = typeof store;
  const collection = (name: string, scope: Scope = store) => ({
    doc: (id: string) => ({
      get: async () => ({ data: structuredClone(scope.get(name)?.get(id) ?? null) }),
      update: async (patch: Record<string, unknown>) => {
        if (controls.failWrite === `${name}/${id}`) throw new Error('injected write failure');
        if (controls.silentWrite === `${name}/${id}`) return { updated: 0 };
        if (controls.codedWrite === `${name}/${id}`)
          return { code: 'DATABASE_TRANSACTION_CONFLICT' };
        const docs = scope.get(name) ?? new Map<string, CollectionDoc>();
        const existing = docs.get(id);
        if (!existing) return { updated: 0 };
        docs.set(id, { ...existing, ...patch });
        scope.set(name, docs);
        return { updated: 1 };
      },
      set: async (data: Record<string, unknown>) => {
        if (controls.failWrite === `${name}/${id}`) throw new Error('injected write failure');
        if (controls.silentWrite === `${name}/${id}`) return { updated: 0 };
        if (controls.codedWrite === `${name}/${id}`)
          return { code: 'DATABASE_TRANSACTION_CONFLICT' };
        const docs = scope.get(name) ?? new Map<string, CollectionDoc>();
        const exists = docs.has(id);
        docs.set(id, { _id: id, ...data });
        scope.set(name, docs);
        controls.afterWrite(`${name}/${id}`);
        return controls.wrongUpsertId === `${name}/${id}`
          ? { upserted: [{ _id: 'wrong-id' }] }
          : exists
            ? { updated: 1 }
            : { upserted: [{ _id: id }] };
      },
      remove: async () => {
        const key = `${name}/${id}`;
        if (controls.failRemove === key) throw Error('forced remove failure');
        if (controls.silentRemove === key) return { deleted: 0 };
        if (controls.codedRemove === key) return { code: 'REMOVE_FAILED', deleted: 1 };
        const deleted = scope.get(name)?.delete(id) ? 1 : 0;
        controls.afterWrite(key);
        return { deleted };
      },
    }),
  });
  return {
    store,
    controls,
    db: {
      command: { set: (value: unknown) => value },
      runTransaction: async <T>(
        operation: (transaction: { collection: typeof collection }) => Promise<T>,
      ) => {
        const copy = structuredClone(store);
        let writing = false;
        let operations = 0;
        let activeReads = 0;
        const trackedCollection = (name: string) => ({
          doc: (id: string) => {
            const ref = collection(name, copy).doc(id);
            return {
              get: async () => {
                operations++;
                assert.equal(writing, false, 'all transaction reads precede writes');
                activeReads++;
                controls.maximumConcurrentReads = Math.max(
                  controls.maximumConcurrentReads,
                  activeReads,
                );
                try {
                  if (activeReads > 1)
                    throw Object.assign(new Error('ResourceUnavailable.TransactionBusy'), {
                      code: 'DATABASE_TRANSACTION_FAIL',
                    });
                  await new Promise((resolve) => setImmediate(resolve));
                  const result = await ref.get();
                  controls.afterRead(`${name}/${id}`);
                  return result;
                } finally {
                  activeReads--;
                }
              },
              update: async (data: Record<string, unknown>) => {
                operations++;
                writing = true;
                return ref.update(data);
              },
              set: async (data: Record<string, unknown>) => {
                operations++;
                writing = true;
                return ref.set(data);
              },
              remove: async () => {
                operations++;
                writing = true;
                return ref.remove();
              },
            };
          },
        });
        try {
          const result = await operation({ collection: trackedCollection });
          store.clear();
          for (const [name, docs] of copy) store.set(name, docs);
          return result;
        } finally {
          controls.maximumOperations = Math.max(controls.maximumOperations, operations);
        }
      },
    },
  };
}

test('production fenced upsert rejects a holder after lease takeover', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [{ _id: 'obs-1', active: false }],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 3, now: at },
  );
  assert.equal(applied, false);
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.active, false);
});

test('production fenced upsert applies for the current lease holder', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 4,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    catalogSourceObservations: [],
  });

  const applied = await upsertDocWithAlibabaLeaseInCloudBase(
    harness.db,
    'catalogSourceObservations',
    'obs-1',
    { active: true },
    { firstSeenOperationId: 'run-current' },
    { connectionId: 'primary', holder: 'current-holder', fence: 4, now: at },
  );
  assert.equal(applied, true);
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'run-current',
  );
});

test('production atomic run claim rejects a stale holder without creating an orphan run', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'new-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-old',
    { status: 'running' },
    { activeRunId: 'run-old' },
    { connectionId: 'primary', holder: 'old-holder', fence: 8, now: at },
  );
  assert.equal(result, 'lease-lost');
  assert.equal(harness.store.get('alibabaSyncRuns')?.size, 0);
  assert.equal(harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId, '');
});

test('production atomic run claim creates the run and claims its checkpoint together', async () => {
  const at = '2026-09-04T10:00:00.000Z';
  const harness = fakeDatabase({
    alibabaSyncLeases: [
      {
        _id: 'primary',
        holder: 'current-holder',
        fence: 9,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: '2026-09-04T10:03:00.000Z',
        releasedAt: '',
      },
    ],
    alibabaSyncCheckpoints: [{ _id: 'primary', activeRunId: '' }],
    alibabaSyncRuns: [],
  });

  const result = await claimAlibabaSyncRunInCloudBase(
    harness.db,
    'run-current',
    { _id: 'forged-run-id', status: 'running' },
    { _id: 'forged-checkpoint-id', activeRunId: 'run-current', stage: 'enumerate' },
    { connectionId: 'primary', holder: 'current-holder', fence: 9, now: at },
  );
  assert.equal(result, 'claimed');
  assert.deepEqual(harness.store.get('alibabaSyncRuns')?.get('run-current'), {
    _id: 'run-current',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(
    harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId,
    'run-current',
  );
});

test('production source observation upsert rejects older captures and preserves first-seen provenance', async () => {
  const harness = fakeDatabase({
    catalogSourceObservations: [
      {
        _id: 'obs-1',
        observedAt: '2026-09-04T10:00:00.000Z',
        title: 'newer',
        firstSeenOperationId: 'first-import',
      },
    ],
  });

  const stale = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T09:00:00.000Z', title: 'older' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T10:01:00.000Z',
  );
  assert.equal(stale.result, 'stale');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newer');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );

  const applied = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'obs-1',
    { observedAt: '2026-09-04T11:00:00.000Z', title: 'newest' },
    { firstSeenOperationId: 'wrong-import' },
    '2026-09-04T11:01:00.000Z',
  );
  assert.equal(applied.result, 'applied');
  assert.equal(harness.store.get('catalogSourceObservations')?.get('obs-1')?.title, 'newest');
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('obs-1')?.firstSeenOperationId,
    'first-import',
  );
});

test('a wx-server-sdk delete reports its count under stats.removed, not deleted', () => {
  // The shape wx-server-sdk 4.0.2 resolves (index.js `remove`); reading
  // `deleted` made every successful admin delete answer "not found".
  assert.equal(wxRemovedCount({ stats: { removed: 1 } }), 1);
  assert.equal(wxRemovedCount({ stats: { removed: 0 } }), 0);
  assert.equal(wxRemovedCount({ deleted: 1 } as never), 0, 'node-sdk shape is not what wx returns');
  assert.equal(wxRemovedCount(undefined), 0);
});

for (const writer of ['fenced-upsert', 'generic-upsert'] as const) {
  test(`source change atomically invalidates the linked preparation through ${writer}`, async () => {
    const at = '2026-10-13T00:00:00.000Z';
    const source = {
      _id: 'observation',
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      active: true,
      observedAt: at,
      observation: {
        source: { provider: 'alibaba', sourceProductKey: 'source-a', observedAt: at },
        identity: { title: 'Before' },
      },
    };
    const live = {
      _id: 'product',
      name: 'Website',
      alibabaPrimarySourceKey: 'source-a',
      detailSourceReady: true,
      published: true,
      productFamily: 'misc',
      catalogDetailPublication: { revision: 'old-approved' },
    };
    const harness = fakeDatabase({
      alibabaSyncLeases: [
        {
          _id: 'primary',
          holder: 'holder',
          fence: 1,
          acquiredAt: at,
          heartbeatAt: at,
          expiresAt: '2026-10-13T00:03:00.000Z',
          releasedAt: '',
        },
      ],
      catalogSourceObservations: [source],
      alibabaProductLinks: [{ _id: 'source-a', sourceKey: 'source-a', productId: 'product' }],
      products: [live],
    });
    const patch = {
      ...source,
      observation: { ...source.observation, identity: { title: 'After' } },
    };
    if (writer === 'fenced-upsert')
      await upsertDocWithAlibabaLeaseInCloudBase(
        harness.db,
        'catalogSourceObservations',
        source._id,
        patch,
        {},
        { connectionId: 'primary', holder: 'holder', fence: 1, now: at },
      );
    else await upsertCatalogSourceObservationInCloudBase(harness.db, source._id, patch, {}, at);
    const product = harness.store.get('products')?.get('product');
    assert.equal(product?.detailSourceReady, false);
    assert.equal(product?.catalogContentGeneration, 1);
    assert.equal(product?.published, true);
    assert.equal(product?.productFamily, 'misc');
    assert.deepEqual(product?.catalogDetailPublication, live.catalogDetailPublication);
  });
}

for (const writer of ['fenced-upsert', 'generic-upsert', 'fenced-tombstone'] as const) {
  for (const fault of [
    'source-failure',
    'product-failure',
    'silent-source',
    'silent-product',
  ] as const) {
    test(`source invalidation rolls back both documents: ${writer}/${fault}`, async () => {
      const at = '2026-10-13T00:00:00.000Z';
      const observation = {
        _id: 'obs',
        provider: 'alibaba',
        sourceProductKey: 'key',
        observedAt: at,
        active: true,
        observation: {
          source: { provider: 'alibaba', sourceProductKey: 'key' },
          identity: { title: 'Before' },
        },
      };
      const harness = fakeDatabase({
        alibabaSyncLeases: [
          {
            _id: 'primary',
            holder: 'holder',
            fence: 1,
            acquiredAt: at,
            heartbeatAt: at,
            expiresAt: '2026-10-13T00:03:00.000Z',
            releasedAt: '',
          },
        ],
        catalogSourceObservations: [observation],
        alibabaProductLinks: [{ _id: 'key', sourceKey: 'key', productId: 'p' }],
        products: [
          { _id: 'p', alibabaPrimarySourceKey: 'key', detailSourceReady: true, published: true },
        ],
      });
      const before = structuredClone(harness.store);
      const target = fault.includes('source') ? 'catalogSourceObservations/obs' : 'products/p';
      if (fault.startsWith('silent')) harness.controls.silentWrite = target;
      else harness.controls.failWrite = target;
      const guard = { connectionId: 'primary', holder: 'holder', fence: 1, now: at };
      const patch = {
        ...observation,
        observation: { ...observation.observation, identity: { title: 'After' } },
      };
      const write = () =>
        writer === 'fenced-upsert'
          ? upsertDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'catalogSourceObservations',
              'obs',
              patch,
              {},
              guard,
            )
          : writer === 'fenced-tombstone'
            ? updateDocWithAlibabaLeaseInCloudBase(
                harness.db,
                'catalogSourceObservations',
                'obs',
                { active: false },
                guard,
              )
            : upsertCatalogSourceObservationInCloudBase(harness.db, 'obs', patch, {}, at);
      await assert.rejects(write(), /write failure|not confirmed/);
      assert.deepEqual(harness.store, before);
      harness.controls.failWrite = '';
      harness.controls.silentWrite = '';
      await write();
      assert.equal(harness.store.get('products')?.get('p')?.detailSourceReady, false);
      assert.ok(harness.controls.maximumOperations <= (writer === 'generic-upsert' ? 5 : 7));
    });
  }
}

test('Cloud observation recapture cannot overwrite its private binding fence', async () => {
  const at = '2026-10-14T00:00:00.000Z';
  const harness = fakeDatabase({
    catalogSourceObservations: [
      { _id: 'o', active: true, observedAt: at, catalogBindingGeneration: 3 },
    ],
  });
  const result = await upsertCatalogSourceObservationInCloudBase(
    harness.db,
    'o',
    { active: true, observedAt: at, catalogBindingGeneration: 1 },
    {},
    at,
  );
  assert.equal(result.doc.catalogBindingGeneration, 3);
  assert.equal(
    harness.store.get('catalogSourceObservations')?.get('o')?.catalogBindingGeneration,
    3,
  );
});

for (const action of ['upsert', 'update'] as const) {
  for (const failure of ['throw', 'silent'] as const) {
    test(`lease fence ${failure} prevents ${action} and releases the owner queue`, async () => {
      const at = '2026-10-14T00:00:00.000Z';
      const harness = fakeDatabase({
        alibabaSyncLeases: [
          {
            _id: 'primary',
            holder: 'owner',
            fence: 1,
            expiresAt: '2026-10-14T00:03:00.000Z',
            releasedAt: '',
          },
        ],
        alibabaSupplierOffers: [{ _id: 'offer', value: 'before' }],
      });
      const before = structuredClone(harness.store);
      if (failure === 'throw') harness.controls.failWrite = 'alibabaSyncLeases/primary';
      else harness.controls.silentWrite = 'alibabaSyncLeases/primary';
      const guard = { connectionId: 'primary', holder: 'owner', fence: 1, now: at };
      const write = () =>
        action === 'upsert'
          ? upsertDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'alibabaSupplierOffers',
              'offer',
              { value: 'after' },
              {},
              guard,
            )
          : updateDocWithAlibabaLeaseInCloudBase(
              harness.db,
              'alibabaSupplierOffers',
              'offer',
              { value: 'after' },
              guard,
            );
      await assert.rejects(write(), /write failure|not confirmed/);
      assert.deepEqual(harness.store, before);
      harness.controls.failWrite = '';
      harness.controls.silentWrite = '';
      assert.equal(await write(), true);
      assert.equal(harness.store.get('alibabaSupplierOffers')?.get('offer')?.value, 'after');
    });
  }
}

function writeAckFixture(collection: string, existing = true) {
  const at = '2026-10-14T00:00:00.000Z';
  return {
    at,
    harness: fakeDatabase({
      alibabaSyncLeases: [
        {
          _id: 'primary',
          holder: 'ack-owner',
          fence: 1,
          expiresAt: '2026-10-14T00:03:00.000Z',
          releasedAt: '',
        },
      ],
      [collection]: existing ? [{ _id: 'target', value: 'before', updatedAt: at }] : [],
    }),
    guard: { connectionId: 'primary', holder: 'ack-owner', fence: 1, now: at },
  };
}

for (const collection of [
  'alibabaSupplierOffers',
  'alibabaRawReplayManifests',
  'alibabaSyncRuns',
  'alibabaSyncCheckpoints',
]) {
  for (const action of ['create', 'upsert', 'update'] as const) {
    for (const fault of ['zero', 'coded'] as const) {
      test(`${collection} ${action} rejects ${fault} business write ACK and rolls back lease transaction`, async () => {
        const { harness, guard } = writeAckFixture(collection, action !== 'create');
        const before = structuredClone(harness.store);
        if (fault === 'zero') harness.controls.silentWrite = `${collection}/target`;
        else harness.controls.codedWrite = `${collection}/target`;
        const write = () =>
          action === 'update'
            ? updateDocWithAlibabaLeaseInCloudBase(
                harness.db,
                collection,
                'target',
                { value: 'after' },
                guard,
              )
            : upsertDocWithAlibabaLeaseInCloudBase(
                harness.db,
                collection,
                'target',
                { value: 'after' },
                {},
                guard,
              );
        if (fault === 'zero') await assert.rejects(write(), /not confirmed/);
        else
          await assert.rejects(
            write(),
            (error) =>
              typeof error === 'object' &&
              error !== null &&
              Reflect.get(error, 'code') === 'DATABASE_TRANSACTION_CONFLICT',
          );
        assert.deepEqual(harness.store, before);
        harness.controls.silentWrite = '';
        harness.controls.codedWrite = '';
        assert.equal(await write(), true);
        assert.equal(harness.store.get(collection)?.get('target')?.value, 'after');
      });
    }
  }
  test(`${collection} refuses a new row ACK naming another identity`, async () => {
    const { harness, guard } = writeAckFixture(collection, false);
    harness.controls.wrongUpsertId = `${collection}/target`;
    const before = structuredClone(harness.store);
    await assert.rejects(
      upsertDocWithAlibabaLeaseInCloudBase(
        harness.db,
        collection,
        'target',
        { value: 'after' },
        {},
        guard,
      ),
      /not confirmed/,
    );
    assert.deepEqual(harness.store, before);
  });
}

for (const target of ['alibabaSyncRuns/new-run', 'alibabaSyncCheckpoints/primary']) {
  test(`run claim cannot succeed when ${target} was not written`, async () => {
    const { harness, guard } = writeAckFixture('unused', false);
    harness.store.set(
      'alibabaSyncCheckpoints',
      new Map([['primary', { _id: 'primary', activeRunId: '' }]]),
    );
    harness.controls.silentWrite = target;
    const before = structuredClone(harness.store);
    const write = () =>
      claimAlibabaSyncRunInCloudBase(
        harness.db,
        'new-run',
        { status: 'running' },
        { activeRunId: 'new-run' },
        guard,
      );
    await assert.rejects(write(), /not confirmed/);
    assert.deepEqual(harness.store, before);
    harness.controls.silentWrite = '';
    assert.equal(await write(), 'claimed');
    assert.equal(harness.store.get('alibabaSyncRuns')?.get('new-run')?.status, 'running');
    assert.equal(
      harness.store.get('alibabaSyncCheckpoints')?.get('primary')?.activeRunId,
      'new-run',
    );
  });
}

test('an unchanged generic target succeeds without requiring a redundant write ACK', async () => {
  const { harness, guard } = writeAckFixture('alibabaSupplierOffers');
  harness.controls.silentWrite = 'alibabaSupplierOffers/target';
  const before = structuredClone(harness.store);
  assert.equal(
    await updateDocWithAlibabaLeaseInCloudBase(
      harness.db,
      'alibabaSupplierOffers',
      'target',
      { value: 'before' },
      guard,
    ),
    true,
  );
  assert.deepEqual(harness.store, before);
  assert.equal(harness.controls.maximumOperations, 2);
});

test('preparation cloud wrapper shares the transaction and confirms its deterministic write', async () => {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock' }],
  });
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'cloud-wrapper-test',
    environmentId: 'test',
    now: () => now,
  });
  const start = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.ok(start.ok && 'progress' in start);
  const replay = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.deepEqual(replay, start);
  const call = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'dispatch', actorId: 'admin', jobId: start.progress.jobId },
    now,
  );
  assert.ok(call.ok && 'call' in call);
  const claimed = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'claim', call: call.call, owner: 'worker' },
    now,
  );
  assert.ok(claimed.ok && 'lease' in claimed);
  assert.equal(claimed.progress.leaseVersion, 1);
  assert.equal(f.controls.maximumOperations, 5);
  const product = f.store.get('products')?.get('p');
  assert.ok(product);
  assert.equal(readCurrentCatalogPreparationRequest(product)?.jobId, start.progress.jobId);
  const business = Object.fromEntries(
    Object.entries(product).filter(
      ([key]) =>
        ![
          'catalogPreparationState',
          'catalogPreparationPolicy',
          'catalogPreparationRequest',
        ].includes(key),
    ),
  );
  assert.deepEqual(business, { _id: 'p', name: 'Clock' });
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const) {
  test(`preparation cloud wrapper rejects ${failure} and rolls back the transaction`, async () => {
    const f = fakeDatabase({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [{ _id: 'p', name: 'Clock' }],
    });
    const now = 1792080000000;
    const authority = createCatalogPreparationAuthority({
      secret: 'cloud-wrapper-test',
      environmentId: 'test',
      now: () => now,
    });
    const started = await manageCatalogPreparationJobInCloudBase(
      f.db,
      authority,
      { action: 'start', actorId: 'admin', productId: 'p' },
      now,
    );
    assert.ok(started.ok && 'progress' in started);
    const jobId = started.progress.jobId;
    const before = structuredClone(f.store);
    if (failure === 'wrongUpsertId') {
      f.store.get('catalogPreparationJobs')?.delete(jobId);
      f.controls.wrongUpsertId = `catalogPreparationJobs/${jobId}`;
      const empty = structuredClone(f.store);
      await assert.rejects(
        manageCatalogPreparationJobInCloudBase(
          f.db,
          authority,
          { action: 'start', actorId: 'admin', productId: 'p' },
          now,
        ),
      );
      assert.deepEqual(f.store, empty);
    } else {
      f.controls[failure] = `catalogPreparationJobs/${jobId}`;
      await assert.rejects(
        manageCatalogPreparationJobInCloudBase(
          f.db,
          authority,
          { action: 'cancel', actorId: 'admin', jobId, expectedLeaseVersion: 0 },
          now,
        ),
      );
      assert.deepEqual(f.store, before);
    }
  });
}

test('preparation cloud transaction callback uses a fresh clock after queue delay and retry', async (t) => {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock' }],
  });
  let clock = 1792080000000;
  t.mock.method(Date, 'now', () => clock);
  const authority = createCatalogPreparationAuthority({
    secret: 'cloud-wrapper-test',
    environmentId: 'test',
    now: () => clock,
  });
  const db = {
    runTransaction: async <T>(operation: Parameters<typeof f.db.runTransaction<T>>[0]) => {
      const before = structuredClone(f.store);
      clock += 6000;
      await f.db.runTransaction(operation);
      f.store.clear();
      for (const [name, rows] of before) f.store.set(name, rows);
      clock += 6000;
      return f.db.runTransaction(operation);
    },
  };
  const result = await manageCatalogPreparationJobInCloudBase(db, authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  assert.ok(result.ok && 'progress' in result);
  assert.equal(result.progress.createdAt, new Date(clock).toISOString());
  assert.equal(f.store.get('catalogPreparationJobs')?.size, 1);
});

async function observationCloudFixture(withSource = false) {
  const image: CollectionDoc = {
    _id: 'image',
    status: 'active',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://test/image.png',
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  };
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        imageIds: ['image'],
        ...(withSource ? { alibabaPrimarySourceKey: 'source' } : {}),
      },
    ],
    ...(withSource
      ? { alibabaSourceProducts: [{ _id: 'source', sourceTitle: 'Source clock' }] }
      : {}),
    images: [image],
  });
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'observation-wrapper-test',
    environmentId: 'test',
    now: () => now,
  });
  const started = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.ok(started.ok && 'progress' in started);
  const jobId = started.progress.jobId;
  const call = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'dispatch', actorId: 'admin', jobId },
    now,
  );
  assert.ok(call.ok && 'call' in call);
  const claimed = await manageCatalogPreparationJobInCloudBase(
    f.db,
    authority,
    { action: 'claim', call: call.call, owner: 'worker' },
    now,
  );
  assert.ok(claimed.ok && 'lease' in claimed);
  const imageInputDigest = storedCatalogImageInputDigest(image);
  const command = {
    action: 'put-image-check' as const,
    jobId,
    lease: claimed.lease,
    imageId: 'image',
    imageInputDigest,
    health: {
      status: 'verified' as const,
      kind: 'stored-image-health-v1' as const,
      imageId: 'image',
      inputDigest: imageInputDigest,
      byteSize: 123,
      checksumSha256: 'a'.repeat(64),
      width: 24,
      height: 16,
      pages: 1,
    },
  };
  const put = () => manageCatalogPreparationJobInCloudBase(f.db, authority, command, now);
  return { ...f, put, jobId, authority, command, now };
}
test('cloud observation transaction reads before both fenced writes and fits its operation budget', async () => {
  const f = await observationCloudFixture();
  const saved = await f.put();
  assert.ok(saved.ok && 'observation' in saved && saved.observation);
  assert.equal(f.controls.maximumOperations, 6);
  assert.equal(f.store.get('catalogPreparationJobs')?.get(f.jobId)?.mutationRevision, 2);
  assert.equal(f.store.get('catalogImageObservations')?.size, 1);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const) {
  test(`cloud ${failure} on observation write rolls back its prior job fence as well`, async () => {
    const f = await observationCloudFixture();
    const before = structuredClone(f.store);
    const saved = await f.put();
    assert.ok(saved.ok && 'observation' in saved && saved.observation);
    const id = saved.observation._id;
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${id}`;
    await assert.rejects(f.put());
    assert.deepEqual(f.store, before);
  });
}

test('source-backed image observation remains bounded to nine actual transaction operations', async () => {
  const f = await observationCloudFixture(true);
  const saved = await f.put();
  assert.ok(saved.ok && 'observation' in saved && saved.observation);
  assert.equal(f.controls.maximumOperations, 9);
});

test('cloud media cursor and observation commit together within nine source-backed operations', async () => {
  const f = await observationCloudFixture(true);
  const planDigest = 'b'.repeat(64);
  const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, f.authority, command, f.now);
  assert.ok(
    (
      await run({
        action: 'bind-media-plan',
        jobId: f.jobId,
        lease: f.command.lease,
        planDigest,
        total: 1,
      })
    ).ok,
  );
  const step = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
  const result = await run(step);
  assert.ok(result.ok && 'media' in result);
  assert.equal(result.media.cursor, 1);
  assert.equal(f.controls.maximumOperations, 9);
  const before = structuredClone(f.store);
  assert.deepEqual(await run(step), result);
  assert.deepEqual(f.store, before);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`cloud ${failure} rolls back both media cursor and observation`, async () => {
    const f = await observationCloudFixture(true);
    const planDigest = 'b'.repeat(64);
    const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
      manageCatalogPreparationJobInCloudBase(f.db, f.authority, command, f.now);
    await run({
      action: 'bind-media-plan',
      jobId: f.jobId,
      lease: f.command.lease,
      planDigest,
      total: 1,
    });
    const before = structuredClone(f.store);
    const step = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
    assert.ok((await run(step)).ok);
    const observationId = f.store.get('catalogImageObservations')?.keys().next().value;
    assert.equal(typeof observationId, 'string');
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${observationId}`;
    await assert.rejects(run(step));
    assert.deepEqual(f.store, before);
  });

async function protectionCloudFixture() {
  const f = await observationCloudFixture(true);
  const run = (cmd: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, f.authority, cmd, f.now);
  const scope = { jobId: f.jobId, lease: f.command.lease };
  const begun = await run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: f.command.imageInputDigest,
  });
  assert.ok(begun.ok && 'protection' in begun);
  const intent = begun.protection;
  const path = catalogProtectedStoragePath(
    `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
    'original.png',
  );
  const target = {
    storageProvider: 'cloudbase-storage' as const,
    storageMode: 'classic-nosql-storage' as const,
    storageFileId: `cloud://test/${path}`,
    storagePath: path,
    byteSize: 123,
  };
  const checkpoint = () =>
    run({
      action: 'checkpoint-image-protection',
      ...scope,
      imageId: 'image',
      intentId: intent._id,
      target,
    });
  const image = f.store.get('images')?.get('image');
  assert.ok(image);
  const health = {
    ...f.command.health,
    inputDigest: storedCatalogImageInputDigest({ ...image, ...target }),
  };
  const commit = () =>
    run({
      action: 'commit-image-protection',
      ...scope,
      imageId: 'image',
      intentId: intent._id,
      health,
    });
  return { ...f, run, scope, intent, target, checkpoint, commit };
}
test('source-backed protection reserves and commits with ten read-before-write operations, preserving counters', async () => {
  const f = await protectionCloudFixture();
  assert.equal(f.controls.maximumOperations, 10);
  assert.ok((await f.checkpoint()).ok);
  const before = structuredClone(f.store.get('products'));
  const committed = await f.commit();
  assert.ok(committed.ok && 'protection' in committed);
  assert.equal(committed.protection.state, 'committed');
  assert.equal(f.controls.maximumOperations, 10);
  assert.equal(f.store.get('images')?.get('image')?.storageFileId, f.target.storageFileId);
  assert.deepEqual(f.store.get('products'), before);
  const snapshot = structuredClone(f.store);
  assert.deepEqual(await f.commit(), committed);
  assert.deepEqual(f.store, snapshot);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const child of ['catalogImageObservations', 'images'] as const)
    test(`cloud protection ${failure} on ${child} rolls back target, journal and job fence`, async () => {
      const f = await protectionCloudFixture();
      await f.checkpoint();
      const before = structuredClone(f.store);
      f.controls[failure] = `${child}/${child === 'images' ? 'image' : f.intent._id}`;
      await assert.rejects(f.commit());
      assert.deepEqual(f.store, before);
    });

async function protectedPixelCloudFixture() {
  const f = await protectionCloudFixture();
  await f.checkpoint();
  assert.ok((await f.commit()).ok);
  const image = f.store.get('images')?.get('image');
  assert.ok(image);
  const health = { ...f.command.health, inputDigest: storedCatalogImageInputDigest(image) };
  const planDigest = 'e'.repeat(64);
  assert.ok((await f.run({ action: 'bind-media-plan', ...f.scope, planDigest, total: 1 })).ok);
  const step = {
    action: 'advance-media-check' as const,
    ...f.scope,
    planDigest,
    index: 0,
    imageId: 'image',
    imageInputDigest: health.inputDigest,
    health,
  };
  return { ...f, health, step };
}
test('protected source-backed pixel receipt, observation and cursor share twelve read-before-write operations', async () => {
  const f = await protectedPixelCloudFixture();
  assert.ok((await f.run(f.step)).ok);
  assert.equal(f.controls.maximumOperations, 12);
  const before = structuredClone(f.store);
  assert.deepEqual(
    await f.run({ action: 'get-protected-image-health', ...f.scope, imageId: 'image' }),
    { ok: true, protectedHealth: f.health },
  );
  assert.deepEqual(f.store, before);
  assert.ok((await f.run(f.step)).ok);
  assert.deepEqual(f.store, before);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`pixel receipt ${failure} rolls back job, observation and cursor`, async () => {
    const f = await protectedPixelCloudFixture();
    const before = structuredClone(f.store);
    assert.ok((await f.run(f.step)).ok);
    const cache = [...(f.store.get('catalogImageObservations')?.values() ?? [])].find(
      (r) => r.kind === 'catalog-protected-image-health-v1',
    );
    assert.ok(cache);
    f.store.clear();
    for (const [name, rows] of before) f.store.set(name, rows);
    f.controls[failure] = `catalogImageObservations/${cache._id}`;
    await assert.rejects(f.run(f.step));
    assert.deepEqual(f.store, before);
  });

async function leasedSourceCloudFixture() {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        published: false,
        productFamily: 'misc',
        alibabaPrimarySourceKey: 'source',
      },
    ],
    alibabaSourceProducts: [{ _id: 'source', sourceTitle: 'Source clock' }],
    images: [
      {
        _id: 'existing',
        status: 'active',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://test/existing.png',
        mimeType: 'image/png',
        byteSize: 123,
        checksumSha256: 'a'.repeat(64),
        publishedRefCount: 0,
      },
    ],
  });
  let clock = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'leased-source-cloud',
    environmentId: 'test',
    now: () => clock,
  });
  const run = (cmd: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, authority, cmd, clock);
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId: s.progress.jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'source-worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId: s.progress.jobId, lease: c.lease };
  const base = {
    sourceUrl: 'https://sc04.alicdn.com/leased-source.png',
    operationId: 'source-operation',
    imageId: 'source-image',
    now: new Date(clock).toISOString(),
  };
  const source = (
    command: Extract<Parameters<typeof run>[0], { action: 'manage-source-media' }>['command'],
  ) => run({ action: 'manage-source-media', ...scope, command });
  const target = {
    storageProvider: 'cloudbase-storage' as const,
    storageMode: 'classic-nosql-storage' as const,
    storageFileId: 'cloud://test/leased-source.png',
    storagePath: 'leased-source.png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    mimeType: 'image/png' as const,
    name: 'Source photo',
  };
  return {
    ...f,
    authority,
    run,
    scope,
    base,
    source,
    target,
    get now() {
      return clock;
    },
    set now(v: number) {
      clock = v;
    },
  };
}
test('source claim/checkpoint/activation and job fence remain ten source-backed operations', async () => {
  const f = await leasedSourceCloudFixture();
  const product = structuredClone(f.store.get('products'));
  assert.deepEqual(await f.source({ ...f.base, action: 'claim' }), {
    ok: true,
    sourceMedia: { status: 'claimed' },
  });
  assert.ok((await f.source({ ...f.base, action: 'checkpoint', target: f.target })).ok);
  assert.deepEqual(await f.source({ ...f.base, action: 'activate', target: f.target }), {
    ok: true,
    sourceMedia: { status: 'ready', imageId: 'source-image', deduplicated: false },
  });
  assert.equal(f.controls.maximumOperations, 10);
  assert.deepEqual(f.store.get('products'), product);
});
async function reuseSourceCloudFixture() {
  const f = await leasedSourceCloudFixture();
  assert.ok((await f.source({ ...f.base, action: 'claim' })).ok);
  assert.equal(
    await acquireImageMutationInCloudBase(f.db, 'existing', f.base.operationId, f.base.now),
    'acquired',
  );
  const reuse = () =>
    f.source({
      ...f.base,
      action: 'reuse',
      existingImageId: 'existing',
      checksumSha256: 'a'.repeat(64),
    });
  return Object.assign(f, { reuse });
}
test('source dedup performs a confirmed pending deletion in twelve operations', async () => {
  const f = await reuseSourceCloudFixture();
  assert.deepEqual(await f.reuse(), {
    ok: true,
    sourceMedia: { status: 'ready', imageId: 'existing', deduplicated: true },
  });
  assert.equal(f.store.get('images')?.has('source-image'), false);
  assert.equal(f.store.get('images')?.has('existing'), true);
  assert.equal(f.controls.maximumOperations, 12);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const child of ['catalogSourceLinks', 'catalogPreparationJobs'] as const)
    test(`leased source ${failure} on ${child} rolls back source rows and job`, async () => {
      const f = await leasedSourceCloudFixture();
      const before = structuredClone(f.store);
      const id =
        child === 'catalogSourceLinks'
          ? sourceMediaLinkId('alibaba', f.base.sourceUrl)
          : f.scope.jobId;
      f.controls[failure] = `${child}/${id}`;
      await assert.rejects(f.source({ ...f.base, action: 'claim' }));
      assert.deepEqual(f.store, before);
    });
for (const failure of ['failRemove', 'silentRemove', 'codedRemove'] as const)
  test(`source dedup ${failure} rolls back link, pending image and job`, async () => {
    const f = await reuseSourceCloudFixture();
    const before = structuredClone(f.store);
    f.controls[failure] = 'images/source-image';
    await assert.rejects(f.reuse());
    assert.deepEqual(f.store, before);
  });
test('lease expiry after a source image write rolls back that write and never commits its URL', async () => {
  const f = await leasedSourceCloudFixture();
  const before = structuredClone(f.store);
  let written = false;
  f.controls.afterWrite = (key) => {
    if (key === 'images/source-image') {
      written = true;
      f.now += 120000;
    }
  };
  await assert.rejects(f.source({ ...f.base, action: 'claim' }), /lease/i);
  assert.equal(written, true);
  assert.deepEqual(f.store, before);
});
test('lease expiry after pending deletion rolls back all dedup writes', async () => {
  const f = await reuseSourceCloudFixture();
  const before = structuredClone(f.store);
  let deleted = false;
  f.controls.afterWrite = (key) => {
    if (key === 'images/source-image') {
      deleted = true;
      f.now += 120000;
    }
  };
  await assert.rejects(f.reuse(), /lease/i);
  assert.equal(deleted, true);
  assert.deepEqual(f.store, before);
});

for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`completed source lock ${failure} rolls back image cleanup and job fence`, async () => {
    const f = await reuseSourceCloudFixture();
    assert.ok((await f.reuse()).ok);
    assert.equal(
      await acquireImageMutationInCloudBase(f.db, 'existing', f.base.operationId, f.base.now),
      'acquired',
    );
    const before = structuredClone(f.store);
    f.controls[failure] = 'images/existing';
    await assert.rejects(
      f.source({ ...f.base, action: 'claim', operationId: 'next', imageId: 'unused' }),
    );
    assert.deepEqual(f.store, before);
  });
test('completed source cleanup expiring after the actual write rolls back, then recovers on a current lease', async () => {
  const f = await reuseSourceCloudFixture();
  assert.ok((await f.reuse()).ok);
  assert.equal(
    await acquireImageMutationInCloudBase(f.db, 'existing', f.base.operationId, f.base.now),
    'acquired',
  );
  const before = structuredClone(f.store);
  const current = f.now;
  let cleaned = false;
  f.controls.afterWrite = (key) => {
    if (key === 'images/existing') {
      cleaned = true;
      f.now += 120000;
    }
  };
  const claim = { ...f.base, action: 'claim' as const, operationId: 'next', imageId: 'unused' };
  await assert.rejects(f.source(claim), /lease/i);
  assert.ok(cleaned);
  assert.deepEqual(f.store, before);
  f.controls.afterWrite = () => {};
  f.now = current;
  assert.deepEqual(await f.source(claim), {
    ok: true,
    sourceMedia: { status: 'ready', imageId: 'existing', deduplicated: true },
  });
  const image = f.store.get('images')?.get('existing');
  assert.equal(image?.imageMutationOwner, '');
  assert.equal(image?.imageMutationStartedAt, '');
  assert.equal(f.store.get('images')?.has('unused'), false);
  assert.deepEqual(f.store.get('products'), before.get('products'));
  assert.deepEqual(f.store.get('catalogSourceLinks'), before.get('catalogSourceLinks'));
});

async function imageHoldCloudFixture() {
  const f = await leasedSourceCloudFixture();
  const job = readCatalogPreparationJob(
    f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
    f.scope.jobId,
    f.now,
  );
  assert.ok(job);
  const hold = catalogPreparationImageHold(job, 'source-only');
  const reserve = () =>
    f.run({ action: 'reserve-image-check', ...f.scope, imageId: 'source-only' });
  return { f, hold, reserve };
}
test('source-backed hold and same-job fence use eight read-before-write operations and do not touch images/products', async () => {
  const { f, hold, reserve } = await imageHoldCloudFixture();
  const images = structuredClone(f.store.get('images'));
  const products = structuredClone(f.store.get('products'));
  f.controls.maximumOperations = 0;
  assert.deepEqual(await reserve(), { ok: true, reservation: 'reserved' });
  assert.equal(f.controls.maximumOperations, 8);
  assert.deepEqual(f.store.get('catalogImageObservations')?.get(hold._id), hold);
  assert.deepEqual(f.store.get('images'), images);
  assert.deepEqual(f.store.get('products'), products);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const target of ['hold', 'job'] as const)
    test(`hold ${target} ${failure} rolls back both physical writes`, async () => {
      const { f, hold, reserve } = await imageHoldCloudFixture();
      const key =
        target === 'hold'
          ? `catalogImageObservations/${hold._id}`
          : `catalogPreparationJobs/${f.scope.jobId}`;
      f.controls[failure] = key;
      const before = structuredClone(f.store);
      await assert.rejects(reserve());
      assert.deepEqual(f.store, before);
      f.controls[failure] = '';
      assert.ok((await reserve()).ok);
    });
test('expiry after the hold write rolls back the partial reservation', async () => {
  const { f, hold, reserve } = await imageHoldCloudFixture();
  const before = structuredClone(f.store);
  f.controls.afterWrite = (key) => {
    if (key === `catalogImageObservations/${hold._id}`) f.now += 120001;
  };
  await assert.rejects(reserve(), /lease changed/);
  assert.deepEqual(f.store, before);
});

async function mediaSealCloudFixture() {
  const f = await protectedPixelCloudFixture();
  assert.ok((await f.run({ action: 'reserve-image-check', ...f.scope, imageId: 'image' })).ok);
  assert.ok((await f.run(f.step)).ok);
  const bind = () =>
    f.run({ action: 'bind-media-seal', ...f.scope, planDigest: f.step.planDigest });
  const attest = () =>
    f.run({
      action: 'attest-media-image',
      ...f.scope,
      planDigest: f.step.planDigest,
      index: 0,
      imageId: 'image',
    });
  return { f, bind, attest };
}
test('final protected image attestation is ten read-before-write operations without image/counter/product writes', async () => {
  const { f, bind, attest } = await mediaSealCloudFixture();
  assert.ok((await bind()).ok);
  f.controls.maximumOperations = 0;
  const images = structuredClone(f.store.get('images'));
  const products = structuredClone(f.store.get('products'));
  const result = await attest();
  assert.ok(result.ok && 'mediaSeal' in result);
  assert.equal(result.mediaSeal.cursor, 1);
  assert.equal(f.controls.maximumOperations, 10);
  assert.deepEqual(f.store.get('images'), images);
  assert.deepEqual(f.store.get('products'), products);
  const before = structuredClone(f.store);
  assert.deepEqual(await attest(), result);
  assert.deepEqual(f.store, before);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const phase of ['bind', 'attest'] as const)
    test(`media seal ${phase} ${failure} cannot advance durable proof`, async () => {
      const { f, bind, attest } = await mediaSealCloudFixture();
      if (phase === 'attest') assert.ok((await bind()).ok);
      f.controls[failure] = `catalogPreparationJobs/${f.scope.jobId}`;
      const before = structuredClone(f.store);
      await assert.rejects(phase === 'attest' ? attest() : bind());
      assert.deepEqual(f.store, before);
    });

test('expiry while reading the protected pixel receipt cannot advance attestation', async () => {
  const { f } = await mediaSealCloudFixture();
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  let clock = f.now + 5;
  const authority = createCatalogPreparationAuthority({
    secret: 'expiry-seal',
    environmentId: 'test',
    now: () => clock,
  });
  const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
    manageCatalogPreparationJobInCloudBase(f.db, authority, command, clock);
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'seal-expiry' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId: f.scope.jobId, lease: c.lease };
  assert.ok((await run({ action: 'bind-media-seal', ...scope, planDigest: f.step.planDigest })).ok);
  const cache = [...(f.store.get('catalogImageObservations')?.values() ?? [])].find(
    (r) => r.kind === 'catalog-protected-image-health-v1',
  );
  assert.ok(cache);
  f.controls.afterRead = (key) => {
    if (key === `catalogImageObservations/${cache._id}`) clock += 120001;
  };
  const before = structuredClone(f.store);
  assert.deepEqual(
    await run({
      action: 'attest-media-image',
      ...scope,
      planDigest: f.step.planDigest,
      index: 0,
      imageId: 'image',
    }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.deepEqual(f.store, before);
});

async function finishReadyCloudFixture() {
  const { f, bind, attest } = await mediaSealCloudFixture();
  assert.ok((await bind()).ok);
  const proof = await attest();
  assert.ok(proof.ok && 'mediaSeal' in proof);
  const job = readCatalogPreparationJob(
    f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
    f.scope.jobId,
    f.now,
  );
  assert.ok(job);
  const command = {
    action: 'finish-preparation' as const,
    ...f.scope,
    inputDigest: job.inputDigest,
    contentGeneration: job.contentGeneration,
    planDigest: proof.mediaSeal.planDigest,
    imageIdsDigest: proof.mediaSeal.imageIdsDigest,
    imageCount: proof.mediaSeal.total,
    previewReady: true as const,
    issues: [],
  };
  return { f, command, finish: () => f.run(command) };
}
test('source-backed atomic ready report and terminal job use seven read-before-write operations', async () => {
  const { f, finish } = await finishReadyCloudFixture();
  const before = structuredClone(f.store.get('images'));
  const productBefore = structuredClone(f.store.get('products')?.get('p'));
  f.controls.maximumOperations = 0;
  const result = await finish();
  assert.ok(result.ok && 'preparation' in result, JSON.stringify(result));
  assert.equal(result.preparation, 'ready');
  assert.equal(f.controls.maximumOperations, 7);
  assert.deepEqual(f.store.get('images'), before);
  assert.equal(f.store.get('products')?.get('p')?.published, productBefore?.published);
  assert.equal(f.store.get('catalogPreparationJobs')?.get(f.scope.jobId)?.state, 'completed');
  const saved = structuredClone(f.store);
  assert.ok((await finish()).ok);
  assert.deepEqual(f.store, saved);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const target of ['products', 'catalogPreparationJobs'] as const)
    test(`atomic ready ${target} ${failure} rolls back both rows and safely retries`, async () => {
      const { f, finish } = await finishReadyCloudFixture();
      const productId = f.store.get('catalogPreparationJobs')?.get(f.scope.jobId)?.productId;
      assert.equal(typeof productId, 'string');
      f.controls[failure] = `${target}/${target === 'products' ? productId : f.scope.jobId}`;
      const before = structuredClone(f.store);
      await assert.rejects(finish());
      assert.deepEqual(f.store, before);
      f.controls[failure] = '';
      assert.ok((await finish()).ok);
    });
for (const target of ['products', 'catalogPreparationJobs'] as const)
  test(`lease expiry after ${target} write rolls back the entire ready transaction`, async () => {
    const { f } = await finishReadyCloudFixture();
    assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
    let now = f.now + 5;
    const authority = createCatalogPreparationAuthority({
      secret: 'ready-expiry',
      environmentId: 'test',
      now: () => now,
    });
    const run = (command: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
      manageCatalogPreparationJobInCloudBase(f.db, authority, command, now);
    const d = await run({ action: 'dispatch', actorId: 'admin', jobId: f.scope.jobId });
    assert.ok(d.ok && 'call' in d);
    const c = await run({ action: 'claim', call: d.call, owner: 'ready-worker' });
    assert.ok(c.ok && 'lease' in c);
    const job = readCatalogPreparationJob(
      f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
      f.scope.jobId,
      now,
    );
    assert.ok(job);
    const proof = job.mediaSeal;
    assert.ok(proof);
    const command = {
      action: 'finish-preparation' as const,
      jobId: f.scope.jobId,
      lease: c.lease,
      inputDigest: job.inputDigest,
      contentGeneration: job.contentGeneration,
      planDigest: proof.planDigest,
      imageIdsDigest: proof.imageIdsDigest,
      imageCount: proof.total,
      previewReady: true as const,
      issues: [],
    };
    const before = structuredClone(f.store);
    f.controls.afterWrite = (key) => {
      if (key === `${target}/${target === 'products' ? job.productId : f.scope.jobId}`)
        now += 120001;
    };
    await assert.rejects(run(command), /lease changed/);
    assert.deepEqual(f.store, before);
  });
for (const [collection, patch] of [
  ['products', { name: 'Edited' }],
  ['alibabaSourceProducts', { sourceTitle: 'Edited source' }],
  ['catalogSourceObservations', { evidenceId: 'different-capture' }],
  ['alibabaProductLinks', { productId: 'other' }],
] as const)
  test(`final ready rechecks actual ${collection} state after attestation`, async () => {
    const { f, finish } = await finishReadyCloudFixture();
    let row = f.store.get(collection)?.values().next().value;
    if (!row) {
      const id =
        collection === 'catalogSourceObservations'
          ? sourceObservationDocumentId('alibaba', 'source')
          : 'source';
      row = { _id: id };
      f.store.set(collection, new Map([[id, row]]));
    }
    Object.assign(row, patch);
    const product = structuredClone(f.store.get('products'));
    const result = await finish();
    assert.ok(!result.ok && result.code === 'STALE', JSON.stringify(result));
    assert.deepEqual(f.store.get('products'), product);
  });

async function completedClaimCloudFixture() {
  const { f, finish } = await finishReadyCloudFixture();
  assert.ok((await finish()).ok);
  const job = readCatalogPreparationJob(
    f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
    f.scope.jobId,
    f.now,
  );
  assert.ok(job);
  const call = f.authority.issueCall({ jobId: f.scope.jobId, nonce: job.nonce });
  const command = { action: 'claim' as const, call, owner: 'new-worker' };
  return { f, job, command, claim: () => f.run(command) };
}
test('source-backed completed claim is five point reads and zero writes or new lease', async () => {
  const { f, claim } = await completedClaimCloudFixture();
  const before = structuredClone(f.store);
  f.controls.maximumOperations = 0;
  const result = await claim();
  assert.ok(result.ok && 'preparation' in result, JSON.stringify(result));
  assert.equal(result.preparation, 'unchanged');
  assert.equal(f.controls.maximumOperations, 5);
  assert.deepEqual(f.store, before);
});
for (const patch of [{ sourceTitle: 'New source' }, null] as const)
  test('completed claim refuses changed or missing source without rewriting terminal state', async () => {
    const { f, claim } = await completedClaimCloudFixture();
    const source = f.store.get('alibabaSourceProducts')?.get('source');
    assert.ok(source);
    if (patch) Object.assign(source, patch);
    else f.store.get('alibabaSourceProducts')?.delete('source');
    const before = structuredClone(f.store);
    assert.deepEqual(await claim(), { ok: false, code: 'STALE' });
    assert.deepEqual(f.store, before);
  });
test('completed native claim rechecks signed admission after asynchronous reads', async () => {
  const { f, job } = await completedClaimCloudFixture();
  let now = f.now + 5;
  const authority = createCatalogPreparationAuthority({
    secret: 'completed-expiry',
    environmentId: 'test',
    now: () => now,
  });
  const call = authority.issueCall({ jobId: job._id, nonce: job.nonce });
  f.controls.afterRead = (key) => {
    if (key === 'products/p') now += 30001;
  };
  const before = structuredClone(f.store);
  assert.deepEqual(
    await manageCatalogPreparationJobInCloudBase(
      f.db,
      authority,
      { action: 'claim', call, owner: 'replacement' },
      now,
    ),
    { ok: false, code: 'FORBIDDEN' },
  );
  assert.deepEqual(f.store, before);
});

async function nonreadyCloudFixture(invalid = false) {
  const f = await protectedPixelCloudFixture();
  assert.ok(
    (
      await f.run({
        ...f.step,
        health: invalid ? { status: 'invalid', reason: 'content' } : f.step.health,
      })
    ).ok,
  );
  const command = {
    action: 'checkpoint-preparation' as const,
    ...f.scope,
    previewReady: true,
    issues: [],
  };
  return { f, command, checkpoint: () => f.run(command) };
}
test('source-backed nonready diagnostic and same-job fence use seven point operations without image or lifecycle writes', async () => {
  const { f, checkpoint } = await nonreadyCloudFixture(true);
  const before = structuredClone(f.store.get('images'));
  const product = structuredClone(f.store.get('products')?.get('p'));
  f.controls.maximumOperations = 0;
  const r = await checkpoint();
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.equal(r.report.state, 'blocked');
  assert.equal(f.controls.maximumOperations, 7);
  assert.deepEqual(f.store.get('images'), before);
  assert.deepEqual(f.store.get('products')?.get('p'), {
    ...product,
    catalogPreparationState: 'blocked',
    catalogPreparationPolicy: r.report.policyVersion,
    catalogPreparationReport: r.report,
  });
  const saved = structuredClone(f.store);
  assert.ok((await checkpoint()).ok);
  assert.deepEqual(f.store, saved);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const target of ['products', 'catalogPreparationJobs'] as const)
    test(`nonready checkpoint ${target} ${failure} rolls back both diagnostic and fence`, async () => {
      const { f, checkpoint } = await nonreadyCloudFixture();
      f.controls[failure] = `${target}/${target === 'products' ? 'p' : f.scope.jobId}`;
      const before = structuredClone(f.store);
      await assert.rejects(checkpoint());
      assert.deepEqual(f.store, before);
    });
for (const target of ['products', 'catalogPreparationJobs'] as const)
  test(`checkpoint expiry after ${target} write rolls back both rows`, async () => {
    const { f } = await nonreadyCloudFixture();
    assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
    let now = f.now + 5;
    const authority = createCatalogPreparationAuthority({
      secret: 'checkpoint-expiry',
      environmentId: 'test',
      now: () => now,
    });
    const run = (cmd: Parameters<typeof manageCatalogPreparationJobInCloudBase>[2]) =>
      manageCatalogPreparationJobInCloudBase(f.db, authority, cmd, now);
    const d = await run({ action: 'dispatch', actorId: 'admin', jobId: f.scope.jobId });
    assert.ok(d.ok && 'call' in d);
    const c = await run({ action: 'claim', call: d.call, owner: 'checkpoint-worker' });
    assert.ok(c.ok && 'lease' in c);
    const before = structuredClone(f.store);
    f.controls.afterWrite = (key) => {
      if (key === `${target}/${target === 'products' ? 'p' : f.scope.jobId}`) now += 120001;
    };
    await assert.rejects(
      run({
        action: 'checkpoint-preparation',
        jobId: f.scope.jobId,
        lease: c.lease,
        previewReady: true,
        issues: [],
      }),
      /lease changed/,
    );
    assert.deepEqual(f.store, before);
  });

async function cancelDiagnosticCloudFixture() {
  const { f, checkpoint } = await nonreadyCloudFixture();
  assert.ok((await checkpoint()).ok);
  const job = readCatalogPreparationJob(
    f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
    f.scope.jobId,
    f.now,
  );
  assert.ok(job);
  const command = {
    action: 'cancel' as const,
    actorId: 'admin',
    jobId: f.scope.jobId,
    expectedLeaseVersion: job.leaseVersion,
  };
  return { f, cancel: () => f.run(command) };
}
test('source-backed cancellation and current nonready invalidation commit together within eight operations', async () => {
  const { f, cancel } = await cancelDiagnosticCloudFixture();
  const images = structuredClone(f.store.get('images'));
  const product = f.store.get('products')?.get('p');
  assert.ok(product);
  const before = structuredClone(product);
  f.controls.maximumOperations = 0;
  const r = await cancel();
  assert.ok(r.ok && 'progress' in r);
  assert.equal(r.progress.state, 'cancelled');
  assert.equal(f.controls.maximumOperations, 8);
  assert.deepEqual(f.store.get('products')?.get('p'), {
    ...before,
    catalogPreparationState: 'stale',
  });
  assert.deepEqual(f.store.get('images'), images);
  const saved = structuredClone(f.store);
  assert.ok((await cancel()).ok);
  assert.deepEqual(f.store, saved);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const target of ['products', 'catalogPreparationJobs'] as const)
    test(`cancellation ${target} ${failure} rolls back both job and current preparation state`, async () => {
      const { f, cancel } = await cancelDiagnosticCloudFixture();
      f.controls[failure] = `${target}/${target === 'products' ? 'p' : f.scope.jobId}`;
      const before = structuredClone(f.store);
      await assert.rejects(cancel());
      assert.deepEqual(f.store, before);
    });

test('source-backed human status is six point reads and no writes or object scans', async () => {
  const { f, checkpoint } = await nonreadyCloudFixture(true);
  assert.ok((await checkpoint()).ok);
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  const before = structuredClone(f.store);
  f.controls.maximumOperations = 0;
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r, JSON.stringify(r));
  assert.equal(r.status.current, true);
  assert.equal(r.status.nextAction, 'edit');
  assert.equal(r.status.report?.state, 'blocked');
  assert.equal(f.controls.maximumOperations, 6);
  assert.deepEqual(f.store, before);
});
test('source-backed completed human status verifies the receipt in six readonly operations', async () => {
  const { f } = await completedClaimCloudFixture();
  const before = structuredClone(f.store);
  f.controls.maximumOperations = 0;
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r, JSON.stringify(r));
  assert.equal(r.status.nextAction, 'ready');
  assert.equal(f.controls.maximumOperations, 6);
  assert.deepEqual(f.store, before);
});
async function retryDiagnosticCloudFixture() {
  const { f, checkpoint } = await nonreadyCloudFixture(true);
  assert.ok((await checkpoint()).ok);
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  const job = readCatalogPreparationJob(
    f.store.get('catalogPreparationJobs')?.get(f.scope.jobId),
    f.scope.jobId,
    f.now,
  );
  assert.ok(job);
  const command = {
    action: 'retry' as const,
    actorId: 'admin',
    jobId: f.scope.jobId,
    expectedLeaseVersion: job.leaseVersion,
  };
  return { f, command, retry: () => f.run(command) };
}
test('source-backed retry and new checking request commit together within eight operations', async () => {
  const { f, retry } = await retryDiagnosticCloudFixture();
  const before = structuredClone(f.store.get('products')?.get('p'));
  const images = structuredClone(f.store.get('images'));
  f.controls.maximumOperations = 0;
  const r = await retry();
  assert.ok(r.ok && 'progress' in r, JSON.stringify(r));
  assert.equal(r.progress.state, 'queued');
  assert.equal(r.progress.media, null);
  assert.equal(f.controls.maximumOperations, 8);
  assert.deepEqual(f.store.get('products')?.get('p'), {
    ...before,
    catalogPreparationState: 'checking',
  });
  const product = f.store.get('products')?.get('p');
  assert.ok(product);
  assert.equal(readCurrentCatalogPreparationRequest(product)?.jobId, r.progress.jobId);
  assert.deepEqual(f.store.get('images'), images);
});
for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const target of ['products', 'catalogPreparationJobs'] as const)
    test(`retry ${target} ${failure} rolls back reset and diagnostic invalidation`, async () => {
      const { f, retry } = await retryDiagnosticCloudFixture();
      f.controls[failure] = `${target}/${target === 'products' ? 'p' : f.scope.jobId}`;
      const before = structuredClone(f.store);
      await assert.rejects(retry());
      assert.deepEqual(f.store, before);
    });

for (const completed of [false, true])
  for (const [collection, patch] of [
    ['products', { name: 'New user input' }],
    ['alibabaSourceProducts', { sourceTitle: 'New supplier input' }],
    ['catalogSourceObservations', { evidenceId: 'new-capture' }],
    ['alibabaProductLinks', { productId: 'other' }],
  ] as const)
    test(`human ${completed ? 'completed' : 'nonready'} status rechecks actual ${collection} and hides old proof`, async () => {
      const f = completed
        ? (await completedClaimCloudFixture()).f
        : (await nonreadyCloudFixture()).f;
      if (!completed)
        assert.ok(
          (
            await f.run({
              action: 'checkpoint-preparation',
              ...f.scope,
              previewReady: true,
              issues: [],
            })
          ).ok,
        );
      let row = f.store.get(collection)?.values().next().value;
      if (!row) {
        const id =
          collection === 'catalogSourceObservations'
            ? sourceObservationDocumentId('alibaba', 'source')
            : 'source';
        row = { _id: id };
        f.store.set(collection, new Map([[id, row]]));
      }
      Object.assign(row, patch);
      const before = structuredClone(f.store);
      const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
      assert.ok(r.ok && 'status' in r, JSON.stringify(r));
      assert.equal(r.status.current, false);
      assert.equal(r.status.nextAction, 'restart');
      assert.equal(r.status.report, null);
      assert.equal(r.status.attestation, null);
      assert.deepEqual(f.store, before);
    });

for (const withSource of [false, true])
  test(`request projection start operation budget with source=${withSource}`, async (t) => {
    const initial = {
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          published: false,
          ...(withSource ? { alibabaPrimarySourceKey: 'source' } : {}),
        },
      ],
    };
    const f = fakeDatabase(initial);
    const now = 1792080000000;
    const authority = createCatalogPreparationAuthority({
      secret: 'projection-budget',
      environmentId: 'test',
      now: () => now,
    });
    const result = await manageCatalogPreparationJobInCloudBase(
      f.db,
      authority,
      { action: 'start', actorId: 'admin', productId: 'p' },
      now,
    );
    assert.ok(result.ok && 'progress' in result);
    assert.equal(f.controls.maximumOperations, withSource ? 8 : 5);
    const before = structuredClone(f.store);
    await manageCatalogPreparationJobInCloudBase(
      f.db,
      authority,
      { action: 'start', actorId: 'admin', productId: 'p' },
      now,
    );
    assert.deepEqual(f.store, before);
    t.diagnostic(
      `Measured transaction operations: ${f.controls.maximumOperations}; reads precede both writes.`,
    );
  });

for (const phase of ['product', 'job'] as const)
  for (const failure of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
    test(`request ${phase} ${failure} rolls back product and job together`, async () => {
      const initial = {
        users: [{ _id: 'admin', role: 'admin' }],
        products: [{ _id: 'p', name: 'Clock', published: false, productFamily: 'misc' }],
      };
      const now = 1792080000000;
      const authority = createCatalogPreparationAuthority({
        secret: 'projection-rollback',
        environmentId: 'test',
        now: () => now,
      });
      const control = fakeDatabase(initial);
      const started = await manageCatalogPreparationJobInCloudBase(
        control.db,
        authority,
        { action: 'start', actorId: 'admin', productId: 'p' },
        now,
      );
      assert.ok(started.ok && 'progress' in started);
      const f = fakeDatabase(initial);
      const before = structuredClone(f.store);
      f.controls[failure] =
        phase === 'product' ? 'products/p' : `catalogPreparationJobs/${started.progress.jobId}`;
      await assert.rejects(
        manageCatalogPreparationJobInCloudBase(
          f.db,
          authority,
          { action: 'start', actorId: 'admin', productId: 'p' },
          now,
        ),
      );
      assert.deepEqual(f.store, before);
      assert.equal(f.store.get('catalogPreparationJobs')?.size ?? 0, 0);
    });

test('lost transaction ACK retains both request and job; explicit same-input retry is read-only', async () => {
  const f = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [{ _id: 'p', name: 'Clock', published: false }],
  });
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'projection-ack',
    environmentId: 'test',
    now: () => now,
  });
  let loseAck = true;
  const db = {
    runTransaction: async <T>(operation: Parameters<typeof f.db.runTransaction<T>>[0]) => {
      const value = await f.db.runTransaction(operation);
      if (loseAck) {
        loseAck = false;
        throw Error('Committed transaction ACK lost');
      }
      return value;
    },
  };
  await assert.rejects(
    manageCatalogPreparationJobInCloudBase(
      db,
      authority,
      { action: 'start', actorId: 'admin', productId: 'p' },
      now,
    ),
    /ACK lost/,
  );
  const product = f.store.get('products')?.get('p');
  assert.ok(product);
  const request = readCurrentCatalogPreparationRequest(product);
  assert.ok(request);
  assert.ok(f.store.get('catalogPreparationJobs')?.get(request.jobId));
  const before = structuredClone(f.store);
  const retried = await manageCatalogPreparationJobInCloudBase(
    db,
    authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    now,
  );
  assert.ok(retried.ok && 'progress' in retried);
  assert.equal(retried.progress.jobId, request.jobId);
  assert.deepEqual(f.store, before);
  assert.equal(f.store.get('catalogPreparationJobs')?.size, 1);
});

for (const writer of ['save', 'row'] as const)
  test(`native withdrawal barrier commits once and rolls back a failed same-state write: ${writer}`, async () => {
    const product = {
      _id: 'p',
      name: 'Clock',
      productFamily: 'misc',
      published: false,
      archived: false,
      catalogContentGeneration: 3,
      catalogLifecycleVersion: 4,
      detailSourceReady: true,
    };
    const h = fakeDatabase({ products: [product] });
    const write = () =>
      writer === 'save'
        ? saveCatalogProductInCloudBase(
            h.db,
            { mode: 'update', productId: 'p', data: { published: false } },
            '2026-10-18T00:00:00.000Z',
          )
        : mutateCatalogRowInCloudBase(
            h.db,
            { action: 'update', collection: 'products', id: 'p', data: { published: false } },
            '2026-10-18T00:00:00.000Z',
          );
    h.controls.failWrite = 'products/p';
    await assert.rejects(write(), /injected write failure/);
    assert.deepEqual(h.store.get('products')?.get('p'), product);
    h.controls.failWrite = '';
    await write();
    const saved = h.store.get('products')?.get('p');
    assert.equal(saved?.catalogLifecycleVersion, 5);
    assert.equal(saved?.catalogContentGeneration, 3);
    assert.equal(saved?.detailSourceReady, true);
    assert.equal(saved?.published, false);
    assert.ok(h.controls.maximumOperations <= 3, 'no extra read/write for the barrier');
  });

for (const mode of ['create', 'update'] as const)
  for (const fault of ['silentWrite', 'codedWrite', 'wrongUpsertId'] as const) {
    if (mode === 'update' && fault === 'wrongUpsertId') continue;
    test(`product ${mode} never returns saved after ${fault} and rolls back identity writes`, async () => {
      const initial = {
        _id: 'ack-product',
        name: 'Original',
        productFamily: 'misc',
        published: false,
        archived: false,
        updatedAt: '2026-10-18T00:00:00.000Z',
      };
      const h = fakeDatabase({ products: mode === 'update' ? [initial] : [] });
      h.controls[fault] = 'products/ack-product';
      const before = structuredClone(h.store);
      await assert.rejects(
        saveCatalogProductInCloudBase(
          h.db,
          {
            mode,
            productId: 'ack-product',
            data: {
              name: 'Reviewed',
              productFamily: 'misc',
              slug: 'ack-owned-product',
              skuCode: 'ACK-OWNED',
            },
          },
          '2026-10-18T00:00:01.000Z',
        ),
      );
      assert.deepEqual(
        h.store,
        before,
        'no product or identity can commit without its acknowledged product write',
      );
      h.controls[fault] = '';
      const retry = await saveCatalogProductInCloudBase(
        h.db,
        {
          mode,
          productId: 'ack-product',
          data: {
            name: 'Reviewed',
            productFamily: 'misc',
            slug: 'ack-owned-product',
            skuCode: 'ACK-OWNED',
          },
        },
        '2026-10-18T00:00:02.000Z',
      );
      assert.equal(retry.result, 'saved');
      assert.equal(h.store.get('products')?.get('ack-product')?.name, 'Reviewed');
    });
  }

for (const kind of ['slug', 'sku'] as const)
  for (const fault of ['silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
    test(`product identity ${kind} ${fault} cannot commit a partial rename`, async () => {
      const product = {
        _id: 'p',
        name: 'Clock',
        productFamily: 'misc',
        published: false,
        slug: 'old-owned',
        skuCode: 'old-owned',
      };
      const old = ['slug', 'sku'].map((type) => ({
        _id: `${type}:old-owned`,
        kind: type,
        normalizedValue: 'old-owned',
        productId: 'p',
      }));
      const h = fakeDatabase({ products: [product], catalogProductIdentities: old });
      const before = structuredClone(h.store);
      h.controls[fault] = `catalogProductIdentities/${kind}:new-owned`;
      await assert.rejects(
        saveCatalogProductInCloudBase(h.db, {
          mode: 'update',
          productId: 'p',
          data: { slug: 'new-owned', skuCode: 'new-owned' },
        }),
      );
      assert.deepEqual(h.store, before);
    });
for (const fault of ['failRemove', 'silentRemove', 'codedRemove'] as const)
  test(`stale product identity ${fault} rolls back the entire rename`, async () => {
    const product = {
      _id: 'p',
      name: 'Clock',
      productFamily: 'misc',
      published: false,
      slug: 'old-owned',
      skuCode: 'old-owned',
    };
    const old = ['slug', 'sku'].map((kind) => ({
      _id: `${kind}:old-owned`,
      kind,
      normalizedValue: 'old-owned',
      productId: 'p',
    }));
    const h = fakeDatabase({ products: [product], catalogProductIdentities: old });
    const before = structuredClone(h.store);
    h.controls[fault] = 'catalogProductIdentities/slug:old-owned';
    await assert.rejects(
      saveCatalogProductInCloudBase(h.db, {
        mode: 'update',
        productId: 'p',
        data: { slug: 'new-owned', skuCode: 'new-owned' },
      }),
    );
    assert.deepEqual(h.store, before);
  });
test('an already acknowledged supplier review does not issue an empty product write', async () => {
  const product = {
    _id: 'p',
    name: 'Clock',
    productFamily: 'misc',
    published: false,
    alibabaPrimarySourceKey: 'source',
    alibabaLinkRevision: 1,
    alibabaReviewPending: false,
  };
  const h = fakeDatabase({ products: [product] });
  const before = structuredClone(h.store);
  const result = await saveCatalogProductInCloudBase(h.db, {
    mode: 'update',
    productId: 'p',
    data: { alibabaReviewPending: false },
    expectedAlibabaIdentity: { revision: 1, primarySourceKey: 'source' },
  });
  assert.equal(result.result, 'saved');
  assert.deepEqual(h.store, before);
  assert.equal(h.controls.maximumOperations, 1, 'the existing no-op plan only reads the product');
});

test('an empty acknowledged review still validates requested classification authority', async () => {
  const product = {
    _id: 'p',
    name: 'Clock',
    productFamily: 'misc',
    published: false,
    updatedAt: '2026-10-18T00:00:00.000Z',
    alibabaPrimarySourceKey: 'source',
    alibabaLinkRevision: 1,
    alibabaReviewPending: false,
  };
  const h = fakeDatabase({ products: [product], users: [{ _id: 'guest', role: 'member' }] });
  const before = structuredClone(h.store);
  const result = await saveCatalogProductInCloudBase(h.db, {
    mode: 'update',
    productId: 'p',
    data: { alibabaReviewPending: false },
    expectedAlibabaIdentity: { revision: 1, primarySourceKey: 'source' },
    expectedClassification: {
      productUpdatedAt: product.updatedAt,
      taxonomyRevision: 0,
      actorId: 'guest',
    },
  });
  assert.equal(result.result, 'invalid-product');
  assert.deepEqual(h.store, before);
});

test('unchanged review preserves an explicitly requested valid classification fence', async () => {
  const product = {
    _id: 'p',
    name: 'Clock',
    productFamily: 'misc',
    published: false,
    updatedAt: '2026-10-18T00:00:00.000Z',
    alibabaPrimarySourceKey: 'source',
    alibabaLinkRevision: 1,
    alibabaReviewPending: false,
  };
  const h = fakeDatabase({ products: [product], users: [{ _id: 'admin', role: 'admin' }] });
  const result = await saveCatalogProductInCloudBase(h.db, {
    mode: 'update',
    productId: 'p',
    data: { alibabaReviewPending: false },
    expectedAlibabaIdentity: { revision: 1, primarySourceKey: 'source' },
    expectedClassification: {
      productUpdatedAt: product.updatedAt,
      taxonomyRevision: 0,
      actorId: 'admin',
    },
  });
  assert.equal(result.result, 'saved');
  assert.equal(typeof h.store.get('users')?.get('admin')?.classificationAuthFence, 'string');
  assert.deepEqual(h.store.get('products')?.get('p'), product);
});

async function ownDraftFixture(
  patch: Record<string, unknown> = {},
  intent: 'save-draft' | 'publish' = 'save-draft',
  extra: Record<string, CollectionDoc[]> = {},
) {
  const product = {
    _id: 'p',
    name: 'Clock',
    description: '',
    productFamily: 'misc',
    published: false,
    archived: false,
    imageIds: [],
    slug: 'old-clock',
    skuCode: 'old-clock',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  const h = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [product],
    catalogProductIdentities: ['slug', 'sku'].map((kind) => ({
      _id: `${kind}:old-clock`,
      kind,
      normalizedValue: 'old-clock',
      productId: 'p',
    })),
    ...extra,
  });
  const operationId = '12345678-1234-4234-8234-123456789012';
  const started = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-start',
    productId: 'p',
    operationId,
    intent,
    expectedUpdatedAt: product.updatedAt,
    values: {
      description: 'Reviewed own draft',
      slug: 'new-clock',
      skuCode: 'new-clock',
      ...patch,
    },
  });
  assert.ok(started.ok && 'record' in started);
  const input = {
    mode: 'update' as const,
    productId: 'p',
    data: structuredClone(started.record.operation.values),
    expectedUpdatedAt: product.updatedAt,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: started.record.operation.inputDigest,
    },
  };
  return { ...h, input, record: started.record };
}

test('native product, aliases and own save receipt commit together; replay is readonly', async () => {
  const h = await ownDraftFixture();
  const result = await saveCatalogProductInCloudBase(h.db, h.input);
  assert.equal(result.result, 'saved');
  const saved = h.store.get('catalogDetailApprovals')?.get(h.record._id);
  assert.equal(saved?.state, 'saved');
  assert.ok(saved?.operation && typeof saved.operation === 'object');
  assert.deepEqual(Reflect.get(saved.operation, 'base'), h.record.operation.base);
  assert.equal(h.store.get('products')?.get('p')?.description, 'Reviewed own draft');
  assert.deepEqual([...(h.store.get('catalogProductIdentities')?.keys() ?? [])].sort(), [
    'sku:new-clock',
    'slug:new-clock',
  ]);
  const snapshot = structuredClone(h.store);
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  assert.deepEqual(h.store, snapshot);
  const query = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-get',
    productId: 'p',
    operationId: h.input.expectedOperation.operationId,
  });
  assert.ok(query.ok && 'record' in query && query.current);
  assert.equal(query.record.state, 'saved');
  assert.ok(h.controls.maximumOperations <= 13, 'sample uses bounded existing per-document writes');
});

test('native owned save verifies 27 held photos once even with 500 configuration choices', async () => {
  const ids = Array.from({ length: 27 }, (_, n) => `photo-${n}`);
  const h = await ownDraftFixture(
    {
      imageIds: ids.slice(0, 9),
      descriptionImageIds: ids.slice(9),
      configurationPhotos: Object.fromEntries(
        Array.from({ length: 500 }, (_, n) => [`variant-${n}`, ids.slice(0, 9)]),
      ),
    },
    'save-draft',
    {
      images: ids.map((_id) => ({
        _id,
        status: 'active',
      })),
    },
  );
  const scope = {
    productId: h.input.productId,
    operationId: h.input.expectedOperation.operationId,
    inputDigest: h.input.expectedOperation.inputDigest,
  };
  const claim = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-photo-claim',
    ...scope,
  });
  assert.ok(claim.ok && 'record' in claim, JSON.stringify(claim));
  assert.ok(h.controls.maximumOperations <= 100);
  const owner = h.record._id;
  h.controls.maximumOperations = 0;
  const reads: string[] = [];
  h.controls.afterRead = (key) => {
    reads.push(key);
  };
  const result = await saveCatalogProductInCloudBase(h.db, {
    ...h.input,
    expectedImageMutationOwner: owner,
  });
  assert.equal(result.result, 'saved');
  assert.deepEqual(
    reads.filter((key) => key.startsWith('images/')).sort(),
    ids.map((id) => `images/${id}`).sort(),
  );
  assert.ok(
    h.controls.maximumOperations <= 40,
    `observed ${h.controls.maximumOperations} transaction document operations`,
  );
  assert.equal(h.store.get('catalogDetailApprovals')?.get(h.record._id)?.state, 'saved');
  assert.equal(h.store.get('products')?.get('p')?.published, false);
  assert.equal(JSON.stringify(h.store.get('products')?.get('p')).includes(owner), false);
  const released = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-photo-release',
    ...scope,
  });
  assert.ok(released.ok, JSON.stringify(released));
  assert.ok(h.controls.maximumOperations <= 100);
  for (const id of ids) assert.equal(h.store.get('images')?.get(id)?.imageMutationOwner, '');
});

for (const fault of [
  'missing-owner',
  'wrong-owner',
  'expired',
  'missing-image',
  'inactive',
] as const)
  test(`native owned photo admission fails closed without writing product or receipt: ${fault}`, async () => {
    const h = await ownDraftFixture({ imageIds: ['new-photo'] }, 'save-draft', {
      images: [{ _id: 'new-photo', status: 'active' }],
    });
    const claimed = await persistStagedApprovalInCloud(h.db, 'admin', {
      action: 'operation-photo-claim',
      productId: h.input.productId,
      operationId: h.input.expectedOperation.operationId,
      inputDigest: h.input.expectedOperation.inputDigest,
    });
    assert.ok(claimed.ok, JSON.stringify(claimed));
    const owner = h.record._id;
    const image = h.store.get('images')?.get('new-photo');
    assert.ok(image);
    if (fault === 'wrong-owner') image.imageMutationOwner = 'other-owner';
    if (fault === 'expired')
      image.imageMutationStartedAt = new Date(Date.now() - 3600000).toISOString();
    if (fault === 'missing-image') h.store.get('images')?.delete('new-photo');
    if (fault === 'inactive') image.status = 'deleted';
    const before = structuredClone(h.store);
    const result = await saveCatalogProductInCloudBase(h.db, {
      ...h.input,
      ...(fault === 'missing-owner' ? {} : { expectedImageMutationOwner: owner }),
    });
    assert.notEqual(result.result, 'saved');
    assert.deepEqual(h.store, before);
  });

for (const phase of ['claim', 'release'] as const)
  for (const target of ['image', 'root'] as const)
    for (const ack of ['failWrite', 'silentWrite', 'codedWrite'] as const)
      test(`native photo ${phase} ${target} ${ack} rolls back the entire phase and can retry`, async () => {
        const h = await ownDraftFixture({ imageIds: ['new-photo'] }, 'save-draft', {
          images: [{ _id: 'new-photo', status: 'active', data: 'legacy bytes stay unchanged' }],
        });
        const scope = {
          productId: h.input.productId,
          operationId: h.input.expectedOperation.operationId,
          inputDigest: h.input.expectedOperation.inputDigest,
        };
        if (phase === 'release') {
          assert.ok(
            (
              await persistStagedApprovalInCloud(h.db, 'admin', {
                action: 'operation-photo-claim',
                ...scope,
              })
            ).ok,
          );
          assert.equal(
            (
              await saveCatalogProductInCloudBase(h.db, {
                ...h.input,
                expectedImageMutationOwner: h.record._id,
              })
            ).result,
            'saved',
          );
        }
        const command = {
          action:
            phase === 'claim'
              ? ('operation-photo-claim' as const)
              : ('operation-photo-release' as const),
          ...scope,
        };
        const before = structuredClone(h.store);
        h.controls[ack] =
          target === 'image' ? 'images/new-photo' : `catalogDetailApprovals/${h.record._id}`;
        await assert.rejects(persistStagedApprovalInCloud(h.db, 'admin', command));
        assert.deepEqual(h.store, before);
        h.controls[ack] = '';
        assert.ok((await persistStagedApprovalInCloud(h.db, 'admin', command)).ok);
        assert.equal(h.store.get('images')?.get('new-photo')?.data, 'legacy bytes stay unchanged');
        assert.ok(h.controls.maximumOperations <= 100);
      });

for (const point of ['receipt', 'product', 'new-identity', 'old-identity'] as const)
  for (const failure of ['throw', 'zero', 'coded', 'wrong-upsert'] as const) {
    if (failure === 'wrong-upsert' && (point === 'product' || point === 'old-identity')) continue;
    test(`native own draft ${point} ${failure} rolls back all stages and can retry`, async () => {
      const h = await ownDraftFixture();
      const key =
        point === 'receipt'
          ? `catalogDetailApprovals/${h.record._id}`
          : point === 'product'
            ? 'products/p'
            : point === 'new-identity'
              ? 'catalogProductIdentities/slug:new-clock'
              : 'catalogProductIdentities/slug:old-clock';
      const control =
        point === 'old-identity'
          ? failure === 'throw'
            ? 'failRemove'
            : failure === 'zero'
              ? 'silentRemove'
              : 'codedRemove'
          : failure === 'throw'
            ? 'failWrite'
            : failure === 'zero'
              ? 'silentWrite'
              : failure === 'coded'
                ? 'codedWrite'
                : 'wrongUpsertId';
      const before = structuredClone(h.store);
      h.controls[control] = key;
      await assert.rejects(saveCatalogProductInCloudBase(h.db, h.input));
      assert.deepEqual(
        h.store,
        before,
        'product, old/new aliases and reserved receipt stay unchanged',
      );
      h.controls[control] = '';
      assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
      assert.equal(h.store.get('catalogDetailApprovals')?.get(h.record._id)?.state, 'saved');
    });
  }

test('native bound save freezes the entire patch and binding before the first storage read', async () => {
  const h = await ownDraftFixture();
  const input = structuredClone(h.input);
  const promise = saveCatalogProductInCloudBase(h.db, input);
  input.data.description = 'Caller changed after dispatch';
  input.expectedOperation.inputDigest = '0'.repeat(64);
  assert.equal((await promise).result, 'saved');
  assert.equal(h.store.get('products')?.get('p')?.description, 'Reviewed own draft');
  assert.equal(h.store.get('catalogDetailApprovals')?.get(h.record._id)?.state, 'saved');
});

test('native identity conflict leaves the operation reserved without product or alias changes', async () => {
  const h = await ownDraftFixture();
  h.store.get('catalogProductIdentities')?.set('sku:new-clock', {
    _id: 'sku:new-clock',
    kind: 'sku',
    normalizedValue: 'new-clock',
    productId: 'other',
  });
  const before = structuredClone(h.store);
  const result = await saveCatalogProductInCloudBase(h.db, h.input);
  assert.equal(result.result, 'conflict');
  assert.deepEqual(h.store, before);
  h.store.get('catalogProductIdentities')?.delete('sku:new-clock');
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
});
for (const saved of [false, true])
  test(`a revoked actor cannot resume its ${saved ? 'saved' : 'reserved'} native operation`, async () => {
    const h = await ownDraftFixture();
    if (saved) assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
    h.store.get('users')?.set('admin', { _id: 'admin', role: 'admin', status: 'suspended' });
    const before = structuredClone(h.store);
    assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'stale');
    assert.deepEqual(h.store, before);
  });

for (const [field, value] of [
  ['name', 'n'.repeat(1001)],
  ['description', 'd'.repeat(30001)],
] as const)
  test(`native own save exposes the ${field} validation issue without writes`, async () => {
    const h = await ownDraftFixture({ [field]: value });
    const before = structuredClone(h.store);
    const result = await saveCatalogProductInCloudBase(h.db, h.input);
    assert.equal(result.result, 'invalid-product');
    assert.ok(
      result.result === 'invalid-product' && result.issues.some((issue) => issue.field === field),
    );
    assert.deepEqual(h.store, before);
  });

for (const [index, description] of [
  '',
  '   ',
  '  Reviewed note  ',
  '\nReviewed note\n',
  'd'.repeat(30000),
  `  ${'d'.repeat(30000)}  `,
].entries())
  test(`native normal description ${index} can save without changing editor text`, async () => {
    const h = await ownDraftFixture({ description });
    assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
    assert.equal(h.store.get('products')?.get('p')?.description, description);
    assert.equal(h.store.get('catalogDetailApprovals')?.get(h.record._id)?.state, 'saved');
  });

test('a lost transaction commit answer is recovered through the own receipt with zero duplicate writes', async () => {
  const h = await ownDraftFixture();
  let loseAnswer = true;
  const uncertain = {
    ...h.db,
    runTransaction: async <T>(operation: Parameters<typeof h.db.runTransaction<T>>[0]) => {
      const result = await h.db.runTransaction(operation);
      if (loseAnswer) {
        loseAnswer = false;
        throw new Error('injected lost answer after transaction committed');
      }
      return result;
    },
  };
  await assert.rejects(
    saveCatalogProductInCloudBase(uncertain, h.input),
    /after transaction committed/,
  );
  assert.equal(h.store.get('products')?.get('p')?.catalogContentGeneration, 1);
  assert.equal(h.store.get('catalogDetailApprovals')?.get(h.record._id)?.state, 'saved');
  const before = structuredClone(h.store);
  const query = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-get',
    productId: 'p',
    operationId: h.input.expectedOperation.operationId,
  });
  assert.ok(query.ok && 'record' in query && query.current && query.revisionCurrent);
  assert.equal(query.record.state, 'saved');
  assert.equal((await saveCatalogProductInCloudBase(uncertain, h.input)).result, 'saved');
  assert.deepEqual(h.store, before);
});

test('native unchanged own draft save fences an older unfinished approval without resetting ready source', async () => {
  const h = await ownDraftFixture({ description: '', slug: 'old-clock', skuCode: 'old-clock' });
  const product = h.store.get('products')?.get('p');
  assert.ok(product);
  Object.assign(product, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
  });
  const older = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(older.ok);
  assert.equal(
    (await persistStagedApprovalInCloud(h.db, 'admin', { action: 'begin', prepared: older.value }))
      .ok,
    true,
  );
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  const saved = h.store.get('products')?.get('p');
  assert.equal(saved?.catalogLifecycleVersion, 1);
  assert.equal(saved?.catalogContentGeneration ?? 0, 0);
  assert.equal(saved?.detailSourceReady, true);
  const before = structuredClone(h.store);
  assert.deepEqual(
    await persistStagedApprovalInCloud(h.db, 'admin', { action: 'finish', jobId: older.value._id }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  assert.deepEqual(h.store, before);
});

for (const afterOwnSave of [false, true])
  test(`native save refuses another completed approval with the same row timestamp: saved=${afterOwnSave}`, async () => {
    const h = await ownDraftFixture({ description: '', slug: 'old-clock', skuCode: 'old-clock' });
    const product = h.store.get('products')?.get('p');
    assert.ok(product);
    Object.assign(product, {
      detailSourceReady: true,
      detailSourceOwner: 'owned-source',
      detailSourceRevision: 'source-r1',
      detailSourceContentGeneration: 0,
      detailSourceManifest: { revision: 'source-r1', variantIds: [] },
      detailSourceCandidate: {
        _id: 'p',
        name: 'Clock',
        schemaVersion: 'catalog-product-detail-v1',
        images: [],
        facts: [],
        offers: [],
      },
    });
    if (afterOwnSave)
      assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
    const current = h.store.get('products')?.get('p');
    assert.ok(current);
    const prepared = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedRevision: null,
        expectedDigest: catalogApprovalDigest(current, []),
      },
      current,
      [],
    );
    assert.ok(prepared.ok);
    assert.equal(
      (
        await persistStagedApprovalInCloud(h.db, 'admin', {
          action: 'begin',
          prepared: prepared.value,
        })
      ).ok,
      true,
    );
    const done = await persistStagedApprovalInCloud(h.db, 'admin', {
      action: 'finish',
      jobId: prepared.value._id,
    });
    assert.ok(done.ok && 'complete' in done && done.complete);
    const before = structuredClone(h.store);
    const query = await persistStagedApprovalInCloud(h.db, 'admin', {
      action: 'operation-get',
      productId: 'p',
      operationId: h.input.expectedOperation.operationId,
    });
    assert.ok(query.ok && 'record' in query);
    assert.equal(query.current, false);
    assert.equal(query.revisionCurrent, true);
    assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'stale');
    assert.deepEqual(h.store, before);
  });

test('native publish intent saves its own source-bound draft with all reads before writes', async () => {
  const h = fakeDatabase({
    users: [{ _id: 'admin', role: 'admin' }],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        description: '',
        productFamily: 'misc',
        published: false,
        archived: false,
        updatedAt: '2026-10-18T00:00:00.000Z',
        alibabaPrimarySourceKey: 's',
        alibabaLinkRevision: 1,
      },
    ],
    alibabaSourceProducts: [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        sourceCategoryId: '100',
        contentHash: 'a'.repeat(64),
        active: true,
      },
    ],
    alibabaProductLinks: [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        productId: 'p',
        linkedAt: '2026-10-18T00:00:00.000Z',
      },
    ],
    catalogSourceObservations: [],
  });
  const command = {
    action: 'operation-start' as const,
    productId: 'p',
    operationId: '12345678-1234-4234-8234-123456789012',
    intent: 'publish' as const,
    expectedUpdatedAt: '2026-10-18T00:00:00.000Z',
    values: { description: 'Own publish draft' },
  };
  const begun = await persistStagedApprovalInCloud(h.db, 'admin', command);
  assert.ok(begun.ok && 'record' in begun);
  const input = {
    mode: 'update' as const,
    productId: 'p',
    data: command.values,
    expectedUpdatedAt: command.expectedUpdatedAt,
    expectedOperation: {
      actorId: 'admin',
      operationId: command.operationId,
      inputDigest: begun.record.operation.inputDigest,
    },
  };
  assert.equal((await saveCatalogProductInCloudBase(h.db, input)).result, 'saved');
  const status = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-get',
    productId: 'p',
    operationId: command.operationId,
  });
  assert.ok(status.ok && 'record' in status && status.current && status.revisionCurrent);
  assert.equal(status.record.state, 'saved');
  if (status.record.state !== 'saved') return;
  assert.deepEqual(status.record.saved.snapshot.source, begun.record.operation.base.source);
  assert.ok(status.record.saved.snapshot.source);
  const product = h.store.get('products')?.get('p');
  assert.equal(product?.published, false);
  assert.equal(product?.catalogDetailPublication, undefined);
  assert.equal(product?.catalogDetailApprovalReceipt, undefined);
  const before = structuredClone(h.store);
  assert.equal((await saveCatalogProductInCloudBase(h.db, input)).result, 'saved');
  assert.deepEqual(h.store, before);
  assert.ok(h.controls.maximumOperations <= 16);
});

async function nativeLinkedPublishFixture() {
  return ownDraftFixture({}, 'publish', {
    products: [
      {
        _id: 'p',
        name: 'Clock',
        description: '',
        productFamily: 'misc',
        published: false,
        archived: false,
        updatedAt: '2026-10-18T00:00:00.000Z',
        slug: 'old-clock',
        skuCode: 'old-clock',
        alibabaPrimarySourceKey: 's',
        alibabaLinkRevision: 1,
      },
    ],
    alibabaSourceProducts: [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        sourceCategoryId: '100',
        contentHash: 'a'.repeat(64),
        active: true,
      },
    ],
    alibabaProductLinks: [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        productId: 'p',
        linkedAt: '2026-10-18T00:00:00.000Z',
      },
    ],
    catalogSourceObservations: [
      {
        _id: sourceObservationDocumentId('alibaba', 's'),
        sourceContentHash: 'a'.repeat(64),
        observation: {
          source: {
            provider: 'alibaba',
            sourceProductKey: 's',
            externalProductId: 'ext',
            observedAt: '2026-10-18T00:00:00.000Z',
          },
          attributes: [{ name: 'Size', value: '10' }],
        },
      },
    ],
  });
}
for (const afterSave of [false, true])
  for (const collection of [
    'alibabaSourceProducts',
    'catalogSourceObservations',
    'alibabaProductLinks',
  ])
    test(`native publish draft refuses changed ${collection} before any write: saved=${afterSave}`, async () => {
      const h = await nativeLinkedPublishFixture();
      if (afterSave)
        assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
      const row = [...(h.store.get(collection)?.values() ?? [])][0];
      assert.ok(row);
      if (collection === 'alibabaSourceProducts') row.sourceCategoryId = '200';
      else if (collection === 'catalogSourceObservations') row.sourceContentHash = 'b'.repeat(64);
      else row.productId = 'another-product';
      const before = structuredClone(h.store);
      assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'stale');
      assert.deepEqual(h.store, before);
    });
test('native publish draft permits capture metadata, keeps source hashes and replays without writes', async () => {
  const h = await nativeLinkedPublishFixture();
  const source = h.store.get('alibabaSourceProducts')?.get('s');
  const link = h.store.get('alibabaProductLinks')?.get('s');
  assert.ok(source && link);
  source.lastSeenAt = '2026-10-18T00:01:00.000Z';
  link.updatedAt = '2026-10-18T00:01:00.000Z';
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  const status = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-get',
    productId: 'p',
    operationId: h.input.expectedOperation.operationId,
  });
  assert.ok(status.ok && 'record' in status && status.current);
  assert.equal(status.record.state, 'saved');
  if (status.record.state !== 'saved') return;
  assert.deepEqual(status.record.saved.snapshot.source, h.record.operation.base.source);
  const before = structuredClone(h.store);
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  assert.deepEqual(h.store, before);
  assert.ok(h.controls.maximumOperations <= 16);
});
for (const mode of ['silentWrite', 'failWrite'] as const)
  test(`native publish draft rolls back its product aliases and source-bound receipt on ${mode}`, async () => {
    const h = await nativeLinkedPublishFixture();
    const before = structuredClone(h.store);
    h.controls[mode] = `catalogDetailApprovals/${h.record._id}`;
    await assert.rejects(saveCatalogProductInCloudBase(h.db, h.input));
    assert.deepEqual(h.store, before);
    h.controls[mode] = '';
    assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
    assert.equal(h.store.get('products')?.get('p')?.published, false);
    assert.ok(h.controls.maximumOperations <= 16);
  });

function pauseApprovalTransaction(h: ReturnType<typeof fakeDatabase>) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    db: {
      ...h.db,
      runTransaction: async <T>(operation: Parameters<typeof h.db.runTransaction<T>>[0]) => {
        await gate;
        return h.db.runTransaction(operation);
      },
    },
  };
}
for (const intent of ['save-draft', 'publish'] as const)
  test(`native operation reservation captures nested input before transaction startup: ${intent}`, async () => {
    const h = fakeDatabase({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          description: '',
          productFamily: 'misc',
          published: false,
          archived: false,
          updatedAt: '2026-10-18T00:00:00.000Z',
        },
      ],
    });
    const paused = pauseApprovalTransaction(h);
    const command = {
      action: 'operation-start' as const,
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      intent,
      expectedUpdatedAt: '2026-10-18T00:00:00.000Z',
      values: {
        description: 'Original submitted draft',
        configurationPhotos: { sku: ['original-image'] },
      },
    };
    const pending = persistStagedApprovalInCloud(paused.db, 'admin', command);
    command.values.description = 'Changed after dispatch';
    command.values.configurationPhotos.sku[0] = 'changed-image';
    paused.release();
    const result = await pending;
    assert.ok(result.ok && 'record' in result);
    assert.equal(result.record.operation.values.description, 'Original submitted draft');
    assert.deepEqual(result.record.operation.values.configurationPhotos, {
      sku: ['original-image'],
    });
  });
test('native operation-get captures its selector before transaction startup', async () => {
  const h = await ownDraftFixture();
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const second = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-start',
    productId: 'p',
    operationId: otherId,
    intent: 'save-draft',
    expectedUpdatedAt: h.input.expectedUpdatedAt ?? null,
    values: { description: 'Another selected job' },
  });
  assert.ok(second.ok && 'record' in second);
  const paused = pauseApprovalTransaction(h);
  const command = {
    action: 'operation-get' as const,
    productId: 'p',
    operationId: h.input.expectedOperation.operationId,
  };
  const pending = persistStagedApprovalInCloud(paused.db, 'admin', command);
  command.operationId = otherId;
  paused.release();
  const result = await pending;
  assert.ok(result.ok && 'record' in result);
  assert.deepEqual(result.record, h.record);
});
test('native legacy begin captures the reviewed approval before transaction startup', async () => {
  const h = await ownDraftFixture();
  const product = h.store.get('products')?.get('p');
  assert.ok(product);
  Object.assign(product, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
  });
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(prepared.ok);
  const reviewed = structuredClone(prepared.value);
  const paused = pauseApprovalTransaction(h);
  const pending = persistStagedApprovalInCloud(paused.db, 'admin', {
    action: 'begin',
    prepared: prepared.value,
  });
  prepared.value.publication.header.name = 'Changed after dispatch';
  paused.release();
  assert.equal((await pending).ok, true);
  assert.deepEqual(h.store.get('catalogDetailApprovals')?.get(reviewed._id), reviewed);
});

for (const [label, value] of [
  ['function', () => 'unsupported'],
  ['symbol', Symbol('unsupported')],
  ['weak-map', new WeakMap<object, unknown>()],
] as const)
  test(`native unclonable ${label} command refuses before opening a transaction`, async () => {
    const h = fakeDatabase({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        { _id: 'p', name: 'Clock', published: false, updatedAt: '2026-10-18T00:00:00.000Z' },
      ],
    });
    let starts = 0;
    const tracked = {
      ...h.db,
      runTransaction: async <T>(operation: Parameters<typeof h.db.runTransaction<T>>[0]) => {
        starts++;
        return h.db.runTransaction(operation);
      },
    };
    const before = structuredClone(h.store);
    const result = await persistStagedApprovalInCloud(tracked, 'admin', {
      action: 'operation-start',
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      intent: 'save-draft',
      expectedUpdatedAt: '2026-10-18T00:00:00.000Z',
      values: { description: value },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.equal(result.validation?.issues[0]?.remedy, 'reload');
    assert.equal(starts, 0);
    assert.deepEqual(h.store, before);
  });
test('native capture keeps all facts of a legal UTF-8 approval larger than the start-command budget', async () => {
  const h = await ownDraftFixture();
  const product = h.store.get('products')?.get('p');
  assert.ok(product);
  const facts = Array.from({ length: 256 }, (_, i) => ({
    name: `Fact ${i}`,
    value: '中'.repeat(600),
  }));
  Object.assign(product, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts,
      offers: [],
    },
  });
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(prepared.ok);
  const reviewed = structuredClone(prepared.value);
  const bytes = Buffer.byteLength(JSON.stringify(reviewed));
  assert.ok(bytes > 256 * 1024 && bytes < 512 * 1024);
  const paused = pauseApprovalTransaction(h);
  const pending = persistStagedApprovalInCloud(paused.db, 'admin', {
    action: 'begin',
    prepared: prepared.value,
  });
  const first = prepared.value.publication.header.facts[0];
  assert.ok(first);
  first.value = 'Changed after dispatch';
  paused.release();
  assert.equal((await pending).ok, true);
  assert.deepEqual(h.store.get('catalogDetailApprovals')?.get(reviewed._id), reviewed);
});

async function nativeOwnApprovalFixture(variantCount = 0, linked = false) {
  const variants: CollectionDoc[] = Array.from({ length: variantCount }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    position,
    sku: `sku-${position}`,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceMissing: false,
    imageIds: [],
    optionValues: { Color: String(position) },
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const source: Record<string, CollectionDoc[]> = linked
    ? {
        alibabaSourceProducts: [
          {
            _id: 's',
            sourceKey: 's',
            connectionId: 'c',
            sourceProductId: 'ext',
            contentHash: 'a'.repeat(64),
            active: true,
          },
        ],
        catalogSourceObservations: [],
        alibabaProductLinks: [
          {
            _id: 's',
            sourceKey: 's',
            connectionId: 'c',
            sourceProductId: 'ext',
            productId: 'p',
            linkedAt: '2026-10-18T00:00:00.000Z',
          },
        ],
      }
    : {};
  const h = await ownDraftFixture({}, 'publish', {
    ...source,
    productVariants: variants,
    catalogDetailVariants: [],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        description: 'Reviewed own draft',
        slug: 'new-clock',
        skuCode: 'new-clock',
        productFamily: 'misc',
        published: false,
        archived: false,
        imageIds: [],
        updatedAt: '2026-10-18T00:00:00.000Z',
        ...(linked ? { alibabaPrimarySourceKey: 's', alibabaLinkRevision: 1 } : {}),
        detailSourceReady: true,
        detailSourceOwner: 'owned-source',
        detailSourceRevision: 'r1',
        detailSourceContentGeneration: 0,
        detailSourceManifest: { revision: 'r1', variantIds: variants.map((row) => row._id) },
        detailSourceCandidate: {
          _id: 'p',
          name: 'Clock',
          schemaVersion: 'catalog-product-detail-v1',
          images: [],
          facts: [],
          offers: [],
        },
      },
    ],
  });
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  const product = h.store.get('products')?.get('p');
  assert.ok(product);
  const plan = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: h.record.operationId,
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    product,
    variants,
  );
  assert.ok(plan.ok, JSON.stringify(plan));
  const command = {
    action: 'operation-approval-begin' as const,
    productId: 'p',
    operationId: h.record.operationId,
    inputDigest: h.record.operation.inputDigest,
    prepared: plan.value,
  };
  return { ...h, command };
}
test('native own approval saves its cursor in the original root; get and saved-draft retries perform no writes', async () => {
  const h = await nativeOwnApprovalFixture();
  const begun = await persistStagedApprovalInCloud(h.db, 'admin', h.command);
  assert.ok(begun.ok && 'record' in begun, JSON.stringify(begun));
  assert.equal(begun.record.state, 'staging');
  assert.equal(begun.current, true);
  assert.equal(h.store.get('catalogDetailApprovals')?.size, 1);
  const before = structuredClone(h.store);
  const get = await persistStagedApprovalInCloud(h.db, 'admin', {
    action: 'operation-get',
    productId: 'p',
    operationId: h.record.operationId,
  });
  assert.deepEqual(get, begun);
  assert.equal((await saveCatalogProductInCloudBase(h.db, h.input)).result, 'saved');
  assert.deepEqual(await persistStagedApprovalInCloud(h.db, 'admin', h.command), begun);
  assert.deepEqual(h.store, before);
  assert.ok(h.controls.maximumOperations <= 10);
  assert.equal(h.store.get('products')?.get('p')?.published, false);
});
for (const mode of ['silentWrite', 'codedWrite', 'failWrite'] as const)
  test(`native own approval refuses ${mode} without a partially written cursor`, async () => {
    const h = await nativeOwnApprovalFixture();
    const before = structuredClone(h.store);
    h.controls[mode] = `catalogDetailApprovals/${h.record._id}`;
    await assert.rejects(persistStagedApprovalInCloud(h.db, 'admin', h.command));
    assert.deepEqual(h.store, before);
  });

test('native own page advances only its cursor with47operations, keeps all reads before writes and publishes nothing', async () => {
  const h = await nativeOwnApprovalFixture(21, true);
  const begun = await persistStagedApprovalInCloud(h.db, 'admin', h.command);
  assert.ok(begun.ok && 'record' in begun);
  const page = {
    action: 'operation-approval-page' as const,
    productId: 'p',
    operationId: h.record.operationId,
    inputDigest: h.record.operation.inputDigest,
    page: 0,
  };
  const product = structuredClone(h.store.get('products')?.get('p'));
  const first = await persistStagedApprovalInCloud(h.db, 'admin', page);
  assert.ok(first.ok && 'record' in first, JSON.stringify(first));
  assert.ok(first.record.state === 'staging');
  assert.equal(first.record.nextPage, 1);
  assert.equal(h.store.get('catalogDetailVariants')?.size, 20);
  assert.equal(h.controls.maximumOperations, 47);
  assert.deepEqual(h.store.get('products')?.get('p'), product);
  const before = structuredClone(h.store);
  let writes = 0;
  h.controls.afterWrite = () => {
    writes++;
  };
  assert.deepEqual(await persistStagedApprovalInCloud(h.db, 'admin', page), first);
  assert.equal(writes, 0);
  assert.deepEqual(h.store, before);
  const last = await persistStagedApprovalInCloud(h.db, 'admin', { ...page, page: 1 });
  assert.ok(last.ok && 'record' in last && last.record.state === 'staging');
  assert.equal(last.record.nextPage, 2);
  assert.equal(h.store.get('catalogDetailVariants')?.size, 21);
  assert.equal(h.store.get('products')?.get('p')?.published, false);
  assert.equal(h.store.get('products')?.get('p')?.catalogDetailApprovalReceipt, undefined);
});
for (const mode of ['silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  for (const where of ['first', 'last', 'root'] as const)
    test(`native own page rolls back20snapshots and cursor on ${mode}/${where}`, async () => {
      const h = await nativeOwnApprovalFixture(21, true);
      assert.equal((await persistStagedApprovalInCloud(h.db, 'admin', h.command)).ok, true);
      const target =
        where === 'root'
          ? `catalogDetailApprovals/${h.record._id}`
          : `catalogDetailVariants/${approvedVariantDocumentId('p', h.command.prepared.revision, where === 'first' ? 'v0' : 'v19')}`;
      h.controls[mode] = target;
      const before = structuredClone(h.store);
      const page = {
        action: 'operation-approval-page' as const,
        productId: 'p',
        operationId: h.record.operationId,
        inputDigest: h.record.operation.inputDigest,
        page: 0,
      };
      await assert.rejects(persistStagedApprovalInCloud(h.db, 'admin', page));
      assert.deepEqual(h.store, before);
      h.controls[mode] = '';
      const retried = await persistStagedApprovalInCloud(h.db, 'admin', page);
      assert.ok(retried.ok && 'record' in retried && retried.record.state === 'staging');
      assert.equal(retried.record.nextPage, 1);
      assert.equal(h.store.get('catalogDetailVariants')?.size, 20);
      assert.equal(h.controls.maximumOperations, 47);
    });

for (const delta of [-1, 1])
  test(`native old ${delta} reference adjustment uses one acknowledged transaction write`, async () => {
    const plan = buildCatalogImageReferencePlan(
      '1'.repeat(64),
      delta === -1 ? [] : ['image'],
      delta === -1 ? ['image'] : [],
    );
    const h = fakeDatabase({
      images: [
        {
          _id: 'image',
          publishedRefCount: delta === -1 ? 0 : 1,
          imageMutationOwner: 'preserve',
          catalogPublishedReferenceLedger: {
            version: 'catalog-image-reference-ledger-v1',
            epoch: 4,
            pending: [catalogImageReferenceEntry(plan, 0)],
          },
        },
      ],
      catalogDetailApprovals: [plan.proof],
    });
    assert.equal(
      await incrementCatalogImageReferenceInCloudBase(h.db, { imageId: 'image', delta }),
      delta === -1 ? 0 : 1,
    );
    assert.equal(h.controls.maximumOperations, 3);
    const image = h.store.get('images')?.get('image');
    assert.ok(image);
    assert.equal(image.publishedRefCount, delta === -1 ? 0 : 1);
    assert.equal(image.imageMutationOwner, 'preserve');
    assert.deepEqual(image.catalogPublishedReferenceLedger, {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 5,
      pending: [],
    });
    assert.deepEqual(h.store.get('catalogDetailApprovals')?.get(plan.proof._id), plan.proof);
  });
for (const fault of ['failWrite', 'silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`native old reference adjustment rolls back ${fault}`, async () => {
    const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], ['image']);
    const h = fakeDatabase({
      images: [
        {
          _id: 'image',
          publishedRefCount: 0,
          catalogPublishedReferenceLedger: {
            version: 'catalog-image-reference-ledger-v1',
            epoch: 4,
            pending: [catalogImageReferenceEntry(plan, 0)],
          },
        },
      ],
      catalogDetailApprovals: [plan.proof],
    });
    const before = structuredClone(h.store);
    h.controls[fault] = 'images/image';
    await assert.rejects(
      incrementCatalogImageReferenceInCloudBase(h.db, { imageId: 'image', delta: 1 }),
    );
    assert.deepEqual(h.store, before);
    h.controls[fault] = '';
    assert.equal(
      await incrementCatalogImageReferenceInCloudBase(h.db, { imageId: 'image', delta: 1 }),
      2,
    );
  });
test('native invalid reference delta is refused before starting a transaction', () => {
  const h = fakeDatabase({ images: [] });
  assert.throws(() =>
    incrementCatalogImageReferenceInCloudBase(h.db, { imageId: 'image', delta: 0.5 }),
  );
  assert.equal(h.controls.maximumOperations, 0);
});

function deletionReferenceFixture(base: number, delta: 1 | -1, committed = true) {
  const plan = buildCatalogImageReferencePlan(
    '1'.repeat(64),
    delta === -1 ? ['image'] : [],
    delta === 1 ? ['image'] : [],
  );
  return fakeDatabase({
    images: [
      {
        _id: 'image',
        status: 'active',
        uploadedByUserId: 'u',
        publishedRefCount: base,
        imageMutationOwner: 'op',
        imageMutationStartedAt: '2026-10-18T00:00:00.000Z',
        storageProvider: 'local-disk',
        storageFileId: 'local://one',
        catalogPublishedReferenceLedger: {
          version: 'catalog-image-reference-ledger-v1',
          epoch: 4,
          pending: [catalogImageReferenceEntry(plan, 0)],
        },
      },
    ],
    catalogDetailApprovals: committed ? [plan.proof] : [],
  });
}
const referenceDeletionBegin = {
  action: 'begin',
  imageId: 'image',
  uploadedByUserId: 'u',
  owner: 'op',
  startedAt: '2026-10-18T00:00:00.000Z',
} as const;
for (const mode of ['public', 'removed', 'unresolved'] as const)
  test(`native deletion checks complete reference state ${mode}`, async () => {
    const h = deletionReferenceFixture(
      mode === 'removed' ? 1 : 0,
      mode === 'removed' ? -1 : 1,
      mode !== 'unresolved',
    );
    const before = structuredClone(h.store);
    const result = await manageImageDeletionInCloudBase(h.db, referenceDeletionBegin);
    assert.equal(result.status, mode === 'removed' ? 'ready' : 'conflict');
    if (mode === 'removed') {
      // Image + committed removal proof + confirmed image write; repeated proof reads share the snapshot.
      assert.equal(h.controls.maximumOperations, 3);
      const image = h.store.get('images')?.get('image');
      assert.ok(image);
      assert.equal(image.status, 'deleted');
      assert.equal(image.publishedRefCount, 0);
      assert.deepEqual(image.catalogPublishedReferenceLedger, {
        version: 'catalog-image-reference-ledger-v1',
        epoch: 5,
        pending: [],
      });
    } else assert.deepEqual(h.store, before);
  });
for (const fault of ['silentWrite', 'codedWrite', 'wrongUpsertId'] as const)
  test(`native deletion reference quarantine rolls back ${fault}`, async () => {
    const h = deletionReferenceFixture(1, -1);
    const before = structuredClone(h.store);
    h.controls[fault] = 'images/image';
    await assert.rejects(manageImageDeletionInCloudBase(h.db, referenceDeletionBegin));
    assert.deepEqual(h.store, before);
    h.controls[fault] = '';
    assert.equal(
      (await manageImageDeletionInCloudBase(h.db, referenceDeletionBegin)).status,
      'ready',
    );
  });
test('native deletion captures the original owner/image command before asynchronous transaction startup', async () => {
  const h = deletionReferenceFixture(1, -1);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database: typeof h.db = {
    ...h.db,
    runTransaction: async (operation) => {
      await gate;
      return h.db.runTransaction(operation);
    },
  };
  const command: Parameters<typeof manageImageDeletionInCloudBase>[1] = {
    ...referenceDeletionBegin,
  };
  const pending = manageImageDeletionInCloudBase(database, command);
  command.imageId = 'other';
  command.owner = 'other';
  command.uploadedByUserId = 'other';
  release();
  assert.equal((await pending).status, 'ready');
  assert.equal(h.store.get('images')?.get('image')?.status, 'deleted');
});

for (const action of ['claim', 'checkpoint'] as const)
  test(`native source ${action} captures nested input before asynchronous SDK startup`, async () => {
    const h = fakeDatabase({ images: [], catalogSourceLinks: [] });
    const base = {
      sourceUrl: 'https://sc04.alicdn.com/capture.png',
      operationId: 'source-op',
      imageId: 'source-image',
      now: '2026-10-18T00:00:00.000Z',
    };
    if (action === 'checkpoint')
      assert.equal(
        (await manageSourceMediaImportInCloudBase(h.db, { ...base, action: 'claim' })).status,
        'claimed',
      );
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const database: typeof h.db = {
      ...h.db,
      runTransaction: async (operation) => {
        await gate;
        return h.db.runTransaction(operation);
      },
    };
    const command: Parameters<typeof manageSourceMediaImportInCloudBase>[1] =
      action === 'claim'
        ? { ...base, action: 'claim' }
        : {
            ...base,
            action: 'checkpoint',
            target: {
              storageProvider: 'local-disk',
              storageMode: 'local-disk',
              storageFileId: 'local://original',
              storagePath: 'smoke/original.png',
              byteSize: 68,
              checksumSha256: 'a'.repeat(64),
              mimeType: 'image/png',
              name: 'original.png',
            },
          };
    const pending = manageSourceMediaImportInCloudBase(database, command);
    command.imageId = 'changed';
    command.operationId = 'changed';
    if (command.action === 'checkpoint') {
      command.target.name = 'changed.png';
      command.target.storageFileId = 'local://changed';
    }
    release();
    assert.equal((await pending).status, action === 'claim' ? 'claimed' : 'checkpointed');
    const image = h.store.get('images')?.get(base.imageId);
    assert.ok(image);
    assert.equal(h.store.get('images')?.has('changed'), false);
    if (action === 'checkpoint') {
      assert.equal(image.name, 'original.png');
      assert.equal(image.storageFileId, 'local://original');
    }
  });

function ordinaryImageFixture() {
  return fakeDatabase({
    images: [
      {
        _id: 'image',
        name: 'old',
        data: 'large-private-data',
        publishedRefCount: 0,
        catalogPublishedReferenceLedger: {
          version: 'catalog-image-reference-ledger-v1',
          epoch: 4,
          pending: [],
        },
      },
    ],
    alibabaSyncLeases: [
      {
        _id: 'c',
        holder: 'holder',
        fence: 1,
        acquiredAt: '2026-10-18T00:00:00.000Z',
        heartbeatAt: '2026-10-18T00:00:00.000Z',
        expiresAt: '2026-10-18T00:01:00.000Z',
        releasedAt: '',
      },
    ],
  });
}
test('native ordinary image metadata patch preserves managed fields with one strict update', async () => {
  const h = ordinaryImageFixture();
  const result = await updateImageInCloudBase(h.db, 'image', {
    name: 'new',
    privateValue: { child: true },
  });
  assert.ok(result);
  assert.equal(result.name, 'new');
  assert.equal(result.publishedRefCount, 0);
  assert.equal(result.data, 'large-private-data');
  assert.deepEqual(result.catalogPublishedReferenceLedger, {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [],
  });
  assert.equal(h.controls.maximumOperations, 2);
});
for (const fault of ['failWrite', 'silentWrite', 'codedWrite'] as const)
  test(`native ordinary image update rolls back ${fault}`, async () => {
    const h = ordinaryImageFixture();
    const before = structuredClone(h.store);
    h.controls[fault] = 'images/image';
    await assert.rejects(updateImageInCloudBase(h.db, 'image', { name: 'new' }));
    assert.deepEqual(h.store, before);
  });
for (const method of ['update', 'lease-update', 'lease-upsert'] as const)
  test(`native ordinary ${method} refuses a managed base reset before any write`, async () => {
    const h = ordinaryImageFixture();
    const before = structuredClone(h.store);
    const guard = {
      connectionId: 'c',
      holder: 'holder',
      fence: 1,
      now: '2026-10-18T00:00:00.000Z',
    };
    await assert.rejects(
      method === 'update'
        ? updateImageInCloudBase(h.db, 'image', { publishedRefCount: 1 })
        : method === 'lease-update'
          ? updateDocWithAlibabaLeaseInCloudBase(
              h.db,
              'images',
              'image',
              { publishedRefCount: 1 },
              guard,
            )
          : upsertDocWithAlibabaLeaseInCloudBase(
              h.db,
              'images',
              'image',
              { publishedRefCount: 1 },
              {},
              guard,
            ),
    );
    assert.deepEqual(h.store, before);
  });
test('native ordinary image input is captured before transaction startup, including later injected managed fields', async () => {
  const h = ordinaryImageFixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database: typeof h.db = {
    ...h.db,
    runTransaction: async (operation) => {
      await gate;
      return h.db.runTransaction(operation);
    },
  };
  const input: Record<string, unknown> = { name: 'captured' };
  const pending = updateImageInCloudBase(database, 'image', input);
  input.name = 'changed';
  input.publishedRefCount = 1;
  input.catalogPublishedReferenceLedger = {};
  release();
  const result = await pending;
  assert.ok(result);
  assert.equal(result.name, 'captured');
  assert.equal(result.publishedRefCount, 0);
});

test('native image lease metadata does not rename the referenced document', async () => {
  const h = ordinaryImageFixture();
  assert.equal(
    await updateDocWithAlibabaLeaseInCloudBase(
      h.db,
      'images',
      'image',
      { _id: 'other', name: 'new' },
      { connectionId: 'c', holder: 'holder', fence: 1, now: '2026-10-18T00:00:00.000Z' },
    ),
    true,
  );
  const image = h.store.get('images')?.get('image');
  assert.ok(image);
  assert.equal(image._id, 'image');
  assert.equal(image.name, 'new');
  assert.equal(image.publishedRefCount, 0);
});

for (const conditional of [false, true])
  test(`native ordinary managed image remove conditional=${conditional} is refused before writes`, async () => {
    const h = ordinaryImageFixture();
    const before = structuredClone(h.store);
    await assert.rejects(
      removeImageInCloudBase(
        h.db,
        'image',
        conditional ? { field: 'name', value: 'old' } : undefined,
      ),
      { name: 'ImageReferenceWriteError', code: 'IMAGE_REFERENCE_DELETION_REQUIRED' },
    );
    assert.deepEqual(h.store, before);
    assert.equal(h.controls.maximumOperations, 1);
  });
test('native ordinary unmatched and missing image removals do not write', async () => {
  const h = ordinaryImageFixture();
  const before = structuredClone(h.store);
  assert.equal(
    await removeImageInCloudBase(h.db, 'image', { field: 'name', value: 'different' }),
    false,
  );
  assert.equal(await removeImageInCloudBase(h.db, 'missing'), false);
  assert.deepEqual(h.store, before);
  assert.equal(h.controls.maximumOperations, 1);
});
for (const fault of ['failRemove', 'silentRemove', 'codedRemove'] as const)
  test(`native ordinary legacy image removal rolls back ${fault}`, async () => {
    const h = ordinaryImageFixture();
    Reflect.deleteProperty(
      h.store.get('images')?.get('image') ?? {},
      'catalogPublishedReferenceLedger',
    );
    const before = structuredClone(h.store);
    h.controls[fault] = 'images/image';
    await assert.rejects(removeImageInCloudBase(h.db, 'image'));
    assert.deepEqual(h.store, before);
  });
test('native ordinary legacy image removal keeps one-read one-remove contract', async () => {
  const h = ordinaryImageFixture();
  Reflect.deleteProperty(
    h.store.get('images')?.get('image') ?? {},
    'catalogPublishedReferenceLedger',
  );
  assert.equal(await removeImageInCloudBase(h.db, 'image'), true);
  assert.equal(h.store.get('images')?.has('image'), false);
  assert.equal(h.controls.maximumOperations, 2);
});
test('native conditional image removal captures expected fields before transaction startup', async () => {
  const h = ordinaryImageFixture();
  Reflect.deleteProperty(
    h.store.get('images')?.get('image') ?? {},
    'catalogPublishedReferenceLedger',
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database: typeof h.db = {
    ...h.db,
    runTransaction: async (operation) => {
      await gate;
      return h.db.runTransaction(operation);
    },
  };
  const expected = { field: 'name', value: 'old' };
  const pending = removeImageInCloudBase(database, 'image', expected);
  expected.value = 'changed';
  release();
  assert.equal(await pending, true);
  assert.equal(h.store.get('images')?.has('image'), false);
});

// Both adapters execute one shared contract, including write rollback and lost-answer replay.
registerLiveSaveStorageContract('CloudBase', (_t, initial) => {
  const h = fakeDatabase(initial);
  return {
    persist: (actor, command) => persistStagedApprovalInCloud(h.db, actor, command),
    save: (input) => saveCatalogProductInCloudBase(h.db, input),
    get: async (collection, id) => structuredClone(h.store.get(collection)?.get(id) ?? null),
    put: async (collection, row) => {
      const rows = h.store.get(collection) ?? new Map();
      rows.set(row._id, structuredClone(row));
      h.store.set(collection, rows);
    },
    snapshot: () =>
      JSON.stringify([...h.store].map(([collection, rows]) => [collection, [...rows]])),
    failProof: (id) => {
      h.controls.failWrite = `catalogDetailApprovals/${id}`;
      return () => {
        h.controls.failWrite = '';
      };
    },
    checkBudget: () =>
      assert.ok(
        h.controls.maximumOperations <= 98,
        `actual transaction operations ${h.controls.maximumOperations}`,
      ),
  };
});
