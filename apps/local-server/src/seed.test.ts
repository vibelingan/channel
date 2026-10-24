import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveCatalogProductWithIdentities, setAdapter } from '@vibelingan-channel/db';
import {
  PRODUCT_IMAGE_MAX_COUNT,
  normalizeProductSlug,
  normalizeSkuCode,
  productFamilyForDoc,
} from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';
import { seed } from './seed.ts';

const ORIGINAL_HEADPHONES = [
  'AuraBeat Pro Studio',
  'AuraBeat Classic',
  'WorkComm Mono',
  'WorkComm Duo',
  'SonicAir 5',
  'SonicAir Move',
] as const;

async function seededStore(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-full-family-seed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(adapter);
  await seed(adapter);
  const products = (
    await adapter.list({
      collection: 'products',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: 'name', dir: 'asc' }],
    })
  ).items;
  const images = (
    await adapter.list({
      collection: 'images',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
    })
  ).items;
  const identities = (
    await adapter.list({
      collection: 'catalogProductIdentities',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
    })
  ).items;
  const overstock = [];
  for (let page = 1; ; page += 1) {
    const result = await adapter.list({
      collection: 'overstock',
      page,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
    });
    overstock.push(...result.items);
    if (page * result.pageSize >= result.total) break;
  }
  return { adapter, identities, images, overstock, products };
}

test('clean local seed includes all four product families and preserves six Headphones', async (t) => {
  const { products } = await seededStore(t);
  const names = new Set(products.map((product) => product.name));
  for (const name of ORIGINAL_HEADPHONES) assert.equal(names.has(name), true, name);
  assert.deepEqual([...new Set(products.map(productFamilyForDoc))].filter(Boolean).sort(), [
    'ai-gadgets',
    'headphones',
    'misc',
    'toys',
  ]);
  assert.ok(products.every((product) => product.published === true));

  const original = products.filter((product) =>
    ORIGINAL_HEADPHONES.includes(product.name as never),
  );
  assert.equal(original.length, ORIGINAL_HEADPHONES.length);
  assert.equal(original.filter((product) => !Object.hasOwn(product, 'productFamily')).length, 1);
});

test('seed product identities are normalized, reserved by owner, and bounded to nine images', async (t) => {
  const { identities, images, products } = await seededStore(t);
  const slugs = products.map((product) => normalizeProductSlug(product.slug));
  const skus = products.map((product) => normalizeSkuCode(product.skuCode));
  assert.ok(slugs.every((slug) => slug !== null));
  assert.ok(skus.every((sku) => sku !== null));
  assert.equal(new Set(slugs).size, products.length);
  assert.equal(new Set(skus).size, products.length);
  assert.equal(identities.length, products.length * 2);
  for (const product of products) {
    const slug = normalizeProductSlug(product.slug);
    const sku = normalizeSkuCode(product.skuCode);
    assert.equal(identities.find((row) => row._id === `slug:${slug}`)?.productId, product._id);
    assert.equal(identities.find((row) => row._id === `sku:${sku}`)?.productId, product._id);
  }
  assert.ok(
    products.every(
      (product) =>
        !Array.isArray(product.imageIds) || product.imageIds.length <= PRODUCT_IMAGE_MAX_COUNT,
    ),
  );
  const imageIds = new Set(images.map((image) => image._id));
  for (const product of products) {
    for (const imageId of Array.isArray(product.imageIds) ? product.imageIds : []) {
      assert.equal(imageIds.has(String(imageId)), true, `${product.name} references ${imageId}`);
    }
  }
});

test('published image refcounts equal distinct seeded catalog references', async (t) => {
  const { images, overstock, products } = await seededStore(t);
  const expected = new Map<string, number>();
  for (const document of [...products, ...overstock]) {
    if (document.published !== true || !Array.isArray(document.imageIds)) continue;
    for (const imageId of new Set(document.imageIds.map(String))) {
      expected.set(imageId, (expected.get(imageId) ?? 0) + 1);
    }
  }
  for (const image of images) {
    assert.equal(image.publishedRefCount, expected.get(image._id) ?? 0, image._id);
  }
});

test('new non-Headphones fixtures contain no VIP or video fields', async (t) => {
  const { products } = await seededStore(t);
  const added = products.filter((product) => productFamilyForDoc(product) !== 'headphones');
  assert.ok(added.length >= 3);
  for (const product of added) {
    assert.equal(Object.hasOwn(product, 'vipPrice'), false);
    assert.equal(Object.hasOwn(product, 'video'), false);
    assert.equal(Object.hasOwn(product, 'videoUrl'), false);
  }
});

test('re-running seed on the same clean database is idempotent', async (t) => {
  const { adapter, products } = await seededStore(t);
  const before = products.map((product) => ({
    name: product.name,
    productFamily: product.productFamily,
    slug: product.slug,
    skuCode: product.skuCode,
  }));
  await seed(adapter);
  const after = (
    await adapter.list({
      collection: 'products',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: 'name', dir: 'asc' }],
    })
  ).items.map((product) => ({
    name: product.name,
    productFamily: product.productFamily,
    slug: product.slug,
    skuCode: product.skuCode,
  }));
  assert.deepEqual(after, before);
});

test('independent clean databases produce the same semantic product fixtures', async (t) => {
  const first = await seededStore(t);
  const second = await seededStore(t);
  const snapshot = (products: typeof first.products) =>
    products.map((product) => ({
      name: product.name,
      productFamily: product.productFamily,
      slug: product.slug,
      skuCode: product.skuCode,
      imageIds: product.imageIds,
      published: product.published,
      archived: product.archived,
    }));
  assert.deepEqual(snapshot(second.products), snapshot(first.products));
});

test('non-empty product stores preserve developer data while repairing reservations', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-existing-seed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(adapter);
  adapter.seedIfEmpty('products', [
    {
      _id: 'existing-product',
      name: 'Existing Product',
      productFamily: 'misc',
      slug: 'existing-product',
      skuCode: 'existing-100',
      published: false,
    },
  ]);
  await seed(adapter);
  const products = await adapter.list({
    collection: 'products',
    page: 1,
    pageSize: 100,
    search: '',
  });
  assert.equal(products.total, 1);
  const productId = products.items[0]?._id;
  assert.equal(
    (await adapter.get('catalogProductIdentities', 'slug:existing-product'))?.productId,
    productId,
  );
  assert.equal(
    (await adapter.get('catalogProductIdentities', 'sku:existing-100'))?.productId,
    productId,
  );
});

test('seeded reservations reject a second product claiming a seeded identity', async (t) => {
  const { adapter, products } = await seededStore(t);
  const seeded = products.find((product) => product.slug === 'aurabeat-classic');
  assert.ok(seeded);
  const result = await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'duplicate-product',
    data: { name: 'Duplicate', slug: seeded.slug, skuCode: 'duplicate-100' },
  });
  assert.equal(result.result, 'conflict');
  const after = await adapter.list({ collection: 'products', page: 1, pageSize: 100, search: '' });
  assert.equal(after.total, products.length);
});

test('identity repair covers more than 100 existing products', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-many-products-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  adapter.seedIfEmpty(
    'products',
    Array.from({ length: 105 }, (_, index) => ({
      _id: `product-${index}`,
      name: `Product ${index}`,
      slug: `product-${index}`,
      skuCode: `sku-${index}`,
    })),
  );
  await adapter.ensureCatalogProductIdentityReservations();
  const reservations = await adapter.list({
    collection: 'catalogProductIdentities',
    page: 1,
    pageSize: 100,
    search: '',
  });
  assert.equal(reservations.total, 210);
  assert.equal(
    (await adapter.get('catalogProductIdentities', 'slug:product-104'))?.productId,
    'product-104',
  );
});

test('identity repair conflict writes no earlier available reservation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-seed-conflict-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  adapter.seedIfEmpty('products', [
    { _id: 'product-a', name: 'A', slug: 'available-slug', skuCode: 'taken-sku' },
  ]);
  adapter.seedIfEmpty('catalogProductIdentities', [
    {
      _id: 'sku:taken-sku',
      kind: 'sku',
      normalizedValue: 'taken-sku',
      productId: 'product-b',
    },
  ]);
  await assert.rejects(
    adapter.ensureCatalogProductIdentityReservations(),
    /conflicting reservation/,
  );
  assert.equal(await adapter.get('catalogProductIdentities', 'slug:available-slug'), null);
});

test('identity repair rejects malformed same-owner reservation data', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-seed-malformed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  adapter.seedIfEmpty('products', [
    { _id: 'product-a', name: 'A', slug: 'product-a', skuCode: 'sku-a' },
  ]);
  adapter.seedIfEmpty('catalogProductIdentities', [
    {
      _id: 'slug:product-a',
      kind: 'sku',
      normalizedValue: 'wrong',
      productId: 'product-a',
    },
  ]);
  await assert.rejects(
    adapter.ensureCatalogProductIdentityReservations(),
    /conflicting reservation/,
  );
  assert.equal(await adapter.get('catalogProductIdentities', 'sku:sku-a'), null);
});

test('refcount backfill includes a deterministic reference beyond the first 100 Overstock rows', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-overstock-page-two-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(adapter);
  adapter.seedIfEmpty('images', [
    { _id: 'page-two-image', name: 'page-two.png', mimeType: 'image/png' },
  ]);
  adapter.seedIfEmpty(
    'overstock',
    Array.from({ length: 101 }, (_, index) => ({
      _id: `overstock-${String(index).padStart(3, '0')}`,
      name: `Overstock ${index}`,
      category: 'electronics',
      published: true,
      imageIds: index === 100 ? ['page-two-image'] : [],
    })),
  );
  await seed(adapter);
  assert.equal((await adapter.get('images', 'page-two-image'))?.publishedRefCount, 1);
});
