import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import test from 'node:test';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import { handlePublicApiEvent } from '@vibelingan-channel/fn-public-api/http-adapter';
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

test('local taxonomy route delegates its request and response to the public HTTP handler', async () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /import \{ handlePublicApiEvent \} from '@vibelingan-channel\/fn-public-api\/http-adapter'/,
  );
  const route = source.match(
    /app\.get\('\/api\/catalog-taxonomy', async \(req, res\) => \{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert.ok(route, 'main.ts must register GET /api/catalog-taxonomy');
  assert.match(route, /await handlePublicApiEvent\(/);
  assert.match(route, /httpMethod: req\.method/);
  assert.match(route, /path: req\.originalUrl/);
  assert.match(route, /headers: req\.headers/);
  assert.match(route, /catalogConfig/);
  assert.match(route, /Object\.entries\(response\.headers\)/);
  assert.match(route, /res\.setHeader\(name, value\)/);
  assert.match(route, /res\.status\(response\.statusCode\)\.send\(response\.body\)/);

  setAdapter(new CatalogMemoryAdapter([]));
  for (const [query, expectedStatus] of [
    ['family=headphones', 200],
    ['family=toys', 200],
    ['family=ai-gadgets', 200],
    ['family=misc', 200],
    ['family=unknown', 400],
    ['family=toys&family=misc', 400],
  ] as const) {
    const response = await handlePublicApiEvent(
      {
        httpMethod: 'GET',
        path: `/api/catalog-taxonomy?${query}`,
        headers: { origin: 'http://localhost:4321' },
      },
      { corsAllowedOrigins: ['http://localhost:4321'] },
    );
    assert.equal(response.statusCode, expectedStatus, query);
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://localhost:4321');
    assert.equal(response.headers.Vary, 'Origin');
    assert.equal(JSON.parse(response.body).ok, expectedStatus === 200);
  }
});

test('local catalog route rejects repeated families and preserves single-family filtering', async (t) => {
  setAdapter(
    new CatalogMemoryAdapter([
      { _id: 'toy', name: 'Toy', productFamily: 'toys', published: true },
      { _id: 'misc', name: 'Misc', productFamily: 'misc', published: true },
    ]),
  );
  const server = testServer();
  t.after(() => closeServer(server));

  const repeated = await fetch(
    `${serverOrigin(server)}/api/products?productFamily=toys&productFamily=misc`,
  );
  assert.equal(repeated.status, 400);
  const rejected = (await repeated.json()) as ApiResult<unknown>;
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'VALIDATION_ERROR');

  const response = await fetch(`${serverOrigin(server)}/api/products?productFamily=toys`);
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
