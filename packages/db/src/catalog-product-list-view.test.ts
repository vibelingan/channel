import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { projectProductListRow, usesProductListView } from './catalog-product-list-view.ts';
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
