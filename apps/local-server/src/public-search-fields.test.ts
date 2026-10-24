/**
 * Public storefront search never matches the Alibaba product ID; the admin
 * search still does. Runs the real public catalog handler on the real local
 * database adapter.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { listSearchFields } from '@vibelingan-channel/db/adapter';
import { getCollection, publicSearchFields } from '@vibelingan-channel/shared';
import { listCatalog } from '../../functions/public-api/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const ALIBABA_ID = 'AAG_BBhgAOVTpOKZBnR03JkR';

async function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-public-search-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(database);
  await database.create('products', {
    _id: 'clock',
    name: 'Nordic World Map Wall Clock',
    series: 'Home Decor',
    modName: 'WM-01',
    productFamily: 'misc',
    published: true,
    unitPrice: 12,
    imageIds: ['clock-photo'],
    alibabaSourceProductId: ALIBABA_ID,
  });
  return database;
}

const itemsOf = (result: unknown) =>
  ((result as { data?: { items?: { _id: string }[] } }).data?.items ?? []).map((item) => item._id);

test('the public search does not match the Alibaba product ID; name, series and model still match', async (t) => {
  await fixture(t);
  assert.deepEqual(itemsOf(await listCatalog('products', { search: ALIBABA_ID }, {})), []);
  assert.deepEqual(itemsOf(await listCatalog('products', { search: 'AAG_BBhg' }, {})), []);
  for (const search of ['world map', 'home decor', 'wm-01'])
    assert.deepEqual(itemsOf(await listCatalog('products', { search }, {})), ['clock'], search);
});

test('the admin search still finds a product by its Alibaba product ID', async (t) => {
  const database = await fixture(t);
  const found = await database.list({
    collection: 'products',
    page: 1,
    pageSize: 10,
    search: ALIBABA_ID,
  });
  assert.deepEqual(
    found.items.map((item) => item._id),
    ['clock'],
  );
});

test('the field lists: public leaves out admin-only ids; a caller list overrides the collection', () => {
  const products = getCollection('products');
  assert.ok(products?.searchableFields.includes('alibabaSourceProductId'), 'admin keeps it');
  assert.deepEqual(publicSearchFields('products'), ['name', 'series', 'modName']);
  assert.deepEqual(publicSearchFields('overstock'), getCollection('overstock')?.searchableFields);
  assert.deepEqual(listSearchFields({}, products), products?.searchableFields);
  assert.deepEqual(listSearchFields({ searchFields: ['name'] }, products), ['name']);
  assert.deepEqual(listSearchFields({}, undefined), []);
});
