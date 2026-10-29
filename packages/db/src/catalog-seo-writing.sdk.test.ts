import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { approveCatalogDetailInCloud, catalogApprovalDigest } from './catalog-detail-commit.ts';
import { persistStagedApprovalInCloud, prepareStagedApproval } from './catalog-detail-staging.ts';
import {
  type AlibabaProductCloudDatabase,
  type NodeSdkDatabase,
  manageCatalogCategoryInCloud,
  mutateAlibabaProductInCloud,
  mutateCatalogRowInCloudBase,
  saveCatalogProductInCloudBase,
  upsertDocWithAlibabaLeaseInCloudBase,
} from './cloudbase-adapter.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const now = '2026-10-29T01:00:00.000Z';
function nativeDatabase(value: unknown): asserts value is NodeSdkDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
  assert.equal(typeof Reflect.get(value, 'command'), 'object');
}

test('the production catalog mutation sends the product and SEO request in the same installed-SDK transaction', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('products', 'p', { name: 'Old headset', published: true, productFamily: 'misc' });
  const result = await mutateCatalogRowInCloudBase(
    fixture.db,
    { action: 'update', collection: 'products', id: 'p', data: { name: 'New headset' } },
    now,
    config,
  );
  assert.equal(result.status, 'written');
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.deepEqual(
    writes.map((call) => call.params.collectionName),
    ['products', 'catalogSeoRequests'],
  );
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
  assert.equal(fixture.rows.get('products/p')?.name, 'New headset');
});

test('a failed native commit publishes neither the real product edit nor its SEO request', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('products', 'p', { name: 'Old headset', published: true });
  fixture.control.failNextCommit = true;
  await assert.rejects(
    mutateCatalogRowInCloudBase(
      fixture.db,
      { action: 'update', collection: 'products', id: 'p', data: { name: 'New headset' } },
      now,
      config,
    ),
    /Synthetic commit failure/,
  );
  assert.equal(fixture.rows.get('products/p')?.name, 'Old headset');
  assert.equal(
    [...fixture.rows].some(([key]) => key.startsWith('catalogSeoRequests/')),
    false,
  );
  assert.equal(fixture.calls.at(-1)?.api, 'database.abortTransaction');
});

test('a rejected request write rolls back the product even after its SDK set succeeded', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('products', 'p', { name: 'Old headset', published: true });
  fixture.control.zeroWriteCollection = 'catalogSeoRequests';
  await assert.rejects(
    mutateCatalogRowInCloudBase(
      fixture.db,
      { action: 'update', collection: 'products', id: 'p', data: { name: 'New headset' } },
      now,
      config,
    ),
    /not confirmed/,
  );
  assert.equal(fixture.rows.get('products/p')?.name, 'Old headset');
  assert.equal(
    [...fixture.rows].some(([key]) => key.startsWith('catalogSeoRequests/')),
    false,
  );
});

test('native category edits create a family request without scanning products', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('users', 'admin', { role: 'admin' });
  const result = await manageCatalogCategoryInCloud(
    fixture.db,
    'admin',
    {
      kind: 'taxonomy',
      operation: 'save',
      family: 'misc',
      expectedRevision: 0,
      name: 'Products for work',
      children: [],
    },
    now,
    config,
  );
  assert.equal(result.status, 'configured');
  const request = [...fixture.rows].find(([key]) => key.startsWith('catalogSeoRequests/'))?.[1];
  assert.equal(request?.kind, 'family');
  assert.equal(request?.family, 'misc');
  assert.equal(
    fixture.calls.some((call) => call.params.collectionName === 'products'),
    false,
  );
});

test('the supplier mutation path records a public row change under its existing product transaction', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('products', 'p', {
    name: 'Headset',
    published: true,
    alibabaPrimarySourceKey: 'source',
    alibabaLinkRevision: 0,
  });
  const native: unknown = fixture.db;
  nativeAlibabaDatabase(native);
  const result = await mutateAlibabaProductInCloud(
    native,
    {
      action: 'unlink',
      productId: 'p',
      expectedRevision: 0,
      expectedPrimarySourceKey: 'source',
      expectedLinks: [],
      now,
    },
    config,
  );
  assert.equal(result.ok, true);
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
});

test('real staged approval of an already public product creates a request when the public pointer changes', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  const header = {
    _id: 'p',
    schemaVersion: 'catalog-product-detail-v1',
    name: 'Headset',
    descriptionText: 'Old public body',
    images: [],
    facts: [],
    offers: [],
  };
  const product = {
    _id: 'p',
    name: 'Headset',
    description: 'New reviewed body',
    published: true,
    productFamily: 'misc',
    imageIds: [],
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: 0 },
  };
  const command = {
    productId: 'p',
    operationId: '12345678-1234-4234-8234-123456789012',
    expectedRevision: 'old',
    expectedDigest: catalogApprovalDigest(product, []),
  };
  const prepared = prepareStagedApproval('admin', command, product, []);
  assert.ok(prepared.ok, JSON.stringify(prepared));
  fixture.put('products', 'p', product);
  fixture.put('users', 'admin', { role: 'admin' });
  fixture.put('catalogDetailApprovals', prepared.value._id, prepared.value);
  const result = await persistStagedApprovalInCloud(
    fixture.db,
    'admin',
    { action: 'finish', jobId: prepared.value._id },
    config,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const request = [...fixture.rows].find(([key]) => key.startsWith('catalogSeoRequests/'))?.[1];
  assert.equal(request?.productId, 'p');
  assert.equal(request?.previouslyPublic, true);
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
});

function nativeAlibabaDatabase(value: unknown): asserts value is AlibabaProductCloudDatabase {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
  assert.equal(typeof Reflect.get(value, 'collection'), 'function');
}

test('the supplier lease fence, product and request share one native commit; a lost lease writes neither', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  const guard = { connectionId: 'source-connection', holder: 'sync-worker', fence: 1, now };
  fixture.put('alibabaSyncLeases', guard.connectionId, {
    holder: guard.holder,
    fence: guard.fence,
    expiresAt: '2026-10-29T02:00:00.000Z',
  });
  fixture.put('products', 'p', { name: 'Old', published: true });
  assert.equal(
    await upsertDocWithAlibabaLeaseInCloudBase(
      fixture.db,
      'products',
      'p',
      { name: 'New' },
      {},
      guard,
      config,
    ),
    true,
  );
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.deepEqual(
    writes.map((call) => call.params.collectionName),
    ['alibabaSyncLeases', 'products', 'catalogSeoRequests'],
  );
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
  const saved = structuredClone([...fixture.rows]);
  const count = fixture.calls.length;
  assert.equal(
    await upsertDocWithAlibabaLeaseInCloudBase(
      fixture.db,
      'products',
      'p',
      { name: 'Wrong' },
      {},
      { ...guard, fence: 2 },
      config,
    ),
    false,
  );
  assert.deepEqual([...fixture.rows], saved);
  assert.equal(
    fixture.calls.slice(count).some((call) => call.api === 'database.modifyDocument'),
    false,
  );
});

test('a real SDK conflict retries from the new product and keeps one latest request', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('products', 'p', { name: 'Old', published: true, privateNote: 'before' });
  fixture.control.beforeCommit = () => {
    fixture.control.beforeCommit = undefined;
    fixture.put('products', 'p', {
      name: 'Old',
      published: true,
      privateNote: 'concurrent private edit',
    });
  };
  const result = await mutateCatalogRowInCloudBase(
    fixture.db,
    { action: 'update', collection: 'products', id: 'p', data: { name: 'New' } },
    now,
    config,
  );
  assert.equal(result.status, 'written');
  assert.equal(fixture.rows.get('products/p')?.privateNote, 'concurrent private edit');
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
  assert.equal(fixture.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
});

test('legacy atomic approval accepts the installed SDK acknowledgement for a newly created request', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  const header = {
    _id: 'p',
    schemaVersion: 'catalog-product-detail-v1',
    name: 'Headset',
    descriptionText: 'Approved body',
    images: [],
    facts: [],
    offers: [],
  };
  const product = {
    _id: 'p',
    name: 'Headset',
    published: true,
    imageIds: [],
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
  };
  fixture.put('products', 'p', product);
  fixture.put('users', 'admin', { role: 'admin' });
  const result = await approveCatalogDetailInCloud(
    fixture.db,
    'admin',
    {
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    config,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
});

test('legacy approval retains all 46 variants within the native operation limit with SEO enabled', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  const header = {
    _id: 'p',
    schemaVersion: 'catalog-product-detail-v1',
    name: 'Headset',
    images: [],
    facts: [],
    offers: [],
  };
  const variants = Array.from({ length: 46 }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    sku: `SKU-${position}`,
    optionValues: { Color: `${position}` },
    position,
    imageIds: [],
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'r1',
    detailSourceMissing: false,
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const product = {
    _id: 'p',
    name: 'Headset',
    published: true,
    imageIds: [],
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'r1', variantIds: variants.map((v) => v._id) },
  };
  fixture.put('products', 'p', product);
  fixture.put('users', 'admin', { role: 'admin' });
  for (const variant of variants) fixture.put('productVariants', variant._id, variant);
  const result = await approveCatalogDetailInCloud(
    fixture.db,
    'admin',
    {
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    config,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.variants, 46);
  for (const variant of variants)
    assert.equal(
      fixture.rows.get(`productVariants/${variant._id}`)?.catalogDetailRevision,
      result.revision,
    );
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
  assert.ok(
    fixture.calls.filter((c) => ['database.getDocument', 'database.modifyDocument'].includes(c.api))
      .length <= 100,
  );
});

test('the dedicated product form save commits its public creation and request together', async (t) => {
  const fixture = articleSdkFixture(t);
  nativeDatabase(fixture.db);
  fixture.put('images', 'image', {
    status: 'active',
    storageProvider: 'cloudbase-storage',
    publishedRefCount: 0,
  });
  const result = await saveCatalogProductInCloudBase(
    fixture.db,
    {
      mode: 'create',
      productId: 'p',
      data: {
        name: 'Headset',
        description: 'Public product description',
        imageIds: ['image'],
        published: true,
        archived: false,
        productFamily: 'misc',
      },
    },
    now,
    config,
  );
  assert.equal(result.result, 'saved', JSON.stringify(result));
  assert.equal(fixture.rows.get('products/p')?.published, true);
  assert.equal(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')).length,
    1,
  );
  const writes = fixture.calls.filter((c) => c.api === 'database.modifyDocument');
  assert.equal(new Set(writes.map((c) => c.params.transactionId)).size, 1);
});
