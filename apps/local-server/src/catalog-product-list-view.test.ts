import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth';
import { setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';
const view = 'admin-product-list-v1';
const marker = '_adminProductListView';
async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-product-list-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const products = Array.from({ length: 25 }, (_, i) => ({
    _id: `p-${String(i).padStart(2, '0')}`,
    name: `Clock ${i}`,
    productFamily: 'misc',
    category: 'legacy',
    subcategoryIds: ['clock'],
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...(i === 0 ? {} : { published: false }),
    description: `description-search-needle-${'多'.repeat(20000)}`,
    series: 'private-series',
    catalogPublication: { privateContent: 'private-publication' },
    catalogPreparationReport: { privateContent: 'private-report' },
    futurePrivateField: { text: 'future-private' },
    alibabaAutoPhotos: {
      gallery: { sources: ['https://sc04.alicdn.com/kf/g1.jpg'], imageIds: ['im-1'] },
      description: { sources: ['description-private'] },
      configs: { private: 'private-config' },
    },
    imageIds: ['im-1'],
    skuCode: 'sku',
    modName: 'model',
    moq: 3,
    alibabaReviewPending: true,
    alibabaReviewReason: 'new',
    alibabaSourceReview: { privateTest: 'metadata-must-remain-exact' },
    manualCatalogPricing: { privateTest: 'pricing-must-remain-exact' },
  }));
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }], products }));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const token = await signSession('owned-list-view', {
    sub: 'admin',
    role: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
  });
  const request = (action: string, data: Record<string, unknown>) =>
    handleAdminRequest({ action, token, data }, { jwtSecret: 'owned-list-view' });
  return { adapter, file, products, request };
}
test('opt-in list uses a detached fixed projection while raw get and legacy list stay complete', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.file, 'utf8');
  const response = await f.request('list', {
    collection: 'products',
    catalogListView: view,
    catalogReadiness: 'all',
    pageSize: 20,
    sort: [{ field: '_id', dir: 'asc' }],
  });
  assert.ok(response.ok, JSON.stringify(response));
  const data = response.data as {
    items: Record<string, unknown>[];
    total: number;
    catalogListView?: string;
  };
  assert.equal(data.catalogListView, view);
  assert.equal(data.total, 25);
  assert.equal(data.items.length, 20);
  const row = data.items[0];
  assert.ok(row);
  assert.equal(row[marker], view);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      '_id',
      marker,
      'name',
      'productFamily',
      'category',
      'subcategoryIds',
      'updatedAt',
      'alibabaAutoPhotos',
      'imageIds',
      'skuCode',
      'modName',
      'moq',
      'alibabaReviewPending',
      'alibabaReviewReason',
      'alibabaSourceReview',
      'manualCatalogPricing',
    ].sort(),
  );
  assert.equal(Object.hasOwn(row, 'published'), false);
  assert.deepEqual(row.alibabaAutoPhotos, { gallery: f.products[0]?.alibabaAutoPhotos.gallery });
  assert.deepEqual(row.alibabaSourceReview, f.products[0]?.alibabaSourceReview);
  assert.deepEqual(row.manualCatalogPricing, f.products[0]?.manualCatalogPricing);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 20000);
  Reflect.set(row, 'name', 'do-not-persist');
  Reflect.set(row.alibabaAutoPhotos as object, 'gallery', {});
  const raw = await f.request('get', { collection: 'products', id: 'p-00' });
  assert.ok(raw.ok);
  assert.deepEqual(raw.data, f.products[0]);
  const legacy = await f.request('list', {
    collection: 'products',
    catalogReadiness: 'all',
    pageSize: 1,
    sort: [{ field: '_id', dir: 'asc' }],
  });
  assert.ok(legacy.ok);
  const full = legacy.data as { items: unknown[]; catalogListView?: string };
  assert.equal(Object.hasOwn(full, 'catalogListView'), false);
  assert.deepEqual(full.items[0], f.products[0]);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
test('projection preserves search over omitted series and stable count/page including empty page', async (t) => {
  const f = await fixture(t);
  for (const [page, expected] of [
    [2, 5],
    [3, 0],
  ]) {
    const result = await f.request('list', {
      collection: 'products',
      catalogListView: view,
      catalogReadiness: 'all',
      search: 'private-series',
      page,
      pageSize: 20,
      sort: [{ field: '_id', dir: 'asc' }],
    });
    assert.ok(result.ok, JSON.stringify(result));
    const data = result.data as {
      items: Record<string, unknown>[];
      total: number;
      catalogListView?: string;
      page: number;
    };
    assert.equal(data.catalogListView, view);
    assert.equal(data.total, 25);
    assert.equal(data.page, page);
    assert.equal(data.items.length, expected);
    if (page === 2)
      assert.deepEqual(
        data.items.map((r) => r._id),
        ['p-20', 'p-21', 'p-22', 'p-23', 'p-24'],
      );
  }
});
for (const [collection, catalogListView] of [
  ['products', 'unknown'],
  ['products', false],
  ['products', null],
  ['products', {}],
  ['users', view],
])
  test(`list view rejects invalid or non-product request ${JSON.stringify([collection, catalogListView])}`, async (t) => {
    const f = await fixture(t);
    const result = await f.request('list', { collection, catalogListView });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'BAD_REQUEST');
  });
