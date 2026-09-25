import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type CatalogClassificationAssignmentRequest,
  type CatalogTaxonomy,
  type CollectionDoc,
  PRODUCT_FAMILY_OPTIONS,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { type ReactNode, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignmentCall, publishConfirmedClassification, taxonomyCall } from './api.ts';
import {
  classificationChoices,
  classificationRequest,
  initialClassification,
  savedProductSubcategories,
  savedSubcategoriesText,
  subcategoryFilterOptions,
  summarizeAssignment,
} from './taxonomy-ui-state.ts';

function product(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'product-1',
    name: 'Studio headset',
    productFamily: 'headphones',
    published: false,
    updatedAt: '2026-09-18T10:00:00.000Z',
    ...overrides,
  };
}

function registry(): CatalogTaxonomy {
  const value = initialCatalogTaxonomy('headphones');
  value.revision = 4;
  value.name = 'Studio audio';
  value.children[0].status = 'archived';
  return value;
}

function command(): CatalogClassificationAssignmentRequest {
  return {
    kind: 'assignment',
    operation: 'replace',
    family: 'headphones',
    taxonomyRevision: 4,
    products: [{ productId: 'product-1', expectedUpdatedAt: '2026-09-18T10:00:00.000Z' }],
    subcategoryIds: [],
  };
}

test('taxonomy API decodes the registry and keeps the catalogCategories protocol', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).data, {
      kind: 'taxonomy',
      operation: 'read',
      family: 'headphones',
    });
    assert.equal(JSON.parse(String(init.body)).action, 'catalogCategories');
    return Response.json({
      ok: true,
      data: { kind: 'taxonomy', status: 'replayed', registry: registry() },
    });
  });
  const result = await taxonomyCall({ kind: 'taxonomy', operation: 'read', family: 'headphones' });
  assert.ok('registry' in result);
  assert.equal(result.registry.name, 'Studio audio');
});

test('taxonomy API rejects malformed and wrong-family responses', async (context) => {
  for (const data of [
    { kind: 'taxonomy', status: 'configured', registry: { ...registry(), revision: '4' } },
    { kind: 'taxonomy', status: 'applied', registry: { ...registry(), extra: true } },
    { kind: 'taxonomy', status: 'configured', registry: initialCatalogTaxonomy('toys') },
  ]) {
    const fetchMock = context.mock.method(globalThis, 'fetch', async () =>
      Response.json({ ok: true, data }),
    );
    await assert.rejects(
      taxonomyCall({ kind: 'taxonomy', operation: 'read', family: 'headphones' }),
      { code: 'INVALID_RESPONSE' },
    );
    fetchMock.mock.restore();
  }
});

test('taxonomy API accepts first-save configured and rejects read/write status swaps', async (context) => {
  const input = {
    kind: 'taxonomy',
    operation: 'save',
    family: 'headphones',
    expectedRevision: 0,
    name: 'Headphones',
    children: initialCatalogTaxonomy('headphones').children,
  } as const;
  const mock = context.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      ok: true,
      data: {
        kind: 'taxonomy',
        status: 'configured',
        registry: { ...initialCatalogTaxonomy('headphones'), revision: 1 },
      },
    }),
  );
  assert.equal((await taxonomyCall(input)).status, 'configured');
  await assert.rejects(
    taxonomyCall({ kind: 'taxonomy', operation: 'read', family: 'headphones' }),
    { code: 'INVALID_RESPONSE' },
  );
  mock.mock.restore();
});

test('taxonomy save sends the expected revision and preserves stale conflicts', async (context) => {
  const command = {
    kind: 'taxonomy',
    operation: 'save',
    family: 'headphones',
    expectedRevision: 4,
    name: registry().name,
    children: registry().children,
  } as const;
  const fetchMock = context.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init.body)).data, command);
      return Response.json({ ok: true, data: { kind: 'taxonomy', status: 'conflict' } });
    },
  );
  assert.deepEqual(await taxonomyCall(command), { kind: 'taxonomy', status: 'conflict' });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('invalid request versions are rejected before any network write', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected request');
  });
  await assert.rejects(assignmentCall({ ...command(), products: [] }));
  await assert.rejects(
    taxonomyCall({
      kind: 'taxonomy',
      operation: 'save',
      family: 'headphones',
      expectedRevision: -1,
      name: registry().name,
      children: registry().children,
    }),
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('assignment summary never treats unknown, partial or refresh-required outcomes as success', () => {
  for (const status of [
    'conflict',
    'invalid',
    'missing',
    'forbidden',
    'unknown',
    'notattempted',
  ] as const) {
    const summary = summarizeAssignment({
      kind: 'assignment',
      results: [
        { productId: 'product-1', status: 'saved' },
        { productId: 'product-2', status },
      ],
    });
    assert.equal(summary.allSaved, false);
    assert.equal(summary.uncertain, status === 'unknown' || status === 'notattempted');
  }
  assert.equal(
    summarizeAssignment({
      kind: 'assignment',
      results: [{ productId: 'product-1', status: 'saved' }],
      refreshRequired: true,
    }).allSaved,
    false,
  );
  assert.equal(
    summarizeAssignment({
      kind: 'assignment',
      results: [{ productId: 'product-1', status: 'saved' }],
    }).allSaved,
    true,
  );
});

test('assignment API rejects malformed, missing, duplicate and unexpected product outcomes', async (context) => {
  for (const results of [
    [{ productId: 'product-1', status: 'success' }],
    [],
    [{ productId: 'another-product', status: 'saved' }],
    [
      { productId: 'product-1', status: 'saved' },
      { productId: 'product-1', status: 'saved' },
    ],
  ]) {
    const fetchMock = context.mock.method(globalThis, 'fetch', async () =>
      Response.json({ ok: true, data: { kind: 'assignment', results } }),
    );
    await assert.rejects(assignmentCall(command()), { code: 'INVALID_RESPONSE' });
    fetchMock.mock.restore();
  }
});

test('assignment API preserves unknown outcomes and never retries a network failure', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      ok: true,
      data: {
        kind: 'assignment',
        results: [{ productId: 'product-1', status: 'unknown' }],
        refreshRequired: true,
      },
    }),
  );
  assert.equal((await assignmentCall(command())).results[0].status, 'unknown');
  fetchMock.mock.restore();
  const failed = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Connection lost');
  });
  await assert.rejects(assignmentCall(command()), /Connection lost/);
  assert.equal(failed.mock.callCount(), 1);
});

test('single-product preload reads legacy and archived IDs but never falls back from malformed IDs', () => {
  assert.deepEqual(initialClassification([product({ category: 'wired' })], registry()), {
    ids: ['headphones-wired'],
    error: null,
  });
  assert.deepEqual(
    initialClassification([product({ subcategoryIds: ['headphones-wired'] })], registry()),
    { ids: ['headphones-wired'], error: null },
  );
  const malformed = initialClassification(
    [product({ category: 'wired', subcategoryIds: 'bad' })],
    registry(),
  );
  assert.deepEqual(malformed.ids, []);
  assert.match(malformed.error ?? '', /invalid|malformed/i);
});

test('archived options may only be retained, and bulk retention requires every selected product', () => {
  const retained = product({ subcategoryIds: ['headphones-wired'] });
  const choice = (products: CollectionDoc[], ids: string[]) =>
    classificationChoices(products, registry(), ids).find(
      (item) => item.child.id === 'headphones-wired',
    );
  assert.equal(choice([retained], ['headphones-wired'])?.disabled, false);
  assert.equal(choice([retained], [])?.disabled, false);
  assert.equal(choice([product()], [])?.disabled, true);
  assert.equal(choice([retained, product({ _id: 'product-2' })], [])?.disabled, true);
});

test('request carries every timestamp and taxonomy revision; replace may remove every child', () => {
  assert.deepEqual(classificationRequest([product()], registry(), 'replace', []), command());
  assert.deepEqual(classificationRequest([product()], registry(), 'clear', []), {
    ...command(),
    operation: 'clear',
  });
  assert.throws(
    () => classificationRequest([product()], registry(), 'append', []),
    /select|choose/i,
  );
});

test('selection rejects zero, duplicate, stale and over-20 products but accepts exactly 20', () => {
  const products = Array.from({ length: 20 }, (_, index) => product({ _id: `product-${index}` }));
  assert.equal(classificationRequest(products, registry(), 'replace', []).products.length, 20);
  for (const selected of [
    [],
    [...products, product({ _id: 'extra' })],
    [product(), product()],
    [product({ updatedAt: undefined })],
  ]) {
    assert.throws(() => classificationRequest(selected, registry(), 'replace', []));
  }
});

test('mixed-family append and clear reject; replace resets children explicitly', () => {
  const products = [product(), product({ _id: 'toy-1', productFamily: 'toys' })];
  for (const mode of ['append', 'clear'] as const) {
    assert.throws(
      () =>
        classificationRequest(
          products,
          registry(),
          mode,
          mode === 'append' ? ['headphones-office'] : [],
        ),
      /family|category/i,
    );
  }
  assert.equal(classificationRequest(products, registry(), 'replace', []).products.length, 2);
  assert.deepEqual(initialClassification([product()], initialCatalogTaxonomy('toys')), {
    ids: [],
    error: null,
  });
});

test('requests reject unknown children, newly assigned archived children and append overflow', () => {
  assert.throws(() => classificationRequest([product()], registry(), 'replace', ['missing']));
  assert.throws(() =>
    classificationRequest([product()], registry(), 'replace', ['headphones-wired']),
  );
  const expanded: CatalogTaxonomy = {
    ...registry(),
    children: Array.from({ length: 17 }, (_, index) => ({
      id: `child-${index}`,
      slug: `child-${index}`,
      name: `Child ${index}`,
      order: index,
      status: 'active',
    })),
  };
  assert.throws(() =>
    classificationRequest(
      [product({ subcategoryIds: expanded.children.slice(0, 16).map((child) => child.id) })],
      expanded,
      'append',
      ['child-16'],
    ),
  );
});

function renderWithTaxonomy(content: ReactNode, seeded = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (seeded) {
    for (const family of PRODUCT_FAMILY_OPTIONS) {
      client.setQueryData(
        ['catalog-taxonomy', family],
        family === 'headphones'
          ? registry()
          : { ...initialCatalogTaxonomy(family), name: `Registry ${family}` },
      );
    }
  }
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, content));
  client.clear();
  return html;
}

test('manager renders all four registry names, immutable existing identities and bounded names', async () => {
  const { CatalogTaxonomyManager } = await import('./CatalogTaxonomyManager.tsx');
  const html = renderWithTaxonomy(createElement(CatalogTaxonomyManager));
  for (const name of ['Studio audio', 'Registry toys', 'Registry ai-gadgets', 'Registry misc'])
    assert.ok(html.includes(name));
  assert.match(html, /maxLength="80"/i);
  assert.match(html, /readonly=""[^>]*value="wired"/i);
  assert.ok(html.includes('Active'));
  assert.ok(html.includes('Save categories'));
});

test('classification editor preloads archived current IDs, previews products and does not publish', async () => {
  const { ProductClassificationEditor } = await import('./ProductClassificationEditor.tsx');
  const html = renderWithTaxonomy(
    createElement(ProductClassificationEditor, {
      products: [product({ subcategoryIds: ['headphones-wired'] })],
      onSaved: () => {},
    }),
  );
  assert.ok(html.includes('Studio audio'));
  assert.ok(html.includes('Studio headset'));
  assert.match(html, /checked=""[^>]*value="headphones-wired"/);
  assert.match(html, /archived/i);
  assert.match(html, /drafts will not be published/i);
  assert.ok(html.includes('Review assignment'));
});

test('bulk classification offers an explicit classify-and-publish review', async () => {
  const { ProductClassificationEditor } = await import('./ProductClassificationEditor.tsx');
  const html = renderWithTaxonomy(
    createElement(ProductClassificationEditor, {
      products: [product({ published: false })],
      publishOnSave: true,
      onSaved: () => {},
    }),
  );
  assert.match(html, /publish only after all classifications are confirmed/i);
  assert.ok(html.includes('Review classification and publish'));
  assert.ok(html.includes('Studio headset'));
});

test('bulk publish runs only after every selected assignment is confirmed', async (context) => {
  const input = {
    ...command(),
    includeSavedRevision: true as const,
    products: [
      { productId: 'product-1', expectedUpdatedAt: '2026-09-18T10:00:00.000Z' },
      { productId: 'product-2', expectedUpdatedAt: '2026-09-18T10:00:00.000Z' },
    ],
  } satisfies CatalogClassificationAssignmentRequest;
  const fetchMock = context.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: false } });
      assert.equal(request.action, 'update');
      assert.deepEqual(request.data.values, { published: true });
      assert.equal(request.data.expectedUpdatedAt, '2026-09-24T00:00:00.000Z');
      return Response.json({ ok: true, data: { _id: request.data.id, published: true } });
    },
  );
  const saved = {
    kind: 'assignment' as const,
    results: input.products.map(({ productId }) => ({
      productId,
      status: 'saved' as const,
      updatedAt: '2026-09-24T00:00:00.000Z',
    })),
  };
  for (const response of [
    {
      ...saved,
      results: [{ productId: 'product-1', status: 'conflict' as const }, saved.results[1]],
    },
    {
      ...saved,
      results: [{ productId: 'product-1', status: 'unknown' as const }, saved.results[1]],
    },
    { ...saved, results: saved.results.slice(0, 1) },
    { ...saved, results: [{ productId: 'other', status: 'saved' as const }, saved.results[1]] },
    { ...saved, refreshRequired: true as const },
    { ...saved, results: [{ productId: 'product-1', status: 'saved' as const }, saved.results[1]] },
  ]) {
    assert.equal(await publishConfirmedClassification(input, response), null);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  const result = await publishConfirmedClassification(input, saved);
  assert.equal(result?.updated, 2);
  assert.equal(fetchMock.mock.callCount(), 4);
});

test('revisioned bulk publish never approves unseen supplier detail', async (context) => {
  const input = {
    ...command(),
    includeSavedRevision: true as const,
    products: [
      { productId: 'supplier-linked', expectedUpdatedAt: '2026-09-18T10:00:00.000Z' },
      { productId: 'ordinary-draft', expectedUpdatedAt: '2026-09-18T10:00:00.000Z' },
    ],
  } satisfies CatalogClassificationAssignmentRequest;
  const revision = '2026-09-24T00:00:00.000Z';
  const actions: string[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    actions.push(request.action);
    if (request.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: true } });
    if (request.action === 'get')
      return Response.json({
        ok: true,
        data: {
          _id: request.data.id,
          published: false,
          ...(request.data.id === 'supplier-linked'
            ? { alibabaPrimarySourceKey: 'a'.repeat(64) }
            : {}),
        },
      });
    assert.equal(request.action, 'update');
    assert.equal(request.data.id, 'ordinary-draft');
    assert.equal(request.data.expectedUpdatedAt, revision);
    assert.deepEqual(request.data.values, { published: true });
    return Response.json({ ok: true, data: { _id: request.data.id, published: true } });
  });
  const result = await publishConfirmedClassification(input, {
    kind: 'assignment',
    results: input.products.map(({ productId }) => ({
      productId,
      status: 'saved',
      updatedAt: revision,
    })),
  });
  assert.equal(result?.updated, 1);
  assert.deepEqual(
    result?.failures.map(({ id, code, outcome }) => ({ id, code, outcome })),
    [{ id: 'supplier-linked', code: 'CONFLICT', outcome: 'rejected' }],
  );
  assert.deepEqual(actions, [
    'catalogDetailCapabilities',
    'get',
    'catalogDetailCapabilities',
    'get',
    'update',
  ]);
});

test('malformed product IDs block assignment and registry reads show a loading state', async () => {
  const { ProductClassificationEditor } = await import('./ProductClassificationEditor.tsx');
  const content = createElement(ProductClassificationEditor, {
    products: [product({ subcategoryIds: 'bad' })],
    onSaved: () => {},
  });
  const html = renderWithTaxonomy(content);
  assert.match(html, /malformed/i);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review assignment<\/button>/);
  assert.ok(renderWithTaxonomy(content, false).includes('Loading categories'));
});

test('saved subcategory names come from subcategoryIds, not the stale legacy scalar', () => {
  const migrated = product({ category: 'wired', subcategoryIds: ['headphones-office'] });
  const before = structuredClone(migrated);
  const saved = savedProductSubcategories(migrated, registry());
  assert.deepEqual(saved, {
    kind: 'assigned',
    children: [{ id: 'headphones-office', name: 'Office Headphones', archived: false }],
  });
  assert.equal(savedSubcategoriesText(saved), 'Office Headphones');
  assert.deepEqual(migrated, before);
});

test('saved subcategory states cover legacy, archived, empty, unclassified and invalid rows', () => {
  const text = (overrides: Partial<CollectionDoc>) =>
    savedSubcategoriesText(savedProductSubcategories(product(overrides), registry()));
  const { productFamily: _family, ...legacy } = product({ category: 'wired' });
  assert.equal(
    savedSubcategoriesText(savedProductSubcategories(legacy, registry())),
    'Wired Headphones (archived)',
  );
  assert.equal(
    text({ subcategoryIds: ['headphones-wired', 'headphones-bluetooth'] }),
    'Wired Headphones (archived), Bluetooth Headphones',
  );
  assert.equal(text({ subcategoryIds: [] }), 'None');
  assert.equal(text({ category: 'wired', subcategoryIds: [] }), 'None');
  assert.equal(text({}), 'None');
  assert.deepEqual(savedProductSubcategories(product({ productFamily: undefined }), registry()), {
    kind: 'unclassified',
  });
  for (const overrides of [
    { subcategoryIds: ['missing'] },
    { subcategoryIds: 'headphones-office' },
    { subcategoryIds: ['headphones-office', 'headphones-office'] },
    { productFamily: 'toys', subcategoryIds: ['headphones-office'] },
    { productFamily: 'toys', category: 'wired' },
  ] as Partial<CollectionDoc>[]) {
    const saved = savedProductSubcategories(product(overrides), registry());
    assert.equal(saved.kind, 'invalid', JSON.stringify(overrides));
    assert.equal(savedSubcategoriesText(saved), 'Invalid saved subcategories');
  }
});

test('filter options keep registry order and label archived children', () => {
  assert.deepEqual(subcategoryFilterOptions(registry()), [
    { value: 'headphones-wired', label: 'Wired Headphones (archived)' },
    { value: 'headphones-office', label: 'Office Headphones' },
    { value: 'headphones-bluetooth', label: 'Bluetooth Headphones' },
  ]);
  assert.deepEqual(subcategoryFilterOptions(initialCatalogTaxonomy('toys')), []);
});

test('edit summary shows saved names read-only, with loading and invalid states', async () => {
  const { SavedClassificationSummary } = await import('./SavedClassificationSummary.tsx');
  const assigned = renderWithTaxonomy(
    createElement(SavedClassificationSummary, {
      product: product({ subcategoryIds: ['headphones-wired', 'headphones-office'] }),
    }),
  );
  assert.ok(assigned.includes('Saved website classification'));
  assert.ok(assigned.includes('Headphones'));
  assert.ok(assigned.includes('Wired Headphones (archived), Office Headphones'));
  assert.doesNotMatch(assigned, /<(input|select|textarea)\b/);
  const invalid = renderWithTaxonomy(
    createElement(SavedClassificationSummary, {
      product: product({ subcategoryIds: ['missing'] }),
    }),
  );
  assert.match(invalid, /Invalid saved subcategories/);
  const loading = renderWithTaxonomy(
    createElement(SavedClassificationSummary, { product: product() }),
    false,
  );
  assert.match(loading, /Loading subcategories/);
  const unclassified = renderWithTaxonomy(
    createElement(SavedClassificationSummary, { product: product({ productFamily: undefined }) }),
    false,
  );
  assert.match(unclassified, /Needs classification/);
  assert.doesNotMatch(unclassified, /Loading/);
});
