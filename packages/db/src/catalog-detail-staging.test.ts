import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { CatalogValidationReportSchema } from '@vibelingan-channel/shared/catalog-issues';
import { catalogApprovalDigest, prepareCatalogApprovalPlan } from './catalog-detail-commit.ts';
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

function fixture(
  count = 105,
  offersAt: (position: number) => unknown[] = () => [],
  productExtra: Record<string, unknown> = {},
) {
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
      offers: offersAt(position),
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
    ...productExtra,
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
  h.fail(6); // the job write: after the prospective product pointer, before commit (no photo write, DEC-21)
  await assert.rejects(
    h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)),
    /injected/,
  );
  assert.equal(h.publication().revision, 'old');
  h.fail(Number.POSITIVE_INFINITY);
  assert.equal((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok, true);
  assert.equal(h.publication().variantCount, 0);
});

test('the approved version carries the price summary planned from every SKU across pages', async () => {
  const fixed = (amountMinor: number) => [
    {
      kind: 'supplier',
      basis: 'source-quote',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor },
    },
  ];
  const h = fixture(25, (position) => fixed(position === 22 ? 99 : 500 + position));
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  for (let page = 0; page < begin.pages; page++) {
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, page))).ok);
  }
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  // The cheapest SKU sits on the second staging page; the summary still finds it.
  assert.deepEqual(h.publication().priceSummary, {
    source: 'sku',
    variantId: 'v22',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 99 },
  });
  assert.equal(h.publication().revision, h.prepared.revision);
});

test('the approval receipt records the public source digest prepared with the candidate (MIU-18)', async () => {
  const sourceDigest = 'd'.repeat(64);
  const h = fixture(0, undefined, { detailSourcePublicDigest: sourceDigest });
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  const receipt = h.row('products', 'p').catalogDetailApprovalReceipt as Record<string, unknown>;
  assert.equal(receipt.sourceDigest, sourceDigest);
});

test('a product prepared before digests existed still approves, with no digest on the receipt', async () => {
  const h = fixture(0);
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  const receipt = h.row('products', 'p').catalogDetailApprovalReceipt as Record<string, unknown>;
  assert.equal('sourceDigest' in receipt, false);
});

test("the receipt records which parts were still the supplier's own at approval (MIU-39)", async () => {
  const approve = async (extra: Record<string, unknown>) => {
    const h = fixture(0, undefined, extra);
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    return (h.row('products', 'p').catalogDetailApprovalReceipt as Record<string, unknown>)
      .supplierParts;
  };
  const supplier = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Headset',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
    descriptionText: 'Soft ear pads',
  };
  assert.deepEqual(
    await approve({
      description: ' Soft ear pads ',
      detailSourceCandidate: supplier,
      detailSourceSupplierMedia: { gallery: ['image'], descriptionImages: [] },
    }),
    { description: true, gallery: true, descriptionImages: true },
  );
  assert.deepEqual(
    await approve({
      description: 'Our own words',
      detailSourceCandidate: supplier,
      detailSourceSupplierMedia: { gallery: ['other'], descriptionImages: null },
    }),
    { description: false, gallery: false, descriptionImages: false },
  );
  // Prepared before this MIU, or a photo not yet imported: photos count as ours.
  assert.deepEqual(
    await approve({ description: 'Soft ear pads', detailSourceCandidate: supplier }),
    { description: true, gallery: false, descriptionImages: false },
  );
});

test('a part the supplier owned stays theirs while nobody edits it, even when not taken (MIU-39)', async () => {
  // E.g. new supplier photos were left for a later approval (image limit), or
  // a sync landed between the plan and prepare: the row still shows what was
  // approved, so it is not an admin edit and a later approval may take them.
  const approve = async (extra: Record<string, unknown>) => {
    const h = fixture(0, undefined, extra);
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    return (h.row('products', 'p').catalogDetailApprovalReceipt as Record<string, unknown>)
      .supplierParts;
  };
  const published = {
    state: 'approved',
    revision: 'old',
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p',
      name: 'Headset',
      images: ['/api/images/image'],
      facts: [],
      offers: [],
      descriptionText: 'Old text',
    },
    variantCount: 0,
  };
  const owned = { supplierParts: { description: true, gallery: true, descriptionImages: true } };
  const supplierMoved = {
    description: 'Old text',
    detailSourceCandidate: { ...published.header, descriptionText: 'New text' },
    detailSourceSupplierMedia: { gallery: ['newer'], descriptionImages: null },
    catalogDetailPublication: published,
  };
  assert.deepEqual(
    await approve({
      ...supplierMoved,
      catalogDetailApprovalReceipt: { revision: 'old', ...owned },
    }),
    { description: true, gallery: true, descriptionImages: true },
  );
  // An edit since the approval, or no earlier ownership, ends it.
  assert.deepEqual(
    await approve({
      ...supplierMoved,
      description: 'Our own words',
      catalogDetailApprovalReceipt: { revision: 'old', ...owned },
    }),
    { description: false, gallery: true, descriptionImages: true },
  );
  assert.deepEqual(
    await approve({ ...supplierMoved, catalogDetailApprovalReceipt: { revision: 'old' } }),
    { description: false, gallery: false, descriptionImages: false },
  );
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

test('media rollover counts unchanged photos as reads without an arbitrary image limit', async () => {
  for (const newDescriptionCount of [10, 11]) {
    const h = fixture(1);
    const product = h.row('products', 'p');
    const oldGallery = Array.from({ length: 9 }, (_, i) => `old-gallery-${i}`);
    const oldDescription = Array.from({ length: 18 }, (_, i) => `old-description-${i}`);
    const newGallery = Array.from({ length: 9 }, (_, i) => `new-gallery-${i}`);
    const newDescription = Array.from(
      { length: newDescriptionCount },
      (_, i) => `new-description-${i}`,
    );
    product.published = true;
    product.imageIds = newGallery;
    product.descriptionImageIds = newDescription;
    for (const variant of h.variants) {
      variant.imageIds = [newGallery[0] ?? 'new-gallery-0'];
      variant.detailSourceCandidate.images = ['/api/images/new-gallery-0'];
    }
    const previous = h.publication();
    product.catalogDetailPublication = {
      ...previous,
      header: {
        ...previous.header,
        images: oldGallery.map((id) => `/api/images/${id}`),
        descriptionImages: oldDescription.map((id) => `/api/images/${id}`),
      },
    };
    const imageStore = h.store().images;
    assert.ok(imageStore);
    for (const id of [...oldGallery, ...oldDescription, ...newGallery, ...newDescription])
      imageStore[id] = {
        _id: id,
        status: 'active',
        storageProvider: 'cloudbase-storage',
        publishedRefCount: 1,
      };
    const prepared = prepareStagedApproval(
      'admin',
      {
        ...h.command,
        expectedDigest: catalogApprovalDigest(product, h.variants),
      },
      product,
      h.variants,
    );
    assert.ok(prepared.ok);
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared.value));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok);
    const before = structuredClone(h.store());
    const result = await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId));
    assert.ok(result.ok);
    assert.equal(h.maximumOperations(), newDescriptionCount === 10 ? 78 : 79);
    assert.notDeepEqual(h.store(), before);
  }
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
  // Locked by a save in progress: "busy, try again" (DEC-21), not "fix the photos".
  assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)), {
    ok: false,
    code: 'MEDIA_BUSY',
  });
  // A stale lock (its holder crashed) or a corrupt one does not clear by
  // waiting: a definite "not ready", never an endless "try again".
  h.row('images', 'image').imageMutationStartedAt = new Date(
    Date.now() - 20 * 60 * 1000,
  ).toISOString();
  assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)), {
    ok: false,
    code: 'MEDIA_NOT_READY',
  });
  h.row('images', 'image').imageMutationStartedAt = '';
  assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)), {
    ok: false,
    code: 'MEDIA_NOT_READY',
  });
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

test('approval never writes a photo whose live-use count does not change (DEC-21: shared photos)', async () => {
  // Products share stored photos (a seller's banners in hundreds of listings).
  // Writing every photo in each approval made any two approvals sharing one
  // collide; only a real change of a live product's photo set may write.
  for (const published of [false, true]) {
    const h = fixture(1);
    const p = h.row('products', 'p');
    p.published = published;
    h.row('images', 'image').publishedRefCount = published ? 1 : 0;
    const prepared = prepareStagedApproval(
      'admin',
      { ...h.command, expectedDigest: catalogApprovalDigest(p, [h.row('productVariants', 'v0')]) },
      p,
      [h.row('productVariants', 'v0')],
    );
    assert.ok(prepared.ok);
    const before = structuredClone(h.row('images', 'image'));
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared.value));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok);
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    assert.notEqual(h.publication().revision, 'old', 'the approval went through');
    assert.deepEqual(h.row('images', 'image'), before, `photo untouched (published=${published})`);
  }
});

test('an approval job older than an hour can no longer finish; a finished one still answers (DEC-21)', async () => {
  const h = fixture(1);
  const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begin.ok);
  assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok);
  // Each run replaces the store, so the job is read again before each change.
  const startedMinutesAgo = (minutes: number) => {
    h.row('catalogDetailApprovals', begin.jobId).createdAt = new Date(
      Date.now() - minutes * 60 * 1000,
    ).toISOString();
  };
  // Photo deletes stop waiting for a job this old, so it must not publish.
  startedMinutesAgo(61);
  const before = structuredClone(h.store());
  assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)), {
    ok: false,
    code: 'APPROVAL_EXPIRED',
  });
  assert.deepEqual(h.store(), before, 'nothing written');
  startedMinutesAgo(59);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
  // Asking again a day later still answers: the job is complete.
  startedMinutesAgo(24 * 60);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
});

test('independent SKU media stays private until atomic approval, with retry-safe reference rollover', async () => {
  for (const published of [true, false]) {
    const h = fixture(1);
    const p = h.row('products', 'p');
    p.published = published;
    p.catalogDetailPublication = {
      ...h.product.catalogDetailPublication,
      variantImageIds: ['old-sku'],
    };
    const v = h.row('productVariants', 'v0');
    const sourceVariant = h.variants[0];
    assert.ok(sourceVariant);
    v.imageIds = ['new-sku'];
    v.detailSourceCandidate = {
      ...sourceVariant.detailSourceCandidate,
      images: ['/api/images/new-sku'],
    };
    const images = h.store().images;
    assert.ok(images);
    const existing = h.row('images', 'image');
    images['old-sku'] = { ...existing, _id: 'old-sku', publishedRefCount: published ? 1 : 0 };
    images['new-sku'] = { ...existing, _id: 'new-sku', publishedRefCount: 0 };
    h.row('images', 'image').publishedRefCount = published ? 1 : 0;
    const prepared = prepareStagedApproval(
      'admin',
      { ...h.command, expectedDigest: catalogApprovalDigest(p, [v]) },
      p,
      [v],
    );
    assert.ok(prepared.ok);
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared.value));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok);
    assert.equal(h.row('images', 'new-sku').publishedRefCount, 0);
    h.row('images', 'new-sku').status = 'deleted';
    assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId)), {
      ok: false,
      code: 'MEDIA_NOT_READY',
    });
    assert.equal(h.publication().revision, 'old');
    h.row('images', 'new-sku').status = 'active';
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    assert.deepEqual(h.publication().variantImageIds, ['new-sku']);
    assert.deepEqual(h.publication().header.images, ['/api/images/image']);
    assert.equal(h.row('images', 'new-sku').publishedRefCount, published ? 1 : 0);
    assert.equal(h.row('images', 'old-sku').publishedRefCount, 0);
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    assert.equal(h.row('images', 'new-sku').publishedRefCount, published ? 1 : 0);
  }
});

test('known but unimported SKU photos cannot silently approve an empty mapping', () => {
  const h = fixture(1);
  const v = {
    ...h.row('productVariants', 'v0'),
    detailSourceUnboundMediaSources: ['https://sc04.alicdn.com/black.jpg'],
  };
  const result = prepareStagedApproval(
    'admin',
    { ...h.command, expectedDigest: catalogApprovalDigest(h.product, [v]) },
    h.product,
    [v],
  );
  assert.deepEqual(result, { ok: false, code: 'MEDIA_NOT_READY' });
});

test('import review digest permits URL-to-owned binding only, not a different source or edited content', async () => {
  const h = fixture(1);
  const sourceVariant = h.variants[0];
  assert.ok(sourceVariant);
  const v = h.row('productVariants', 'v0');
  v.detailSourceMediaSources = ['https://sc04.alicdn.com/black.jpg'];
  v.detailSourceUnboundMediaSources = v.detailSourceMediaSources;
  v.imageIds = [];
  v.detailSourceCandidate = { ...sourceVariant.detailSourceCandidate, images: [] };
  const review = () =>
    runCatalogApprovalWorkflow(
      {
        get: async (c, id) => structuredClone(h.store()[c]?.[id] ?? null),
        persist: async () => {
          throw new Error('read only');
        },
      },
      'admin',
      { action: 'review', productId: 'p', includePreviewMedia: true },
    );
  const initial = await review();
  assert.ok(initial.ok && 'previewMedia' in initial);
  const importDigest = initial.previewMedia?.importDigest;
  assert.ok(importDigest);
  v.imageIds = ['image'];
  v.detailSourceCandidate = {
    ...sourceVariant.detailSourceCandidate,
    images: ['/api/images/image'],
  };
  v.detailSourceUnboundMediaSources = [];
  const bound = await review();
  assert.ok(bound.ok && 'previewMedia' in bound);
  assert.equal(bound.previewMedia?.importDigest, importDigest);
  assert.notEqual(bound.expectedDigest, initial.expectedDigest);
  v.detailSourceMediaSources = ['https://sc04.alicdn.com/white.jpg'];
  const changed = await review();
  assert.ok(changed.ok && 'previewMedia' in changed);
  assert.notEqual(changed.previewMedia?.importDigest, importDigest);
  v.detailSourceMediaSources = ['https://sc04.alicdn.com/black.jpg'];
  h.row('products', 'p').name = 'Concurrent manual edit';
  const edited = await review();
  assert.ok(edited.ok && 'previewMedia' in edited);
  assert.notEqual(edited.previewMedia?.importDigest, importDigest);
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

test('a configuration photo edit changes the approval fingerprint; products without one keep theirs (DEC-20)', async () => {
  const { approvalProductFingerprint } = await import('./catalog-detail-staging.ts');
  const { publicationContentFingerprint } = await import('./catalog-publication-fingerprint.ts');
  const product = { _id: 'p', name: 'Headset', imageIds: ['a'] };
  const withChoice = { ...product, configurationPhotos: { v1: ['a'] } };
  assert.notEqual(approvalProductFingerprint(withChoice), approvalProductFingerprint(product));
  assert.notEqual(
    publicationContentFingerprint(withChoice),
    publicationContentFingerprint(product),
  );
  assert.equal(
    approvalProductFingerprint({ ...product, configurationPhotos: undefined }),
    approvalProductFingerprint(product),
  );
});

test('a source A-to-B-to-A generation cannot finish an older job even after its content is restored', async () => {
  const h = fixture(0, () => [], { catalogContentGeneration: 1, detailSourceContentGeneration: 1 });
  const begun = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
  assert.ok(begun.ok);
  await h.run(async (tx) => {
    const current = await tx.get('products', 'p');
    assert.ok(current);
    await tx.set('products', { ...current, catalogContentGeneration: 3 });
  });
  assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', h.prepared._id)), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.publication().revision, 'old');
});

for (const field of ['catalogLifecycleVersion', 'catalogClassificationRevision']) {
  test(`an ABA transition of ${field} cannot finish an old approval`, async () => {
    const h = fixture(0, () => [], { [field]: 0 });
    const begun = await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared));
    assert.ok(begun.ok);
    await h.run(async (tx) => {
      const current = await tx.get('products', 'p');
      assert.ok(current);
      await tx.set('products', { ...current, [field]: 2 });
    });
    assert.deepEqual(await h.run((tx) => finishStagedApproval(tx, 'admin', h.prepared._id)), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.publication().revision, 'old');
  });
}

test('oversized UTF-8 configuration reports its exact byte budget without losing source data', () => {
  const h = fixture(1);
  const original = h.variants[0];
  assert.ok(original);
  const options = Array.from({ length: 44 }, (_, index) => ({
    name: `Option ${index}`,
    value: '中'.repeat(1000),
  }));
  const row = {
    ...original,
    detailSourceCandidate: { ...original.detailSourceCandidate, options },
    optionValues: Object.fromEntries(options.map((option) => [option.name, option.value])),
  };
  const variants = [row];
  const before = structuredClone(row);
  const result = prepareStagedApproval(
    'admin',
    { ...h.command, expectedDigest: catalogApprovalDigest(h.product, variants) },
    h.product,
    variants,
  );
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && result.validation);
  assert.equal(result.validation.issues[0]?.code, 'TOO_LARGE');
  assert.equal(result.validation.issues[0]?.path, 'variants.items.0');
  assert.deepEqual(result.validation.issues[0]?.expected, { maxBytes: 128 * 1024 });
  assert.ok((result.validation.issues[0]?.observed?.bytes ?? 0) > 128 * 1024);
  assert.doesNotMatch(JSON.stringify(result), /中/);
  assert.deepEqual(row, before);
});

test('oversized approval job reports a separate exact job budget before persistence', () => {
  const h = fixture(0);
  const facts = Array.from({ length: 256 }, (_, index) => ({
    name: `Fact ${index}`,
    value: '中'.repeat(1000),
  }));
  const product = {
    ...h.product,
    detailSourceCandidate: { ...h.product.detailSourceCandidate, facts },
  };
  const before = structuredClone(product);
  const result = prepareStagedApproval(
    'admin',
    { ...h.command, expectedDigest: catalogApprovalDigest(product, []) },
    product,
    [],
  );
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && result.validation);
  assert.equal(result.validation.issues[0]?.code, 'TOO_LARGE');
  assert.equal(result.validation.issues[0]?.stage, 'commit');
  assert.deepEqual(result.validation.issues[0]?.expected, { maxBytes: 512 * 1024 });
  assert.ok((result.validation.issues[0]?.observed?.bytes ?? 0) > 512 * 1024);
  assert.doesNotMatch(JSON.stringify(result), /中/);
  assert.deepEqual(product, before);
});

test('malformed workflow requests retain a safe validation report before any product read', async () => {
  const result = await runCatalogApprovalWorkflow(
    {
      get: async (collection, id) => {
        assert.equal(collection, 'users');
        return { _id: id, role: 'admin' };
      },
      persist: async () => {
        throw new Error('Malformed request cannot persist');
      },
    },
    'admin',
    { action: 'review', productId: 'p', page: -1, PRIVATE_KEY: 'PRIVATE_SOURCE_TOKEN' },
  );
  assert.ok(
    !result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result && result.validation,
  );
  const validation = CatalogValidationReportSchema.parse(result.validation);
  assert.ok(validation.issues.some((issue) => issue.path === 'page' && issue.remedy === 'reload'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY|PRIVATE_SOURCE_TOKEN/);
});

test('a legacy collapsed-options approval cannot stage a new projection, and a freshly reviewed operation recovers', async () => {
  const h = fixture(21);
  // h.prepared represents the old last-value projection; the source retains both values.
  for (const row of h.variants) {
    const current = h.row('productVariants', row._id);
    const source = CatalogDetailVariantSchema.parse(current.detailSourceCandidate);
    current.detailSourceCandidate = {
      ...source,
      options: [
        { name: 'Color', value: 'First' },
        { name: 'Color', value: row.optionValues.Color },
      ],
    };
  }
  assert.ok((await h.run((tx) => beginStagedApproval(tx, 'admin', h.prepared))).ok);
  const before = structuredClone(h.store());
  assert.deepEqual(await h.run((tx) => stageApprovalPage(tx, 'admin', h.prepared._id, 0)), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.deepEqual(h.store(), before, 'no new page or cursor is mixed into the older job');
  assert.equal(h.publication().revision, 'old');
  const product = h.row('products', 'p');
  const rows = h.variants.map((row) => h.row('productVariants', row._id));
  const renewed = prepareStagedApproval(
    'admin',
    {
      ...h.command,
      operationId: '22345678-1234-4234-8234-123456789012',
      expectedDigest: catalogApprovalDigest(product, rows),
    },
    product,
    rows,
  );
  assert.ok(renewed.ok);
  assert.ok((await h.run((tx) => beginStagedApproval(tx, 'admin', renewed.value))).ok);
  for (let page = 0; page < renewed.value.pageHashes.length; page++)
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', renewed.value._id, page))).ok);
  assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', renewed.value._id))).ok);
  assert.equal(h.publication().revision, renewed.value.revision);
  assert.equal(h.publication().variantCount, 21);
  assert.equal(h.row('products', 'p').published, false);
});

test('staged begin builds the complete effective configuration plan once for both digest and job', () => {
  const h = fixture();
  const first = h.variants[0];
  assert.ok(first);
  const values = first.optionValues;
  let reads = 0;
  Object.defineProperty(first, 'optionValues', {
    enumerable: true,
    get: () => {
      reads++;
      return values;
    },
  });
  const prepared = prepareStagedApproval('admin', h.command, h.product, h.variants);
  assert.ok(prepared.ok);
  assert.equal(reads, 1, 'one effective plan for matching digest and the final job');
  assert.equal(prepared.value.variantIds.length, 105);
  assert.equal(prepared.value.pageHashes.length, 6);
});

test('readonly review builds its complete effective plan once for digest and displayed page', async () => {
  const h = fixture();
  const first = h.variants[0];
  assert.ok(first);
  const values = first.optionValues;
  let reads = 0;
  Object.defineProperty(first, 'optionValues', {
    enumerable: true,
    get: () => {
      reads++;
      return values;
    },
  });
  const review = await runCatalogApprovalWorkflow(
    {
      get: async (collection, id) => h.store()[collection]?.[id] ?? null,
      persist: async () => {
        throw new Error('Readonly review attempted persistence');
      },
    },
    'admin',
    { action: 'review', productId: 'p' },
  );
  assert.ok(review.ok && 'kind' in review && review.kind === 'review');
  assert.equal(reads, 1, 'one effective plan for digest and the review page');
  assert.equal(review.expectedDigest, h.command.expectedDigest);
  assert.equal(review.detail.variants.total, 105);
  assert.equal(h.store().catalogDetailApprovals, undefined);
});

const digestBaselines = new Map([
  [0, '65ce6a3801573b3e0524d916045577faa22de1b9f59e895abdb3c76d2c70c29d'],
  [1, 'c8f29158c6ea9cb3f46fd146ef4692574205b9d4fdd7b648e39bad13ddab27db'],
  [20, '5c6e7f5e0db034a1da7cbf8f717e6ff3122d42fad9436c1c743658ac5c86d33a'],
  [21, '3abe41d69a79a32f26079a2cbdb0305674254528cda0c3a378d5ff93a2fbccf6'],
  [105, '6ba7acde91343171015925275b54ebe3882ae3b86b1be6b3b16721104ce969aa'],
]);
for (const [count, expected] of digestBaselines) {
  test(`approval digest baseline remains exact for ${count} configurations and a chosen revision`, () => {
    const h = fixture(count);
    assert.equal(catalogApprovalDigest(h.product, h.variants), expected);
    const revision = '22222222-2222-4222-8222-222222222222';
    const prepared = prepareCatalogApprovalPlan(h.product, h.variants, revision);
    assert.equal(
      prepared.digest,
      expected,
      'target revision must not change the existing review identity',
    );
    assert.equal(prepared.plan.publication.revision, revision);
    assert.equal(prepared.plan.variants.length, count);
    CatalogDetailPublicationSchema.parse(prepared.plan.publication);
  });
}
test('manual zero-configuration digest baseline remains exact', () => {
  const h = fixture(0, () => [], {
    detailSourceOwner: 'manual:p',
    skuCode: 'M-0',
    unitPrice: 2.5,
    moq: 25,
  });
  assert.equal(
    catalogApprovalDigest(h.product, h.variants),
    'bf50d123a1df4a5adef4714ccae37704fa23e99632f9a84252db65c4893a49a6',
  );
});

test('whole-media status is opt-in so ordinary strict review clients keep the same metadata shape', async () => {
  const h = fixture();
  const store = {
    get: async (collection: string, id: string) => h.store()[collection]?.[id] ?? null,
    persist: async () => {
      throw new Error('Readonly review attempted a write');
    },
  };
  const ordinary = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
    includePreviewMedia: true,
  });
  assert.ok(ordinary.ok && 'kind' in ordinary && ordinary.kind === 'review');
  assert.ok(ordinary.previewMedia);
  assert.equal(Object.hasOwn(ordinary.previewMedia, 'allVariantsBound'), false);
  h.row('productVariants', 'v104').detailSourceUnboundMediaSources = [
    'https://sc04.alicdn.com/final-photo.png',
  ];
  const summary = await runCatalogApprovalWorkflow(store, 'admin', {
    action: 'review',
    productId: 'p',
    includePreviewMedia: true,
    includeMediaSummary: true,
  });
  assert.ok(summary.ok && 'kind' in summary && summary.kind === 'review');
  assert.equal(summary.previewMedia?.allVariantsBound, false);
  assert.equal(summary.previewMedia?.variantSources.length, 50);
  assert.ok(
    summary.previewMedia?.variantSources.every((variant) => variant.unboundSources.length === 0),
  );
});

test('a media summary cannot be requested without the matching preview metadata', async () => {
  const h = fixture();
  const result = await runCatalogApprovalWorkflow(
    {
      get: async (collection, id) => {
        assert.equal(collection, 'users', 'reject before reading any product or configuration');
        return h.store()[collection]?.[id] ?? null;
      },
      persist: async () => {
        throw new Error('Invalid request attempted a write');
      },
    },
    'admin',
    { action: 'review', productId: 'p', includeMediaSummary: true },
  );
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
});

test('full legal gallery rollover and unchanged SKU media use the actual transaction budget', async () => {
  for (const [published, retiredSkuCount, shouldFinish, expectedOperations] of [
    [true, 0, true, 86],
    [true, 6, true, 98],
    [true, 7, false, 3],
    [false, 39, true, 98],
    [false, 40, false, 3],
  ] as const) {
    const h = fixture(1);
    const product = h.row('products', 'p');
    const oldGallery = Array.from({ length: 9 }, (_, i) => `old-gallery-${i}`);
    const oldDescription = Array.from({ length: 18 }, (_, i) => `old-description-${i}`);
    const newGallery = Array.from({ length: 9 }, (_, i) => `new-gallery-${i}`);
    const newDescription = Array.from({ length: 18 }, (_, i) => `new-description-${i}`);
    const retired = Array.from({ length: retiredSkuCount }, (_, i) => `old-sku-${i}`);
    product.published = published;
    product.imageIds = newGallery;
    product.descriptionImageIds = newDescription;
    for (const variant of h.variants) {
      variant.imageIds = [newGallery[0] ?? 'new-gallery-0'];
      variant.detailSourceCandidate.images = ['/api/images/new-gallery-0'];
    }
    const previous = h.publication();
    product.catalogDetailPublication = {
      ...previous,
      variantImageIds: retired,
      header: {
        ...previous.header,
        images: oldGallery.map((id) => `/api/images/${id}`),
        descriptionImages: oldDescription.map((id) => `/api/images/${id}`),
      },
    };
    const imageStore = h.store().images;
    assert.ok(imageStore);
    for (const id of [
      ...oldGallery,
      ...oldDescription,
      ...newGallery,
      ...newDescription,
      ...retired,
    ])
      imageStore[id] = {
        _id: id,
        status: 'active',
        storageProvider: 'cloudbase-storage',
        publishedRefCount: published ? 1 : 0,
      };
    const prepared = prepareStagedApproval(
      'admin',
      {
        ...h.command,
        expectedDigest: catalogApprovalDigest(product, h.variants),
      },
      product,
      h.variants,
    );
    assert.ok(prepared.ok);
    const begin = await h.run((tx) => beginStagedApproval(tx, 'admin', prepared.value));
    assert.ok(begin.ok);
    assert.ok((await h.run((tx) => stageApprovalPage(tx, 'admin', begin.jobId, 0))).ok);
    const before = structuredClone(h.store());
    let operations = 0;
    const result = await h.run((tx) =>
      finishStagedApproval(
        {
          get: (collection, id) => {
            operations++;
            return tx.get(collection, id);
          },
          set: (collection, row) => {
            operations++;
            return tx.set(collection, row);
          },
        },
        'admin',
        begin.jobId,
      ),
    );
    assert.equal(result.ok, shouldFinish, `published=${published}, retired=${retiredSkuCount}`);
    assert.equal(operations, expectedOperations);
    if (!shouldFinish) {
      assert.deepEqual(result, { ok: false, code: 'APPROVAL_TOO_LARGE' });
      assert.deepEqual(h.store(), before);
      continue;
    }
    for (const id of [...oldGallery, ...oldDescription, ...retired])
      assert.equal(h.row('images', id).publishedRefCount, 0);
    for (const id of [...newGallery, ...newDescription])
      assert.equal(h.row('images', id).publishedRefCount, published ? 1 : 0);
    const committed = structuredClone(h.store());
    assert.ok((await h.run((tx) => finishStagedApproval(tx, 'admin', begin.jobId))).ok);
    assert.deepEqual(h.store(), committed, 'finish replay must not update counters again');
  }
});
