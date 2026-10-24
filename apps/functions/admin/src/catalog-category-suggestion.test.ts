import { strict as assert } from 'node:assert';
import test from 'node:test';
import type * as database from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  initialCatalogTaxonomy,
  matchesFilter,
} from '@vibelingan-channel/shared';
import {
  readCatalogCategorySuggestion,
  validateSuggestedAssignment,
} from './catalog-category-suggestion.ts';

const updatedAt = '2026-09-18T10:00:00.000Z';
const command = { kind: 'suggestion', productId: 'product-a' };

function fixture(overrides: Partial<CollectionDoc> = {}) {
  const product: CollectionDoc = {
    _id: 'product-a',
    updatedAt,
    productFamily: 'headphones',
    subcategoryIds: [],
    alibabaPrimarySourceKey: 'source-a',
    alibabaSourceCategoryId: '123',
    ...overrides,
  };
  const mapping: CollectionDoc = {
    _id: 'alibaba-icbu-123',
    updatedAt,
    provider: 'alibaba',
    sourceTaxonomy: 'alibaba:icbu',
    sourceCategoryId: '123',
    productFamily: 'headphones',
    channelCategory: 'wired',
    reviewRequired: false,
  };
  const actor: CollectionDoc = { _id: 'admin', role: 'admin', status: 'active' };
  const source: CollectionDoc = { _id: 'source-a', active: true, sourceCategoryId: '123' };
  const link: CollectionDoc = { _id: 'source-a', productId: product._id };
  const mappings = [mapping];
  const store: Record<string, CollectionDoc[]> = {
    users: [actor],
    products: [product],
    sourceCategoryMappings: mappings,
    alibabaSourceProducts: [source],
    alibabaProductLinks: [link],
    catalogTaxonomies: [{ _id: 'headphones', ...initialCatalogTaxonomy('headphones') }],
  };
  const reads: string[] = [];
  const reader: Pick<typeof database, 'get' | 'list'> = {
    async get(collection, id) {
      reads.push(collection);
      return store[collection]?.find((row) => row._id === id) ?? null;
    },
    async list(query) {
      reads.push(query.collection);
      const items = (store[query.collection] ?? []).filter(
        (row) => !query.filter || matchesFilter(row, query.filter),
      );
      return { items, total: items.length, page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
    },
  };
  return { product, mapping, mappings, actor, source, link, store, reader, reads };
}

test('suggestion resolves a legacy mapping without overwriting confirmed empty classification', async () => {
  const state = fixture();
  const before = structuredClone(state.store);
  const result = await readCatalogCategorySuggestion('admin', command, state.reader);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.subcategoryIds, ['headphones-wired']);
  assert.equal(result.family, 'headphones');
  assert.equal(result.source.primarySourceKey, 'source-a');
  assert.equal(result.source.sourceCategoryId, '123');
  assert.equal(result.productUpdatedAt, updatedAt);
  assert.equal(result.mapping.id, state.mapping._id);
  assert.match(result.mapping.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.store, before);
});

test('suggestion rejects a foreign link, stale source category, or contradictory product source', async () => {
  for (const scenario of ['foreign', 'source-category', 'review-category', 'inactive']) {
    const state = fixture();
    if (scenario === 'foreign') state.link.productId = 'another-product';
    if (scenario === 'source-category') state.source.sourceCategoryId = '456';
    if (scenario === 'review-category')
      state.product.alibabaSourceReview = { sourceCategoryId: '456' };
    if (scenario === 'inactive') state.source.active = false;
    const result = await readCatalogCategorySuggestion('admin', command, state.reader);
    assert.equal(result.status, 'conflict', scenario);
  }
});

test('suggestion fails closed on duplicate, manual-review, invalid or archived mappings', async () => {
  for (const scenario of ['duplicate', 'review', 'invalid-category', 'archived', 'malformed-ids']) {
    const state = fixture();
    if (scenario === 'duplicate') state.mappings.push({ ...state.mapping, _id: 'duplicate' });
    if (scenario === 'review') state.mapping.reviewRequired = true;
    if (scenario === 'invalid-category') state.mapping.channelCategory = 'missing';
    if (scenario === 'archived') {
      const registry = initialCatalogTaxonomy('headphones');
      const child = registry.children[0];
      assert.ok(child);
      child.status = 'archived';
      state.store.catalogTaxonomies = [{ _id: 'headphones', ...registry }];
    }
    if (scenario === 'malformed-ids') state.mapping.subcategoryIds = null;
    const result = await readCatalogCategorySuggestion('admin', command, state.reader);
    assert.notEqual(result.status, 'ready', scenario);
  }
});

test('explicit empty mapping suppresses the legacy child without changing the product', async () => {
  const state = fixture();
  state.mapping.subcategoryIds = [];
  const before = structuredClone(state.store);
  const result = await readCatalogCategorySuggestion('admin', command, state.reader);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.deepEqual(result.subcategoryIds, []);
  assert.deepEqual(state.store, before);
});

test('suggestion authenticates before reading products and bounds the command', async () => {
  const state = fixture();
  state.actor.role = 'viewer';
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, state.reader)).status,
    'forbidden',
  );
  assert.deepEqual(state.reads, ['users']);
  await assert.rejects(
    readCatalogCategorySuggestion('admin', { ...command, extra: 'x'.repeat(16384) }, state.reader),
  );
});

test('suggestion supports family-only mappings without inventing child IDs', async () => {
  for (const family of ['ai-gadgets', 'toys', 'misc'] as const) {
    const state = fixture();
    state.mapping.productFamily = family;
    state.mapping.channelCategory = '';
    const result = await readCatalogCategorySuggestion('admin', command, state.reader);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') continue;
    assert.equal(result.family, family);
    assert.deepEqual(result.subcategoryIds, []);
  }
});

test('suggestion revision tracks mapping edits and ignores assignment fences', async () => {
  const state = fixture();
  const before = await readCatalogCategorySuggestion('admin', command, state.reader);
  assert.ok(before.status === 'ready');
  state.mapping.categoryAssignmentFence = 'other-operation';
  assert.deepEqual(await readCatalogCategorySuggestion('admin', command, state.reader), before);
  state.mapping.channelCategory = 'office';
  const after = await readCatalogCategorySuggestion('admin', command, state.reader);
  assert.ok(after.status === 'ready');
  assert.notEqual(after.mapping.revision, before.mapping.revision);
});

test('suggested manual assignment rechecks source and mapping before delegating the save', async () => {
  for (const scenario of [
    'unchanged',
    'source',
    'mapping',
    'product',
    'link',
    'different-product',
  ]) {
    const state = fixture();
    const suggestion = await readCatalogCategorySuggestion('admin', command, state.reader);
    assert.ok(suggestion.status === 'ready');
    const input = {
      kind: 'assignment',
      operation: 'replace',
      family: suggestion.family,
      taxonomyRevision: suggestion.taxonomyRevision,
      subcategoryIds: suggestion.subcategoryIds,
      products: [{ productId: 'product-a', expectedUpdatedAt: updatedAt }],
      expectedSuggestion: suggestion,
    };
    if (scenario === 'source') state.product.alibabaPrimarySourceKey = 'source-b';
    if (scenario === 'mapping') state.mapping.channelCategory = 'office';
    if (scenario === 'product') state.product.updatedAt = '2026-09-18T11:00:00.000Z';
    if (scenario === 'link') state.link.productId = 'another-product';
    if (scenario === 'different-product')
      input.products = [{ productId: 'other', expectedUpdatedAt: updatedAt }];
    assert.equal(
      await validateSuggestedAssignment('admin', input, state.reader),
      scenario === 'unchanged',
      scenario,
    );
  }
});

test('suggestion revision changes with mapping content even without a timestamp change', async () => {
  const state = fixture();
  const before = await readCatalogCategorySuggestion('admin', command, state.reader);
  state.mapping.channelCategory = 'office';
  const after = await readCatalogCategorySuggestion('admin', command, state.reader);
  assert.equal(before.status, 'ready');
  assert.equal(after.status, 'ready');
  if (before.status !== 'ready' || after.status !== 'ready') return;
  assert.notEqual(before.mapping.revision, after.mapping.revision);
  assert.deepEqual(after.subcategoryIds, ['headphones-office']);
});

test('suggestion handles absent product, source and mapping without inventing a target', async () => {
  const missingProduct = fixture();
  missingProduct.store.products = [];
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, missingProduct.reader)).status,
    'missing',
  );
  const missingSource = fixture({ alibabaPrimarySourceKey: undefined });
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, missingSource.reader)).status,
    'no-source',
  );
  const missingMapping = fixture();
  missingMapping.mappings.splice(0);
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, missingMapping.reader)).status,
    'unmapped',
  );
});

test('suggestion rejects strict-command violations before any database reads', async () => {
  for (const input of [
    { ...command, productId: ' product-a' },
    { ...command, productId: 'x'.repeat(201) },
    { ...command, apply: true },
    { kind: 'suggestion' },
  ]) {
    const state = fixture();
    await assert.rejects(readCatalogCategorySuggestion('admin', input, state.reader));
    assert.deepEqual(state.reads, []);
  }
});

test('suggestion rejects a wrong-family registry and a legacy child attached to another family', async () => {
  const state = fixture();
  state.store.catalogTaxonomies = [{ _id: 'headphones', ...initialCatalogTaxonomy('toys') }];
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, state.reader)).status,
    'invalid',
  );
  state.mapping.productFamily = 'toys';
  assert.equal(
    (await readCatalogCategorySuggestion('admin', command, state.reader)).status,
    'invalid',
  );
});
