import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import {
  type CollectionDoc,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

const config = { jwtSecret: 'classification-assignment-local-test-secret' };

function productFactory(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'product',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    name: 'Classification product',
    productFamily: 'toys',
    published: false,
    archived: false,
    unitPrice: 4.5,
    imageIds: [],
    description: 'Keep the original details',
    catalogApprovedDetail: { revision: 1 },
    catalogDetailApprovalReceipt: { contentFingerprint: 'unchanged' },
    ...overrides,
  };
}

async function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-classification-assignment-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const database = new JsonFileAdapter(file);
  setAdapter(database);
  await database.create('users', { _id: 'admin', role: 'admin', status: 'active' });
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'Admin',
    email: 'admin@local.invalid',
    role: 'admin',
  });
  const call = (data: unknown, session: string | undefined = token) =>
    handleAdminRequest({ action: 'catalogCategories', token: session, data }, config);
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const registry = initialCatalogTaxonomy(family);
    const response = await call({
      kind: 'taxonomy',
      operation: 'save',
      family,
      expectedRevision: 0,
      name: registry.name,
      children: [
        ...registry.children,
        ...['first', 'second'].map((suffix, order) => ({
          id: `${family}-${suffix}`,
          name: suffix,
          slug: suffix,
          order: order + 10,
          status: 'active',
        })),
      ],
    });
    assert.equal(response.ok, true, JSON.stringify(response));
  }
  return { database, file, call, token };
}

function assignment(product: CollectionDoc, family: ProductFamily) {
  return {
    kind: 'assignment',
    operation: 'replace',
    family,
    taxonomyRevision: 1,
    products: [{ productId: product._id, expectedUpdatedAt: product.updatedAt }],
    subcategoryIds: [`${family}-first`, `${family}-second`],
  };
}

test('authenticated assignment persists two children in all four families without changing price, details or approvals', async (context) => {
  const { database, file, call } = await fixture(context);
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const product = await database.create(
      'products',
      productFactory({ _id: family, productFamily: family }),
    );
    const response = await call(assignment(product, family));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(response.data, {
      kind: 'assignment',
      results: [{ productId: family, status: 'saved' }],
    });
    const reopened = new JsonFileAdapter(file);
    const saved = await reopened.get('products', family);
    assert.ok(saved);
    assert.deepEqual(saved, {
      ...product,
      subcategoryIds: [`${family}-first`, `${family}-second`],
      updatedAt: saved.updatedAt,
    });
  }
});

test('append deduplicates, clear remains explicit, and stale product or taxonomy versions reject', async (context) => {
  const { database, call } = await fixture(context);
  let product = await database.create(
    'products',
    productFactory({ subcategoryIds: ['toys-first'] }),
  );
  const original = structuredClone(product);
  const appended = await call({ ...assignment(product, 'toys'), operation: 'append' });
  assert.equal(appended.ok, true);
  assert.deepEqual(appended.data, {
    kind: 'assignment',
    results: [{ productId: product._id, status: 'saved' }],
  });
  product = (await database.get('products', product._id)) ?? product;
  assert.deepEqual(product.subcategoryIds, ['toys-first', 'toys-second']);
  const stale = await call(assignment(original, 'toys'));
  assert.equal(stale.ok, true);
  assert.deepEqual(stale.data, {
    kind: 'assignment',
    results: [{ productId: product._id, status: 'conflict' }],
  });
  const staleRegistry = await call({ ...assignment(product, 'toys'), taxonomyRevision: 0 });
  assert.equal(staleRegistry.ok, true);
  assert.deepEqual(staleRegistry.data, stale.data);
  const cleared = await call({
    ...assignment(product, 'toys'),
    operation: 'clear',
    subcategoryIds: [],
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.data, appended.data);
  assert.deepEqual((await database.get('products', product._id))?.subcategoryIds, []);
  assert.equal((await database.get('products', product._id))?.published, false);
});

test('batch reports independent conflicts, enforces its limit and never moves a published product', async (context) => {
  const { database, call } = await fixture(context);
  const first = await database.create('products', productFactory({ _id: 'first' }));
  const second = await database.create('products', productFactory({ _id: 'second' }));
  const response = await call({
    ...assignment(first, 'toys'),
    products: [
      { productId: first._id, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' },
      { productId: second._id, expectedUpdatedAt: second.updatedAt },
    ],
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, {
    kind: 'assignment',
    results: [
      { productId: 'first', status: 'conflict' },
      { productId: 'second', status: 'saved' },
    ],
  });
  const tooMany = await call({
    ...assignment(first, 'toys'),
    products: Array.from({ length: 21 }, (_, index) => ({
      productId: `p-${index}`,
      expectedUpdatedAt: first.updatedAt,
    })),
  });
  assert.equal(tooMany.ok, false);
  const duplicate = await call({
    ...assignment(first, 'toys'),
    products: [assignment(first, 'toys').products[0], assignment(first, 'toys').products[0]],
  });
  assert.equal(duplicate.ok, false);
  const live = await database.create(
    'products',
    productFactory({ _id: 'live', published: true, imageIds: ['image'] }),
  );
  for (const operation of ['replace', 'append', 'clear']) {
    const result = await call({
      ...assignment(live, 'misc'),
      operation,
      ...(operation === 'clear' ? { subcategoryIds: [] } : {}),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(await database.get('products', live._id), live);
  }
});

test('unknown save outcome stops the batch and requires refresh before any retry', async (context) => {
  const { database, call } = await fixture(context);
  const first = await database.create('products', productFactory({ _id: 'first' }));
  const second = await database.create('products', productFactory({ _id: 'second' }));
  let saves = 0;
  context.mock.method(database, 'saveCatalogProductWithIdentities', async () => {
    saves++;
    throw new Error('Lost acknowledgement');
  });
  const response = await call({
    ...assignment(first, 'toys'),
    products: [
      { productId: first._id, expectedUpdatedAt: first.updatedAt },
      { productId: second._id, expectedUpdatedAt: second.updatedAt },
    ],
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, {
    kind: 'assignment',
    refreshRequired: true,
    results: [
      { productId: 'first', status: 'unknown' },
      { productId: 'second', status: 'notattempted' },
    ],
  });
  assert.equal(saves, 1);
  assert.deepEqual(await database.get('products', second._id), second);
});

test('assignment rejects revoked administrators and malformed requests without product writes', async (context) => {
  const { database, call } = await fixture(context);
  const product = await database.create('products', productFactory());
  for (const extra of [
    { subcategoryIds: ['toys-first', 'toys-first'] },
    { operation: 'clear' },
    { unexpected: true },
  ]) {
    const response = await call({ ...assignment(product, 'toys'), ...extra });
    assert.equal(response.ok, false);
  }
  await database.update('users', 'admin', { role: 'member' });
  const denied = await call(assignment(product, 'toys'));
  assert.equal(denied.ok, false);
  assert.deepEqual(await database.get('products', product._id), product);
});
