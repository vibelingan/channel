/** What changed at Alibaba, for the admin's side-by-side review (DEC-19, DEC-20; MIU-41). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import { type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { SupplierReviewSchema } from '@vibelingan-channel/shared/catalog-supplier-review';
import { sourceVariantIds } from './catalog-detail-source.ts';
import { pendingSupplierParts, readSupplierReview } from './catalog-supplier-review.ts';

const url = (name: string) => `https://sc04.alicdn.com/${name}.jpg`;
const path = (name: string) => `/api/images/img-${name}`;

function observation(
  text: string,
  gallery: string[],
  descriptionImages: string[] = [],
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
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
    throw new Error('not used: the review is read-only');
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

const reader = { listApprovedVariants: async () => [] };
const review = async (actor = 'admin') => {
  const result = await readSupplierReview(
    actor,
    { action: 'supplier-review', productId: 'p1' },
    reader,
  );
  if (result.ok) SupplierReviewSchema.parse(result);
  return result;
};
const sha = (part: string, value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify([part, value]))
    .digest('hex');

test('each part that differs shows the website and the incoming value, with where ours came from', async () => {
  store();
  const result = await review();
  assert.ok(result.ok);
  assert.deepEqual(result.parts, [
    {
      part: 'description',
      website: { text: 'Old text' },
      incoming: { text: 'New text' },
      origin: 'supplier',
      incomingDigest: sha('description', 'New text'),
    },
    {
      part: 'gallery',
      website: { imageIds: ['img-a', 'img-b'] },
      // In the supplier's order; photo c is not imported yet.
      incoming: { urls: [url('c'), url('a')], imageIds: [null, 'img-a'] },
      origin: 'supplier',
      incomingDigest: sha('gallery', [url('c'), url('a')]),
    },
    {
      part: 'descriptionImages',
      website: { imageIds: [] },
      incoming: { urls: [url('d')], imageIds: [null] },
      origin: 'supplier',
      incomingDigest: sha('descriptionImages', [url('d')]),
    },
  ]);
});

test('an admin edit is labelled; a decision counts only for the exact incoming value', async () => {
  store({
    description: 'Our own words',
    supplierDecisions: {
      description: { choice: 'keep', incomingDigest: sha('description', 'New text') },
      gallery: { choice: 'keep', incomingDigest: sha('gallery', [url('older')]) },
    },
  });
  const result = await review();
  assert.ok(result.ok);
  const byPart = Object.fromEntries(result.parts.map((part) => [part.part, part]));
  assert.equal(byPart.description?.origin, 'admin');
  assert.equal(byPart.description?.decision, 'keep');
  assert.equal(byPart.gallery?.decision, undefined, 'decided for an older incoming value');
  assert.deepEqual(await pendingSupplierParts(result.parts), ['gallery', 'descriptionImages']);
});

test('parts already equal to the supplier, or with nothing incoming, are not listed', async () => {
  const docs = store({ description: 'New text', imageIds: ['img-a'] });
  const stored = docs.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation('New text', ['a'], []);
  let result = await review();
  assert.ok(result.ok);
  assert.deepEqual(result.parts, []);
  stored.observation = observation('', [], []);
  result = await review();
  assert.ok(result.ok);
  assert.deepEqual(result.parts, [], 'an empty supplier text or gallery is never offered');
});

test('approved before baselines existed: origin is unknown unless the layout shows the text matched', async () => {
  store({}, {});
  let result = await review();
  assert.ok(result.ok);
  assert.deepEqual(
    result.parts.map((part) => part.origin),
    ['unknown', 'unknown', 'unknown'],
  );
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
  result = await review();
  assert.ok(result.ok);
  assert.equal(result.parts[0]?.origin, 'supplier');
});

test('price and configuration changes come old → new; configurations list their photos', async () => {
  const docs = store();
  const stored = docs.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation('Old text', ['a', 'b'], [], {
    variants: [
      {
        sourceVariantKey: 'black',
        options: [{ sourceName: 'Color', value: 'Black' }],
        inventory: [],
        media: [{ sourceUrl: url('e'), position: 0, role: 'variant' }],
      },
    ],
    offers: [
      {
        sourceOfferKey: 'o-product',
        kind: 'supplier',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor: 390 },
      },
    ],
  });
  const variantId = sourceVariantIds('p1', 'source-a', stored.observation as never).get('black');
  assert.ok(variantId);
  const product = docs.products?.[0];
  assert.ok(product);
  product.configurationPhotos = { [variantId]: ['img-b'] };
  const result = await review();
  assert.ok(result.ok);
  assert.deepEqual(result.changes?.configurationsAdded, ['Black']);
  assert.deepEqual(result.changes?.productPrice, {
    before: [],
    after: [{ mode: 'fixed', currency: 'USD', amountMinor: 390 }],
  });
  assert.deepEqual(result.configurations, [
    { id: variantId, label: 'Black', supplierImageIds: null, adminImageIds: ['img-b'] },
  ]);
});

test('drafts have no changes yet; manual products have nothing to review; only admins may read', async () => {
  store({ catalogDetailPublication: undefined });
  const result = await review();
  assert.ok(result.ok);
  assert.equal(result.changes, null);
  store({ alibabaPrimarySourceKey: undefined });
  assert.deepEqual(await review(), { ok: true, parts: [], changes: null, configurations: [] });
  store();
  assert.deepEqual(await review('editor'), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await readSupplierReview('admin', { action: 'supplier-review' }, reader), {
    ok: false,
    code: 'VALIDATION_ERROR',
  });
});
