import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { type HttpResponse, handlePublicApiEvent } from './http-adapter.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  constructor(private readonly store: Store) {}

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...(this.store[query.collection] ?? [])];
    if (query.search) {
      const needle = query.search.toLowerCase();
      docs = docs.filter((doc) => JSON.stringify(doc).toLowerCase().includes(needle));
    }
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    if (query.sort && query.sort.length > 0) {
      docs.sort((a, b) => compareBySort(a, b, query.sort ?? []));
    }
    const total = docs.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: docs.slice(start, start + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.store[collection]?.find((doc) => doc._id === id) ?? null;
  }

  async findByField(
    collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.store[collection]?.find((doc) => doc[field] === value) ?? null;
  }

  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc: CollectionDoc = { _id: `${collection}-${Date.now()}`, ...data };
    this.store[collection] = [...(this.store[collection] ?? []), doc];
    return doc;
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.store[collection] ?? [];
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return null;
    const updated = { ...(docs[index] as CollectionDoc), ...data };
    docs[index] = updated;
    return updated;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.store[collection] ?? [];
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return false;
    docs.splice(index, 1);
    return true;
  }
}

function body(response: HttpResponse): unknown {
  return response.body ? JSON.parse(response.body) : null;
}

function seedStore(): Store {
  const products = Array.from({ length: 55 }, (_, index) => ({
    _id: `p-${index + 1}`,
    name: `Product ${index + 1}`,
    category: index % 2 === 0 ? 'wired' : 'office',
    published: true,
    imageIds: index === 0 ? ['linked-image'] : [],
  }));
  products.push({
    _id: 'p-hidden',
    name: 'Hidden Product',
    category: 'wired',
    published: false,
    imageIds: ['hidden-image'],
  });

  return {
    products,
    overstock: [
      {
        _id: 'o-1',
        name: 'Published Overstock',
        category: 'electronics',
        published: true,
        imageIds: ['overstock-image'],
      },
    ],
    images: [
      {
        _id: 'linked-image',
        name: 'linked.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
      },
      {
        _id: 'hidden-image',
        name: 'hidden.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
      },
      {
        _id: 'unlinked-image',
        name: 'unlinked.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
      },
      {
        _id: '_placeholder',
        name: 'placeholder.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
      },
    ],
  };
}

function setup(): void {
  setAdapter(new MemoryAdapter(seedStore()));
}

test('lists only published catalog items and caps pageSize at 48', async () => {
  setup();
  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/products', queryStringParameters: { pageSize: '99' } },
    { apiBaseUrl: 'https://api.example.test' },
  );
  const json = body(response) as {
    ok: true;
    data: { items: CollectionDoc[]; total: number; pageSize: number };
  };

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.pageSize, 48);
  assert.equal(json.data.items.length, 48);
  assert.equal(json.data.total, 55);
  assert.equal(
    json.data.items.some((item) => item._id === 'p-hidden'),
    false,
  );
  assert.deepEqual(json.data.items[0]?.images, [
    'https://api.example.test/api/images/linked-image',
  ]);
});

test('returns 404 for unpublished catalog detail', async () => {
  setup();
  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/products/p-hidden' },
    {},
  );
  assert.equal(response.statusCode, 404);
  assert.deepEqual(body(response), {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Item not found' },
  });
});

test('serves only images linked from published catalog records', async () => {
  setup();
  const linked = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/linked-image' },
    {},
  );
  const hidden = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/hidden-image' },
    {},
  );
  const unlinked = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/unlinked-image' },
    {},
  );

  assert.equal(linked.statusCode, 200);
  assert.equal(linked.headers['Content-Type'], 'image/svg+xml');
  assert.equal(linked.headers['Cache-Control'], 'public, max-age=3600');
  assert.equal(linked.isBase64Encoded, true);
  assert.equal(hidden.statusCode, 404);
  assert.equal(unlinked.statusCode, 404);
});

test('does not expose public file downloads', async () => {
  setup();
  const response = await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/files/sample' }, {});
  assert.equal(response.statusCode, 404);
});

test('returns 204 for CORS preflight', async () => {
  setup();
  const response = await handlePublicApiEvent(
    { httpMethod: 'OPTIONS', path: '/api/products', headers: { origin: 'https://site.example' } },
    { corsAllowedOrigins: ['https://site.example'] },
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://site.example');
});
