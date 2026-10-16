import { catalogPreparationImageHold } from './catalog-preparation-image-hold.ts';
import { readCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceMediaLinkId, sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import {
  acquireImageMutationInCloudBase,
  claimAlibabaSyncRunInCloudBase,
  manageCatalogPreparationJobInCloudBase,
  preparingProductHiddenWhere,
  unclassifiedProductWhere,
  updateDocWithAlibabaLeaseInCloudBase,
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
          : exists ? { updated: 1 } : { upserted: [{ _id: id }] };
      },
      remove: async () => {
        const key = `${name}/${id}`;
        if (controls.failRemove === key) throw Error('forced remove failure');
        if (controls.silentRemove === key) return {deleted:0};
        if (controls.codedRemove === key) return {code:'REMOVE_FAILED',deleted:1};
        const deleted = scope.get(name)?.delete(id) ? 1 : 0;
        controls.afterWrite(key);
        return {deleted};
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
        const trackedCollection = (name: string) => ({
          doc: (id: string) => {
            const ref = collection(name, copy).doc(id);
            return {
              get: async () => {
                operations++;
                assert.equal(writing, false, 'all transaction reads precede writes');
                const result = await ref.get();
                controls.afterRead(`${name}/${id}`);
                return result;
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
  assert.ok(f.controls.maximumOperations <= 4);
  assert.deepEqual(f.store.get('products')?.get('p'), { _id: 'p', name: 'Clock' });
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
    products: [{ _id: 'p', name: 'Clock', imageIds: ['image'], ...(withSource ? { alibabaPrimarySourceKey: 'source' } : {}) }],
    ...(withSource ? { alibabaSourceProducts: [{ _id: 'source', sourceTitle: 'Source clock' }] } : {}),
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
    const f = await observationCloudFixture(),
      before = structuredClone(f.store),
      saved = await f.put();
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
  const saved = await f.put();assert.ok(saved.ok && 'observation' in saved && saved.observation);
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
