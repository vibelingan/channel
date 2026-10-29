import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CollectionDoc,
  initialCatalogTaxonomy,
  productFamilyForDoc,
} from '@vibelingan-channel/shared';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import {
  type CatalogPublicChangeStore,
  planCatalogPublicChange,
  writeCatalogPublicChange,
} from './catalog-public-changes.ts';
import { prepareCatalogPublicState } from './catalog-public-content.ts';

function product(): CollectionDoc {
  return {
    _id: 'p',
    name: 'Unapproved row title',
    productFamily: 'misc',
    published: true,
    archived: false,
    imageIds: ['draft_image'],
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      variantStorage: 'immutable-v1',
      variantCount: 1,
      header: {
        _id: 'p',
        schemaVersion: 'catalog-product-detail-v1',
        name: 'Approved headset',
        images: ['/api/images/gallery'],
        descriptionText: 'Approved description',
        descriptionImages: ['/api/images/description'],
        facts: [{ name: 'Connection', value: 'USB-C' }],
        offers: [],
      },
    },
  };
}

function variant(id = 'v1', position = 0, revision = 'r1'): CollectionDoc {
  return {
    _id: approvedVariantDocumentId('p', revision, id),
    productId: 'p',
    variantId: id,
    catalogDetailRevision: revision,
    catalogDetailPosition: position,
    catalogDetailApproved: {
      id,
      sku: `SKU-${id}`,
      options: [{ name: 'Colour', value: 'Black' }],
      images: ['/api/images/variant'],
      inventory: { state: 'unknown' },
      offers: [],
    },
    privateNote: 'not public',
  };
}

function taxonomyFor(p: CollectionDoc) {
  const family = productFamilyForDoc(p);
  return family ? initialCatalogTaxonomy(family) : undefined;
}

function state(p = product(), items = [variant()]) {
  return prepareCatalogPublicState({
    product: p,
    detailEnabled: true,
    taxonomy: taxonomyFor(p),
    variants: { kind: 'approved', total: items.length, items },
  });
}

test('the public state includes all approved content, not unapproved row edits', () => {
  const before = state();
  assert.equal(before.visible, true);
  if (!before.visible) throw new Error('Expected a public product');
  assert.match(before.semanticHash, /^[a-f0-9]{64}$/);
  assert.equal(before.detailRevision, 'r1');
  assert.deepEqual(
    state({ ...product(), name: 'Another unapproved name', vipPrice: 1, imageIds: ['private'] }),
    before,
  );
  const changed = variant();
  changed.catalogDetailApproved = {
    ...object(changed.catalogDetailApproved),
    options: [{ name: 'Colour', value: 'White' }],
  };
  assert.notDeepEqual(state(product(), [changed]), before);
});

test('new approval identities for identical public content preserve the content hash', () => {
  const old = state();
  const p = product();
  p.catalogDetailPublication = { ...object(p.catalogDetailPublication), revision: 'r2' };
  assert.deepEqual(state(p, [variant('v1', 0, 'r2')]), { ...old, detailRevision: 'r2' });
});

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publication(p: CollectionDoc, patch: Record<string, unknown>): CollectionDoc {
  return { ...p, catalogDetailPublication: { ...object(p.catalogDetailPublication), ...patch } };
}

function rowState(p: CollectionDoc, items: CollectionDoc[] = []) {
  return prepareCatalogPublicState({
    product: p,
    detailEnabled: true,
    taxonomy: taxonomyFor(p),
    variants: { kind: 'row', total: items.length, items },
  });
}

test('a legacy row has a fixed, independently calculated content hash', () => {
  // SHA-256 of the documented canonical JSON, calculated independently with Python hashlib.
  assert.deepEqual(rowState({ _id: 'p', name: 'Legacy', productFamily: 'misc', published: true }), {
    productId: 'p',
    visible: true,
    detailRevision: null,
    semanticHash: '0bc43872a4c8cd8e64196e3a445348812f7ac03c026e0a698ba944d789bde50a',
  });
});

test('absent historical fields keep published products visible', () => {
  const p = { _id: 'p', name: 'Legacy', published: true };
  assert.equal(rowState(p).visible, true);
  assert.equal(rowState({ ...p, productFamily: '', slug: '', archived: false }).visible, true);
});

for (const fields of [
  {},
  { published: false },
  { published: 'true' },
  { published: true, archived: true },
  { published: true, archived: null },
]) {
  test(`visibility follows the public API for ${JSON.stringify(fields)}`, () => {
    assert.deepEqual(
      prepareCatalogPublicState({ product: { _id: 'p', ...fields }, detailEnabled: true }),
      { productId: 'p', visible: false },
    );
  });
}

test('source refresh times and private fields never change a row content hash', () => {
  const p = {
    _id: 'p',
    name: 'Headset',
    published: true,
    alibabaPrimarySourceKey: 'private-source-a',
    alibabaSourceLastSyncedAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
    vipPrice: 10,
  };
  assert.deepEqual(
    rowState({
      ...p,
      alibabaPrimarySourceKey: 'private-source-b',
      alibabaSourceLastSyncedAt: '2026-10-29T00:00:00Z',
      updatedAt: '2026-10-29T00:00:00Z',
      vipPrice: 100,
      newPrivateField: 'private',
      catalogContentGeneration: 100,
    }),
    rowState(p),
  );
});

for (const field of [
  'name',
  'descriptionText',
  'categoryLabel',
  'descriptionImages',
  'facts',
  'offers',
  'images',
  'websitePricing',
]) {
  test(`approved ${field} changes the content hash`, () => {
    const p = product();
    const header = object(object(p.catalogDetailPublication).header);
    const values: Record<string, unknown> = {
      name: 'Changed approved name',
      descriptionText: 'Changed approved text',
      categoryLabel: 'Headphones',
      descriptionImages: ['/api/images/new_description'],
      facts: [{ name: 'Connection', value: 'Bluetooth' }],
      offers: [
        {
          kind: 'supplier',
          basis: 'source-quote',
          pricing: { mode: 'fixed', currency: 'USD', amountMinor: 700 },
        },
      ],
      images: ['/api/images/new_gallery'],
      websitePricing: {
        basis: 'website-manual',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor: 600 },
      },
    };
    assert.notDeepEqual(
      state(publication(p, { header: { ...header, [field]: values[field] } })),
      state(p),
    );
  });
}

test('structured specifications, packaging and note layout participate in the hash', () => {
  const p = publication(product(), {
    content: {
      schemaVersion: 'catalog-content-v1',
      specifications: [],
      packaging: [],
      notes: ['A note'],
    },
    noteBlocks: [{ kind: 'paragraph', text: 'A note' }],
  });
  assert.notDeepEqual(state(p), state(product()));
  assert.notDeepEqual(
    state(publication(p, { noteBlocks: [{ kind: 'heading', text: 'A note' }] })),
    state(p),
  );
  assert.notDeepEqual(
    state(
      publication(p, {
        content: {
          schemaVersion: 'catalog-content-v1',
          specifications: [],
          packaging: [{ name: 'Box', value: 'Plain' }],
          notes: ['A note'],
        },
      }),
    ),
    state(p),
  );
});

test('approved price summary changes participate independently of the row price', () => {
  const p = publication(product(), {
    priceSummary: {
      source: 'website',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 700 },
    },
  });
  assert.notDeepEqual(state(p), state(product()));
  assert.deepEqual(state({ ...p, unitPrice: 99 }), state(p));
});

test('changes beyond the first approved page are detected', () => {
  const items = Array.from({ length: 60 }, (_, i) => variant(`v${i}`, i));
  const p = publication(product(), { variantCount: 60 });
  const before = state(p, items);
  const changed = structuredClone(items);
  changed[55] = {
    ...variant('v55', 55),
    catalogDetailApproved: { ...object(changed[55]?.catalogDetailApproved), sku: 'Changed SKU' },
  };
  assert.notDeepEqual(state(p, changed), before);
  assert.deepEqual(state(p, [...items].reverse()), before);
});

test('approved order is public content, while private variant metadata is not', () => {
  const p = publication(product(), { variantCount: 2 });
  const items = [variant('a', 0), variant('b', 1)];
  const before = state(p, items);
  assert.notDeepEqual(state(p, [variant('a', 1), variant('b', 0)]), before);
  assert.deepEqual(
    state(
      p,
      items.map((item) => ({ ...item, sourcePrice: 123, updatedAt: 'new-time' })),
    ),
    before,
  );
});

test('legacy approved variant storage has the same public hash as immutable storage', () => {
  const p = product();
  const { variantStorage: _storage, ...legacy } = object(p.catalogDetailPublication);
  assert.deepEqual(
    state({ ...p, catalogDetailPublication: legacy }, [{ ...variant(), _id: 'v1' }]),
    state(p),
  );
});

for (const [name, patch] of Object.entries({
  'another revision': { catalogDetailRevision: 'r0' },
  'another product': { productId: 'other' },
  'wrong immutable key': { _id: 'v1' },
  'wrong canonical id': { variantId: 'other' },
  'missing position': { catalogDetailPosition: undefined },
  'duplicate position': { catalogDetailPosition: 1 },
  'withdrawn variant': { archived: true },
  'corrupt archive state': { archived: null },
  'missing approved values': { catalogDetailApproved: null },
})) {
  test(`incomplete approved input is rejected: ${name}`, () => {
    assert.throws(() => state(product(), [{ ...variant(), ...patch }]), {
      code: 'INCOMPLETE_PUBLIC_CONTENT',
    });
  });
}

test('missing, duplicate and truncated approved sets cannot produce a content hash', () => {
  assert.throws(() => state(product(), []), { code: 'INCOMPLETE_PUBLIC_CONTENT' });
  assert.throws(() => state(publication(product(), { variantCount: 2 }), [variant(), variant()]), {
    code: 'INCOMPLETE_PUBLIC_CONTENT',
  });
  assert.throws(
    () =>
      prepareCatalogPublicState({
        product: product(),
        detailEnabled: true,
        variants: { kind: 'approved', total: 2, items: [variant()] },
      }),
    { code: 'INCOMPLETE_PUBLIC_CONTENT' },
  );
  assert.throws(() => prepareCatalogPublicState({ product: product(), detailEnabled: true }), {
    code: 'INCOMPLETE_PUBLIC_CONTENT',
  });
});

test('a disabled detail feature uses row content and rejects approved-row inputs', () => {
  const p = product();
  assert.throws(
    () =>
      prepareCatalogPublicState({
        product: p,
        detailEnabled: false,
        variants: { kind: 'approved', total: 1, items: [variant()] },
      }),
    { code: 'INCOMPLETE_PUBLIC_CONTENT' },
  );
  const before = prepareCatalogPublicState({
    product: p,
    detailEnabled: false,
    taxonomy: taxonomyFor(p),
    variants: { kind: 'row', total: 0, items: [] },
  });
  const after = prepareCatalogPublicState({
    product: { ...p, name: 'Changed row' },
    detailEnabled: false,
    taxonomy: taxonomyFor(p),
    variants: { kind: 'row', total: 0, items: [] },
  });
  assert.notDeepEqual(before, after);
});

test('row variant order matches the public cap and uses a stable id tiebreaker', () => {
  const p = { _id: 'p', name: 'Legacy', published: true };
  const items = Array.from({ length: 51 }, (_, i) => ({
    _id: `v${String(i).padStart(2, '0')}`,
    productId: 'p',
    position: 0,
    sku: `SKU-${i}`,
  }));
  const before = rowState(p, items);
  assert.deepEqual(rowState(p, [...items].reverse()), before);
  assert.deepEqual(
    rowState(
      p,
      items.map((item, i) => (i === 50 ? { ...item, sku: 'Outside public cap' } : item)),
    ),
    before,
  );
  assert.notDeepEqual(
    rowState(
      p,
      items.map((item, i) => (i === 49 ? { ...item, sku: 'Visible SKU changed' } : item)),
    ),
    before,
  );
  assert.notDeepEqual(
    rowState(
      p,
      items.map((item, i) => (i === 50 ? { ...item, position: -1 } : item)),
    ),
    before,
  );
});

test('row variant options and exact inventory are public, private prices are withheld', () => {
  const p = { _id: 'p', name: 'Legacy', published: true };
  const item = {
    _id: 'v1',
    productId: 'p',
    optionValues: { Colour: 'Black' },
    inventoryState: 'known',
    inventoryQuantity: 2,
  };
  const before = rowState(p, [item]);
  assert.notDeepEqual(rowState(p, [{ ...item, inventoryQuantity: 3 }]), before);
  assert.notDeepEqual(rowState(p, [{ ...item, optionValues: { Colour: 'White' } }]), before);
  assert.deepEqual(
    rowState(p, [{ ...item, sourceRegularPrice: 999, inventorySnapshots: ['private'] }]),
    before,
  );
  assert.throws(() => rowState(p, [{ ...item, productId: 'other' }]), {
    code: 'INCOMPLETE_PUBLIC_CONTENT',
  });
  assert.throws(() => rowState(p, [{ ...item, archived: true }]), {
    code: 'INCOMPLETE_PUBLIC_CONTENT',
  });
});

test('object key insertion order and absent optional values do not create changes', () => {
  const item = variant();
  const approved = object(item.catalogDetailApproved);
  const reversed = Object.fromEntries(Object.entries(approved).reverse());
  assert.deepEqual(state(product(), [{ ...item, catalogDetailApproved: reversed }]), state());
  const p = { _id: 'p', name: 'Legacy', published: true, description: undefined };
  assert.deepEqual(rowState(p), rowState({ _id: 'p', name: 'Legacy', published: true }));
});

test('corrupt public numeric values fail instead of hashing as null', () => {
  assert.throws(
    () => rowState({ _id: 'p', name: 'Legacy', published: true, unitPrice: Number.NaN }),
    { code: 'INVALID_PUBLIC_CONTENT' },
  );
});

for (const invalidId of [' p ', 'p\n1', 'p\u007f1']) {
  test(`product identities are validated without silently rewriting ${JSON.stringify(invalidId)}`, () => {
    assert.throws(() => rowState({ _id: invalidId, name: 'Legacy', published: true }), {
      code: 'INVALID_PUBLIC_CONTENT',
    });
  });
}

test('content preparation and the transaction component distinguish real edits from reapproval', async () => {
  const rows = new Map<string, CollectionDoc>();
  const store: CatalogPublicChangeStore = {
    get: async (collection, id) => rows.get(`${collection}/${id}`) ?? null,
    set: async (collection, row) => {
      rows.set(`${collection}/${row._id}`, structuredClone(row));
    },
  };
  const change = async (before: ReturnType<typeof state>, after: ReturnType<typeof state>) => {
    const plan = await planCatalogPublicChange(store, {
      siteOrigin: 'https://shop.example',
      before,
      after,
      now: '2026-10-29T01:00:00Z',
    });
    await writeCatalogPublicChange(store, plan);
    return { kind: plan.kind, sequence: plan.sequence };
  };
  const first = state();
  assert.deepEqual(await change({ productId: 'p', visible: false }, first), {
    kind: 'changed',
    sequence: 1,
  });
  const second = state(publication(product(), { revision: 'r2' }), [variant('v1', 0, 'r2')]);
  assert.deepEqual(await change(first, second), { kind: 'metadata', sequence: 1 });
  const p = publication(product(), {
    revision: 'r2',
    header: {
      ...object(object(product().catalogDetailPublication).header),
      descriptionText: 'Updated approved description',
    },
  });
  const third = state(p, [variant('v1', 0, 'r2')]);
  assert.deepEqual(await change(second, third), { kind: 'changed', sequence: 2 });
  assert.deepEqual(await change(third, third), { kind: 'unchanged', sequence: 2 });
  const withdrawn = prepareCatalogPublicState({
    product: { ...p, published: false },
    detailEnabled: true,
  });
  assert.deepEqual(await change(third, withdrawn), { kind: 'changed', sequence: 3 });
  assert.deepEqual(await change(withdrawn, third), { kind: 'changed', sequence: 4 });
});

test('an incomplete legacy variant query cannot be treated as a complete public state', () => {
  assert.throws(
    () =>
      prepareCatalogPublicState({
        product: { _id: 'p', name: 'Legacy', published: true },
        detailEnabled: false,
        variants: { kind: 'row', total: 2, items: [{ _id: 'v', productId: 'p' }] },
      }),
    { code: 'INCOMPLETE_PUBLIC_CONTENT' },
  );
});

test('effective category assignment and its public label participate in the content hash', () => {
  const p = {
    _id: 'p',
    name: 'Headset',
    published: true,
    productFamily: 'headphones',
    category: 'wired',
  };
  const taxonomy = initialCatalogTaxonomy('headphones');
  const input = {
    product: p,
    detailEnabled: true,
    taxonomy,
    variants: { kind: 'row', total: 0, items: [] },
  };
  const first = prepareCatalogPublicState(input);
  assert.deepEqual(
    prepareCatalogPublicState({
      ...input,
      product: { ...p, subcategoryIds: ['headphones-wired'] },
    }),
    first,
  );
  assert.notDeepEqual(
    prepareCatalogPublicState({
      ...input,
      product: { ...p, category: '', subcategoryIds: ['headphones-office'] },
    }),
    first,
  );
  assert.notDeepEqual(
    prepareCatalogPublicState({ ...input, taxonomy: { ...taxonomy, name: 'Audio Products' } }),
    first,
  );
  assert.notDeepEqual(
    prepareCatalogPublicState({
      ...input,
      taxonomy: {
        ...taxonomy,
        children: taxonomy.children.map((child) =>
          child.id === 'headphones-wired' ? { ...child, name: 'Wired Audio' } : child,
        ),
      },
    }),
    first,
  );
  assert.deepEqual(
    prepareCatalogPublicState({ ...input, taxonomy: { ...taxonomy, revision: 100 } }),
    first,
  );
  const assigned = {
    ...input,
    product: { ...p, category: '', subcategoryIds: ['headphones-wired'] },
  };
  assert.notDeepEqual(
    prepareCatalogPublicState({
      ...assigned,
      product: { ...assigned.product, subcategoryIds: ['headphones-office'] },
    }),
    prepareCatalogPublicState(assigned),
  );
  assert.notDeepEqual(
    prepareCatalogPublicState({
      ...assigned,
      taxonomy: {
        ...taxonomy,
        children: taxonomy.children.map((child) =>
          child.id === 'headphones-wired' ? { ...child, status: 'archived' } : child,
        ),
      },
    }),
    prepareCatalogPublicState(assigned),
  );
});

test('missing or mismatched category context cannot stand in for the current registry', () => {
  const input = {
    product: { _id: 'p', name: 'Headset', published: true, productFamily: 'headphones' },
    detailEnabled: true,
    variants: { kind: 'row', total: 0, items: [] },
  };
  assert.throws(() => prepareCatalogPublicState(input), { code: 'INCOMPLETE_PUBLIC_CONTENT' });
  assert.throws(
    () => prepareCatalogPublicState({ ...input, taxonomy: initialCatalogTaxonomy('misc') }),
    { code: 'INCOMPLETE_PUBLIC_CONTENT' },
  );
});
