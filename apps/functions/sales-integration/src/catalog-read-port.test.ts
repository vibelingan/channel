/** SDK query/response contract tests. The network sender is a fixture, not cloud evidence. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as cloudbase from '@cloudbase/node-sdk';
import type { AdapterListQuery } from '@vibelingan-channel/db';
import { approvedVariantDocumentId } from '@vibelingan-channel/db/catalog-detail-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createApprovedProductReader } from '../../public-api/src/catalog-detail.ts';
import { createCatalogReadPort } from './catalog-read-port.ts';

interface SdkCall {
  action: string;
  input: {
    collectionName: string;
    query?: string;
    order?: string;
    offset?: number;
    limit?: number;
  };
}

const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve('@cloudbase/node-sdk/package.json'));
const Request = require(join(sdkRoot, 'dist/utils/tcbdbapirequester.js')).TcbDBApiHttpRequester;
const rows = (documents: CollectionDoc[]) => ({
  data: { list: documents.map((row) => JSON.stringify(row)) },
});

async function withSdk(
  send: (call: SdkCall) => Promise<unknown> | unknown,
  run: (read: ReturnType<typeof createCatalogReadPort>, calls: SdkCall[]) => Promise<void>,
) {
  const original = Request.prototype.send;
  const calls: SdkCall[] = [];
  try {
    Request.prototype.send = async (action: SdkCall['action'], input: SdkCall['input']) => {
      const call = { action, input };
      calls.push(call);
      assert.ok(['database.getDocument', 'database.calculateDocument'].includes(action));
      return send(call);
    };
    const app = cloudbase.init({
      env: 'sdk-contract-fixture',
      secretId: 'synthetic-secret-id',
      secretKey: 'synthetic-secret-key',
      sessionToken: 'synthetic-session',
    });
    await run(createCatalogReadPort(app.database({ throwOnNotFound: false })), calls);
  } finally {
    Request.prototype.send = original;
  }
}

const query = (overrides: Partial<AdapterListQuery> = {}): AdapterListQuery => ({
  collection: 'catalogDetailVariants',
  page: 2,
  pageSize: 2,
  search: '',
  filter: {
    combinator: 'and',
    clauses: [
      { field: 'productId', op: 'eq', value: 'p1' },
      { field: 'catalogDetailRevision', op: 'eq', value: 'r1' },
      { field: 'archived', op: 'ne', value: true },
    ],
  },
  sort: [
    { field: 'catalogDetailPosition', dir: 'asc' },
    { field: '_id', dir: 'asc' },
  ],
  ...overrides,
});

const approved = (extra: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'p1',
  name: 'Unapproved row name',
  published: true,
  catalogDetailPublication: {
    state: 'approved',
    revision: 'r1',
    variantCount: 0,
    variantStorage: 'immutable-v1',
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p1',
      name: 'Approved headset',
      images: [],
      facts: [],
      offers: [],
      websitePricing: {
        basis: 'website-manual',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor: 430, minimumOrderQuantity: 1000 },
      },
    },
  },
  ...extra,
});

test('product reads are restricted and distinguish missing documents from SDK errors', async () => {
  await withSdk(
    () => rows([]),
    async (read, calls) => {
      assert.equal(await read.get('products', 'p1'), null);
      await assert.rejects(() => read.get('oemProjects', 'p1'), /Unexpected catalog collection/);
      assert.equal(calls.length, 1);
    },
  );
  for (const answer of [{ code: 'ACCESS_DENIED' }, rows([{ _id: 'other' }])]) {
    await withSdk(
      () => answer,
      async (read) => {
        await assert.rejects(() => read.get('products', 'p1'));
      },
    );
  }
});

test('variant paging uses the exact SDK filter, order, offset and row identity', async () => {
  const document = {
    _id: 'row-3',
    productId: 'p1',
    catalogDetailRevision: 'r1',
    catalogDetailPosition: 2,
  };
  for (const collection of ['catalogDetailVariants', 'productVariants']) {
    await withSdk(
      ({ action }) =>
        action === 'database.calculateDocument' ? { data: { total: 3 } } : rows([document]),
      async (read, calls) => {
        assert.deepEqual(await read.list(query({ collection })), {
          items: [document],
          total: 3,
          page: 2,
          pageSize: 2,
        });
        assert.equal(calls.length, 2);
        for (const { input } of calls) {
          assert.equal(input.collectionName, collection);
          assert.deepEqual(JSON.parse(input.query ?? '{}'), {
            productId: 'p1',
            catalogDetailRevision: 'r1',
            archived: { $ne: true },
          });
        }
        const page = calls[1]?.input;
        assert.ok(page);
        const order = JSON.parse(page.order ?? '{}');
        assert.deepEqual(order, {
          catalogDetailPosition: { $numberInt: '1' },
          _id: { $numberInt: '1' },
        });
        assert.deepEqual(Object.keys(order), ['catalogDetailPosition', '_id']);
        assert.equal(page.offset, 2);
        assert.equal(page.limit, 2);
      },
    );
  }
});

test('an expanded collection, filter, sort or page is rejected before SDK I/O', async () => {
  const valid = query();
  const invalid = [
    query({ collection: 'oemProjects' }),
    query({ filter: { combinator: 'or', clauses: valid.filter?.clauses ?? [] } }),
    query({
      filter: { combinator: 'and', clauses: [{ field: 'productId', op: 'eq', value: 'p1' }] },
    }),
    query({ sort: [{ field: '_id', dir: 'desc' }] }),
    query({ page: 0 }),
    query({ page: 1.5 }),
    query({ pageSize: 51 }),
    query({ pageSize: 0 }),
  ];
  await withSdk(
    () => {
      throw Error('Unexpected network call');
    },
    async (read, calls) => {
      for (const input of invalid)
        await assert.rejects(() => read.list(input), /Unexpected approved catalog query/);
      assert.equal(calls.length, 0);
    },
  );
});

test('failed counts, failed queries and malformed rows cannot become an empty approved page', async () => {
  for (const scenario of [
    'count-error',
    'count-invalid',
    'query-error',
    'row-invalid',
    'transport-error',
  ]) {
    await withSdk(
      ({ action }) => {
        if (scenario === 'transport-error') throw Error('Synthetic SDK failure');
        if (action === 'database.calculateDocument') {
          if (scenario === 'count-error') return { code: 'ACCESS_DENIED' };
          return { data: { total: scenario === 'count-invalid' ? -1 : 1 } };
        }
        return scenario === 'query-error' ? { code: 'ACCESS_DENIED' } : rows([{ _id: '' }]);
      },
      async (read) => {
        await assert.rejects(() => read.list(query()), Error, scenario);
      },
    );
  }
});

test('the request-local port preserves published/approved rules and publication rechecks', async () => {
  for (const product of [
    approved({ published: false }),
    approved({ archived: true }),
    approved({ catalogDetailPublication: undefined }),
  ]) {
    await withSdk(
      () => rows([product]),
      async (read, calls) => {
        const result = await createApprovedProductReader(read)('p1');
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'NOT_FOUND');
        assert.equal(calls.length, 1);
      },
    );
  }
  let productReads = 0;
  await withSdk(
    ({ action, input }) => {
      if (input.collectionName === 'products')
        return rows([approved(++productReads === 2 ? { published: false } : {})]);
      return action === 'database.calculateDocument' ? { data: { total: 0 } } : rows([]);
    },
    async (read) => {
      const result = await createApprovedProductReader(read)('p1');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'CONFLICT');
    },
  );
});

test('the complete reader returns the requested immutable page using approved content only', async () => {
  const product = approved();
  const publication = product.catalogDetailPublication;
  assert.ok(publication && typeof publication === 'object');
  const pagedProduct = approved({ catalogDetailPublication: { ...publication, variantCount: 3 } });
  const variant = {
    id: 'v3',
    options: [],
    images: [],
    offers: [],
    inventory: { state: 'unknown' },
  };
  const row = {
    _id: approvedVariantDocumentId('p1', 'r1', 'v3'),
    variantId: 'v3',
    productId: 'p1',
    catalogDetailRevision: 'r1',
    catalogDetailPosition: 2,
    catalogDetailApproved: variant,
  };
  await withSdk(
    ({ action, input }) => {
      if (input.collectionName === 'products') return rows([pagedProduct]);
      return action === 'database.calculateDocument' ? { data: { total: 3 } } : rows([row]);
    },
    async (read, calls) => {
      const result = await createApprovedProductReader(read)('p1', 2, 2, 'r1');
      assert.ok(result.ok);
      assert.equal(result.data.name, 'Approved headset');
      assert.deepEqual(result.data.variants, {
        items: [variant],
        total: 3,
        page: 2,
        pageSize: 2,
        hasMore: false,
      });
      assert.equal(calls.length, 4);
    },
  );
});
