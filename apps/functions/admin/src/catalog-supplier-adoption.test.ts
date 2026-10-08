/** Which parts an approval may take from the supplier (DEC-18, MIU-39). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import { type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planSupplierAdoption } from './catalog-supplier-adoption.ts';

const url = (name: string) => `https://sc04.alicdn.com/${name}.jpg`;
const path = (name: string) => `/api/images/img-${name}`;

function observation(text: string, gallery: string[], descriptionImages: string[] = []) {
  return {
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
        text,
        imageUrls: descriptionImages.map(url),
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
      media: gallery.map((name, position) => ({
        sourceUrl: url(name),
        position,
        role: position === 0 ? 'primary' : 'gallery',
      })),
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
    warnings: [],
  };
}

/**
 * A live product approved when its text was "Old text" and its gallery the
 * supplier's photos a and b, all the supplier's own. The supplier now has
 * "New text" and photos c and a; photo c is not imported yet.
 */
function store(
  product: Record<string, unknown> = {},
  receipt: Record<string, unknown> = {
    supplierParts: { description: true, gallery: true, descriptionImages: true },
  },
  publication: Record<string, unknown> = {},
) {
  const header = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p1',
    name: 'Headset',
    images: [path('a'), path('b')],
    facts: [],
    offers: [],
    descriptionText: 'Old text',
  };
  const docs: Record<string, CollectionDoc[]> = {
    users: [
      { _id: 'admin', role: 'admin' },
      { _id: 'editor', role: 'contributor' },
    ],
    products: [
      {
        _id: 'p1',
        name: 'Headset',
        description: 'Old text',
        imageIds: ['img-a', 'img-b'],
        published: true,
        alibabaPrimarySourceKey: 'source-a',
        catalogDetailPublication: {
          state: 'approved',
          revision: 'r1',
          header,
          variantCount: 0,
          ...publication,
        },
        catalogDetailApprovalReceipt: { revision: 'r1', ...receipt },
        ...product,
      },
    ],
    catalogSourceObservations: [
      {
        _id: sourceObservationDocumentId('alibaba', 'source-a'),
        observation: observation('New text', ['c', 'a'], ['d']),
      },
    ],
    catalogSourceLinks: ['a', 'b'].map((name) => ({
      _id: sourceMediaLinkId('alibaba', url(name)),
      provider: 'alibaba',
      sourceUrl: url(name),
      imageId: `img-${name}`,
    })),
  };
  const unused = async (): Promise<never> => {
    throw new Error('not used: the plan is read-only');
  };
  const adapter = {
    get: async (collection: string, id: string) =>
      structuredClone(docs[collection]?.find((doc) => doc._id === id) ?? null),
    list: unused,
    findByField: unused,
    create: unused,
    update: unused,
    remove: unused,
    incrementField: unused,
  } as unknown as DbAdapter;
  setAdapter(adapter);
  return docs;
}

const plan = (actor = 'admin') =>
  planSupplierAdoption(actor, { action: 'supplier-adoption', productId: 'p1' });

test('unedited parts take the supplier’s new text and photos, in the supplier’s order', async () => {
  store();
  assert.deepEqual(await plan(), {
    ok: true,
    adoption: {
      description: 'New text',
      gallery: [url('c'), url('a')],
      descriptionImages: [url('d')],
    },
  });
});

test('a part an admin edited since the approval keeps the admin’s version', async () => {
  store({ description: 'Our own words', imageIds: ['img-b', 'img-a'] });
  // Text changed and photos reordered after approval; description images untouched.
  assert.deepEqual(await plan(), {
    ok: true,
    adoption: { descriptionImages: [url('d')] },
  });
});

test('a part that was already the admin’s at approval stays the admin’s', async () => {
  store({}, { supplierParts: { description: false, gallery: false, descriptionImages: true } });
  assert.deepEqual(await plan(), { ok: true, adoption: { descriptionImages: [url('d')] } });
});

test('nothing to take when the row already shows the supplier’s version', async () => {
  const docs = store();
  const stored = docs.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation('Old text', ['a', 'b']);
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
});

test('an empty supplier text or gallery never wipes ours', async () => {
  const docs = store();
  const stored = docs.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation('', []);
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
});

test('approvals from before MIU-39: the text counts as the supplier’s only when its layout was kept', async () => {
  // Structured content is kept only when the row text equalled the supplier's.
  store(
    {},
    {},
    {
      content: {
        schemaVersion: 'catalog-content-v1',
        specifications: [],
        packaging: [],
        notes: [],
      },
    },
  );
  assert.deepEqual(await plan(), { ok: true, adoption: { description: 'New text' } });
  store({}, {});
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
});

test('manual, unapproved and archived products, and contributors, get nothing', async () => {
  store({ alibabaPrimarySourceKey: undefined });
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
  store({ catalogDetailPublication: undefined });
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
  store({ archived: true });
  assert.deepEqual(await plan(), { ok: true, adoption: {} });
  store();
  assert.deepEqual(await plan('editor'), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await planSupplierAdoption('admin', { action: 'supplier-adoption' }), {
    ok: false,
    code: 'VALIDATION_ERROR',
  });
});

test('photos that would push the approval past its image limit wait for a later one', async () => {
  // Finish touches every image of the old and new versions: at most 46 (5 fixed
  // + 2 per image ≤ 98 operations). The row's 2 photos + SKU photos count too.
  const skuPhotos = (count: number) => ({
    variantImageIds: Array.from({ length: count }, (_, index) => `sku-${index}`),
  });
  store({}, undefined, skuPhotos(43));
  // 45 now; the gallery adds photo c (46, fits); the description photo d would be 47.
  assert.deepEqual(await plan(), {
    ok: true,
    adoption: { description: 'New text', gallery: [url('c'), url('a')] },
    deferred: ['descriptionImages'],
  });
  store({}, undefined, skuPhotos(44));
  assert.deepEqual(await plan(), {
    ok: true,
    adoption: { description: 'New text' },
    deferred: ['gallery', 'descriptionImages'],
  });
});

test('the plan names the product revision it judged, for the guarded save', async () => {
  store({ updatedAt: '2026-10-08T00:00:00.000Z' });
  const result = await plan();
  assert.ok(result.ok);
  assert.equal(result.updatedAt, '2026-10-08T00:00:00.000Z');
});

test('the image limit also counts the supplier\u2019s configuration photos', async () => {
  // Finish's new version carries the re-prepared configurations' photos too.
  const docs = store({}, undefined, {
    variantImageIds: Array.from({ length: 40 }, (_, index) => `sku-${index}`),
  });
  const stored = docs.catalogSourceObservations?.[0];
  assert.ok(stored);
  const observed = observation('New text', ['c', 'a'], ['d']) as Record<string, unknown>;
  observed.variants = [
    {
      sourceVariantKey: 'black',
      options: [{ sourceName: 'Color', value: 'Black' }],
      inventory: [],
      media: ['e', 'f', 'g', 'h'].map((name, position) => ({
        sourceUrl: url(name),
        position,
        role: 'variant',
      })),
    },
  ];
  stored.observation = observed;
  // 42 now + 4 new configuration photos = 46; any taken photo would be 47.
  assert.deepEqual(await plan(), {
    ok: true,
    adoption: { description: 'New text' },
    deferred: ['gallery', 'descriptionImages'],
  });
});
