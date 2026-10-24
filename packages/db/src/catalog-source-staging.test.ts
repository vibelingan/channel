import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { publicSourceDigest } from '@vibelingan-channel/shared/catalog-source-digest';
import { persistStagedApprovalInCloud } from './catalog-detail-staging.ts';
import { primarySourceLinkSnapshot } from './catalog-source-binding.ts';
import { sourceBindingHash, sourceInputDigest } from './catalog-source-inputs.ts';
import {
  SourcePageSchema,
  sourceDigest,
  sourceGalleryDigest,
  stageSourcePage,
} from './catalog-source-staging.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

const sourceObservationId = sourceObservationDocumentId('alibaba', 'source');
function bindFixture(
  store: Record<string, CollectionDoc>,
  sourceKey: string,
  productId: string,
  observationId: string,
) {
  const source = {
    _id: sourceKey,
    sourceKey,
    connectionId: 'fixture',
    sourceProductId: `fixture-${sourceKey}`,
    active: true,
  };
  const link = {
    _id: sourceKey,
    sourceKey,
    connectionId: source.connectionId,
    sourceProductId: source.sourceProductId,
    productId,
    linkedAt: '2026-01-01T00:00:00.000Z',
  };
  store[`alibabaSourceProducts/${sourceKey}`] = source;
  store[`alibabaProductLinks/${sourceKey}`] = link;
  const snapshot = primarySourceLinkSnapshot(source, link, productId);
  assert.ok(snapshot.ok);
  return {
    sourceHash: sourceBindingHash(source),
    observationHash: sourceInputDigest(store[`catalogSourceObservations/${observationId}`] ?? null),
    linkHash: snapshot.linkHash,
  };
}

test('source preparation seals only the complete generation; retries, changed observation and wrong actor are safe', async () => {
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/product': {
      _id: 'product',
      alibabaPrimarySourceKey: 'source',
      imageIds: [],
      published: true,
      name: 'Manual title',
      unitPrice: 7,
    },
    [`catalogSourceObservations/${sourceObservationId}`]: {
      _id: sourceObservationId,
      observation: { value: 1 },
    },
  };
  const binding = bindFixture(store, 'source', 'product', sourceObservationId);
  const tx = {
    get: async (c: string, id: string) => structuredClone(store[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      store[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const ids = Array.from({ length: 21 }, (_, i) => `sku-${i}`);
  const page = (index: number) =>
    SourcePageSchema.parse({
      action: 'source-page',
      productId: 'product',
      sourceKey: 'source',
      observationId: sourceObservationId,
      expectedBinding: binding,
      observationDigest: sourceDigest({ value: 1 }),
      galleryDigest: sourceDigest([]),
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'product',
        name: 'Source',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: ids,
      page: index,
      variants: ids.slice(index * 20, (index + 1) * 20).map((id) => ({
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      })),
    });
  assert.deepEqual(await stageSourcePage(tx, 'stranger', page(0)), {
    ok: false,
    code: 'FORBIDDEN',
  });
  assert.deepEqual(await stageSourcePage(tx, 'admin', page(1)), {
    ok: false,
    code: 'SOURCE_NOT_READY',
  });
  assert.equal((await stageSourcePage(tx, 'admin', page(0))).ok, true);
  assert.equal(store['products/product']?.detailSourceReady, false);
  assert.equal((await stageSourcePage(tx, 'admin', page(0))).ok, true);
  store[`catalogSourceObservations/${sourceObservationId}`] = {
    _id: sourceObservationId,
    observation: { value: 2 },
  };
  assert.deepEqual(await stageSourcePage(tx, 'admin', page(1)), { ok: false, code: 'CONFLICT' });
  store[`catalogSourceObservations/${sourceObservationId}`] = {
    _id: sourceObservationId,
    observation: { value: 1 },
  };
  const done = await stageSourcePage(tx, 'admin', page(1));
  assert.equal(done.ok && done.complete, true);
  const product = store['products/product'];
  assert.equal(product?.detailSourceReady, true);
  assert.equal(product?.name, 'Manual title');
  assert.equal(product?.unitPrice, 7);
  assert.equal(product?.published, true);
  assert.equal(Object.keys(store).filter((key) => key.startsWith('productVariants/')).length, 21);
});

const realObservation = (amountMinor: number) => ({
  identity: { attributes: [{ sourceName: 'Material', value: 'ABS' }] },
  content: {
    description: { text: 'Headset' },
    media: [{ sourceUrl: 'https://img.example/1.jpg' }],
  },
  variants: [
    { sourceVariantKey: 'black', options: [{ sourceName: 'Color', value: 'Black' }], media: [] },
  ],
  offers: [
    {
      sourceOfferKey: 'o-black',
      sourceVariantKey: 'black',
      kind: 'supplier',
      pricing: { mode: 'fixed' as const, currency: 'USD', amountMinor },
    },
  ],
});

async function prepareOnce(
  observation: unknown,
  revision: string,
  existing: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
) {
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/product': {
      _id: 'product',
      alibabaPrimarySourceKey: 'source',
      imageIds: [],
      ...existing,
    },
    [`catalogSourceObservations/${sourceObservationId}`]: { _id: sourceObservationId, observation },
  };
  const binding = bindFixture(store, 'source', 'product', sourceObservationId);
  const tx = {
    get: async (c: string, id: string) => structuredClone(store[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      store[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const result = await stageSourcePage(
    tx,
    'admin',
    SourcePageSchema.parse({
      action: 'source-page',
      productId: 'product',
      sourceKey: 'source',
      observationId: sourceObservationId,
      expectedBinding: binding,
      observationDigest: sourceDigest(observation),
      galleryDigest: sourceDigest([]),
      revision,
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'product',
        name: 'Source',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: ['black'],
      page: 0,
      variants: [
        { id: 'black', options: [], images: [], offers: [], inventory: { state: 'unknown' } },
      ],
      ...input,
    }),
  );
  assert.equal(result.ok, true);
  return store['products/product'];
}

test('prepare records the public digest of the observation it built the candidate from (MIU-17)', async () => {
  const first = realObservation(430);
  const prepared = await prepareOnce(first, 'a'.repeat(64));
  assert.equal(prepared?.detailSourcePublicDigest, publicSourceDigest(first));
  const repriced = await prepareOnce(realObservation(399), 'b'.repeat(64));
  assert.notEqual(repriced?.detailSourcePublicDigest, prepared?.detailSourcePublicDigest);
});

test('an observation without the public fields records no digest instead of failing prepare', async () => {
  const prepared = await prepareOnce({ value: 1 }, 'c'.repeat(64));
  assert.equal(prepared?.detailSourceReady, true);
  assert.equal('detailSourcePublicDigest' in (prepared ?? {}), false);
});

test('a product prepared before digests existed gets one when prepared again from the same data', async () => {
  // Same revision, already complete: prepare short-circuits, but must still
  // record the digest, or approvals of most live products would carry none.
  const observation = realObservation(430);
  const revision = 'd'.repeat(64);
  const prepared = await prepareOnce(observation, revision, {
    detailSourceRevision: revision,
    detailSourceNextPage: 1,
    detailSourceReady: true,
  });
  assert.equal(prepared?.detailSourcePublicDigest, publicSourceDigest(observation));
});

test('a fresh prepare from data without the public fields drops an old digest', async () => {
  const prepared = await prepareOnce({ value: 1 }, 'e'.repeat(64), {
    detailSourcePublicDigest: 'f'.repeat(64),
  });
  assert.equal('detailSourcePublicDigest' in (prepared ?? {}), false);
});

test("prepare records which of our images are the supplier's photos (MIU-39)", async () => {
  const supplierMedia = { gallery: ['img-1', 'img-2'], descriptionImages: null };
  const prepared = await prepareOnce(realObservation(430), 'a'.repeat(64), {}, { supplierMedia });
  assert.deepEqual(prepared?.detailSourceSupplierMedia, supplierMedia);
  // Same data prepared again: refreshed (an import since may have linked a photo).
  const revision = 'b'.repeat(64);
  const linked = { gallery: ['img-1', 'img-2'], descriptionImages: ['img-3'] };
  const again = await prepareOnce(
    realObservation(430),
    revision,
    {
      detailSourceRevision: revision,
      detailSourceNextPage: 1,
      detailSourceReady: true,
      detailSourceSupplierMedia: supplierMedia,
    },
    { supplierMedia: linked },
  );
  assert.deepEqual(again?.detailSourceSupplierMedia, linked);
  // A prepare that sends none drops an old record instead of keeping a stale one.
  const none = await prepareOnce(realObservation(430), 'c'.repeat(64), {
    detailSourceSupplierMedia: supplierMedia,
  });
  assert.equal('detailSourceSupplierMedia' in (none ?? {}), false);
});

test('configuration photo choices are part of the gallery digest only when set (DEC-20)', () => {
  const base = { _id: 'p', imageIds: ['a'] };
  assert.equal(
    sourceGalleryDigest(base),
    sourceDigest(['a']),
    'products without choices keep their digest',
  );
  assert.notEqual(
    sourceGalleryDigest({ ...base, configurationPhotos: { v1: ['a'] } }),
    sourceGalleryDigest({ ...base, configurationPhotos: { v1: [] } }),
  );
});

test('a source page without the current content generation cannot restore an invalidated ready flag', async () => {
  const observation = { value: 1 };
  const product = {
    _id: 'p',
    name: 'Clock',
    alibabaPrimarySourceKey: 'key',
    imageIds: [],
    catalogContentGeneration: 1,
    detailSourceReady: false,
  };
  const observationId = sourceObservationDocumentId('alibaba', 'key');
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': product,
    [`catalogSourceObservations/${observationId}`]: { _id: observationId, observation },
  };
  const binding = bindFixture(store, 'key', 'p', observationId);
  const writes: string[] = [];
  const tx = {
    get: async (collection: string, id: string) => store[`${collection}/${id}`] ?? null,
    set: async (collection: string, row: CollectionDoc) => {
      writes.push(collection);
      store[`${collection}/${row._id}`] = row;
    },
  };
  const input = SourcePageSchema.parse({
    action: 'source-page',
    productId: 'p',
    sourceKey: 'key',
    observationId,
    expectedBinding: binding,
    observationDigest: sourceDigest(observation),
    galleryDigest: sourceGalleryDigest(product),
    revision: 'a'.repeat(64),
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p',
      name: 'Clock',
      images: [],
      facts: [],
      offers: [],
    },
    content: null,
    noteBlocks: null,
    variantIds: [],
    page: 0,
    variants: [],
  });
  assert.deepEqual(await stageSourcePage(tx, 'admin', input), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(writes, []);
  const current = SourcePageSchema.parse({ ...input, contentGeneration: 1 });
  assert.equal((await stageSourcePage(tx, 'admin', current)).ok, true);
  assert.equal(store['products/p']?.detailSourceContentGeneration, 1);
  store['products/p'] = {
    ...store['products/p'],
    _id: 'p',
    catalogContentGeneration: 2,
    detailSourceReady: false,
  };
  writes.length = 0;
  assert.deepEqual(await stageSourcePage(tx, 'admin', current), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(writes, []);
});

test('every newly prepared source page changes the write fence; a repeated page does not write it', async () => {
  const observationId = sourceObservationDocumentId('alibaba', 'k');
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': {
      _id: 'p',
      name: 'Clock',
      alibabaPrimarySourceKey: 'k',
      imageIds: [],
      published: false,
    },
    [`catalogSourceObservations/${observationId}`]: {
      _id: observationId,
      observation: { value: 1 },
    },
  };
  const binding = bindFixture(store, 'k', 'p', observationId);
  const fences: unknown[] = [];
  const tx = {
    get: async (collection: string, id: string) =>
      structuredClone(store[`${collection}/${id}`] ?? null),
    set: async (collection: string, row: CollectionDoc) => {
      if (collection === 'catalogSourceObservations') fences.push(row.detailPreparationFence);
      store[`${collection}/${row._id}`] = structuredClone(row);
    },
  };
  const ids = Array.from({ length: 21 }, (_, i) => `configuration-${i}`);
  const page = (index: number) =>
    SourcePageSchema.parse({
      action: 'source-page',
      productId: 'p',
      sourceKey: 'k',
      observationId,
      expectedBinding: binding,
      observationDigest: sourceDigest({ value: 1 }),
      galleryDigest: sourceDigest([]),
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Clock',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: ids,
      page: index,
      variants: ids.slice(index * 20, (index + 1) * 20).map((id) => ({
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      })),
    });
  assert.equal((await stageSourcePage(tx, 'admin', page(0))).ok, true);
  assert.equal((await stageSourcePage(tx, 'admin', page(1))).ok, true);
  assert.equal(fences.length, 2);
  assert.notDeepEqual(
    fences[0],
    fences[1],
    'the second page must perform an actual observation write',
  );
  assert.equal((await stageSourcePage(tx, 'admin', page(1))).ok, true);
  assert.equal(fences.length, 2, 'a confirmed repeated page has no new source write');
});

test('production Cloud source paging succeeds when identical writes acknowledge zero updates', async () => {
  const observationId = sourceObservationDocumentId('alibaba', 'k');
  let store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': {
      _id: 'p',
      name: 'Clock',
      alibabaPrimarySourceKey: 'k',
      imageIds: [],
      published: false,
    },
    [`catalogSourceObservations/${observationId}`]: {
      _id: observationId,
      observation: { value: 1 },
    },
  };
  const binding = bindFixture(store, 'k', 'p', observationId);
  const ids = Array.from({ length: 21 }, (_, i) => `configuration-${i}`);
  const page = (index: number) =>
    SourcePageSchema.parse({
      action: 'source-page',
      productId: 'p',
      sourceKey: 'k',
      observationId,
      expectedBinding: binding,
      observationDigest: sourceDigest({ value: 1 }),
      galleryDigest: sourceDigest([]),
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Clock',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: ids,
      page: index,
      variants: ids.slice(index * 20, (index + 1) * 20).map((id) => ({
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      })),
    });
  let zeroAcks = 0;
  let maximumOperations = 0;
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    async runTransaction(operation) {
      const copy = structuredClone(store);
      let writes = false;
      let operations = 0;
      const result = await operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => {
              assert.equal(writes, false, 'all reads precede writes');
              operations++;
              return { data: structuredClone(copy[`${collection}/${id}`] ?? null) };
            },
            set: async (data) => {
              writes = true;
              operations++;
              assert.equal(Object.hasOwn(data, '_id'), false);
              const key = `${collection}/${id}`;
              const next = { ...structuredClone(data), _id: id };
              if (isDeepStrictEqual(copy[key], next)) {
                zeroAcks++;
                return { updated: 0 };
              }
              const existing = copy[key];
              copy[key] = next;
              return existing ? { updated: 1 } : { upserted: [{ _id: id }] };
            },
            update: async () => {
              throw new Error('unexpected partial update');
            },
            remove: async () => {
              throw new Error('unexpected removal');
            },
          }),
        }),
      });
      maximumOperations = Math.max(maximumOperations, operations);
      store = copy;
      return result;
    },
  };
  assert.equal((await persistStagedApprovalInCloud(db, 'admin', page(0))).ok, true);
  const final = await persistStagedApprovalInCloud(db, 'admin', page(1));
  assert.ok(final.ok && 'complete' in final && final.complete);
  assert.equal(zeroAcks, 0, 'every requested write must change the stored row');
  assert.equal(maximumOperations, 47);
  assert.equal((await persistStagedApprovalInCloud(db, 'admin', page(1))).ok, true);
  assert.equal(zeroAcks, 0);
  assert.equal(store['products/p']?.published, false);
});

for (const fault of ['product', 'connection', 'external-id', 'relinked', 'metadata'] as const)
  test(`source-page transaction checks the frozen primary link (${fault})`, async () => {
    const observationId = sourceObservationDocumentId('alibaba', 'k');
    const store: Record<string, CollectionDoc> = {
      'users/admin': { _id: 'admin', role: 'admin' },
      'products/p': { _id: 'p', name: 'Clock', alibabaPrimarySourceKey: 'k', imageIds: [] },
      [`catalogSourceObservations/${observationId}`]: {
        _id: observationId,
        observation: { value: 1 },
      },
    };
    const binding = bindFixture(store, 'k', 'p', observationId);
    const packet = SourcePageSchema.parse({
      action: 'source-page',
      productId: 'p',
      sourceKey: 'k',
      observationId,
      expectedBinding: binding,
      observationDigest: sourceDigest({ value: 1 }),
      galleryDigest: sourceDigest([]),
      revision: 'a'.repeat(64),
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Clock',
        images: [],
        facts: [],
        offers: [],
      },
      content: null,
      noteBlocks: null,
      variantIds: [],
      page: 0,
      variants: [],
    });
    const link = store['alibabaProductLinks/k'];
    assert.ok(link);
    store['alibabaProductLinks/k'] = {
      ...link,
      ...(fault === 'product' ? { productId: 'other' } : {}),
      ...(fault === 'connection' ? { connectionId: 'other' } : {}),
      ...(fault === 'external-id' ? { sourceProductId: 'other' } : {}),
      ...(fault === 'relinked' ? { linkedAt: '2026-01-02T00:00:00.000Z' } : {}),
      ...(fault === 'metadata'
        ? { categoryAssignmentFence: 'new-metadata-fence', updatedAt: '2026-01-02T00:00:00.000Z' }
        : {}),
    };
    const writes: string[] = [];
    const before = structuredClone(store);
    const result = await stageSourcePage(
      {
        get: async (collection, id) => structuredClone(store[`${collection}/${id}`] ?? null),
        set: async (collection, row) => {
          writes.push(collection);
          store[`${collection}/${row._id}`] = structuredClone(row);
        },
      },
      'admin',
      packet,
    );
    assert.equal(result.ok, fault === 'metadata');
    if (fault !== 'metadata') {
      assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
      assert.deepEqual(writes, []);
      assert.deepEqual(store, before);
    }
  });
