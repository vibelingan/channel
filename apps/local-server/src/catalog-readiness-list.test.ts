import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth';
import { setAdapter } from '@vibelingan-channel/db';
import { CatalogReadinessSchema } from '@vibelingan-channel/shared/catalog-preparation';
import {
  expected,
  prepared,
  rows,
} from '../../../packages/db/src/testing/catalog-readiness-fixtures.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';
async function fixture(t: { after(fn: () => void): void }, products = rows()) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-readiness-query-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }], products }));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const token = await signSession('readiness-query-secret', {
    sub: 'admin',
    email: 'admin@example.test',
    role: 'admin',
    name: 'Admin',
  });
  const api = async (data: Record<string, unknown>) =>
    handleAdminRequest({ action: 'list', token, data }, { jwtSecret: 'readiness-query-secret' });
  return { adapter, file, api };
}

for (const catalogReadiness of CatalogReadinessSchema.options)
  test(`native readiness ${catalogReadiness} filters before count/page and survives reopen`, async (t) => {
    const ids = expected[catalogReadiness];
    const f = await fixture(t);
    const before = readFileSync(f.file, 'utf8');
    const actual: string[] = [];
    for (let page = 1; page <= ids.length + 1; page++) {
      const result = await f.adapter.list({
        collection: 'products',
        catalogReadiness,
        page,
        pageSize: 1,
        search: '',
        sort: [{ field: '_id', dir: 'asc' }],
      });
      assert.equal(result.total, ids.length);
      actual.push(...result.items.map((row) => row._id));
    }
    assert.deepEqual(actual, ids);
    assert.equal(new Set(actual).size, actual.length);
    assert.equal(readFileSync(f.file, 'utf8'), before);
    assert.equal(
      (
        await new JsonFileAdapter(f.file).list({
          collection: 'products',
          catalogReadiness,
          page: 1,
          pageSize: 100,
          search: '',
        })
      ).total,
      ids.length,
    );
  });
test('actual admin API preserves optional rollout and makes pending-photo problems reachable', async (t) => {
  const f = await fixture(t);
  const old = await f.api({ collection: 'products', pageSize: 100 });
  assert.ok(old.ok);
  assert.equal((old.data as { total: number }).total, rows().length - 1);
  for (const catalogReadiness of CatalogReadinessSchema.options) {
    const ids = expected[catalogReadiness];
    const r = await f.api({
      collection: 'products',
      catalogReadiness,
      pageSize: 100,
      sort: [{ field: '_id', dir: 'asc' }],
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(
      (r.data as { items: { _id: string }[] }).items.map((row) => row._id),
      ids,
    );
  }
});
test('readiness is product-only, strict and never silently widens invalid requests', async (t) => {
  const f = await fixture(t);
  for (const data of [
    { collection: 'products', catalogReadiness: 'invalid' },
    { collection: 'products', catalogReadiness: ['normal'] },
    { collection: 'images', catalogReadiness: 'normal' },
  ]) {
    const r = await f.api(data);
    assert.equal(r.ok, false, JSON.stringify(data));
    if (!r.ok) assert.equal(r.error.code, 'BAD_REQUEST');
  }
});
test('readiness AND classification and OR search filters precede pagination', async (t) => {
  const f = await fixture(t, [
    ...Array.from({ length: 25 }, (_, i) => prepared(`ready-${String(i).padStart(2, '0')}`)),
    prepared('bad', 'blocked'),
    { ...prepared('missing-family'), productFamily: undefined },
  ]);
  const r = await f.adapter.list({
    collection: 'products',
    catalogReadiness: 'normal',
    productFamily: 'misc',
    filter: {
      combinator: 'or',
      clauses: [
        { field: 'name', op: 'contains', value: 'ready' },
        { field: 'name', op: 'contains', value: 'bad' },
      ],
    },
    search: 'Clock',
    page: 2,
    pageSize: 20,
    sort: [{ field: '_id', dir: 'asc' }],
  });
  assert.equal(r.total, 25);
  assert.deepEqual(
    r.items.map((x) => x._id),
    ['ready-20', 'ready-21', 'ready-22', 'ready-23', 'ready-24'],
  );
  const unclassified = await f.api({
    collection: 'products',
    catalogReadiness: 'normal',
    needsClassification: true,
  });
  assert.ok(unclassified.ok);
  assert.deepEqual(
    (unclassified.data as { items: { _id: string }[] }).items.map((x) => x._id),
    ['missing-family'],
  );
  assert.equal((await f.adapter.get('products', 'missing-family'))?.productFamily, undefined);
});

test('default rollout remains read-only and does not fetch per-product source data', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.file, 'utf8');
  let gets = 0;
  const original = f.adapter.get.bind(f.adapter);
  f.adapter.get = async (...args) => {
    gets++;
    return original(...args);
  };
  for (const catalogReadiness of ['normal', 'issues', 'preparing', 'unchecked'] as const)
    await f.adapter.list({
      collection: 'products',
      catalogReadiness,
      page: 1,
      pageSize: 100,
      search: '',
    });
  assert.equal(gets, 0);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const old = await f.adapter.list({ collection: 'products', page: 1, pageSize: 100, search: '' });
  assert.equal(old.total, rows().length);
});

test('subcategory AND readiness AND family retain the same total and exact selected IDs', async (t) => {
  const f = await fixture(t, [
    { ...prepared('selected-a'), subcategoryIds: ['clock'] },
    { ...prepared('selected-b'), subcategoryIds: ['clock'] },
    { ...prepared('blocked', 'blocked'), subcategoryIds: ['clock'] },
    { ...prepared('other-subcategory'), subcategoryIds: ['other'] },
    { ...prepared('other-family'), productFamily: 'toys', subcategoryIds: ['clock'] },
  ]);
  const query = {
    collection: 'products',
    catalogReadiness: 'normal' as const,
    productFamily: 'misc' as const,
    productSubcategories: { family: 'misc' as const, ids: ['clock'], knownIds: ['clock', 'other'] },
    pageSize: 1,
    search: 'Clock',
    sort: [{ field: '_id', dir: 'asc' as const }],
  };
  const first = await f.adapter.list({ ...query, page: 1 });
  const second = await f.adapter.list({ ...query, page: 2 });
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
  assert.deepEqual(
    [...first.items, ...second.items].map((x) => x._id),
    ['selected-a', 'selected-b'],
  );
});

test('equal primary sort values paginate deterministically by identity', async (t) => {
  const f = await fixture(t, [
    { ...prepared('b'), name: 'Clock' },
    { ...prepared('a'), name: 'Clock' },
  ]);
  const ids: string[] = [];
  for (const page of [1, 2]) {
    const r = await f.adapter.list({
      collection: 'products',
      catalogReadiness: 'normal',
      page,
      pageSize: 1,
      search: '',
      sort: [{ field: 'name', dir: 'desc' }],
    });
    ids.push(...r.items.map((x) => x._id));
  }
  // Default missing createdAt is a real legacy tie; insertion order must not determine the page.
  const defaultIds: string[] = [];
  for (const page of [1, 2])
    defaultIds.push(
      ...(
        await f.adapter.list({
          collection: 'products',
          catalogReadiness: 'normal',
          page,
          pageSize: 1,
          search: '',
        })
      ).items.map((x) => x._id),
    );
  assert.deepEqual(defaultIds, ['a', 'b']);
  assert.deepEqual(ids, ['a', 'b']);
});

test('explicit all scope exposes pending legacy products without changing omitted-scope compatibility', async (t) => {
  const f = await fixture(t);
  const all = await f.api({ collection: 'products', catalogReadiness: 'all', pageSize: 100 });
  assert.ok(all.ok, JSON.stringify(all));
  assert.equal((all.data as { total: number }).total, rows().length);
  assert.ok((all.data as { items: { _id: string }[] }).items.some((row) => row._id === 'waiting'));
  const legacy = await f.api({ collection: 'products', pageSize: 100 });
  assert.ok(legacy.ok);
  assert.equal((legacy.data as { total: number }).total, rows().length - 1);
});
