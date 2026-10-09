/** Alibaba photos copied ahead into our storage; drafts appear ready (PT-G). */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
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
  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return null;
    docs[index] = { ...(docs[index] as CollectionDoc), ...data };
    return structuredClone(docs[index] as CollectionDoc);
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
function fakeImporter(
  store: Store,
  failing: string[] = [],
  reason: 'fetch-failed' | 'not-found' | 'write-failed' = 'fetch-failed',
) {
  const calls: string[] = [];
  const importImage = async (source: string): Promise<MediaImportResult> => {
    calls.push(source);
    if (failing.some((name) => source.includes(name))) return { ok: false, reason };
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
    gallery: {
      sources: [url('a-g1'), url('a-g2')],
      imageIds: ['img-a-g1', 'img-a-g2'],
      unusable: [],
      missing: [],
    },
    description: { sources: [url('a-d1')], imageIds: ['img-a-d1'], unusable: [], missing: [] },
  });
  // Image locks are released.
  assert.ok(store.images?.every((image) => !image.imageMutationOwner));
  // A second pass has nothing to do.
  const again = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(again.prepared, 0);
});

test('prepare: one product is one unit — a passing failure saves nothing and the product tries again in 10 minutes', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true }), draft('b')] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store, ['a-g2']);
  const page = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.equal(page.waiting, 1);
  assert.equal(page.prepared, 1, 'the other product is not held up');
  const a = () => store.products?.find((row) => row._id === 'a') as CollectionDoc;
  assert.equal(a().imageIds, undefined, 'nothing saved for a');
  assert.equal(a().alibabaPhotosPending, true, 'still hidden while incomplete');
  assert.deepEqual((store.products?.[1] as CollectionDoc).imageIds, ['img-b-g1', 'img-b-g2']);
  // Five minutes later: still waiting, nothing fetched again.
  const soon = await prepareAlibabaPhotosPage({
    importImage: importer.importImage,
    now: () => new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  assert.equal(soon.waiting, 1);
  assert.equal(importer.calls.filter((call) => call === url('a-g2')).length, 1);
  // Eleven minutes later it is tried again; everything lands together.
  const later = await prepareAlibabaPhotosPage({
    importImage: fakeImporter(store).importImage,
    now: () => new Date(Date.now() + 11 * 60 * 1000).toISOString(),
  });
  assert.equal(later.prepared, 1);
  assert.deepEqual(a().imageIds, ['img-a-g1', 'img-a-g2']);
  assert.equal(a().alibabaPhotosPending, false);
});

test('prepare: a photo Alibaba no longer has is skipped and does not block the product', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const page = await prepareAlibabaPhotosPage({
    importImage: fakeImporter(store, ['a-g2'], 'not-found').importImage,
  });
  assert.equal(page.prepared, 1);
  const a = store.products?.[0] as CollectionDoc;
  assert.deepEqual(a.imageIds, ['img-a-g1']);
  assert.equal(a.alibabaPhotosPending, false);
  assert.deepEqual(Reflect.get(a.alibabaAutoPhotos as object, 'gallery'), {
    sources: [url('a-g1'), url('a-g2')],
    imageIds: ['img-a-g1'],
    unusable: [url('a-g2')],
    missing: [],
  });
  assert.equal(photoPreparationPlan(a), null, 'not tried again while Alibaba keeps it');
});

test('prepare: a photo that keeps failing is given up after 6 tries so the product can appear', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store, ['a-g2']);
  let minutes = 0;
  let page = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  for (let tries = 1; tries < 6; tries += 1) {
    minutes += 11;
    const at = minutes;
    page = await prepareAlibabaPhotosPage({
      importImage: importer.importImage,
      now: () => new Date(Date.now() + at * 60 * 1000).toISOString(),
    });
  }
  assert.equal(importer.calls.filter((call) => call === url('a-g2')).length, 6);
  assert.equal(page.prepared, 1);
  const a = store.products?.[0] as CollectionDoc;
  assert.deepEqual(a.imageIds, ['img-a-g1']);
  assert.equal(a.alibabaPhotosPending, false);
});

test('prepare: "Copy photos now" tries unavailable photos again, e.g. GIFs once accepted', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  // First the description photo is refused as content we did not accept.
  const refused = fakeImporter(store, ['a-d1'], 'not-found');
  await prepareAlibabaPhotosPage({ importImage: refused.importImage });
  const a = () => store.products?.[0] as CollectionDoc;
  assert.equal(a().descriptionImageIds, undefined);
  assert.deepEqual(Reflect.get(a().alibabaAutoPhotos as object, 'description').unusable, [
    url('a-d1'),
  ]);
  // An automatic run leaves it alone: nothing changed at Alibaba.
  const automatic = fakeImporter(store);
  await prepareAlibabaPhotosPage({ importImage: automatic.importImage });
  assert.deepEqual(automatic.calls, []);
  // A manual retry fetches it again and the product gets it.
  const manual = fakeImporter(store);
  const page = await prepareAlibabaPhotosPage({
    importImage: manual.importImage,
    retryUnavailable: true,
  });
  assert.deepEqual(manual.calls, [url('a-d1')], 'only the unavailable photo is fetched');
  assert.equal(page.prepared, 1);
  assert.deepEqual(a().descriptionImageIds, ['img-a-d1']);
  assert.deepEqual(Reflect.get(a().alibabaAutoPhotos as object, 'description').unusable, []);
  assert.deepEqual(a().imageIds, ['img-a-g1', 'img-a-g2'], 'other parts unchanged');
});

test('prepare: when every photo is unavailable, the draft is shown without photos', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const page = await prepareAlibabaPhotosPage({
    importImage: fakeImporter(store, ['a-'], 'not-found').importImage,
  });
  assert.equal(page.prepared, 1);
  const a = store.products?.[0] as CollectionDoc;
  assert.equal(a.alibabaPhotosPending, false, 'never hidden for good');
  assert.equal(a.imageIds, undefined);
});

test('prepare: a refresh whose new photos are all unavailable keeps the old ones and still follows Alibaba', async () => {
  const filled = draft('a', {
    imageIds: ['img-a-g1'],
    alibabaSourceImageUrls: [url('a-g9')],
    alibabaDescriptionImageUrls: [],
    alibabaPhotosPending: true,
    alibabaAutoPhotos: {
      gallery: { sources: [url('a-g1')], imageIds: ['img-a-g1'], unusable: [], missing: [] },
    },
  });
  const store: Store = { products: [filled] };
  setAdapter(new MemoryAdapter(store));
  const page = await prepareAlibabaPhotosPage({
    importImage: fakeImporter(store, ['a-g9'], 'not-found').importImage,
  });
  assert.equal(page.prepared, 1);
  const a = () => store.products?.[0] as CollectionDoc;
  assert.deepEqual(a().imageIds, ['img-a-g1']);
  assert.equal(a().alibabaPhotosPending, false);
  assert.deepEqual(Reflect.get(a().alibabaAutoPhotos as object, 'gallery'), {
    sources: [url('a-g9')],
    imageIds: ['img-a-g1'],
    unusable: [url('a-g9')],
    missing: [],
  });
  assert.equal(photoPreparationPlan(a()), null, 'nothing to do until Alibaba changes again');
  // Alibaba's next change is still the sync's to follow.
  assert.deepEqual(
    photoPreparationPlan({ ...a(), alibabaSourceImageUrls: [url('a-g10')] })?.parts.map(
      (part) => part.part,
    ),
    ['gallery'],
  );
});

test('prepare: a hidden product approved or published before its photos landed is shown again', async () => {
  for (const state of [
    { published: true, catalogDetailApprovalReceipt: { contentFingerprint: 'x' } },
    { catalogDetailApprovalReceipt: { contentFingerprint: 'x' } },
    { archived: true },
  ]) {
    const store: Store = { products: [draft('a', { alibabaPhotosPending: true, ...state })] };
    setAdapter(new MemoryAdapter(store));
    const importer = fakeImporter(store);
    const page = await prepareAlibabaPhotosPage({ importImage: importer.importImage });
    assert.equal(page.prepared, 1, JSON.stringify([state, page.failures]));
    assert.equal(page.failures.length, 0);
    assert.equal(page.busy, 0);
    const a = store.products?.[0] as CollectionDoc;
    assert.equal(a.alibabaPhotosPending, false, 'back in the admin list');
    assert.equal(a.imageIds, undefined, 'its photos are not touched');
    assert.equal(a.alibabaAutoPhotos, undefined);
    assert.deepEqual(importer.calls, [], 'nothing copied');
  }
});

test('prepare: a failure in our own storage never counts toward giving a photo up', async () => {
  const store: Store = { products: [draft('a', { alibabaPhotosPending: true })] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store, ['a-g2'], 'write-failed');
  for (let tries = 0; tries < 8; tries += 1) {
    const at = tries * 11;
    const page = await prepareAlibabaPhotosPage({
      importImage: importer.importImage,
      now: () => new Date(Date.now() + at * 60 * 1000).toISOString(),
    });
    assert.equal(page.waiting, 1, `try ${tries + 1}`);
  }
  assert.equal(importer.calls.filter((call) => call === url('a-g2')).length, 8);
  assert.equal((store.products?.[0] as CollectionDoc).alibabaPhotosPending, true);
});

test('prepare: a refresh with a passing failure keeps the old photos and keeps following Alibaba', async () => {
  const filled = draft('a', {
    imageIds: ['img-a-g1'],
    alibabaSourceImageUrls: [url('a-g9')],
    alibabaDescriptionImageUrls: [],
    alibabaAutoPhotos: {
      gallery: { sources: [url('a-g1')], imageIds: ['img-a-g1'], unusable: [], missing: [] },
    },
  });
  const store: Store = { products: [filled] };
  setAdapter(new MemoryAdapter(store));
  await prepareAlibabaPhotosPage({ importImage: fakeImporter(store, ['a-g9']).importImage });
  const a = store.products?.[0] as CollectionDoc;
  assert.deepEqual(a.imageIds, ['img-a-g1']);
  assert.deepEqual(a.alibabaAutoPhotos, filled.alibabaAutoPhotos);
  assert.deepEqual(
    photoPreparationPlan(a)?.parts.map((part) => part.part),
    ['gallery'],
    'still the sync to refresh',
  );
});

test('prepare: drafts filled under the earlier rule with photos missing are prepared again', () => {
  const earlier = draft('a', {
    imageIds: ['img-a-g1'],
    alibabaDescriptionImageUrls: [],
    alibabaAutoPhotos: {
      gallery: {
        sources: [url('a-g1'), url('a-g2')],
        imageIds: ['img-a-g1'],
        missing: [url('a-g2')],
      },
    },
  });
  assert.deepEqual(
    photoPreparationPlan(earlier)?.parts.map((part) => part.part),
    ['gallery'],
  );
});

test('prepare: a draft approved, published or archived while its photos copy is left alone', async () => {
  for (const change of [
    { catalogDetailApprovalReceipt: { contentFingerprint: 'x' } },
    { published: true },
    { archived: true },
  ]) {
    const store: Store = { products: [draft('a')] };
    setAdapter(new MemoryAdapter(store));
    const importer = fakeImporter(store);
    const page = await prepareAlibabaPhotosPage({
      importImage: async (source) => {
        // Approval writes the product without a new revision.
        Object.assign(store.products?.[0] as CollectionDoc, change);
        return importer.importImage(source);
      },
    });
    assert.equal(page.busy, 1);
    assert.equal((store.products?.[0] as CollectionDoc).imageIds, undefined);
  }
});

test('prepare: an image removed before the save is never referenced', async () => {
  const store: Store = { products: [draft('a', { alibabaDescriptionImageUrls: [] })] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  const page = await prepareAlibabaPhotosPage({
    importImage: async (source) => {
      const result = await importer.importImage(source);
      // An admin removes the unreferenced candidate right after it was copied.
      if (result.ok)
        store.images = (store.images ?? []).filter((image) => image._id !== result.imageId);
      return result;
    },
  });
  assert.equal(page.busy, 1);
  assert.equal((store.products?.[0] as CollectionDoc).imageIds, undefined);
});

test('plan: a photo list an admin emptied is theirs, never refilled', () => {
  assert.deepEqual(
    photoPreparationPlan(draft('a', { descriptionImageIds: [] }))?.parts.map((part) => part.part),
    ['gallery'],
  );
});

test('prepare: configuration photos are copied for approval without changing the product photos', async () => {
  const observationDoc = {
    _id: sourceObservationDocumentId('alibaba', 'source-a'),
    observation: {
      schemaVersion: 'catalog-source-observation-v1',
      source: {
        provider: 'alibaba',
        sourceProductKey: 'source-a',
        externalProductId: '987',
        observedAt: '2026-10-01T00:00:00.000Z',
        captureMode: 'full',
        completeness: 'full-product',
      },
      identity: { title: 'Supplier title', matchHints: {}, attributes: [] },
      content: {
        description: {
          text: 'Supplier text',
          imageUrls: [],
          placeholder: false,
          sanitized: true,
          provenance: 'provider-description',
        },
        media: [],
      },
      lifecycle: { sourceListingStatus: 'published' },
      variants: [
        {
          sourceVariantKey: 'white',
          options: [{ sourceName: 'Color', value: 'White' }],
          inventory: [],
          media: [{ sourceUrl: url('a-white'), position: 0, role: 'variant' }],
        },
      ],
      offers: [],
      evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
      warnings: [],
    },
  };
  const store: Store = {
    products: [draft('a', { imageIds: ['own'], descriptionImageIds: ['own-d'] })],
    catalogSourceObservations: [observationDoc],
  };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  assert.deepEqual(importer.calls, [url('a-white')]);
  const a = store.products?.[0] as CollectionDoc;
  assert.deepEqual(a.imageIds, ['own']);
  assert.deepEqual(a.descriptionImageIds, ['own-d']);
  assert.deepEqual(a.alibabaAutoPhotos, {
    configurations: { sources: [url('a-white')], imageIds: [], unusable: [], missing: [] },
  });
});

test('prepare: every call makes progress, even with no time left', async () => {
  const store: Store = { products: [draft('a')] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  let calls = 0;
  let after = '';
  for (;;) {
    calls += 1;
    const page = await prepareAlibabaPhotosPage({
      afterProductId: after,
      importImage: importer.importImage,
      budgetMs: 0,
    });
    if (page.done) break;
    after = page.nextProductId;
    assert.ok(calls < 10, 'no endless loop');
  }
  assert.deepEqual((store.products?.[0] as CollectionDoc).imageIds, ['img-a-g1', 'img-a-g2']);
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
  const importer = fakeImporter(store, ['a-g2'], 'not-found');
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

test('prepare: a call stops at its time limit even when nothing needs downloading', async () => {
  // Photos already copied: every product is quick, but a page of many must
  // still stop once its time is up (seen in the production catch-up).
  const store: Store = { products: [draft('a'), draft('b'), draft('c')] };
  setAdapter(new MemoryAdapter(store));
  const importer = fakeImporter(store);
  await prepareAlibabaPhotosPage({ importImage: importer.importImage });
  for (const product of store.products ?? []) {
    product.alibabaSourceImageUrls = [url(`${product._id}-g1`)];
    product.alibabaDescriptionImageUrls = [];
  }
  const page = await prepareAlibabaPhotosPage({
    importImage: importer.importImage,
    budgetMs: 0,
  });
  assert.equal(page.done, false);
  assert.equal(page.visited, 1, 'one product, then the time limit');
});
