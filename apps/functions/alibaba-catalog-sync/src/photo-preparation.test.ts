/** Alibaba photos copied ahead into our storage; drafts appear ready (PT-G). */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type CatalogProductSaveInput,
  type CatalogProductSaveResult,
  type ImageMutationAcquireResult,
  type ImageMutationReleaseResult,
  planCatalogProductSave,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from '@vibelingan-channel/db/adapter';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import type { MediaImportResult } from './media-import.ts';
import { photoPreparationPlan, prepareAlibabaPhotosPage } from './photo-preparation.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  constructor(readonly store: Store) {}
  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...this.docs(query.collection)];
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    if (query.sort) {
      const sort = query.sort;
      docs.sort((a, b) => compareBySort(a, b, sort));
    }
    const start = (query.page - 1) * query.pageSize;
    return {
      items: structuredClone(docs.slice(start, start + query.pageSize)),
      total: docs.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return structuredClone(this.docs(collection).find((doc) => doc._id === id) ?? null);
  }
  async findByField(): Promise<CollectionDoc | null> {
    return null;
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(): Promise<boolean> {
    return false;
  }
  async incrementField(): Promise<number | null> {
    return null;
  }
  async createDocWithId(): Promise<'created' | 'exists'> {
    throw new Error('not used');
  }
  async upsertDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc> {
    const docs = this.docs(collection);
    const index = docs.findIndex((doc) => doc._id === id);
    const next = { ...(index >= 0 ? docs[index] : {}), ...data, _id: id } as CollectionDoc;
    if (index >= 0) docs[index] = next;
    else docs.push(next);
    return structuredClone(next);
  }
  async acquireImageMutation(
    imageId: string,
    owner: string,
    startedAt: string,
  ): Promise<ImageMutationAcquireResult> {
    const docs = this.docs('images');
    const index = docs.findIndex((doc) => doc._id === imageId);
    if (index < 0) return 'missing';
    const existing = docs[index] as CollectionDoc;
    const transition = transitionImageMutationAcquire(existing, owner, startedAt);
    if (transition.result !== 'acquired') return transition.result;
    docs[index] = { ...existing, ...transition.patch };
    return 'acquired';
  }
  async releaseImageMutation(imageId: string, owner: string): Promise<ImageMutationReleaseResult> {
    const docs = this.docs('images');
    const index = docs.findIndex((doc) => doc._id === imageId);
    if (index < 0) return 'missing';
    const existing = docs[index] as CollectionDoc;
    const transition = transitionImageMutationRelease(existing, owner);
    if (transition.result !== 'released') return transition.result;
    docs[index] = { ...existing, ...transition.patch };
    return 'released';
  }
  async saveCatalogProductWithIdentities(
    input: CatalogProductSaveInput,
  ): Promise<CatalogProductSaveResult> {
    const products = this.docs('products');
    const index = products.findIndex((doc) => doc._id === input.productId);
    const existing = index >= 0 ? (products[index] as CollectionDoc) : null;
    const plan = planCatalogProductSave(existing, input, '2026-10-09T05:00:00.000Z');
    if (plan.result !== 'ready') return plan;
    if (index >= 0) products[index] = plan.doc;
    else products.push(plan.doc);
    return { result: 'saved', doc: plan.doc, previous: existing };
  }
}

const url = (name: string) => `https://sc04.alicdn.com/${name}.jpg`;

function draft(id: string, overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: id,
    name: `Draft ${id}`,
    published: false,
    archived: false,
    alibabaPrimarySourceKey: `source-${id}`,
    alibabaLinkRevision: 1,
    alibabaReviewPending: true,
    alibabaReviewReason: 'new',
    alibabaSourceImageUrls: [url(`${id}-g1`), url(`${id}-g2`)],
    alibabaDescriptionImageUrls: [url(`${id}-d1`)],
    updatedAt: '2026-10-09T01:00:00.000Z',
    ...overrides,
  };
}

/** A fake copier: every URL becomes an active image; names in `failing` fail. */
function fakeImporter(store: Store, failing: string[] = []) {
  const calls: string[] = [];
  const importImage = async (source: string): Promise<MediaImportResult> => {
    calls.push(source);
    if (failing.some((name) => source.includes(name))) return { ok: false, reason: 'fetch-failed' };
    const imageId = `img-${source.split('/').at(-1)?.replace('.jpg', '')}`;
    store.images ??= [];
    if (!store.images.some((image) => image._id === imageId))
      store.images.push({
        _id: imageId,
        status: 'active',
        uploadedByUserId: 'alibaba-catalog-sync',
        publishedRefCount: 0,
      });
    store.catalogSourceLinks ??= [];
    store.catalogSourceLinks.push({
      _id: sourceMediaLinkId('alibaba', source),
      kind: 'media',
      provider: 'alibaba',
      sourceUrl: source,
      imageId,
    });
    return { ok: true, imageId, deduplicated: false };
  };
  return { calls, importImage };
}

test('plan: an untouched draft gets its photos; edited, published, approved, archived and manual products do not', () => {
  assert.deepEqual(
    photoPreparationPlan(draft('a'))?.parts.map((part) => [part.part, part.sources.length]),
    [
      ['gallery', 2],
      ['description', 1],
    ],
  );
  // The admin chose photos: theirs stay.
  assert.equal(photoPreparationPlan(draft('a', { imageIds: ['own'] }))?.parts.length, 1);
  for (const product of [
    draft('a', { published: true }),
    draft('a', { catalogDetailApprovalReceipt: { contentFingerprint: 'x' } }),
    draft('a', { archived: true }),
    draft('a', { alibabaPrimarySourceKey: undefined }),
    draft('a', { alibabaSourceImageUrls: [], alibabaDescriptionImageUrls: [] }),
  ])
    assert.equal(photoPreparationPlan(product), null);
  // A hidden draft that cannot be prepared is still shown.
  assert.deepEqual(
    photoPreparationPlan(draft('a', { archived: true, alibabaPhotosPending: true })),
    { parts: [], showDraft: true },
  );
});

test('plan: auto-filled photos follow Alibaba until an admin changes them', () => {
  const filled = draft('a', {
    imageIds: ['img-a-g1', 'img-a-g2'],
    descriptionImageIds: ['img-a-d1'],
    alibabaAutoPhotos: {
      gallery: { sources: [url('a-g1'), url('a-g2')], imageIds: ['img-a-g1', 'img-a-g2'] },
      description: { sources: [url('a-d1')], imageIds: ['img-a-d1'] },
    },
  });
  assert.equal(photoPreparationPlan(filled), null, 'up to date');
  const newPhotos = { ...filled, alibabaSourceImageUrls: [url('a-g3')] };
  assert.deepEqual(
    photoPreparationPlan(newPhotos)?.parts.map((part) => part.part),
    ['gallery'],
  );
  // The admin removed one: from now on the gallery is theirs.
  assert.equal(photoPreparationPlan({ ...newPhotos, imageIds: ['img-a-g2'] }), null);
  // The admin removed all description photos after the fill: not refilled.
  assert.equal(
    photoPreparationPlan({
      ...filled,
      descriptionImageIds: [],
      alibabaDescriptionImageUrls: [url('a-d9')],
    }),
    null,
  );
});

test('prepare: copies each photo once, fills the draft in one save and shows a hidden draft', async () => {
  const store: Store = {
    products: [draft('a', { alibabaPhotosPending: true }), draft('b')],
    images: [{ _id: 'img-b-g1', status: 'active', uploadedByUserId: 'alibaba-catalog-sync' }],
    catalogSourceLinks: [
      {
        _id: sourceMediaLinkId('alibaba', url('b-g1')),
        kind: 'media',
        provider: 'alibaba',
        sourceUrl: url('b-g1'),
        imageId: 'img-b-g1',
      },
    ],
  };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  const page = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(page.done, true);
  assert.equal(page.prepared, 2);
  // b-g1 was already copied: reused, not fetched again.
  assert.equal(importer.calls.includes(url('b-g1')), false);
  assert.equal(page.photosReused, 1);
  assert.equal(page.photosCopied, 5);
  const a = store.products?.find((row) => row._id === 'a') as CollectionDoc;
  assert.deepEqual(a.imageIds, ['img-a-g1', 'img-a-g2']);
  assert.deepEqual(a.descriptionImageIds, ['img-a-d1']);
  assert.equal(a.alibabaPhotosPending, false);
  assert.deepEqual(a.alibabaAutoPhotos, {
    gallery: { sources: [url('a-g1'), url('a-g2')], imageIds: ['img-a-g1', 'img-a-g2'] },
    description: { sources: [url('a-d1')], imageIds: ['img-a-d1'] },
  });
  // Image locks are released.
  assert.ok(store.images?.every((image) => !image.imageMutationOwner));
  // A second pass has nothing to do.
  const again = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(again.prepared, 0);
});

test('prepare: a photo that cannot be copied is left out and does not block the draft', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store, ['a-g2']);
  const page = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(page.photosFailed, 1);
  const a = store.products?.[0] as CollectionDoc;
  assert.deepEqual(a.imageIds, ['img-a-g1']);
  assert.equal(a.alibabaPhotosPending, false);
  // Not retried while Alibaba's photos stay the same.
  assert.equal(photoPreparationPlan(a), null);
});

test('prepare: an admin edit made meanwhile wins; the draft is looked at again next pass', async () => {
  const store: Store = { products: [draft('a')] };
  const adapter = new MemoryAdapter(store);
  setAdapter(adapter);
  const importer = fakeImporter(store);
  const importImage = async (source: string) => {
    // The admin saves the draft while its photos are being copied.
    const row = store.products?.[0] as CollectionDoc;
    row.name = 'Admin name';
    row.updatedAt = '2026-10-09T02:00:00.000Z';
    return importer.importImage(source);
  };
  const page = await prepareAlibabaPhotosPage({ importImage });
  assert.equal(page.busy, 1);
  assert.equal(page.prepared, 0);
  assert.equal((store.products?.[0] as CollectionDoc).imageIds, undefined);
  assert.equal((store.products?.[0] as CollectionDoc).name, 'Admin name');
  // Photos were copied; the next pass only attaches them.
  const next = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(next.prepared, 1);
  assert.equal(next.photosCopied, 0);
});

test('prepare: stops inside the time budget and resumes on the same product', async () => {
  const store: Store = { products: [draft('a'), draft('b')] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  let now = 0;
  const importImage = async (source: string) => {
    now += 5_000;
    return importer.importImage(source);
  };
  const first = await prepareAlibabaPhotosPage({ importImage, budgetMs: 12_000, clock: () => now });
  assert.equal(first.done, false);
  assert.equal(first.prepared, 1, 'product a finished');
  assert.equal(first.nextProductId, 'a', 'b resumes next call');
  const second = await prepareAlibabaPhotosPage({
    afterProductId: first.nextProductId,
    importImage,
    budgetMs: 60_000,
    clock: () => now,
  });
  assert.equal(second.done, true);
  assert.equal(second.prepared, 1);
  assert.deepEqual((store.products?.[1] as CollectionDoc).imageIds, ['img-b-g1', 'img-b-g2']);
});

test('prepare: hidden drafts only, when asked', async () => {
  const store: Store = { products: [draft('a'), draft('b', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  const page = await prepareAlibabaPhotosPage({
    importImage: importer.importImage,
    pendingOnly: true,
  });
  assert.equal(page.prepared, 1);
  assert.equal((store.products?.[0] as CollectionDoc).imageIds, undefined);
  assert.equal((store.products?.[1] as CollectionDoc).alibabaPhotosPending, false);
});

test('prepare: a photo that failed is not fetched again when a product resumes', async () => {
  const store: Store = { products: [draft('a')] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store, ['a-g2']);
  let now = 0;
  const importImage = async (source: string) => {
    now += 7_000;
    return importer.importImage(source);
  };
  const first = await prepareAlibabaPhotosPage({ importImage, budgetMs: 12_000, clock: () => now });
  assert.equal(first.done, false, 'ran out of time inside product a');
  assert.equal(first.prepared, 0);
  const second = await prepareAlibabaPhotosPage({
    importImage,
    budgetMs: 60_000,
    clock: () => now,
  });
  assert.equal(second.prepared, 1);
  assert.equal(importer.calls.filter((call) => call === url('a-g2')).length, 1);
  assert.deepEqual((store.products?.[0] as CollectionDoc).imageIds, ['img-a-g1']);
});
