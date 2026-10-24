import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type CatalogTaxonomy,
  type CollectionDoc,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { JsonFileAdapter } from '../../../apps/local-server/src/json-adapter.ts';
import { type CatalogProductSaveInput, planCatalogProductSave } from './adapter.ts';
import { type NodeSdkDatabase, saveCatalogProductInCloudBase } from './cloudbase-adapter.ts';
import { planProductSubcategorySave as planSubcategorySave } from './product-subcategory-save.ts';

const updatedAt = '2026-09-18T01:00:00.000Z';

function administrator(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return { _id: 'admin-a', role: 'admin', ...overrides };
}

function planProductSubcategorySave(
  existing: CollectionDoc | null,
  input: CatalogProductSaveInput,
  storedRegistry: CollectionDoc | null,
  actor: CollectionDoc | null = administrator(),
) {
  return planSubcategorySave(existing, input, storedRegistry, actor);
}

function product(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'product-a',
    productFamily: 'headphones',
    subcategoryIds: ['headphones-wired'],
    updatedAt,
    ...overrides,
  };
}

function save(
  overrides: Omit<Partial<CatalogProductSaveInput>, 'expectedClassification'> & {
    expectedClassification?: CatalogProductSaveInput['expectedClassification'];
  } = {},
): CatalogProductSaveInput {
  const { expectedClassification, ...rest } = overrides;
  const input: CatalogProductSaveInput = {
    mode: 'update',
    productId: 'product-a',
    data: { subcategoryIds: ['headphones-wired'] },
    ...rest,
  };
  if (!Object.hasOwn(overrides, 'expectedClassification'))
    input.expectedClassification = {
      productUpdatedAt: updatedAt,
      taxonomyRevision: 0,
      actorId: 'admin-a',
    };
  else if (expectedClassification !== undefined)
    input.expectedClassification = { actorId: 'admin-a', ...expectedClassification };
  return input;
}

function registry(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return { ...initialCatalogTaxonomy('headphones'), _id: 'headphones', ...overrides };
}

function archivedRegistry(): CollectionDoc {
  const taxonomy = initialCatalogTaxonomy('headphones');
  return registry({
    children: taxonomy.children.map((child) => ({ ...child, status: 'archived' })),
  });
}

function invalid(result: ReturnType<typeof planProductSubcategorySave>): void {
  assert.equal(result.result, 'invalid-product');
  if (result.result !== 'invalid-product') return;
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => issue.field === 'category'));
  assert.equal(Object.hasOwn(result, 'registryFence'), false);
}

test('creation accepts multiple valid assignments and fences the deterministic default', () => {
  const input = save({
    mode: 'create',
    data: {
      productFamily: 'headphones',
      subcategoryIds: ['headphones-wired', 'headphones-office'],
    },
    expectedClassification: { productUpdatedAt: null, taxonomyRevision: 0 },
  });
  const snapshot = structuredClone(input);
  assert.deepEqual(planProductSubcategorySave(null, input, null), {
    result: 'ready',
    registryFence: registry({ assignmentFence: 1 }),
  });
  assert.deepEqual(input, snapshot);
});

test('explicit empty assignments remain explicit and also fence the registry', () => {
  const input = save({ data: { subcategoryIds: [] } });
  assert.deepEqual(planProductSubcategorySave(product(), input, null), {
    result: 'ready',
    registryFence: registry({ assignmentFence: 1 }),
  });
  assert.deepEqual(input.data.subcategoryIds, []);
});

test('unrelated price and media writes do not validate or fence malformed classifications', () => {
  for (const data of [{ price: 12 }, { imageIds: ['image-a'] }, { name: 'Renamed' }]) {
    const stored = product({ subcategoryIds: null, productFamily: 'broken' });
    const snapshot = structuredClone(stored);
    assert.deepEqual(
      planProductSubcategorySave(stored, save({ data, expectedClassification: undefined }), null),
      { result: 'ready' },
    );
    assert.deepEqual(stored, snapshot);
  }
});

test('explicit assignments require a classification expectation', () => {
  invalid(planProductSubcategorySave(product(), save({ expectedClassification: undefined }), null));
});

test('product timestamp and taxonomy revision must both match', () => {
  for (const expectedClassification of [
    { productUpdatedAt: null, taxonomyRevision: 0 },
    { productUpdatedAt: 'stale', taxonomyRevision: 0 },
    { productUpdatedAt: updatedAt, taxonomyRevision: 1 },
    { productUpdatedAt: updatedAt, taxonomyRevision: -1 },
    { productUpdatedAt: updatedAt, taxonomyRevision: 0.5 },
  ]) {
    invalid(planProductSubcategorySave(product(), save({ expectedClassification }), null));
  }
});

test('creation requires a null product timestamp and the current taxonomy revision', () => {
  for (const expectedClassification of [
    { productUpdatedAt: updatedAt, taxonomyRevision: 0 },
    { productUpdatedAt: null, taxonomyRevision: 1 },
  ]) {
    invalid(
      planProductSubcategorySave(
        null,
        save({
          mode: 'create',
          data: { productFamily: 'headphones', subcategoryIds: [] },
          expectedClassification,
        }),
        null,
      ),
    );
  }
});

test('updates cannot treat a missing or malformed stored timestamp as a create', () => {
  for (const timestamp of [undefined, null, 17, '']) {
    const stored = product();
    Reflect.set(stored, 'updatedAt', timestamp);
    invalid(
      planProductSubcategorySave(
        stored,
        save({ expectedClassification: { productUpdatedAt: null, taxonomyRevision: 0 } }),
        null,
      ),
    );
  }
});

test('explicit assignments require a valid family even for a clear', () => {
  for (const productFamily of [undefined, null, 'unknown', '']) {
    invalid(
      planProductSubcategorySave(
        product(),
        save({ data: { productFamily, subcategoryIds: [] } }),
        null,
      ),
    );
  }
});

test('rejects unknown, wrong-parent, duplicate and malformed assignment values', () => {
  for (const subcategoryIds of [
    ['unknown'],
    ['toys-wired'],
    ['headphones-wired', 'headphones-wired'],
    [' headphones-wired'],
    null,
    undefined,
    'headphones-wired',
    [12],
  ]) {
    invalid(planProductSubcategorySave(product(), save({ data: { subcategoryIds } }), null));
  }
});

test('new assignments cannot select archived children', () => {
  invalid(planProductSubcategorySave(product({ subcategoryIds: [] }), save(), archivedRegistry()));
  invalid(
    planProductSubcategorySave(
      null,
      save({
        mode: 'create',
        data: { productFamily: 'headphones', subcategoryIds: ['headphones-wired'] },
        expectedClassification: { productUpdatedAt: null, taxonomyRevision: 0 },
      }),
      archivedRegistry(),
    ),
  );
});

test('valid previous assignments may retain or remove archived children in the same family', () => {
  for (const subcategoryIds of [['headphones-wired'], []]) {
    assert.equal(
      planProductSubcategorySave(product(), save({ data: { subcategoryIds } }), archivedRegistry())
        .result,
      'ready',
    );
  }
});

test('malformed previous assignments can be repaired but cannot inherit archived children', () => {
  for (const subcategoryIds of [
    null,
    ['headphones-wired', 'unknown'],
    ['headphones-wired', 'headphones-wired'],
  ]) {
    const stored = product({ subcategoryIds });
    assert.equal(
      planProductSubcategorySave(stored, save({ data: { subcategoryIds: [] } }), archivedRegistry())
        .result,
      'ready',
    );
    assert.equal(planProductSubcategorySave(stored, save(), null).result, 'ready');
    invalid(planProductSubcategorySave(stored, save(), archivedRegistry()));
  }
});

test('moving a migrated product requires explicit new IDs and an expectation, including an empty prior list', () => {
  for (const subcategoryIds of [[], ['headphones-wired'], null]) {
    invalid(
      planProductSubcategorySave(
        product({ subcategoryIds }),
        save({ data: { productFamily: 'toys' } }),
        null,
      ),
    );
    invalid(
      planProductSubcategorySave(
        product({ subcategoryIds }),
        save({
          data: { productFamily: 'toys', subcategoryIds: [] },
          expectedClassification: undefined,
        }),
        null,
      ),
    );
  }
});

test('parent moves accept an explicit clear or active children of the new parent', () => {
  const taxonomy: CatalogTaxonomy = {
    ...initialCatalogTaxonomy('toys'),
    children: [{ id: 'toy-a', name: 'Toy A', slug: 'toy-a', order: 0, status: 'active' }],
  };
  for (const subcategoryIds of [[], ['toy-a']]) {
    const result = planProductSubcategorySave(
      product(),
      save({ data: { productFamily: 'toys', subcategoryIds } }),
      { ...taxonomy, _id: 'toys' },
    );
    assert.equal(result.result, 'ready');
    if (result.result === 'ready') assert.equal(result.registryFence?._id, 'toys');
  }
  invalid(
    planProductSubcategorySave(
      product(),
      save({ data: { productFamily: 'toys', subcategoryIds: ['headphones-wired'] } }),
      null,
    ),
  );
});

test('a shared ID in a different family cannot inherit archived status', () => {
  const target = registry({ family: 'toys', _id: 'toys', children: archivedRegistry().children });
  invalid(
    planProductSubcategorySave(
      product(),
      save({ data: { productFamily: 'toys', subcategoryIds: ['headphones-wired'] } }),
      target,
    ),
  );
});

test('migrated products reject changed legacy scalars before checking explicit assignments', () => {
  for (const category of ['office', '', null, undefined, ['wired']]) {
    for (const data of [{ category }, { category, subcategoryIds: [] }]) {
      invalid(planProductSubcategorySave(product({ category: 'wired' }), save({ data }), null));
    }
  }
});

test('identical legacy scalar patches require explicit assignments and classification expectations', () => {
  const stored = product({ category: 'wired' });
  invalid(planProductSubcategorySave(stored, save({ data: { category: 'wired' } }), null));
  invalid(
    planProductSubcategorySave(
      stored,
      save({ data: { category: 'wired', subcategoryIds: [] }, expectedClassification: undefined }),
      null,
    ),
  );
  assert.equal(
    planProductSubcategorySave(
      stored,
      save({ data: { category: 'wired', subcategoryIds: [] } }),
      null,
    ).result,
    'ready',
  );
});

test('legacy-only writes stay unchanged until the product has explicit assignments', () => {
  const stored: CollectionDoc = {
    _id: 'product-a',
    productFamily: 'headphones',
    category: 'wired',
    updatedAt,
  };
  assert.deepEqual(
    planProductSubcategorySave(
      stored,
      save({ data: { category: 'office' }, expectedClassification: undefined }),
      null,
    ),
    { result: 'ready' },
  );
});

test('strict registry validation selects schema fields without discarding stored metadata', () => {
  const stored = registry({
    revision: 4,
    assignmentFence: 8,
    updatedAt,
    audit: { actor: 'admin-a' },
  });
  const snapshot = structuredClone(stored);
  const result = planProductSubcategorySave(
    product(),
    save({ expectedClassification: { productUpdatedAt: updatedAt, taxonomyRevision: 4 } }),
    stored,
  );
  assert.deepEqual(result, { result: 'ready', registryFence: { ...stored, assignmentFence: 9 } });
  assert.deepEqual(stored, snapshot);
});

test('corrupt registry rows fail closed rather than falling back to defaults', () => {
  for (const stored of [
    registry({ _id: 'toys' }),
    registry({ family: 'toys' }),
    registry({ revision: '0' }),
    registry({ children: null }),
    registry({ name: '' }),
  ]) {
    invalid(planProductSubcategorySave(product(), save({ data: { subcategoryIds: [] } }), stored));
  }
});

test('fence counter rejects corruption and rollover', () => {
  for (const assignmentFence of [
    null,
    -1,
    0.5,
    '1',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ]) {
    invalid(planProductSubcategorySave(product(), save(), registry({ assignmentFence })));
  }
  const result = planProductSubcategorySave(
    product(),
    save(),
    registry({ assignmentFence: Number.MAX_SAFE_INTEGER - 1 }),
  );
  assert.equal(result.result, 'ready');
  if (result.result === 'ready')
    assert.equal(result.registryFence?.assignmentFence, Number.MAX_SAFE_INTEGER);
});

function localDatabase(
  context: Pick<import('node:test').TestContext, 'after'>,
  store: Record<string, CollectionDoc[]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-subcategory-save-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(file, JSON.stringify({ users: [administrator()], ...store }));
  return { file, adapter: new JsonFileAdapter(file) };
}

test('local adapter persists multiple assignments, identities and first registry fence together', async (context) => {
  const { adapter, file } = localDatabase(context);
  const subcategoryIds = ['headphones-wired', 'headphones-office'];
  const result = await adapter.saveCatalogProductWithIdentities(
    save({
      mode: 'create',
      data: { productFamily: 'headphones', subcategoryIds, slug: 'headset-a', skuCode: 'sku-a' },
      expectedClassification: { productUpdatedAt: null, taxonomyRevision: 0 },
    }),
  );
  assert.equal(result.result, 'saved');
  const reopened = new JsonFileAdapter(file);
  assert.deepEqual((await reopened.get('products', 'product-a'))?.subcategoryIds, subcategoryIds);
  assert.equal(typeof (await reopened.get('users', 'admin-a'))?.classificationAuthFence, 'string');
  assert.equal((await reopened.get('users', 'admin-a'))?.role, 'admin');
  assert.deepEqual(
    await reopened.get('catalogTaxonomies', 'headphones'),
    registry({ assignmentFence: 1 }),
  );
  assert.equal(
    (await reopened.get('catalogProductIdentities', 'slug:headset-a'))?.productId,
    'product-a',
  );
  assert.equal(
    (await reopened.get('catalogProductIdentities', 'sku:sku-a'))?.productId,
    'product-a',
  );
});

test('local adapter rejects invalid, stale, legacy and implicit-parent changes without writes', async (context) => {
  const { adapter, file } = localDatabase(context, {
    products: [product({ category: 'wired' })],
    catalogTaxonomies: [archivedRegistry()],
  });
  const before = readFileSync(file, 'utf8');
  const snapshot = structuredClone(Reflect.get(adapter, 'store'));
  for (const input of [
    save({ expectedClassification: undefined }),
    save({ expectedClassification: { productUpdatedAt: 'stale', taxonomyRevision: 0 } }),
    save({ expectedClassification: { productUpdatedAt: updatedAt, taxonomyRevision: 1 } }),
    save({ data: { subcategoryIds: ['headphones-office'] } }),
    save({ data: { subcategoryIds: ['unknown'], slug: 'free-slug' } }),
    save({ data: { category: 'office' } }),
    save({ data: { productFamily: 'toys' } }),
  ]) {
    const result = await adapter.saveCatalogProductWithIdentities(input);
    assert.equal(result.result, 'invalid-product');
    if (result.result === 'invalid-product') assert.equal(result.issues[0]?.field, 'category');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(Reflect.get(adapter, 'store'), snapshot);
  }
});

test('local identity conflicts do not advance the assignment fence or write any product', async (context) => {
  const { adapter, file } = localDatabase(context, {
    products: [product()],
    catalogTaxonomies: [registry({ assignmentFence: 4 })],
    catalogProductIdentities: [
      { _id: 'slug:taken', kind: 'slug', normalizedValue: 'taken', productId: 'other' },
    ],
  });
  const before = readFileSync(file, 'utf8');
  const result = await adapter.saveCatalogProductWithIdentities(
    save({ data: { subcategoryIds: [], slug: 'taken', skuCode: 'free-sku' } }),
  );
  assert.equal(result.result, 'conflict');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal((await adapter.get('catalogTaxonomies', 'headphones'))?.assignmentFence, 4);
});

test('local persistence failure restores product, identity and new or existing registry state', async (context) => {
  for (const catalogTaxonomies of [undefined, [registry({ assignmentFence: 4 })]]) {
    const { adapter, file } = localDatabase(context, {
      products: [product()],
      ...(catalogTaxonomies ? { catalogTaxonomies } : {}),
    });
    const before = readFileSync(file, 'utf8');
    const snapshot = structuredClone(Reflect.get(adapter, 'store'));
    Object.defineProperty(adapter, 'persist', {
      configurable: true,
      value: () => {
        throw new Error('injected persistence failure');
      },
    });
    await assert.rejects(
      adapter.saveCatalogProductWithIdentities(
        save({ data: { subcategoryIds: [], slug: 'new-slug' } }),
      ),
      /injected persistence failure/,
    );
    assert.deepEqual(Reflect.get(adapter, 'store'), snapshot);
    assert.equal(readFileSync(file, 'utf8'), before);
    Reflect.deleteProperty(adapter, 'persist');
    assert.equal(
      (await adapter.saveCatalogProductWithIdentities(save({ data: { subcategoryIds: [] } })))
        .result,
      'saved',
    );
  }
});

test('local ordinary media and price edits preserve assignments, receipts and taxonomy metadata', async (context) => {
  const receipt = { contentFingerprint: 'unchanged' };
  const stored = product({ subcategoryIds: null, price: 5, catalogDetailApprovalReceipt: receipt });
  const taxonomy = registry({ revision: 3, assignmentFence: 4, audit: { actor: 'admin-a' } });
  const { adapter } = localDatabase(context, { products: [stored], catalogTaxonomies: [taxonomy] });
  const result = await adapter.saveCatalogProductWithIdentities(
    save({ data: { price: 7, imageIds: ['image-a'] }, expectedClassification: undefined }),
  );
  assert.equal(result.result, 'saved');
  if (result.result === 'saved') {
    assert.equal(result.doc.subcategoryIds, null);
    assert.equal(result.doc.price, 7);
    assert.deepEqual(result.doc.catalogDetailApprovalReceipt, receipt);
  }
  assert.deepEqual(await adapter.get('catalogTaxonomies', 'headphones'), taxonomy);
});

test('local explicit parent clear persists an empty list and fences only the target registry', async (context) => {
  const source = registry({ assignmentFence: 7 });
  const { adapter, file } = localDatabase(context, {
    products: [product()],
    catalogTaxonomies: [source],
  });
  const result = await adapter.saveCatalogProductWithIdentities(
    save({ data: { productFamily: 'toys', subcategoryIds: [] } }),
  );
  assert.equal(result.result, 'saved');
  const reopened = new JsonFileAdapter(file);
  assert.deepEqual((await reopened.get('products', 'product-a'))?.subcategoryIds, []);
  assert.deepEqual(await reopened.get('catalogTaxonomies', 'headphones'), source);
  assert.deepEqual(await reopened.get('catalogTaxonomies', 'toys'), {
    ...initialCatalogTaxonomy('toys'),
    _id: 'toys',
    assignmentFence: 1,
  });
});

test('local concurrent product saves with one timestamp allow only one assignment', async (context) => {
  const { adapter, file } = localDatabase(context, { products: [product()] });
  const other = new JsonFileAdapter(file);
  const results = await Promise.all([
    adapter.saveCatalogProductWithIdentities(save({ data: { subcategoryIds: [] } })),
    other.saveCatalogProductWithIdentities(
      save({ data: { subcategoryIds: ['headphones-office'] } }),
    ),
  ]);
  assert.equal(results.filter((result) => result.result === 'saved').length, 1);
  assert.equal(results.filter((result) => result.result === 'invalid-product').length, 1);
  assert.equal((await adapter.get('catalogTaxonomies', 'headphones'))?.assignmentFence, 1);
});

test('local sequential classification saves cannot reuse a timestamp within one millisecond', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(updatedAt) });
  const { adapter } = localDatabase(context, { products: [product()] });
  const first = await adapter.saveCatalogProductWithIdentities(
    save({ data: { subcategoryIds: [] } }),
  );
  assert.equal(first.result, 'saved');
  const second = await adapter.saveCatalogProductWithIdentities(
    save({ data: { subcategoryIds: ['headphones-office'] } }),
  );
  assert.equal(second.result, 'invalid-product');
  assert.deepEqual((await adapter.get('products', 'product-a'))?.subcategoryIds, []);
  assert.equal((await adapter.get('catalogTaxonomies', 'headphones'))?.assignmentFence, 1);
});

test('local classification requires an actor and a current administrator without writing anything', async (context) => {
  for (const actor of [
    null,
    { _id: 'admin-a', role: 'member' },
    { _id: 'admin-a', role: 'admin', status: 'suspended' },
  ]) {
    const { adapter, file } = localDatabase(context, {
      products: [product()],
      users: actor ? [actor] : [],
    });
    const before = readFileSync(file, 'utf8');
    const input = save();
    assert.ok(input.expectedClassification);
    Reflect.set(input.expectedClassification, 'actorId', 'admin-a');
    assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'invalid-product');
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

function cloudDatabase(initial: Record<string, CollectionDoc[]> = {}) {
  let store: Record<string, Record<string, CollectionDoc>> = Object.fromEntries(
    Object.entries({ users: [administrator()], products: [product()], ...initial }).map(
      ([collection, documents]) => [
        collection,
        Object.fromEntries(documents.map((document) => [document._id, structuredClone(document)])),
      ],
    ),
  );
  const reads: string[] = [];
  const writes: string[] = [];
  const behavior: {
    failCollection?: string;
    acknowledgement?: unknown;
    setAcknowledgement?: { updated?: number; upserted?: Array<{ _id?: string }> };
    beforeWrite?: () => void;
    beforeCommit?: () => void;
  } = {};
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    runTransaction: async (operation) => {
      const snapshot = structuredClone(store);
      const draft = structuredClone(store);
      const touched: Array<{ collection: string; id: string }> = [];
      const write = (collection: string, id: string, data: Record<string, unknown>) => {
        writes.push(`${collection}/${id}`);
        touched.push({ collection, id });
        behavior.beforeWrite?.();
        assert.deepEqual(store[collection]?.[id], snapshot[collection]?.[id], 'write conflict');
        draft[collection] ??= {};
        draft[collection][id] = { ...data, _id: id };
      };
      const result = await operation({
        collection: (collection) => ({
          doc: (id) => ({
            get: async () => {
              reads.push(`${collection}/${id}`);
              return { data: draft[collection]?.[id] ? [draft[collection][id]] : [] };
            },
            update: async (patch) => {
              if (behavior.failCollection === collection) return behavior.acknowledgement;
              const existing = draft[collection]?.[id];
              if (!existing) return { updated: 0 };
              write(collection, id, { ...existing, ...patch });
              return { updated: 1 };
            },
            set: async (data) => {
              assert.equal(Object.hasOwn(data, '_id'), false);
              if (behavior.failCollection === collection) return behavior.setAcknowledgement ?? {};
              const existed = Boolean(draft[collection]?.[id]);
              write(collection, id, data);
              return existed ? { updated: 1 } : { updated: 0, upserted: [{ _id: id }] };
            },
            remove: async () => {
              assert.deepEqual(
                store[collection]?.[id],
                snapshot[collection]?.[id],
                'write conflict',
              );
              const documents = draft[collection];
              if (!documents?.[id]) return { deleted: 0 };
              Reflect.deleteProperty(documents, id);
              return { deleted: 1 };
            },
          }),
        }),
      });
      behavior.beforeCommit?.();
      for (const { collection, id } of touched) {
        assert.deepEqual(store[collection]?.[id], snapshot[collection]?.[id], 'write conflict');
      }
      store = draft;
      return result;
    },
  };
  return {
    db,
    behavior,
    reads,
    writes,
    snapshot: () => structuredClone(store),
    revoke: (actor: CollectionDoc | null) => {
      store.users ??= {};
      if (actor) store.users['admin-a'] = actor;
      else Reflect.deleteProperty(store.users, 'admin-a');
    },
  };
}

test('cloud saves read and fence the actor in the product transaction with insert acknowledgements', async () => {
  const harness = cloudDatabase();
  const result = await saveCatalogProductInCloudBase(harness.db, save(), updatedAt);
  assert.equal(result.result, 'saved');
  assert.ok(harness.reads.includes('users/admin-a'));
  assert.ok(harness.writes.includes('users/admin-a'));
  assert.equal(typeof harness.snapshot().users?.['admin-a']?.classificationAuthFence, 'string');
  assert.equal(harness.snapshot().catalogTaxonomies?.headphones?.assignmentFence, 1);
});

test('cloud classification aborts when administrator revocation races its transaction', async () => {
  for (const actor of [
    null,
    administrator({ role: 'member' }),
    administrator({ status: 'suspended' }),
  ]) {
    for (const point of ['beforeWrite', 'beforeCommit'] as const) {
      const harness = cloudDatabase();
      const before = harness.snapshot();
      harness.behavior[point] = () => harness.revoke(actor);
      await assert.rejects(
        saveCatalogProductInCloudBase(harness.db, save(), updatedAt),
        /write conflict/,
      );
      assert.deepEqual(harness.snapshot().products, before.products);
      assert.equal(harness.snapshot().catalogTaxonomies, undefined);
      assert.deepEqual(harness.snapshot().users?.['admin-a'] ?? null, actor);
    }
  }
});

test('classification rejects missing, empty, malformed or mismatched actor identity in both adapters', async (context) => {
  for (const actorId of [undefined, '', ' ', null, 12, 'missing-admin']) {
    const input = save();
    assert.ok(input.expectedClassification);
    Reflect.set(input.expectedClassification, 'actorId', actorId);
    invalid(planProductSubcategorySave(product(), input, null));
    const local = localDatabase(context, { products: [product()] });
    const before = readFileSync(local.file, 'utf8');
    assert.equal(
      (await local.adapter.saveCatalogProductWithIdentities(input)).result,
      'invalid-product',
    );
    assert.equal(readFileSync(local.file, 'utf8'), before);
    const cloud = cloudDatabase();
    assert.equal(
      (await saveCatalogProductInCloudBase(cloud.db, input, updatedAt)).result,
      'invalid-product',
    );
    assert.deepEqual(cloud.writes, []);
  }
  invalid(planSubcategorySave(product(), save(), null));
});

test('cloud classification rejects revoked administrators before writing and ordinary saves do not touch users', async () => {
  for (const users of [
    [],
    [administrator({ role: 'member' })],
    [administrator({ status: 'suspended' })],
  ]) {
    const harness = cloudDatabase({ users });
    const before = harness.snapshot();
    assert.equal(
      (await saveCatalogProductInCloudBase(harness.db, save(), updatedAt)).result,
      'invalid-product',
    );
    assert.deepEqual(harness.snapshot(), before);
    assert.deepEqual(harness.writes, []);
    assert.equal(
      (
        await saveCatalogProductInCloudBase(
          harness.db,
          save({ data: { price: 10 }, expectedClassification: undefined }),
          updatedAt,
        )
      ).result,
      'saved',
    );
    assert.deepEqual(harness.snapshot().users, before.users);
    assert.equal(harness.snapshot().catalogTaxonomies, undefined);
  }
});

test('rejected identities and publication never mutate authorization or registry fences', async (context) => {
  const initial = {
    products: [product()],
    catalogProductIdentities: [
      { _id: 'slug:taken', productId: 'other', kind: 'slug', normalizedValue: 'taken' },
    ],
  };
  for (const data of [
    { subcategoryIds: [], slug: 'taken' },
    { subcategoryIds: [], published: true },
  ]) {
    const harness = cloudDatabase(initial);
    const before = harness.snapshot();
    const input = save({ data });
    assert.notEqual(
      (await saveCatalogProductInCloudBase(harness.db, input, updatedAt)).result,
      'saved',
    );
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.snapshot(), before);
    const local = localDatabase(context, initial);
    const contents = readFileSync(local.file, 'utf8');
    assert.notEqual((await local.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    assert.equal(readFileSync(local.file, 'utf8'), contents);
  }
});

test('ordinary product saves advance valid timestamps without rewriting invalid legacy now values', () => {
  for (const now of [updatedAt, '2026-09-17T01:00:00.000Z', '2026-09-19T01:00:00.000Z', 'now']) {
    const result = planCatalogProductSave(
      product(),
      save({ data: { price: 9 }, expectedClassification: undefined }),
      now,
    );
    assert.equal(result.result, 'ready');
    if (result.result !== 'ready') continue;
    assert.equal(
      result.doc.updatedAt,
      now === 'now'
        ? now
        : new Date(Math.max(Date.parse(now), Date.parse(updatedAt) + 1)).toISOString(),
    );
  }
});

test('ordinary price saves invalidate stale classification versions even under a frozen clock', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(updatedAt) });
  const local = localDatabase(context, { products: [product()] });
  const cloud = cloudDatabase();
  const ordinary = save({ data: { price: 9 }, expectedClassification: undefined });
  assert.equal((await local.adapter.saveCatalogProductWithIdentities(ordinary)).result, 'saved');
  assert.equal(
    (await saveCatalogProductInCloudBase(cloud.db, ordinary, updatedAt)).result,
    'saved',
  );
  assert.equal(
    (await local.adapter.saveCatalogProductWithIdentities(save())).result,
    'invalid-product',
  );
  assert.equal(
    (await saveCatalogProductInCloudBase(cloud.db, save(), updatedAt)).result,
    'invalid-product',
  );
  assert.equal((await local.adapter.get('users', 'admin-a'))?.classificationAuthFence, undefined);
  assert.equal(cloud.snapshot().users?.['admin-a']?.classificationAuthFence, undefined);
});

test('cloud sequential classification saves advance both timestamp and authorization fence', async () => {
  const harness = cloudDatabase();
  const first = await saveCatalogProductInCloudBase(harness.db, save(), updatedAt);
  assert.equal(first.result, 'saved');
  if (first.result !== 'saved') return;
  const fence = harness.snapshot().users?.['admin-a']?.classificationAuthFence;
  assert.equal(
    (await saveCatalogProductInCloudBase(harness.db, save(), updatedAt)).result,
    'invalid-product',
  );
  assert.equal(harness.snapshot().users?.['admin-a']?.classificationAuthFence, fence);
  const next = save({
    expectedClassification: { productUpdatedAt: String(first.doc.updatedAt), taxonomyRevision: 0 },
  });
  assert.equal((await saveCatalogProductInCloudBase(harness.db, next, updatedAt)).result, 'saved');
  assert.notEqual(harness.snapshot().users?.['admin-a']?.classificationAuthFence, fence);
  assert.equal(harness.snapshot().catalogTaxonomies?.headphones?.assignmentFence, 2);
});

test('local queued saves revalidate administrator state under the shared file lock', async (context) => {
  for (const patch of [{ role: 'member' }, { status: 'suspended' }]) {
    const local = localDatabase(context, { products: [product()] });
    const peer = new JsonFileAdapter(local.file);
    const [revoked, saved] = await Promise.all([
      peer.update('users', 'admin-a', patch),
      local.adapter.saveCatalogProductWithIdentities(save()),
    ]);
    assert.ok(revoked);
    assert.equal(saved.result, 'invalid-product');
    assert.deepEqual(await local.adapter.get('products', 'product-a'), product());
    assert.equal(await local.adapter.get('catalogTaxonomies', 'headphones'), null);
  }
});

test('cloud registry creation rejects an insert acknowledgement for another document', async () => {
  const harness = cloudDatabase();
  harness.behavior.failCollection = 'catalogTaxonomies';
  harness.behavior.setAcknowledgement = { updated: 0, upserted: [{ _id: 'toys' }] };
  const before = harness.snapshot();
  await assert.rejects(
    saveCatalogProductInCloudBase(harness.db, save(), updatedAt),
    /not acknowledged/,
  );
  assert.deepEqual(harness.snapshot(), before);
});

test('cloud classification rolls back when either authorization or taxonomy fence is unacknowledged', async () => {
  for (const acknowledgement of [
    undefined,
    null,
    {},
    { updated: 0 },
    { updated: -1 },
    { updated: '1' },
    { updated: Number.NaN },
    { updated: Number.POSITIVE_INFINITY },
    { updated: 0, upserted: [{ _id: 'admin-a' }] },
  ]) {
    const harness = cloudDatabase();
    harness.behavior.failCollection = 'users';
    harness.behavior.acknowledgement = acknowledgement;
    const before = harness.snapshot();
    await assert.rejects(
      saveCatalogProductInCloudBase(harness.db, save(), updatedAt),
      /not acknowledged/,
    );
    assert.deepEqual(harness.snapshot(), before);
  }
  for (const acknowledgement of [
    {},
    { updated: 0 },
    { updated: -1 },
    { upserted: [] },
    { upserted: [{}] },
  ]) {
    const harness = cloudDatabase();
    harness.behavior.failCollection = 'catalogTaxonomies';
    harness.behavior.setAcknowledgement = acknowledgement;
    const before = harness.snapshot();
    await assert.rejects(
      saveCatalogProductInCloudBase(harness.db, save(), updatedAt),
      /not acknowledged/,
    );
    assert.deepEqual(harness.snapshot(), before);
  }
});
