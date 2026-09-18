import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { get, list, setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import {
  type CatalogTaxonomy,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  buildWriteSchema,
  getCollection,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { saveCategoryMapping as saveCategoryMappingAsActor } from '../../functions/admin/src/catalog-categories.ts';
import {
  readCatalogCategorySuggestion,
  validateSuggestedAssignment,
} from '../../functions/admin/src/catalog-category-suggestion.ts';
import { JsonFileAdapter } from './json-adapter.ts';

function saveCategoryMapping(values: Record<string, unknown>, id?: string) {
  return saveCategoryMappingAsActor(values, id, 'admin');
}

async function fixture(context: TestContext, family: ProductFamily = 'headphones') {
  const directory = mkdtempSync(join(tmpdir(), 'channel-mapping-regression-'));
  const file = join(directory, 'db.json');
  const database = new JsonFileAdapter(file);
  setAdapter(database);
  const registry: CatalogTaxonomy = {
    ...initialCatalogTaxonomy(family),
    revision: 1,
    children: [
      ...initialCatalogTaxonomy(family).children,
      { id: `${family}-one`, name: 'First', slug: 'first', order: 10, status: 'active' },
      { id: `${family}-two`, name: 'Second', slug: 'second', order: 20, status: 'active' },
      { id: `${family}-old`, name: 'Old', slug: 'old', order: 30, status: 'archived' },
    ],
  };
  await database.create('catalogTaxonomies', { _id: family, ...registry });
  await database.create('users', { _id: 'admin', role: 'admin', status: 'active' });
  await database.create('products', {
    _id: 'product',
    name: 'Manually classified product',
    productFamily: 'misc',
    subcategoryIds: [],
    published: true,
    unitPrice: 12,
    imageIds: ['approved-image'],
    alibabaPrimarySourceKey: 'source',
    alibabaSourceCategoryId: '1234',
  });
  await database.create('alibabaSourceProducts', {
    _id: 'source',
    sourceCategoryId: '1234',
    active: true,
  });
  await database.create('alibabaProductLinks', { _id: 'source', productId: 'product' });
  const mapping = {
    provider: 'alibaba',
    sourceTaxonomy: 'alibaba:icbu',
    sourceCategoryId: '1234',
    productFamily: family,
    reviewRequired: false,
  };
  const products = async () =>
    JSON.stringify(
      (await database.list({ collection: 'products', page: 1, pageSize: 100, search: '' })).items,
    );
  const before = await products();
  context.after(async () => {
    try {
      assert.equal(await products(), before, 'products remain byte-identical');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const suggestion = () =>
    readCatalogCategorySuggestion('admin', { kind: 'suggestion', productId: 'product' });
  return { database, file, registry, mapping, suggestion };
}

for (const family of PRODUCT_FAMILY_OPTIONS) {
  test(`mapping save and suggestion preserve multiple ${family} IDs across restart without writing products`, async (context) => {
    const { database, file, mapping, suggestion } = await fixture(context, family);
    const subcategoryIds = [`${family}-two`, `${family}-one`];
    const saved = await saveCategoryMapping({ ...mapping, subcategoryIds });
    assert.ok(saved);
    assert.deepEqual(saved.subcategoryIds, subcategoryIds);
    setAdapter(new JsonFileAdapter(file));
    const result = await suggestion();
    assert.equal(result.status, 'ready');
    assert.ok(result.status === 'ready');
    assert.equal(result.family, family);
    assert.equal(result.taxonomyRevision, 1);
    assert.deepEqual(result.subcategoryIds, subcategoryIds);
    const injected = await readCatalogCategorySuggestion(
      'admin',
      { kind: 'suggestion', productId: 'product' },
      { get: database.get.bind(database), list },
    );
    assert.deepEqual(injected, result);
    const assignment = {
      kind: 'assignment',
      operation: 'replace',
      family,
      taxonomyRevision: 1,
      products: [{ productId: 'product', expectedUpdatedAt: result.productUpdatedAt }],
      subcategoryIds,
      expectedSuggestion: result,
    };
    assert.equal(await validateSuggestedAssignment('admin', assignment), true);
    await saveCategoryMapping({ subcategoryIds: [] }, saved._id);
    const cleared = await suggestion();
    assert.ok(cleared.status === 'ready');
    assert.deepEqual(cleared.subcategoryIds, []);
    assert.equal(await validateSuggestedAssignment('admin', assignment), false);
  });
}

test('authenticated generic admin saves mappings and reads suggestions without exposing generic product assignment', async (context) => {
  const { mapping, database } = await fixture(context, 'toys');
  const config = { jwtSecret: 'local-mapping-regression-secret' };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'Admin',
    email: 'admin@local.invalid',
    role: 'admin',
  });
  const created = await handleAdminRequest(
    {
      action: 'create',
      token,
      data: {
        collection: 'sourceCategoryMappings',
        values: { ...mapping, subcategoryIds: ['toys-one', 'toys-two'] },
      },
    },
    config,
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const before = await database.get('sourceCategoryMappings', 'alibaba-icbu-1234');
  assert.ok(before);
  const invalid = await handleAdminRequest(
    {
      action: 'update',
      token,
      data: {
        collection: 'sourceCategoryMappings',
        id: before._id,
        values: { subcategoryIds: ['toys-old'] },
      },
    },
    config,
  );
  assert.equal(invalid.ok, false);
  assert.deepEqual(await database.get('sourceCategoryMappings', before._id), before);
  const cleared = await handleAdminRequest(
    {
      action: 'update',
      token,
      data: {
        collection: 'sourceCategoryMappings',
        id: before._id,
        values: { subcategoryIds: [] },
      },
    },
    config,
  );
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  const suggestion = await handleAdminRequest(
    {
      action: 'catalogCategories',
      token,
      data: {
        kind: 'suggestion',
        productId: 'product',
      },
    },
    config,
  );
  assert.equal(suggestion.ok, true, JSON.stringify(suggestion));
  assert.ok(suggestion.ok && suggestion.data && typeof suggestion.data === 'object');
  assert.ok('status' in suggestion.data && suggestion.data.status === 'ready');
  assert.ok('subcategoryIds' in suggestion.data);
  assert.deepEqual(suggestion.data.subcategoryIds, []);
  const productWrite = await handleAdminRequest(
    {
      action: 'update',
      token,
      data: {
        collection: 'products',
        id: 'product',
        values: { subcategoryIds: ['toys-one'] },
      },
    },
    config,
  );
  assert.equal(productWrite.ok, false);
});

test('explicit IDs and clears override retained legacy labels; absent IDs retain legacy fallback', async (context) => {
  const { mapping, suggestion } = await fixture(context);
  const saved = await saveCategoryMapping({ ...mapping, channelCategory: 'wired' });
  assert.ok(saved);
  const legacy = await suggestion();
  assert.ok(legacy.status === 'ready');
  assert.deepEqual(legacy.subcategoryIds, ['headphones-wired']);
  for (const subcategoryIds of [['headphones-one', 'headphones-two'], []]) {
    await saveCategoryMapping({ subcategoryIds }, saved._id);
    const result = await suggestion();
    assert.ok(result.status === 'ready');
    assert.deepEqual(result.subcategoryIds, subcategoryIds);
  }
  await assert.rejects(
    () => saveCategoryMapping({ subcategoryIds: [], channelCategory: 'wired' }, saved._id),
    /The legacy subcategory contradicts the explicit subcategories\./,
  );
});

test('mapping save rejects wrong-parent, archived, duplicate, malformed and oversized IDs', async (context) => {
  const { database, mapping } = await fixture(context);
  for (const subcategoryIds of [
    ['toys-one'],
    ['headphones-old'],
    ['headphones-one', 'headphones-one'],
    ['missing'],
    [' spaced '],
    null,
    'headphones-one',
    Array.from({ length: 17 }, (_, index) => `child-${index}`),
  ]) {
    await assert.rejects(
      () => saveCategoryMapping({ ...mapping, subcategoryIds }),
      /Choose up to 16 distinct active subcategories from the selected website category\./,
    );
    assert.equal(await database.get('sourceCategoryMappings', 'alibaba-icbu-1234'), null);
  }
});

test('mapping patch validates merged IDs and never retains archived selections even for manual review', async (context) => {
  const { database, registry, mapping } = await fixture(context);
  const saved = await saveCategoryMapping({ ...mapping, subcategoryIds: ['headphones-one'] });
  assert.ok(saved);
  const before = JSON.stringify(await database.get('sourceCategoryMappings', saved._id));
  await assert.rejects(
    () => saveCategoryMapping({ productFamily: 'toys' }, saved._id),
    /Choose up to 16 distinct active subcategories from the selected website category\./,
  );
  assert.equal(JSON.stringify(await database.get('sourceCategoryMappings', saved._id)), before);
  await database.update('catalogTaxonomies', 'headphones', {
    children: registry.children.map((child) => ({ ...child, status: 'archived' })),
  });
  await assert.rejects(
    () => saveCategoryMapping({ reviewRequired: true }, saved._id),
    /Choose up to 16 distinct active subcategories from the selected website category\./,
  );
  assert.equal(JSON.stringify(await database.get('sourceCategoryMappings', saved._id)), before);
});

test('duplicate source mappings conflict, and manual-review suggestions never write products', async (context) => {
  const { database, mapping, suggestion } = await fixture(context);
  const saved = await saveCategoryMapping({ ...mapping, subcategoryIds: ['headphones-one'] });
  assert.ok(saved);
  await assert.rejects(
    () => saveCategoryMapping({ ...mapping, subcategoryIds: [] }),
    /already exists/,
  );
  await saveCategoryMapping({ reviewRequired: true }, saved._id);
  assert.equal((await suggestion()).status, 'review-required');
  await database.create('sourceCategoryMappings', { _id: 'duplicate', ...mapping });
  assert.equal((await suggestion()).status, 'conflict');
});

test('suggestion digest covers IDs even when timestamps and legacy fields do not change', async (context) => {
  const { database, mapping, suggestion } = await fixture(context);
  const saved = await saveCategoryMapping({ ...mapping, subcategoryIds: ['headphones-one'] });
  assert.ok(saved);
  const before = await suggestion();
  assert.ok(before.status === 'ready');
  const changed = await readCatalogCategorySuggestion(
    'admin',
    { kind: 'suggestion', productId: 'product' },
    {
      get: database.get.bind(database),
      list: async (query) => {
        const result = await list(query);
        return {
          ...result,
          items: result.items.map((item) => ({ ...item, subcategoryIds: ['headphones-two'] })),
        };
      },
    },
  );
  assert.ok(changed.status === 'ready');
  assert.notEqual(changed.mapping.revision, before.mapping.revision);
});

test('mapping IDs are writable only on the mapping schema; taxonomy stays outside generic reads', async () => {
  const mappings = getCollection('sourceCategoryMappings');
  const products = getCollection('products');
  assert.ok(mappings && products);
  assert.deepEqual(buildWriteSchema(mappings).partial().parse({ subcategoryIds: [] }), {
    subcategoryIds: [],
  });
  assert.throws(
    () => buildWriteSchema(products).partial().parse({ subcategoryIds: [] }),
    /subcategoryIds/,
  );
  assert.throws(() => get('catalogTaxonomies', 'headphones'), /Unknown collection/);
});

test('mapping form renders taxonomy choices and omits legacy fields for explicit IDs without changing migrated product fields', () => {
  execFileSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { getCollection, initialCatalogTaxonomy, PRODUCT_FAMILY_OPTIONS } from '@vibelingan-channel/shared';
        import { RecordForm, coerceValues } from './src/islands/admin/RecordForm.tsx';
        const client = new QueryClient();
        const collection = getCollection('sourceCategoryMappings');
        for (const family of PRODUCT_FAMILY_OPTIONS) {
          client.setQueryData(['catalog-taxonomy', family], {
            ...initialCatalogTaxonomy(family),
            children: [
              { id: family + '-one', name: 'Selectable child', slug: 'one', order: 0, status: 'active' },
              { id: family + '-old', name: 'Archived child', slug: 'old', order: 1, status: 'archived' },
            ],
          });
          const initial = { _id: 'mapping', provider: 'alibaba', sourceTaxonomy: 'alibaba:icbu',
            productFamily: family, channelCategory: 'wired', subcategoryIds: [family + '-one'] };
          const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client },
            createElement(RecordForm, { collection, title: 'Mapping', initial,
              submitting: false, error: null, onSubmit() {}, onCancel() {} })));
          assert.doesNotMatch(markup, /<textarea[^>]*id="subcategoryIds"/);
          assert.doesNotMatch(markup, /Headphones Subcategory/);
          assert.match(markup, /type="checkbox"[^>]*checked=""[^>]*value="[^"]+-one"/);
          assert.match(markup, /Selectable child/);
          assert.doesNotMatch(markup, /Archived child/);
          const values = coerceValues(collection, { productFamily: family,
            subcategoryIds: '[]', channelCategory: 'wired', provider: 'alibaba', sourceTaxonomy: 'alibaba:icbu' }, initial);
          assert.deepEqual(values.subcategoryIds, []);
          assert.equal(Object.hasOwn(values, 'channelCategory'), false);
        }
        const product = { _id: 'product', name: 'Product', productFamily: 'headphones', category: 'wired', subcategoryIds: [] };
        const values = coerceValues(getCollection('products'), { name: 'Updated', productFamily: 'toys', category: 'wired' }, product);
        assert.equal(Object.hasOwn(values, 'productFamily'), false);
        assert.equal(Object.hasOwn(values, 'category'), false);
        client.clear();
      `,
    ],
    {
      cwd: fileURLToPath(new URL('../../site/', import.meta.url)),
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
});
