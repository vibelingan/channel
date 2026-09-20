import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CollectionDoc, initialCatalogTaxonomy } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from '../../../apps/local-server/src/json-adapter.ts';
import type { CatalogProductSaveInput } from './adapter.ts';
import { resolveCatalogMappingEvidence } from './catalog-mapping-transaction.ts';
import {
  CatalogExpectedSuggestionSchema,
  planCatalogSuggestionSave,
} from './catalog-suggestion-save.ts';
import { type NodeSdkDatabase, saveCatalogProductInCloudBase } from './cloudbase-adapter.ts';

const now = '2026-09-18T12:00:00.000Z';
const fence = 'suggestion-save-fence';

function fixture() {
  const product: CollectionDoc = {
    _id: 'product',
    productFamily: 'headphones',
    subcategoryIds: [],
    updatedAt: now,
    alibabaPrimarySourceKey: 'source',
    alibabaSourceCategoryId: '100',
    alibabaSourceReview: { sourceCategoryId: '100' },
  };
  const source: CollectionDoc = {
    _id: 'source',
    sourceCategoryId: '100',
    active: true,
    updatedAt: now,
    metadata: { preserved: true },
  };
  const link: CollectionDoc = { _id: 'source', productId: 'product', updatedAt: now };
  const mapping: CollectionDoc = {
    _id: 'alibaba-icbu-100',
    provider: 'alibaba',
    sourceTaxonomy: 'alibaba:icbu',
    sourceCategoryId: '100',
    productFamily: 'headphones',
    subcategoryIds: ['headphones-wired'],
    reviewRequired: false,
    updatedAt: now,
  };
  const registry: CollectionDoc = {
    ...initialCatalogTaxonomy('headphones'),
    _id: 'headphones',
  };
  const evidence = resolveCatalogMappingEvidence(mapping, registry);
  assert.equal(evidence.status, 'ready');
  if (evidence.status !== 'ready') throw new Error('Invalid fixture mapping');
  const input: CatalogProductSaveInput = {
    mode: 'update',
    productId: product._id,
    data: { productFamily: evidence.family, subcategoryIds: [...evidence.subcategoryIds] },
    requireDetailApproval: true,
    expectedClassification: {
      productUpdatedAt: now,
      taxonomyRevision: evidence.taxonomyRevision,
      actorId: 'admin',
    },
    expectedSuggestion: {
      kind: 'suggestion',
      productId: product._id,
      productUpdatedAt: now,
      source: { primarySourceKey: source._id, sourceCategoryId: '100' },
      mapping: evidence.mapping,
      family: evidence.family,
      subcategoryIds: [...evidence.subcategoryIds],
      taxonomyRevision: evidence.taxonomyRevision,
    },
  };
  return { product, source, link, mapping, registry, input };
}

function plan(current: ReturnType<typeof fixture>) {
  return planCatalogSuggestionSave(current.product, current.input, current, fence);
}

function assertChanged(result: unknown) {
  assert.deepEqual(result, {
    result: 'invalid-product',
    issues: [
      { field: 'category', message: 'Product classification changed. Reload before saving.' },
    ],
  });
}

test('unchanged suggestion prepares three fences without changing its evidence or inputs', () => {
  const current = fixture();
  const before = structuredClone(current);
  const result = plan(current);
  assert.equal(result.result, 'ready');
  if (result.result !== 'ready') return;
  assert.deepEqual(result.fences, [
    {
      collection: 'alibabaSourceProducts',
      doc: { ...current.source, categoryAssignmentFence: fence },
    },
    { collection: 'alibabaProductLinks', doc: { ...current.link, categoryAssignmentFence: fence } },
    {
      collection: 'sourceCategoryMappings',
      doc: { ...current.mapping, categoryAssignmentFence: fence },
    },
  ]);
  const fencedMapping = result.fences.find(
    ({ collection }) => collection === 'sourceCategoryMappings',
  );
  assert.ok(fencedMapping);
  assert.deepEqual(
    resolveCatalogMappingEvidence(fencedMapping.doc, current.registry),
    resolveCatalogMappingEvidence(current.mapping, current.registry),
  );
  assert.deepEqual(current, before);
});

const tampering: [string, (current: ReturnType<typeof fixture>) => void][] = [
  ['product id', ({ product }) => Object.assign(product, { _id: 'other' })],
  [
    'product timestamp',
    ({ product }) => Object.assign(product, { updatedAt: '2026-09-18T12:00:00.001Z' }),
  ],
  [
    'product primary source',
    ({ product }) => Object.assign(product, { alibabaPrimarySourceKey: 'other' }),
  ],
  [
    'direct product category',
    ({ product }) => Object.assign(product, { alibabaSourceCategoryId: '200' }),
  ],
  [
    'nested product category',
    ({ product }) => Object.assign(product, { alibabaSourceReview: { sourceCategoryId: '200' } }),
  ],
  [
    'malformed direct category',
    ({ product }) => Object.assign(product, { alibabaSourceCategoryId: 100 }),
  ],
  [
    'malformed nested category',
    ({ product }) => Object.assign(product, { alibabaSourceReview: { sourceCategoryId: 100 } }),
  ],
  ['source identity', ({ source }) => Object.assign(source, { _id: 'other' })],
  [
    'source category in the same millisecond',
    ({ source }) => Object.assign(source, { sourceCategoryId: '200' }),
  ],
  ['source activity', ({ source }) => Object.assign(source, { active: false })],
  ['link identity', ({ link }) => Object.assign(link, { _id: 'other' })],
  ['link target', ({ link }) => Object.assign(link, { productId: 'other' })],
  ['mapping identity', ({ mapping }) => Object.assign(mapping, { _id: 'other' })],
  ['mapping provider', ({ mapping }) => Object.assign(mapping, { provider: 'other' })],
  ['mapping source taxonomy', ({ mapping }) => Object.assign(mapping, { sourceTaxonomy: 'other' })],
  ['mapping source category', ({ mapping }) => Object.assign(mapping, { sourceCategoryId: '200' })],
  ['mapping review state', ({ mapping }) => Object.assign(mapping, { reviewRequired: true })],
  [
    'mapping digest in the same millisecond',
    ({ mapping }) => Object.assign(mapping, { policyVersion: 'changed' }),
  ],
  ['mapping family', ({ mapping }) => Object.assign(mapping, { productFamily: 'toys' })],
  [
    'mapping children',
    ({ mapping }) => Object.assign(mapping, { subcategoryIds: ['headphones-office'] }),
  ],
  ['registry identity', ({ registry }) => Object.assign(registry, { _id: 'toys' })],
  ['registry revision', ({ registry }) => Object.assign(registry, { revision: 1 })],
  ['registry targets', ({ registry }) => Object.assign(registry, { children: [] })],
  ['request product', ({ input }) => Object.assign(input, { productId: 'other' })],
  ['request family', ({ input }) => Object.assign(input.data, { productFamily: 'toys' })],
  ['request children', ({ input }) => Object.assign(input.data, { subcategoryIds: [] })],
  [
    'classification revision',
    ({ input }) => {
      assert.ok(input.expectedClassification);
      input.expectedClassification.taxonomyRevision = 1;
    },
  ],
  [
    'classification timestamp',
    ({ input }) => {
      assert.ok(input.expectedClassification);
      input.expectedClassification.productUpdatedAt = null;
    },
  ],
  [
    'missing classification expectation',
    ({ input }) => {
      Reflect.deleteProperty(input, 'expectedClassification');
    },
  ],
  ['creation', ({ input }) => Object.assign(input, { mode: 'create' })],
];

for (const [name, mutate] of tampering) {
  test(`suggestion rejects changed ${name}`, () => {
    const current = fixture();
    mutate(current);
    const before = structuredClone(current);
    assertChanged(plan(current));
    assert.deepEqual(current, before);
  });
}

test('missing source, link, mapping or product rejects without fences', () => {
  const current = fixture();
  for (const key of ['source', 'link', 'mapping'] as const) {
    assertChanged(
      planCatalogSuggestionSave(current.product, current.input, { ...current, [key]: null }, fence),
    );
  }
  assertChanged(planCatalogSuggestionSave(null, current.input, current, fence));
});

test('runtime evidence parser rejects invalid and prototype-shaped families before lookup', () => {
  const expected = fixture().input.expectedSuggestion;
  assert.ok(expected);
  for (const value of [
    null,
    [],
    { ...expected, family: '__proto__' },
    { ...expected, family: 'constructor' },
    { ...expected, family: 'toString' },
    { ...expected, subcategoryIds: ['headphones-wired', 'headphones-wired'] },
    { ...expected, taxonomyRevision: -1 },
    { ...expected, source: { ...expected.source, extra: true } },
    { ...expected, mapping: { ...expected.mapping, revision: 'invalid' } },
    { ...expected, extra: true },
  ]) {
    assert.equal(CatalogExpectedSuggestionSchema.safeParse(value).success, false);
    const current = fixture();
    Reflect.set(current.input, 'expectedSuggestion', value);
    assertChanged(plan(current));
  }
  assert.equal(CatalogExpectedSuggestionSchema.safeParse(expected).success, true);
  assert.equal(
    CatalogExpectedSuggestionSchema.safeParse({ ...expected, status: 'ready' }).success,
    true,
  );
});

test('ordinary saves do not fence suggestion documents', () => {
  const current = fixture();
  const { expectedSuggestion: _expected, ...ordinary } = current.input;
  current.input = ordinary;
  assert.deepEqual(plan(current), { result: 'ready', fences: [] });
});

function seed(current: ReturnType<typeof fixture>): Record<string, CollectionDoc[]> {
  return {
    users: [{ _id: 'admin', role: 'admin', status: 'active', metadata: 'preserved' }],
    products: [current.product],
    catalogTaxonomies: [current.registry],
    alibabaSourceProducts: [current.source],
    alibabaProductLinks: [current.link],
    sourceCategoryMappings: [current.mapping],
  };
}

function cloudDatabase(initial: Record<string, CollectionDoc[]>) {
  const store = new Map(
    Object.entries(initial).map(([collection, documents]) => [
      collection,
      new Map(documents.map((document) => [document._id, structuredClone(document)])),
    ]),
  );
  const reads: string[] = [];
  const writes: string[] = [];
  const behavior: {
    failCollection?: string;
    beforeCommit?: () => void;
  } = {};
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    runTransaction: async (operation) => {
      const snapshot = structuredClone(store);
      const draft = structuredClone(store);
      const touched: { collection: string; id: string }[] = [];
      const write = (collection: string, id: string, data: Record<string, unknown>) => {
        writes.push(`${collection}/${id}`);
        touched.push({ collection, id });
        const documents = draft.get(collection) ?? new Map<string, CollectionDoc>();
        documents.set(id, { ...data, _id: id });
        draft.set(collection, documents);
      };
      const result = await operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => {
              reads.push(`${collection}/${id}`);
              return { data: structuredClone(draft.get(collection)?.get(id) ?? null) };
            },
            set: async (data) => {
              assert.equal(Object.hasOwn(data, '_id'), false);
              if (behavior.failCollection === collection) return { updated: 0 };
              const exists = draft.get(collection)?.has(id);
              write(collection, id, data);
              return exists ? { updated: 1 } : { upserted: [{ _id: id }] };
            },
            update: async (patch) => {
              if (behavior.failCollection === collection) return { updated: 0 };
              const existing = draft.get(collection)?.get(id);
              if (!existing) return { updated: 0 };
              write(collection, id, { ...existing, ...patch });
              return { updated: 1 };
            },
            remove: async () => {
              writes.push(`${collection}/${id}`);
              touched.push({ collection, id });
              return { deleted: draft.get(collection)?.delete(id) ? 1 : 0 };
            },
          }),
        }),
      });
      behavior.beforeCommit?.();
      for (const { collection, id } of touched) {
        assert.deepEqual(
          store.get(collection)?.get(id),
          snapshot.get(collection)?.get(id),
          'write conflict',
        );
      }
      for (const { collection, id } of touched) {
        const documents = store.get(collection) ?? new Map<string, CollectionDoc>();
        const doc = draft.get(collection)?.get(id);
        if (doc) documents.set(id, doc);
        else documents.delete(id);
        store.set(collection, documents);
      }
      return result;
    },
  };
  return { db, store, reads, writes, behavior };
}

test('cloud save fences exact source, link and mapping while retaining actor and registry fences', async () => {
  const current = fixture();
  current.product.catalogDetailApprovalReceipt = { contentFingerprint: 'untouched' };
  const cloud = cloudDatabase(seed(current));
  assert.equal((await saveCatalogProductInCloudBase(cloud.db, current.input, now)).result, 'saved');
  const fences: unknown[] = [];
  for (const [collection, before] of [
    ['alibabaSourceProducts', current.source],
    ['alibabaProductLinks', current.link],
    ['sourceCategoryMappings', current.mapping],
  ] as const) {
    const doc = cloud.store.get(collection)?.get(before._id);
    assert.ok(doc);
    assert.equal(typeof doc.categoryAssignmentFence, 'string');
    fences.push(doc.categoryAssignmentFence);
    assert.deepEqual(doc, { ...before, categoryAssignmentFence: doc.categoryAssignmentFence });
    assert.ok(cloud.reads.includes(`${collection}/${before._id}`));
  }
  assert.equal(new Set(fences).size, 1);
  assert.match(String(fences[0]), /^[a-f0-9-]{36}$/);
  assert.equal(typeof cloud.store.get('users')?.get('admin')?.classificationAuthFence, 'string');
  assert.equal(cloud.store.get('catalogTaxonomies')?.get('headphones')?.assignmentFence, 1);
  const saved = cloud.store.get('products')?.get('product');
  assert.deepEqual(saved?.subcategoryIds, ['headphones-wired']);
  assert.equal(saved?.updatedAt, '2026-09-18T12:00:00.001Z');
  assert.deepEqual(
    saved?.catalogDetailApprovalReceipt,
    current.product.catalogDetailApprovalReceipt,
  );
  assert.equal(saved?.alibabaPrimarySourceKey, current.product.alibabaPrimarySourceKey);
});

test('cloud revalidates every stale suggestion dependency with zero attempted writes', async () => {
  for (const [name, mutate] of tampering) {
    const current = fixture();
    mutate(current);
    const cloud = cloudDatabase(seed(current));
    cloud.store.set('catalogTaxonomies', new Map([['headphones', current.registry]]));
    const before = structuredClone(cloud.store);
    const result = await saveCatalogProductInCloudBase(cloud.db, current.input, now);
    assert.equal(result.result, 'invalid-product', name);
    assert.deepEqual(cloud.writes, [], name);
    assert.deepEqual(cloud.store, before, name);
  }
});

test('suggestion acceptance still enforces current administrator authorization', async () => {
  for (const users of [
    [],
    [{ _id: 'admin', role: 'member' }],
    [{ _id: 'admin', role: 'admin', status: 'suspended' }],
  ]) {
    const current = fixture();
    const cloud = cloudDatabase({ ...seed(current), users });
    assert.equal(
      (await saveCatalogProductInCloudBase(cloud.db, current.input, now)).result,
      'invalid-product',
    );
    assert.deepEqual(cloud.writes, []);
  }
});

test('suggestion acceptance cannot replace required detail approval', async () => {
  const current = fixture();
  current.product.published = true;
  const cloud = cloudDatabase(seed(current));
  const result = await saveCatalogProductInCloudBase(cloud.db, current.input, now);
  assert.equal(result.result, 'invalid-product');
  if (result.result !== 'invalid-product') return;
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.field === 'published' &&
        issue.message === 'Review and approve the current product details before publishing.',
    ),
  );
  assert.deepEqual(cloud.writes, []);
});

test('cloud rejects malformed expectation before any dynamic document lookup', async () => {
  const current = fixture();
  Reflect.set(current.input, 'expectedSuggestion', {
    ...current.input.expectedSuggestion,
    family: '__proto__',
  });
  const cloud = cloudDatabase(seed(current));
  assertChanged(await saveCatalogProductInCloudBase(cloud.db, current.input, now));
  assert.deepEqual(cloud.reads, []);
  assert.deepEqual(cloud.writes, []);
});

test('cloud identity conflict leaves all suggestion documents and fences untouched', async () => {
  const current = fixture();
  current.input.data.slug = 'taken';
  const cloud = cloudDatabase({
    ...seed(current),
    catalogProductIdentities: [
      { _id: 'slug:taken', kind: 'slug', normalizedValue: 'taken', productId: 'other' },
    ],
  });
  assert.equal(
    (await saveCatalogProductInCloudBase(cloud.db, current.input, now)).result,
    'conflict',
  );
  assert.deepEqual(cloud.writes, []);
});

test('cloud unacknowledged actor, registry or suggestion fences roll back the complete save', async () => {
  for (const collection of [
    'users',
    'catalogTaxonomies',
    'alibabaSourceProducts',
    'alibabaProductLinks',
    'sourceCategoryMappings',
  ]) {
    const current = fixture();
    current.input.data.slug = 'new-product';
    const cloud = cloudDatabase(seed(current));
    cloud.behavior.failCollection = collection;
    const before = structuredClone(cloud.store);
    await assert.rejects(
      saveCatalogProductInCloudBase(cloud.db, current.input, now),
      /not acknowledged/,
    );
    assert.deepEqual(cloud.store, before, collection);
  }
});

test('cloud source, link and mapping changes during the transaction conflict without overwriting the concurrent edit', async () => {
  for (const [collection, id, patch] of [
    ['alibabaSourceProducts', 'source', { active: false }],
    ['alibabaProductLinks', 'source', { productId: 'other' }],
    ['sourceCategoryMappings', 'alibaba-icbu-100', { policyVersion: 'changed' }],
  ] as const) {
    const current = fixture();
    const cloud = cloudDatabase(seed(current));
    cloud.behavior.beforeCommit = () => {
      const doc = cloud.store.get(collection)?.get(id);
      assert.ok(doc);
      Object.assign(doc, patch);
    };
    await assert.rejects(
      saveCatalogProductInCloudBase(cloud.db, current.input, now),
      /write conflict/,
    );
    assert.deepEqual(cloud.store.get('products')?.get('product'), current.product);
    assert.equal(cloud.store.get('users')?.get('admin')?.classificationAuthFence, undefined);
    assert.equal(
      cloud.store.get('catalogTaxonomies')?.get('headphones')?.assignmentFence,
      undefined,
    );
    const changed = cloud.store.get(collection)?.get(id);
    assert.ok(changed);
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(changed[key], value);
    assert.equal(changed.categoryAssignmentFence, undefined);
  }
});

function localDatabase(
  context: Pick<import('node:test').TestContext, 'after'>,
  current = fixture(),
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-suggestion-save-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(file, JSON.stringify(seed(current)));
  return { adapter: new JsonFileAdapter(file), file, current };
}

test('local save commits suggestion fences together and rejects same-clock replay', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const { adapter, file, current } = localDatabase(context);
  assert.equal((await adapter.saveCatalogProductWithIdentities(current.input)).result, 'saved');
  const saved = await adapter.get('products', 'product');
  assert.equal(saved?.updatedAt, '2026-09-18T12:00:00.001Z');
  assert.deepEqual(saved?.subcategoryIds, ['headphones-wired']);
  for (const [collection, original] of [
    ['alibabaSourceProducts', current.source],
    ['alibabaProductLinks', current.link],
    ['sourceCategoryMappings', current.mapping],
  ] as const) {
    const doc = await adapter.get(collection, original._id);
    assert.ok(doc);
    assert.equal(typeof doc.categoryAssignmentFence, 'string');
    assert.deepEqual(doc, { ...original, categoryAssignmentFence: doc.categoryAssignmentFence });
  }
  const before = readFileSync(file, 'utf8');
  assertChanged(await adapter.saveCatalogProductWithIdentities(current.input));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('local source changes after actual preflight read within the same millisecond reject without writes', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const { adapter, file, current } = localDatabase(context);
  const preflight = await adapter.get('alibabaSourceProducts', 'source');
  assert.deepEqual(preflight, current.source);
  await adapter.update('alibabaSourceProducts', 'source', { sourceCategoryId: '200' });
  assert.equal(
    (await adapter.get('alibabaSourceProducts', 'source'))?.updatedAt,
    preflight?.updatedAt,
  );
  const before = readFileSync(file, 'utf8');
  assertChanged(await adapter.saveCatalogProductWithIdentities(current.input));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('local persistence failure restores suggestion documents and all fences in memory and on disk', async (context) => {
  const { adapter, file, current } = localDatabase(context);
  const before = readFileSync(file, 'utf8');
  const storeBefore: unknown = structuredClone(Reflect.get(adapter, 'store'));
  Object.defineProperty(adapter, 'persist', {
    configurable: true,
    value: () => {
      throw new Error('injected persistence failure');
    },
  });
  await assert.rejects(
    adapter.saveCatalogProductWithIdentities(current.input),
    /injected persistence failure/,
  );
  assert.deepEqual(Reflect.get(adapter, 'store'), storeBefore);
  assert.equal(readFileSync(file, 'utf8'), before);
});
