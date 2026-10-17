import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  projectProductListResult,
  projectProductListRow,
  usesProductListView,
} from './catalog-product-list-view.ts';
import { listDocumentsInCloudBase } from './cloudbase-adapter.ts';
const require = createRequire(import.meta.url);
const wx = require('wx-server-sdk');
wx.init({ env: 'owned-list-view-contract' });
const view = 'admin-product-list-v1' as const;
const marker = '_adminProductListView';
for (const optIn of [true, false])
  test(`native get projects before transport only when opted in: ${optIn}`, async () => {
    const events: string[] = [];
    let projection: Record<string, boolean> | undefined;
    const raw = {
      _id: 'p',
      name: 'Clock',
      published: false,
      updatedAt: 'version',
      description: '大'.repeat(50000),
      catalogPreparationRequest: { private: 'request' },
      futurePrivateField: 'future-private',
      alibabaSourceReview: { exact: 'metadata' },
      alibabaAutoPhotos: {
        gallery: { imageIds: ['image'], sources: ['source'] },
        description: { private: 'description' },
      },
    };
    const before = JSON.stringify(raw);
    const query = {
      where: (_where: Record<string, unknown>) => query,
      orderBy: (_key: string, _dir: string) => {
        events.push('sort');
        return query;
      },
      skip: (_n: number) => {
        events.push('skip');
        return query;
      },
      limit: (_n: number) => {
        events.push('limit');
        return query;
      },
      field: (fields: Record<string, boolean>) => {
        events.push('field');
        projection = fields;
        return query;
      },
      count: async () => {
        events.push('count');
        assert.equal(projection, undefined);
        return { total: 1 };
      },
      get: async () => {
        events.push('get');
        if (!projection) return { data: [structuredClone(raw)] };
        const row: Record<string, unknown> = {};
        for (const [path, include] of Object.entries(projection)) {
          assert.equal(include, true);
          if (path === 'alibabaAutoPhotos.gallery')
            row.alibabaAutoPhotos = { gallery: structuredClone(raw.alibabaAutoPhotos.gallery) };
          else if (Object.hasOwn(raw, path)) row[path] = structuredClone(Reflect.get(raw, path));
        }
        return { data: [row] };
      },
      doc: (_id: string): never => {
        throw Error('No per-row read');
      },
      add: async (): Promise<never> => {
        throw Error('No list write');
      },
    };
    const result = await listDocumentsInCloudBase(
      {
        command: wx.database().command,
        RegExp: () => {
          throw Error('Unexpected regexp');
        },
        collection: (name) => {
          assert.equal(name, 'products');
          return query;
        },
      },
      {
        collection: 'products',
        page: 1,
        pageSize: 20,
        search: '',
        ...(optIn ? { catalogListView: view } : {}),
      },
    );
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    if (optIn) {
      assert.equal(
        events.filter((e) => e === 'field').length,
        1,
        'native field() must run, even if DTO shaping also strips fields',
      );
      assert.ok(events.indexOf('field') > events.indexOf('count'));
      assert.ok(events.indexOf('field') < events.indexOf('get'));
      assert.equal(projection?.['alibabaAutoPhotos.gallery'], true);
      for (const key of [
        'alibabaAutoPhotos',
        'description',
        'futurePrivateField',
        'catalogPreparationRequest',
      ])
        assert.equal(Object.hasOwn(projection ?? {}, key), false);
      assert.equal(Reflect.get(result, 'catalogListView'), view);
      assert.equal(result.items[0]?.[marker], view);
      assert.equal(result.items[0]?.description, undefined);
      assert.deepEqual(result.items[0]?.alibabaAutoPhotos, {
        gallery: raw.alibabaAutoPhotos.gallery,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
    } else {
      assert.equal(events.includes('field'), false);
      assert.deepEqual(result.items[0], raw);
      assert.equal(Object.hasOwn(result, 'catalogListView'), false);
    }
    assert.equal(JSON.stringify(raw), before);
  });

test('summary copies nested metadata and arrays without changing the source record', () => {
  const raw = {
    _id: 'p',
    subcategoryIds: ['clock'],
    alibabaSourceReview: { modelNumbers: ['T142'] },
    alibabaAutoPhotos: { gallery: { sources: ['source'] } },
  };
  const before = JSON.stringify(raw);
  const row = projectProductListRow(raw);
  (row.subcategoryIds as string[]).push('other');
  (row.alibabaSourceReview as { modelNumbers: string[] }).modelNumbers.push('changed');
  (row.alibabaAutoPhotos as { gallery: { sources: string[] } }).gallery.sources.push('changed');
  assert.equal(JSON.stringify(raw), before);
});
test('adapter summary opt-in rejects invalid values rather than widening to a full list', () => {
  assert.equal(usesProductListView({ collection: 'products' }), false);
  assert.equal(usesProductListView({ collection: 'products', catalogListView: view }), true);
  for (const catalogListView of ['invalid', false, null, {}, []])
    assert.throws(() => usesProductListView({ collection: 'products', catalogListView }));
  assert.throws(() => usesProductListView({ collection: 'users', catalogListView: view }));
});

const rowLimit = 8 * 1024;
const limited = '_adminProductListLimited';
const incomplete = '_adminProductListCoreIncomplete';
for (const char of ['a', '中', '😀', '\u0000', '"'])
  test(`summary exact UTF-8 JSON budget and one extra byte: ${JSON.stringify(char)}`, () => {
    const empty = projectProductListRow({ _id: 'p', name: '' });
    const room = rowLimit - Buffer.byteLength(JSON.stringify(empty));
    const cost = Buffer.byteLength(JSON.stringify(char)) - 2;
    const name = char.repeat(Math.floor(room / cost)) + 'a'.repeat(room % cost);
    const exact = projectProductListRow({ _id: 'p', name });
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), rowLimit);
    assert.equal(Object.hasOwn(exact, limited), false);
    assert.equal(exact.name, name);
    const extra = projectProductListRow({ _id: 'p', name: `${name}a` });
    assert.ok(Buffer.byteLength(JSON.stringify(extra)) <= rowLimit);
    assert.equal(extra[limited], true);
    assert.equal(extra[incomplete], true);
    assert.equal(extra._id, 'p');
  });
function largeReview() {
  return {
    schemaVersion: 'alibaba-source-review-v1',
    provider: 'alibaba',
    externalProductId: 'external',
    sourceCategoryId: 'source-category',
    sourceListingStatus: 'published',
    variantCount: 3,
    offerCount: 4,
    modelNumbers: Array.from({ length: 100 }, () => '中'.repeat(256)),
    optionNames: Array.from({ length: 100 }, () => '中'.repeat(256)),
  };
}
test('large metadata keeps exact operation and source identity while full content remains untouched', () => {
  const raw = {
    _id: 'p',
    name: 'Clock',
    productFamily: 'misc',
    category: 'legacy',
    subcategoryIds: ['clock'],
    published: false,
    archived: false,
    updatedAt: '2026-10-18T00:00:00.000Z',
    alibabaReviewPending: true,
    alibabaReviewReason: 'changed',
    alibabaPrimarySourceKey: 'source-key',
    alibabaSourceCategoryId: 'direct-category',
    alibabaSourceReview: largeReview(),
  };
  const before = JSON.stringify(raw);
  const result = projectProductListRow(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= rowLimit);
  assert.equal(result[limited], true);
  assert.equal(Object.hasOwn(result, incomplete), false);
  for (const key of [
    '_id',
    'name',
    'productFamily',
    'category',
    'subcategoryIds',
    'published',
    'archived',
    'updatedAt',
    'alibabaReviewPending',
    'alibabaReviewReason',
    'alibabaPrimarySourceKey',
    'alibabaSourceCategoryId',
  ])
    assert.deepEqual(result[key], Reflect.get(raw, key), key);
  const projectedReview = result.alibabaSourceReview;
  assert.ok(projectedReview && typeof projectedReview === 'object');
  assert.equal(
    Reflect.get(projectedReview, 'sourceCategoryId'),
    raw.alibabaSourceReview.sourceCategoryId,
  );
  assert.equal(JSON.stringify(raw), before);
  const missingState = { ...raw };
  Reflect.deleteProperty(missingState, 'published');
  assert.equal(Object.hasOwn(projectProductListRow(missingState), 'published'), false);
  assert.equal(projectProductListRow({ ...raw, published: true }).published, true);
});
test('oversized selected metadata is rejected before serializing the whole row', (t) => {
  const raw = { _id: 'p', name: 'Clock', alibabaSourceReview: largeReview() };
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      Reflect.get(value, 'alibabaSourceReview') === raw.alibabaSourceReview
    )
      throw Error('Oversized row must not be fully serialized');
    return stringify(value);
  });
  const row = projectProductListRow(raw);
  assert.equal(row[limited], true);
  assert.ok(Buffer.byteLength(stringify(row)) <= rowLimit);
});

test('row depth leaves room for its list page envelope', () => {
  let nested: unknown = 'value';
  for (let i = 0; i < 30; i++) nested = { nested };
  const raw = { _id: 'deep', name: 'Clock', alibabaSourceReview: { extra: nested } };
  const before = JSON.stringify(raw);
  const page = projectProductListResult({ items: [raw], total: 1, page: 1, pageSize: 20 });
  assert.equal(page.items[0]?._adminProductListLimited, true);
  assert.equal(page.items[0]?._id, 'deep');
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 1024 * 1024);
  assert.equal(JSON.stringify(raw), before);
});

test('100 maximum-size rows fit the page envelope and oversized result metadata is refused', () => {
  const items = Array.from({ length: 100 }, (_, i) => {
    const row = { _id: `max-${i}`, name: '' };
    row.name = 'a'.repeat(8192 - Buffer.byteLength(JSON.stringify(projectProductListRow(row))));
    return row;
  });
  const input = { items, total: 100, page: 1, pageSize: 100 };
  const page = projectProductListResult(input);
  assert.equal(page.items.length, 100);
  for (const row of page.items) assert.equal(Buffer.byteLength(JSON.stringify(row)), 8192);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 1024 * 1024);
  const future = { ...input, extra: 'a'.repeat(1024 * 1024) };
  assert.throws(() => projectProductListResult(future), /page could not be bounded/);
  const first = items[0];
  assert.ok(first);
  assert.throws(
    () => projectProductListResult({ ...input, items: [...items, first] }),
    /page was not confirmed/,
  );
});
