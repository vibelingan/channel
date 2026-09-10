import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import {
  beginStagedApproval,
  finishStagedApproval,
  persistStagedApprovalInCloud,
  prepareStagedApproval,
  runStagedApproval,
  stageApprovalPage,
} from './catalog-detail-staging.ts';
import { runCatalogApprovalWorkflow } from './catalog-detail-workflow.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

function fixture(count = 105) {
  const variants = Array.from({ length: count }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceMissing: false,
    position,
    sku: `sku-${position}`,
    optionValues: { Color: String(position) },
    imageIds: ['image'],
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: ['/api/images/image'],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const header = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Headset',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
  };
  const product = {
    _id: 'p',
    name: 'Reviewed headset',
    description: '',
    imageIds: ['image'],
    productFamily: 'headphones',
    published: false,
    archived: false,
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: variants.map((v) => v._id) },
    catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: 0 },
  };
  const command = {
    productId: 'p',
    operationId: '12345678-1234-4234-8234-123456789012',
    expectedRevision: 'old',
    expectedDigest: catalogApprovalDigest(product, variants),
  };
  let store: Record<string, Record<string, CollectionDoc>> = {
    products: { p: product },
    productVariants: Object.fromEntries(variants.map((v) => [v._id, v])),
    users: { admin: { _id: 'admin', role: 'admin' }, other: { _id: 'other', role: 'admin' } },
    images: {
      image: {
        _id: 'image',
        status: 'active',
        storageProvider: 'cloudbase-storage',
        publishedRefCount: 0,
      },
    },
  };
  let failAt = Number.POSITIVE_INFINITY;
  let maximumOperations = 0;
  let queue = Promise.resolve();
  const run = <T>(
    action: (tx: {
      get(collection: string, id: string): Promise<CollectionDoc | null>;
      set(collection: string, row: CollectionDoc): Promise<void>;
    }) => Promise<T>,
  ) => {
    const work = queue.then(async () => {
      const copy = structuredClone(store);
      let operations = 0;
      const tick = () => {
        operations++;
        assert.ok(operations <= 98);
        if (operations === failAt) throw new Error('injected failure');
      };
      const result = await action({
        get: async (collection, id) => {
          tick();
          return structuredClone(copy[collection]?.[id] ?? null);
        },
        set: async (collection, row) => {
          tick();
          copy[collection] ??= {};
          copy[collection][row._id] = structuredClone(row);
        },
      });
      maximumOperations = Math.max(maximumOperations, operations);
      store = copy;
      return result;
    });
    queue = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  const prepared = prepareStagedApproval('admin', command, product, variants);
  const row = (collection: string, id: string): CollectionDoc => {
    const found = store[collection]?.[id];
    assert.ok(found, `${collection}/${id} must exist`);
    return found;
  };
  const publication = () =>
    CatalogDetailPublicationSchema.parse(row('products', 'p').catalogDetailPublication);
  assert.ok(prepared.ok);
  return {
    prepared: prepared.value,
    run,
    command,
    product,
    variants,
    store: () => store,
    row,
    publication,
    fail: (n: number) => {
      failAt = n;
    },
    maximumOperations: () => maximumOperations,
  };
}

test('105 SKU approval stages privately then switches once without publishing or changing canonical rows', async () => {
  const h = fixture();
  const prepared = h.prepared;
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared));
  assert.ok(begin.ok);
  for (let page = 0; page < 6; page++) {
    const result = await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, page));
    assert.ok(result.ok);
    assert.equal(h.publication().revision, 'old');
  }
  const result = await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId));
  assert.ok(result.ok);
  assert.equal(Object.keys(h.store().catalogDetailVariants ?? {}).length, 105);
  assert.equal(h.row('products', 'p').published, false);
  assert.deepEqual(Object.values(h.store().productVariants ?? {}), h.variants);
  assert.equal(h.publication().variantStorage, 'immutable-v1');
  assert.ok(h.maximumOperations() <= 50);
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, true);
});

test('two prepared approvals can stage independently, but only one compare-and-swap wins', async () => {
  const h = fixture(1);
  const second = prepareStagedApproval(
    'admin',
    { ...h.command, operationId: '22345678-1234-4234-8234-123456789012' },
    h.product,
    h.variants,
  );
  assert.ok(second.ok);
  const starts = await Promise.all(
    [h.prepared, second.value].map((prepared) =>
      h.run((tx) => beginStagedApproval(tx, 'admin', prepared)),
    ),
  );
  for (const start of starts) {
    assert.ok(start.ok);
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', start.jobId, 0))).ok);
  }
  const results = await Promise.all(
    starts.map((start) => {
      assert.ok(start.ok);
      return h.run((tx) => finishStagedApproval(tx, 'admin', start.jobId));
    }),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.code === 'CONFLICT').length, 1);
  assert.equal(Object.keys(h.store().catalogDetailVariants ?? {}).length, 2);
});

test('zero-SKU publication needs no page, and a failed final commit leaves the old pointer intact', async () => {
  const h = fixture(0);
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok && begin.pages === 0);
  assert.equal((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok, false);
  h.fail(7); // after writing the prospective product pointer, before transaction commit
  await assert.rejects(
    h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)),
    /injected/,
  );
  assert.equal(h.publication().revision, 'old');
  h.fail(Number.POSITIVE_INFINITY);
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, true);
  assert.equal(h.publication().variantCount, 0);
});

test('review digest covers manual pricing: editing price after review cannot prepare a stale approval', () => {
  const h = fixture(1);
  const changed = { ...h.product, catalogPricingMode: 'manual', unitPrice: 6.2 };
  assert.deepEqual(prepareStagedApproval('admin', h.command, changed, h.variants), {
    ok: false,
    code: 'CONFLICT',
  });
});

test('job corruption, duplicate identities, and oversized variants fail without cursor progress', async () => {
  const h = fixture(1);
  assert.equal(
    prepareStagedApproval('admin', h.command, h.product, [...h.variants, ...h.variants]).ok,
    false,
  );
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  h.row('catalogDetailApprovals', begin.jobId).state = 'complete';
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, false);
  assert.equal(h.publication().revision, 'old');
  assert.equal(
    prepareStagedApproval('admin', h.command, h.product, [
      { ...h.variants[0], _id: 'v0', sku: 'x'.repeat(150000) },
    ]).ok,
    false,
  );
});

test('CloudBase staged inserts accept real upsert acknowledgements, not silent or mismatched writes', async () => {
  for (const ack of ['upsert', 'missing', 'wrong-id'] as const) {
    const h = fixture(0);
    const db: NodeSdkDatabase = {
      command: { set: (value) => value },
      runTransaction: (operation) =>
        h.run((tx) =>
          operation({
            collection: (collection) => ({
              doc: (id) => ({
                get: async () => ({ data: (await tx.get(collection, id)) ?? undefined }),
                set: async (data) => {
                  assert.equal(Object.hasOwn(data, '_id'), false);
                  await tx.set(collection, { ...data, _id: id });
                  return ack === 'missing'
                    ? {}
                    : { updated: 0, upserted: [{ _id: ack === 'upsert' ? id : 'wrong' }] };
                },
                update: async () => {
                  throw new Error('Unexpected update');
                },
                remove: async () => {
                  throw new Error('Unexpected remove');
                },
              }),
            }),
          }),
        ),
    };
    const work = persistStagedApprovalInCloud(db, 'admin', {
      action: 'begin',
      prepared: h.prepared,
    });
    if (ack === 'upsert') assert.ok((await work).ok);
    else {
      await assert.rejects(work, /not confirmed/);
      assert.equal(h.store().catalogDetailApprovals, undefined);
    }
  }
});

test('server review includes all 105 SKUs, exposes bounded pages and never exceeds eight parallel reads', async () => {
  const h = fixture();
  let inflight = 0;
  let maximum = 0;
  const store = {
    get: async (collection: string, id: string) => {
      inflight++;
      maximum = Math.max(maximum, inflight);
      await Promise.resolve();
      inflight--;
      return structuredClone(h.store()[collection]?.[id] ?? null);
    },
    persist: (
      actorId: string,
      command: import('./catalog-detail-staging.ts').ApprovalPersistenceCommand,
    ) => h.run((tx) => runStagedApproval(tx, actorId, command)),
  };
  const first = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
  });
  assert.ok(first.ok && 'kind' in first && first.kind === 'review');
  assert.equal(first.detail.variants.items.length, 50);
  assert.equal(first.detail.variants.total, 105);
  const last = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
    page: 3,
    expectedDigest: first.expectedDigest,
  });
  assert.ok(last.ok && 'kind' in last && last.kind === 'review');
  assert.equal(last.detail.variants.items.length, 5);
  assert.equal(last.detail.variants.items[4]?.id, 'v104');
  assert.equal(last.detail.variants.hasMore, false);
  assert.ok(maximum <= 8);
  assert.equal(h.store().catalogDetailApprovals, undefined, 'review is read-only');
  h.row('productVariants', 'v104').optionValues = { Color: 'changed since page 1' };
  const changed = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
    page: 3,
    expectedDigest: first.expectedDigest,
  });
  assert.deepEqual(changed, { ok: false, code: 'CONFLICT' });
});

test('review media opt-in preserves old strict clients and returns fresh media with the same digest', async () => {
  const h = fixture(1);
  h.row('products', 'p').descriptionImageIds = ['image'];
  h.row('products', 'p').alibabaDescriptionImageUrls = ['https://example.com/description.png'];
  const store = {
    get: async (collection: string, id: string) =>
      structuredClone(h.store()[collection]?.[id] ?? null),
    persist: async () => {
      throw new Error('Review must not write');
    },
  };
  const legacy = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
  });
  assert.ok(legacy.ok && 'kind' in legacy);
  assert.equal(Object.hasOwn(legacy, 'previewMedia'), false);
  assert.equal(Object.hasOwn(legacy.detail, 'descriptionImages'), false);
  const current = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
    includePreviewMedia: true,
  });
  assert.ok(current.ok && 'kind' in current);
  assert.equal(current.expectedDigest, legacy.expectedDigest);
  assert.deepEqual(current.detail.descriptionImages, ['/api/images/image']);
  assert.deepEqual(current.previewMedia?.descriptionIds, ['image']);
  assert.deepEqual(current.previewMedia?.descriptionSources, [
    'https://example.com/description.png',
  ]);
});

test('review rejects partial/mixed source generations and revoked actors without creating a job', async () => {
  for (const fault of [
    'missing-row',
    'missing-manifest',
    'generation-change',
    'suspended',
    'foreign-binding',
  ] as const) {
    const h = fixture(2);
    if (fault === 'missing-manifest') h.row('products', 'p').detailSourceManifest = null;
    if (fault === 'suspended') h.row('users', 'admin').status = 'suspended';
    if (fault === 'foreign-binding') h.row('productVariants', 'v0').productId = 'another-product';
    const result = await runCatalogApprovalWorkflow(
      {
        get: async (collection, id) => {
          if (collection === 'productVariants' && id === 'v0') {
            if (fault === 'missing-row') return null;
            if (fault === 'generation-change') h.row('products', 'p').detailSourceReady = false;
          }
          return structuredClone(h.store()[collection]?.[id] ?? null);
        },
        persist: async () => {
          throw new Error('A rejected review must not persist');
        },
      },
      'admin',
      { action: 'review', productId: 'p' },
    );
    assert.equal(result.ok, false, fault);
    assert.equal(h.store().catalogDetailApprovals, undefined);
  }
});

test('interrupted page rolls back and retries without skipping or duplicating SKU snapshots', async () => {
  const h = fixture();
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  h.fail(30);
  await assert.rejects(
    h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0)),
    /injected/,
  );
  assert.equal(h.store().catalogDetailVariants, undefined);
  h.fail(Number.POSITIVE_INFINITY);
  assert.equal((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok, true);
  const snapshot = structuredClone(h.store().catalogDetailVariants);
  assert.equal((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok, true);
  assert.deepEqual(h.store().catalogDetailVariants, snapshot);
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, false);
});

test('wrong actor, skipped page, changed source, and edited product cannot complete stale review', async () => {
  for (const change of ['actor', 'skip', 'source', 'product', 'sku'] as const) {
    const h = fixture();
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
    assert.ok(begin.ok);
    if (change === 'source') h.row('products', 'p').detailSourceReady = false;
    if (change === 'product') h.row('products', 'p').name = 'New name';
    if (change === 'sku') h.row('productVariants', 'v0').optionValues = { Color: 'changed' };
    const result = await h.run((tx) =>
      stageApprovalPage(
        tx,
        change === 'actor' ? 'other' : 'admin',
        begin.jobId,
        change === 'skip' ? 1 : 0,
      ),
    );
    assert.equal(result.ok, false, change);
    assert.equal(h.publication().revision, 'old');
  }
});

test('missing and busy media cannot switch a fully staged approval; a newer approval defeats old retry', async () => {
  const h = fixture(1);
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  assert.equal((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok, true);
  h.row('images', 'image').status = 'deleted';
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, false);
  h.row('images', 'image').status = 'active';
  h.row('images', 'image').imageMutationOwner = 'upload';
  h.row('images', 'image').imageMutationStartedAt = new Date().toISOString();
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, false);
  h.row('images', 'image').imageMutationOwner = '';
  h.row('images', 'image').imageMutationStartedAt = '';
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, true);
  h.row('products', 'p').catalogDetailPublication = {
    ...h.product.catalogDetailPublication,
    revision: 'newer',
  };
  assert.equal((await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared))).ok, false);
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, false);
});

test('reapproval atomically releases old snapshot-only media; failure and retry cannot leak or double-decrement', async () => {
  const h = fixture(0);
  const p = h.row('products', 'p');
  p.published = true;
  p.catalogDetailPublication = {
    ...h.product.catalogDetailPublication,
    header: { ...h.product.catalogDetailPublication.header, images: ['/api/images/old-image'] },
  };
  h.row('images', 'image').publishedRefCount = 1;
  const images = h.store().images;
  assert.ok(images);
  images['old-image'] = {
    _id: 'old-image',
    status: 'active',
    storageProvider: 'cloudbase-storage',
    publishedRefCount: 1,
  };
  const prepared = prepareStagedApproval(
    'admin',
    {
      ...h.command,
      expectedDigest: catalogApprovalDigest(p, []),
    },
    p,
    [],
  );
  assert.ok(prepared.ok);
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared.value));
  assert.ok(begin.ok);
  h.fail(8); // two image writes precede the product pointer write
  await assert.rejects(
    h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)),
    /injected/,
  );
  assert.equal(h.row('images', 'old-image').publishedRefCount, 1);
  assert.equal(h.publication().revision, 'old');
  h.fail(Number.POSITIVE_INFINITY);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  assert.equal(h.row('images', 'old-image').publishedRefCount, 0);
  assert.equal(h.row('images', 'image').publishedRefCount, 1);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  assert.equal(h.row('images', 'old-image').publishedRefCount, 0);
});
