import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type CatalogProductSaveResult,
  get,
  saveCatalogProductWithIdentities,
  setAdapter,
} from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

function temporaryDatabase(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'channel-catalog-identities-'));
  return { directory, file: join(directory, 'db.json') };
}

function readStore(file: string): Record<string, CollectionDoc[]> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CollectionDoc[]>;
}

test('RACE: JsonFileAdapter persists exactly one owner for a shared slug and SKU', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'create',
      productId: 'product-a',
      data: { name: 'A', slug: 'Desk Lamp', skuCode: 'SKU-100' },
    }),
    saveCatalogProductWithIdentities({
      mode: 'create',
      productId: 'product-b',
      data: { name: 'B', slug: 'desk-lamp', skuCode: 'sku-100' },
    }),
  ]);

  assert.equal(results.filter((result) => result.result === 'saved').length, 1);
  assert.equal(results.filter((result) => result.result === 'conflict').length, 1);
  const persisted = readStore(file);
  assert.equal(persisted.products?.length, 1);
  const owner = persisted.products?.[0]?._id;
  assert.deepEqual(
    persisted.catalogProductIdentities?.map((doc) => [doc._id, doc.productId]).sort(),
    [
      ['sku:sku-100', owner],
      ['slug:desk-lamp', owner],
    ],
  );

  setAdapter(new JsonFileAdapter(file));
  assert.equal((await get('products', String(owner)))?._id, owner);
});

test('JsonFileAdapter update transfers identities and survives a reopened read', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-a',
    data: { name: 'A', description: 'Keep me', slug: 'desk-lamp', skuCode: 'sku-100' },
  });
  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'product-a',
    data: { slug: 'table-lamp', skuCode: 'sku-200' },
  });
  assert.equal(saved.result, 'saved');

  setAdapter(new JsonFileAdapter(file));
  const reread = await get('products', 'product-a');
  assert.deepEqual(reread, saved.result === 'saved' ? saved.doc : null);
  assert.equal(reread?.description, 'Keep me');
  assert.deepEqual(
    readStore(file)
      .catalogProductIdentities?.map((doc) => doc._id)
      .sort(),
    ['sku:sku-200', 'slug:table-lamp'],
  );
});

test('legacy update releases each valid old identity and persists a real createdAt', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        {
          _id: 'legacy-product',
          name: 'Legacy',
          slug: 'old-slug',
          skuCode: 42,
          createdAt: null,
        },
      ],
      catalogProductIdentities: [
        {
          _id: 'slug:old-slug',
          kind: 'slug',
          normalizedValue: 'old-slug',
          productId: 'legacy-product',
        },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));

  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'legacy-product',
    data: { slug: 'new-slug', skuCode: 'sku-200' },
  });
  assert.equal(saved.result, 'saved');
  const persisted = readStore(file);
  assert.equal(typeof persisted.products?.[0]?.createdAt, 'string');
  assert.deepEqual(persisted.catalogProductIdentities?.map((doc) => doc._id).sort(), [
    'sku:sku-200',
    'slug:new-slug',
  ]);
});

test('conflict, corrupt reservation, and malformed facade input produce no writes', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [],
      catalogProductIdentities: [
        { _id: 'slug:taken', kind: 'slug', normalizedValue: 'taken', productId: 'other' },
        { _id: 'sku:corrupt', kind: 'slug', normalizedValue: 'wrong', productId: 'product-a' },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));
  const before = readFileSync(file, 'utf8');

  assert.equal(
    (
      await saveCatalogProductWithIdentities({
        mode: 'create',
        productId: 'product-a',
        data: { slug: 'taken', skuCode: 'free' },
      })
    ).result,
    'conflict',
  );
  assert.equal(
    (
      await saveCatalogProductWithIdentities({
        mode: 'create',
        productId: 'product-a',
        data: { slug: 'free', skuCode: 'corrupt' },
      })
    ).result,
    'conflict',
  );
  assert.throws(
    () =>
      saveCatalogProductWithIdentities({
        mode: 'delete',
        productId: 'product-a',
        data: {},
      } as never),
    /invalid catalog product save input/i,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('RACE: concurrent archive and publish cannot persist an archived published product', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-race',
    data: {
      name: 'Race Product',
      productFamily: 'toys',
      slug: 'race-product',
      skuCode: 'race-100',
      description: 'Complete product.',
      imageIds: ['image-1'],
      published: true,
    },
  });

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-race',
      data: { archived: true },
    }),
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-race',
      data: { published: true },
    }),
  ]);
  assert.ok(results.some((result) => result.result === 'saved'));
  const persisted = readStore(file).products?.[0];
  assert.equal(persisted?.archived, true);
  assert.equal(persisted?.published, false);
});

test('legacy missing archived plus submitted false remains published', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        {
          _id: 'legacy-published',
          name: 'Legacy Published',
          productFamily: 'headphones',
          slug: 'legacy-published',
          skuCode: 'legacy-100',
          description: 'Complete legacy product.',
          imageIds: ['image-1'],
          published: true,
        },
      ],
      catalogProductIdentities: [
        {
          _id: 'slug:legacy-published',
          kind: 'slug',
          normalizedValue: 'legacy-published',
          productId: 'legacy-published',
        },
        {
          _id: 'sku:legacy-100',
          kind: 'sku',
          normalizedValue: 'legacy-100',
          productId: 'legacy-published',
        },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));
  const result = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'legacy-published',
    data: { name: 'Edited', archived: false },
  });
  assert.equal(result.result, 'saved');
  assert.equal(readStore(file).products?.[0]?.published, true);
});

test('RACE: duplicate publish returns one authoritative unpublished previous row', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-publish',
    data: {
      name: 'Publish Product',
      productFamily: 'toys',
      slug: 'publish-product',
      skuCode: 'publish-100',
      description: 'Complete product.',
      imageIds: ['image-1'],
      published: false,
    },
  });

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-publish',
      data: { published: true },
    }),
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-publish',
      data: { published: true },
    }),
  ]);
  const saved = results.filter(
    (result): result is Extract<CatalogProductSaveResult, { result: 'saved' }> =>
      result.result === 'saved',
  );
  assert.equal(saved.length, 2);
  assert.equal(saved.filter((result) => result.previous?.published === false).length, 1);
  assert.equal(saved.filter((result) => result.previous?.published === true).length, 1);
});
