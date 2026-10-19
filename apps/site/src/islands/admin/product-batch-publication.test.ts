import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogTaxonomyResultSchema } from '@vibelingan-channel/shared';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { assignmentCall, batchUpdateRecords } from './api.ts';

test('native table HTTP publication preserves mixed rejected drafts, classifications and existing non-publication actions', async (t) => {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const db = h.adapter;
  const config = {
    jwtSecret: 'publication-local-test-secret',
    enableDetailApproval: true,
    ...media.config,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'Operator',
    email: 'operator@local.invalid',
    role: 'admin',
  });
  const values = new Map<string, string>([
    ['channel.token', token],
    ['channel.user', JSON.stringify({ id: 'admin', role: 'admin', name: 'Operator' })],
  ]);
  for (const [name, value] of [
    ['location', new URL('https://http-table.test/admin')],
    [
      'localStorage',
      {
        get length() {
          return values.size;
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
      },
    ],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const product = {
    published: false,
    archived: false,
    name: 'Publish contract fixture',
    productFamily: 'misc',
    category: '',
    subcategoryIds: [],
    description: 'A real local persistence check',
    imageIds: ['image'],
    unitPrice: 5.7,
  };
  for (const [id, patch] of [
    ['ready', { productFamily: 'headphones' }],
    ['quote', { unitPrice: null }],
    ['no-family', { productFamily: null }],
    ['no-image', { imageIds: [], alibabaSourceImageUrls: ['https://sc04.alicdn.com/preview.jpg'] }],
    ['changed', { alibabaReviewPending: true, alibabaReviewReason: 'changed' }],
    ['removed', { alibabaReviewPending: true, alibabaReviewReason: 'removed' }],
    ['archived', { archived: true }],
    ['stale', {}],
  ] as const)
    await db.create('products', { ...product, ...patch, _id: id });
  const ids = [
    'ready',
    'no-family',
    'no-image',
    'changed',
    'removed',
    'archived',
    'stale',
    'quote',
  ];
  const opened = await Promise.all(
    ids.map(async (id) => {
      const row = await db.get('products', id);
      assert.ok(row);
      return row;
    }),
  );
  const revisions = new Map(opened.map((row) => [row._id, row.updatedAt ?? null]));
  await db.update('products', 'stale', { name: 'Another administrator’s retained edit' });
  const rejectedBefore = new Map(
    await Promise.all(
      ids
        .filter((id) => !['ready', 'quote'].includes(id))
        .map(async (id) => [id, await db.get('products', id)] as const),
    ),
  );
  const invoke = async (body: unknown) => {
    const response = await handleAdminFunctionEvent(
      { httpMethod: 'POST', body: JSON.stringify(body) },
      config,
      handleAdminRequest,
    );
    assert.ok('statusCode' in response);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const old = await invoke({
    action: 'batchUpdate',
    token,
    data: { collection: 'products', ids: ['ready'], values: { published: true } },
  });
  assert.equal(old.status, 400);
  assert.match(await old.text(), /individually/);
  const starts: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        'https://http-table.test',
      );
      assert.equal(url.origin, 'https://http-table.test');
      if (url.pathname === '/api/admin') {
        const body = JSON.parse(String(init?.body));
        if (body.data?.action === 'product-operation-start') starts.push(body.data.productId);
        return invoke(body);
      }
      assert.equal(init?.method, 'GET');
      assert.equal(init.credentials, 'omit');
      const response = await handlePublicApiEvent(
        {
          httpMethod: 'GET',
          path: url.pathname,
          queryStringParameters: Object.fromEntries(url.searchParams),
        },
        { enableCatalogDetail: true },
      );
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers,
      });
    },
  );
  try {
    const result = await batchUpdateRecords(
      'products',
      ids,
      { published: true },
      revisions,
      opened,
    );
    assert.equal(result.updated, 2, JSON.stringify(result.failures));
    assert.deepEqual(
      result.items.map((row) => row._id),
      ['ready', 'quote'],
    );
    assert.deepEqual(
      result.failures.map((row) => row.id),
      ['no-family', 'no-image', 'changed', 'removed', 'archived', 'stale'],
    );
    assert.match(result.failures[0]?.message ?? '', /category/i);
    assert.match(result.failures[1]?.message ?? '', /image|photo/i);
    assert.equal(starts.includes('no-family'), false, 'publishing never invents a category');
    for (const [id, row] of rejectedBefore) {
      const after = await new JsonFileAdapter(h.file).get('products', id);
      if (id === 'no-image') {
        // Preparation can stage private detail metadata before media eligibility is known.
        // Every user-owned field and lifecycle state must remain intact.
        for (const field of [
          'name',
          'description',
          'productFamily',
          'category',
          'subcategoryIds',
          'imageIds',
          'unitPrice',
          'published',
          'archived',
          'alibabaSourceImageUrls',
        ])
          assert.deepEqual(after?.[field], row?.[field], field);
      } else assert.deepEqual(after, row);
      const publicRow = await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${id}/detail` },
        { enableCatalogDetail: true },
      );
      assert.equal(publicRow.statusCode, 404);
    }
    for (const id of ['ready', 'quote']) {
      const row = await new JsonFileAdapter(h.file).get('products', id);
      assert.equal(row?.published, true);
      assert.equal(row?.productFamily, id === 'ready' ? 'headphones' : 'misc');
      assert.deepEqual(row?.subcategoryIds, []);
      assert.equal(row?.unitPrice, id === 'ready' ? 5.7 : null);
    }
    const sharedImage = await db.readCatalogImageReference({ action: 'read', imageId: 'image' });
    assert.equal(sharedImage.state, 'counted');
    assert.ok(sharedImage.state === 'counted');
    assert.equal(sharedImage.effectiveCount, 2);
    const disabled = await batchUpdateRecords('products', ['ready', 'quote'], { published: false });
    assert.equal(disabled.updated, 2);
    assert.equal((await db.get('images', 'image'))?.publishedRefCount, 0);
    await db.update('products', 'ready', { category: 'wired', unitPrice: 5.7 });
    const unsafe = await batchUpdateRecords('products', ['ready', 'no-family'], {
      productFamily: 'misc',
    });
    assert.equal(unsafe.updated, 0);
    assert.ok(
      unsafe.failures.every(
        (row) => row.code === 'VALIDATION_ERROR' && /Classification version/.test(row.message),
      ),
    );
    const taxonomyReply = await handleAdminRequest(
      {
        action: 'catalogCategories',
        token,
        data: { kind: 'taxonomy', operation: 'read', family: 'misc' },
      },
      config,
    );
    assert.ok(taxonomyReply.ok);
    const taxonomy = CatalogTaxonomyResultSchema.parse(taxonomyReply.data);
    assert.ok('registry' in taxonomy);
    const classifyRows = await Promise.all(
      ['ready', 'no-family'].map(async (id) => {
        const row = await db.get('products', id);
        assert.ok(row && typeof row.updatedAt === 'string');
        return { productId: id, expectedUpdatedAt: row.updatedAt };
      }),
    );
    const classified = await assignmentCall({
      kind: 'assignment',
      operation: 'replace',
      family: 'misc',
      taxonomyRevision: taxonomy.registry.revision,
      subcategoryIds: [],
      products: classifyRows,
    });
    assert.deepEqual(
      classified.results,
      ['ready', 'no-family'].map((productId) => ({ productId, status: 'saved' })),
    );
    const classifiedRow = await new JsonFileAdapter(h.file).get('products', 'ready');
    assert.equal(classifiedRow?.productFamily, 'misc');
    assert.equal(classifiedRow?.category, '');
    assert.equal(classifiedRow?.published, false);
    assert.equal(classifiedRow?.unitPrice, 5.7);
    assert.deepEqual(classifiedRow?.imageIds, ['image']);
    await db.update('users', 'admin', { status: 'suspended' });
    const count = starts.length;
    const revoked = await batchUpdateRecords('products', ['ready', 'no-family'], {
      published: true,
    });
    assert.equal(revoked.updated, 0);
    assert.equal(
      starts.length,
      count,
      'fresh authorization refuses before any original publication starts',
    );
    assert.equal(revoked.failures.length, 2);
    assert.ok(revoked.failures.every((row) => row.code === 'UNAUTHORIZED' && !row.retryable));
  } finally {
    await db.update('users', 'admin', { status: 'active' });
    for (const id of ['ready', 'quote']) {
      const row = await db.get('products', id);
      if (row?.published === true) {
        const response = await handleAdminRequest(
          {
            action: 'update',
            token,
            data: {
              collection: 'products',
              id,
              values: { published: false },
              expectedUpdatedAt: row.updatedAt,
            },
          },
          config,
        );
        assert.ok(response.ok, JSON.stringify(response));
      }
    }
  }
});
