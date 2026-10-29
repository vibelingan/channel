import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type CatalogSeoRequest,
  catalogSeoRequests,
  catalogSeoRequestsForStore,
  readCatalogSeoRecordingConfig,
} from './catalog-seo-requests.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const now = '2026-10-29T01:00:00.000Z';
const product: CollectionDoc = {
  _id: 'p',
  name: 'Headset',
  published: true,
  productFamily: 'misc',
};

test('a public product edit produces one scoped pending request without private content', () => {
  const requests = catalogSeoRequests(
    [
      {
        collection: 'products',
        before: product,
        after: { ...product, name: 'New headset', vipPrice: 123, privateNote: 'secret' },
      },
    ],
    config,
    now,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0] ?? {}).sort(), [
    '_id',
    'kind',
    'previouslyPublic',
    'productId',
    'requestedAt',
    'schemaVersion',
    'siteOrigin',
    'state',
    'token',
  ]);
  assert.equal(productRequest(requests[0]).productId, 'p');
  assert.equal(requests[0]?.kind, 'product');
  assert.equal(requests[0]?.state, 'pending');
  assert.equal(requests[0]?.siteOrigin, config.siteOrigin);
  assert.equal(productRequest(requests[0]).previouslyPublic, true);
  assert.equal(requests[0]?.requestedAt, now);
  assert.doesNotMatch(JSON.stringify(requests), /secret|123|New headset/);
});

test('internal edits and private drafts produce no SEO request', () => {
  assert.deepEqual(
    catalogSeoRequests(
      [
        {
          collection: 'products',
          before: product,
          after: {
            ...product,
            vipPrice: 99,
            catalogContentGeneration: 9,
            updatedAt: now,
            alibabaSourceLastSyncedAt: now,
          },
        },
        {
          collection: 'products',
          before: { ...product, published: false },
          after: { ...product, published: false, name: 'Private' },
        },
      ],
      config,
      now,
    ),
    [],
  );
});

test('publishing, withdrawal and removal target the same durable request without erasing delivery leases', () => {
  const make = (before: CollectionDoc | null, after: CollectionDoc | null) =>
    productRequest(catalogSeoRequests([{ collection: 'products', before, after }], config, now)[0]);
  const a = make(null, product);
  const b = make(product, { ...product, published: false });
  const c = make(product, null);
  assert.equal(a?._id, b?._id);
  assert.equal(b?._id, c?._id);
  assert.notEqual(a?.token, b?.token);
  assert.equal(a?.previouslyPublic, false);
  assert.equal(b?.previouslyPublic, true);
  assert.equal(c?.previouslyPublic, true);
  assert.equal('lease' in (a ?? {}), false);
});

test('recording is disabled by default and an enabled target must be explicit and canonical', () => {
  assert.equal(readCatalogSeoRecordingConfig({}), undefined);
  assert.equal(readCatalogSeoRecordingConfig({ CATALOG_SEO_RECORDING: '0' }), undefined);
  assert.throws(() => readCatalogSeoRecordingConfig({ CATALOG_SEO_RECORDING: '1' }));
  assert.throws(() => readCatalogSeoRecordingConfig({ CATALOG_SEO_RECORDING: 'yes' }));
  assert.deepEqual(
    readCatalogSeoRecordingConfig({
      CATALOG_SEO_RECORDING: '1',
      CATALOG_SEO_SITE_ORIGIN: config.siteOrigin,
      CATALOG_DETAIL_APPROVAL_ENABLED: '1',
    }),
    config,
  );
  assert.throws(() =>
    readCatalogSeoRecordingConfig({
      CATALOG_SEO_RECORDING: '1',
      CATALOG_SEO_SITE_ORIGIN: 'https://shop.example/',
    }),
  );
  assert.throws(() =>
    readCatalogSeoRecordingConfig({
      CATALOG_SEO_RECORDING: '1',
      CATALOG_SEO_SITE_ORIGIN: config.siteOrigin,
      SITE_URL: 'https://other.example',
    }),
  );
});

test('whole-store comparison catches actual product and variant edits once per product', () => {
  const before = {
    products: [product],
    productVariants: [{ _id: 'v', productId: 'p', sku: 'Black' }],
  };
  const after = {
    products: [{ ...product, name: 'New' }],
    productVariants: [{ _id: 'v', productId: 'p', sku: 'White' }],
  };
  const requests = catalogSeoRequestsForStore(before, after, config, now);
  assert.equal(requests.length, 1);
  assert.equal(productRequest(requests[0]).productId, 'p');
});

function productRequest(row: CatalogSeoRequest | undefined) {
  assert.ok(row?.kind === 'product');
  return row;
}

test('private SKU media bookkeeping does not enqueue another public check', () => {
  const publication = {
    state: 'approved',
    revision: 'r1',
    header: {
      _id: 'p',
      schemaVersion: 'catalog-product-detail-v1',
      name: 'Headset',
      descriptionText: 'Reviewed body',
      images: [],
      facts: [],
      offers: [],
    },
    variantCount: 0,
    variantStorage: 'immutable-v1',
    variantImageIds: ['private-a'],
  };
  const before = { ...product, catalogDetailPublication: publication };
  assert.deepEqual(
    catalogSeoRequests(
      [
        {
          collection: 'products',
          before,
          after: {
            ...before,
            catalogDetailPublication: { ...publication, variantImageIds: ['private-b'] },
          },
        },
      ],
      config,
      now,
    ),
    [],
  );
  assert.equal(
    catalogSeoRequests(
      [
        {
          collection: 'products',
          before,
          after: { ...before, catalogDetailPublication: { ...publication, revision: 'r2' } },
        },
      ],
      config,
      now,
    ).length,
    1,
    'a new immutable variant revision must still be checked',
  );
});

test('variant movement updates both visible parents, while private and immutable variants do not', () => {
  const other = { ...product, _id: 'other' };
  const row = { _id: 'v', productId: 'p', sku: 'Black', position: 0 };
  const parents = {
    before: (id: string) => (id === 'p' ? product : other),
    after: (id: string) => (id === 'p' ? product : other),
  };
  const changes = [
    { collection: 'productVariants', before: row, after: { ...row, productId: 'other' } },
  ];
  assert.deepEqual(
    catalogSeoRequests(changes, config, now, parents).map((r) => productRequest(r).productId),
    ['other', 'p'],
  );
  assert.throws(() => catalogSeoRequests(changes, config, now), /parent snapshot/);
  const hidden = { ...product, published: false };
  assert.deepEqual(
    catalogSeoRequests(changes, config, now, { before: () => hidden, after: () => hidden }),
    [],
  );
  const approved = {
    ...product,
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      header: {
        _id: 'p',
        schemaVersion: 'catalog-product-detail-v1',
        name: 'Headset',
        descriptionText: 'Approved',
        images: [],
        facts: [],
        offers: [],
      },
      variantCount: 1,
      variantStorage: 'immutable-v1',
    },
  };
  assert.deepEqual(
    catalogSeoRequests(
      [{ collection: 'productVariants', before: row, after: { ...row, sku: 'White' } }],
      config,
      now,
      { before: () => approved, after: () => approved },
    ),
    [],
  );
});

test('the same product in two sites has two independent request identities', () => {
  const changes = [
    { collection: 'products', before: product, after: { ...product, name: 'Changed' } },
  ];
  assert.notEqual(
    catalogSeoRequests(changes, config, now)[0]?._id,
    catalogSeoRequests(changes, { ...config, siteOrigin: 'https://other.example' }, now)[0]?._id,
  );
});

test('invalid product identities fail instead of creating an undeliverable request', () => {
  assert.throws(() =>
    catalogSeoRequests(
      [{ collection: 'products', before: null, after: { ...product, _id: 'p\nother' } }],
      config,
      now,
    ),
  );
});

test('taxonomy fences do not enqueue work, while visible names and archived children do', () => {
  const taxonomy = {
    _id: 'misc',
    family: 'misc',
    revision: 1,
    name: 'Products',
    children: [{ id: 'work', name: 'Work', slug: 'work', order: 0, status: 'active' }],
  };
  const change = (after: CollectionDoc) =>
    catalogSeoRequests([{ collection: 'catalogTaxonomies', before: taxonomy, after }], config, now);
  assert.deepEqual(change({ ...taxonomy, revision: 2, assignmentFence: 9 }), []);
  for (const after of [
    { ...taxonomy, name: 'Office products' },
    { ...taxonomy, children: [{ ...taxonomy.children[0], status: 'archived' }] },
  ]) {
    const requests = change(after);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, 'family');
  }
});
