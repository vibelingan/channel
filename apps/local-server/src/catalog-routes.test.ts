import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import test from 'node:test';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type ApiResult,
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import express from 'express';
import { closeServer, registerCatalogRoutes } from './catalog-routes.ts';

class CatalogMemoryAdapter implements DbAdapter {
  constructor(private readonly products: CollectionDoc[]) {}

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let items = this.products.filter((doc) => !query.filter || matchesFilter(doc, query.filter));
    if (query.sort) items = [...items].sort((a, b) => compareBySort(a, b, query.sort ?? []));
    const total = items.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: items.slice(start, start + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(_collection: string, id: string): Promise<CollectionDoc | null> {
    return this.products.find((product) => product._id === id) ?? null;
  }
  async findByField(
    _collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.products.find((product) => product[field] === value) ?? null;
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
}

function testServer() {
  const app = express();
  registerCatalogRoutes(app, 'products', '/api/products', {});
  return app.listen(0);
}

function serverOrigin(server: ReturnType<typeof testServer>): string {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function rawGet(
  server: ReturnType<typeof testServer>,
  path: string,
): Promise<{ status: number; body: string }> {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: address.port, method: 'GET', path },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('local catalog route uses production repeated-query parsing and family filtering', async (t) => {
  setAdapter(
    new CatalogMemoryAdapter([
      { _id: 'toy', name: 'Toy', productFamily: 'toys', published: true },
      { _id: 'misc', name: 'Misc', productFamily: 'misc', published: true },
    ]),
  );
  const server = testServer();
  t.after(() => closeServer(server));

  const response = await fetch(
    `${serverOrigin(server)}/api/products?productFamily=toys&productFamily=misc`,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: true;
    data: { items: CollectionDoc[]; total: number };
  };
  assert.deepEqual(
    payload.data.items.map((item) => item._id),
    ['toy'],
  );
  assert.equal(payload.data.total, 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(response.headers.get('vary'), 'Origin, Authorization');
});

test('local catalog route rejects an unknown family with production error headers', async (t) => {
  setAdapter(new CatalogMemoryAdapter([]));
  const server = testServer();
  t.after(() => closeServer(server));

  const response = await fetch(`${serverOrigin(server)}/api/products?productFamily=garden`);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), null);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('access-control-max-age'), '86400');
  const payload = (await response.json()) as ApiResult<unknown>;
  assert.equal(payload.ok, false);
  if (!payload.ok) assert.equal(payload.error.code, 'VALIDATION_ERROR');
});

test('local catalog route mirrors production OPTIONS and unsupported-method responses', async (t) => {
  setAdapter(new CatalogMemoryAdapter([]));
  const server = testServer();
  t.after(() => closeServer(server));
  const origin = serverOrigin(server);

  const options = await fetch(`${origin}/api/products`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(await options.text(), '');

  for (const method of ['HEAD', 'POST']) {
    const response = await fetch(`${origin}/api/products`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    if (method === 'POST') {
      const payload = (await response.json()) as ApiResult<unknown>;
      assert.equal(payload.ok, false);
    }
  }
});

test('local slug route mirrors production canonical and malformed path behavior', async (t) => {
  setAdapter(
    new CatalogMemoryAdapter([
      { _id: 'product-1', name: 'Desk Lamp', slug: 'desk-lamp', published: true },
      { _id: 'draft', name: 'Draft', slug: 'draft-product', published: false },
    ]),
  );
  const server = testServer();
  t.after(() => closeServer(server));
  const origin = serverOrigin(server);

  const valid = await fetch(`${origin}/api/products/slug/desk-lamp`);
  assert.equal(valid.status, 200);
  for (const slug of ['draft-product', '%2E%2E', 'desk%2Flamp', '%', '%252F']) {
    const response = await rawGet(server, `/api/products/slug/${slug}`);
    assert.equal(response.status, 404, `local slug ${slug} must not resolve`);
    const payload = JSON.parse(response.body) as ApiResult<unknown>;
    assert.equal(payload.ok, false);
    if (!payload.ok) assert.equal(payload.error.code, 'NOT_FOUND');
  }
});
