import { strict as assert } from 'node:assert';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  type AdapterListQuery,
  type DbAdapter,
  incrementField,
  nextCounterValue,
  setAdapter,
} from '@vibelingan-channel/db';
import { type MediaStorageAdapter, setMediaStorage } from '@vibelingan-channel/media-storage';
import {
  CATALOG_IMAGE_MAX_COUNT,
  type CollectionDoc,
  type ListResult,
  type Role,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { type HttpResponse, handlePublicApiEvent } from './http-adapter.ts';

type Store = Record<string, CollectionDoc[]>;

const JWT_SECRET = 'test-public-api-secret';
const authEvent = (path: string, token: string) => ({
  httpMethod: 'GET',
  path,
  headers: { Authorization: `Bearer ${token}` },
});

/** Storage-backed bytes keyed by storageFileId; a missing key models an
 *  unfetchable object so getCatalogImage's fetch-failure branch is exercised. */
const STORAGE_BYTES: Record<string, string> = {
  'cloud://active': Buffer.from('storage-png-bytes').toString('base64'),
};

const fakeMediaStorage: MediaStorageAdapter = {
  async putObject() {
    throw new Error('fake media storage: putObject not used in public-api tests');
  },
  async getObjectAsBase64(fileId: string) {
    const bytes = STORAGE_BYTES[fileId];
    if (bytes === undefined) throw new Error(`fake media storage: no object for ${fileId}`);
    return { body: bytes, byteSize: Buffer.from(bytes, 'base64').byteLength };
  },
  async getTempUrl() {
    throw new Error('fake media storage: getTempUrl not used in public-api tests');
  },
  async deleteObject() {
    throw new Error('fake media storage: deleteObject not used in public-api tests');
  },
  async getUploadCredential() {
    throw new Error('fake media storage: getUploadCredential not used in public-api tests');
  },
};

class MemoryAdapter implements DbAdapter {
  readonly listQueries: AdapterListQuery[] = [];

  constructor(private readonly store: Store) {}

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    this.listQueries.push(query);
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

  async incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null> {
    const docs = this.store[collection] ?? [];
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return null;
    const existing = docs[index] as CollectionDoc;
    const next = nextCounterValue(existing[field], delta);
    docs[index] = { ...existing, [field]: next };
    return next;
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
    // Pricing tiers + internal fields, to prove the public projection ships
    // only the allowlisted fields (vipPrice is role-gated in the UI).
    unitPrice: 12,
    wholesalePrice: 10,
    vipPrice: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }));
  products.push({
    _id: 'p-hidden',
    name: 'Hidden Product',
    category: 'wired',
    published: false,
    imageIds: ['hidden-image'],
    unitPrice: 12,
    wholesalePrice: 10,
    vipPrice: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
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
      // Storage-backed rows — visibility is canonical (status + publishedRefCount),
      // no catalog scan. Bytes are proxied via the media adapter.
      {
        _id: 'storage-active',
        name: 'active.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: 1,
      },
      {
        _id: 'storage-zero',
        name: 'zero.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: 0,
      },
      {
        _id: 'storage-pending',
        name: 'pending.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'pending',
        publishedRefCount: 1,
      },
      {
        _id: 'storage-nobytes',
        name: 'nobytes.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://missing',
        status: 'active',
        publishedRefCount: 1,
      },
      // Legacy row that HAS been backfilled to refCount 0 → canonical, no scan.
      {
        _id: 'legacy-refcount-zero',
        name: 'legacy0.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
        publishedRefCount: 0,
      },
      // Storage row with a corrupt (non-finite) counter → must fail closed.
      {
        _id: 'storage-corrupt-refcount',
        name: 'corrupt.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: 'oops',
      },
      // Legacy row canonically visible via refCount>0; its id is in NO catalog,
      // so a 200 proves the canonical path rendered it WITHOUT the scan fallback.
      {
        _id: 'legacy-refcount-positive',
        name: 'legacy1.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
        publishedRefCount: 1,
      },
      // Storage row for the Phase B↔C contract test (refCount bumped at runtime).
      {
        _id: 'storage-link-e2e',
        name: 'e2e.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: 0,
      },
      // Post-D hardening fixtures: a numeric-STRING counter is corruption (the
      // writer always stores a number) and must fail closed, not coerce.
      {
        _id: 'storage-string-refcount',
        name: 's1.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: '1',
      },
      {
        _id: 'legacy-string-refcount',
        name: 'l1.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
        publishedRefCount: '1',
      },
      // A non-image mimeType on a visible row must never be reflected into the
      // response Content-Type (stored-XSS via content-type confusion).
      {
        _id: 'legacy-scripty-mime',
        name: 'scripty.html',
        mimeType: 'text/html',
        data: Buffer.from('<script>document.title = "xss"</script>').toString('base64'),
        publishedRefCount: 1,
      },
      // Unknown/corrupt provider must not be treated as storage-backed.
      {
        _id: 'storage-unknown-provider',
        name: 'u.png',
        mimeType: 'image/png',
        storageProvider: 'mystery-store',
        storageFileId: 'cloud://active',
        status: 'active',
        publishedRefCount: 1,
      },
    ],
    // Users rows backing the authenticated catalog path: `resolveCatalogViewer`
    // re-anchors every verified token to its CURRENT row (V3 revocation), so a
    // token without a live row unlocks nothing.
    users: [
      { _id: 'u-member', email: 'm@example.com', role: 'member', status: 'active' },
      {
        _id: 'u-contributor',
        email: 'c@example.com',
        role: 'contributor',
        status: 'active',
      },
      { _id: 'u-admin', email: 'a@example.com', role: 'admin', status: 'active' },
      { _id: 'u-viewer', email: 'v@example.com', role: 'viewer', status: 'active' },
      // Legacy row predating the status field — stays valid, mirroring `login`.
      { _id: 'u-legacy', email: 'l@example.com', role: 'member' },
    ],
  };
}

function setup(store: Store = seedStore()): MemoryAdapter {
  const adapter = new MemoryAdapter(store);
  setAdapter(adapter);
  setMediaStorage(fakeMediaStorage);
  return adapter;
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

test('catalog pages use stable _id ascending order across the full fixture', async () => {
  const store = seedStore();
  const products = store.products ?? [];
  products[53] = { ...(products[53] as CollectionDoc), _id: '1' };
  products[54] = { ...(products[54] as CollectionDoc), _id: '01' };
  const adapter = setup(store);
  const expectedIds = products
    .filter((product) => product.published === true)
    .map((product) => product._id)
    .sort();
  assert.equal(expectedIds.length, 55);

  const responses = await Promise.all(
    [1, 2].map((page) =>
      handlePublicApiEvent(
        {
          httpMethod: 'GET',
          path: '/api/products',
          queryStringParameters: { page: String(page), pageSize: '30' },
        },
        {},
      ),
    ),
  );
  const pages = responses.map(
    (response) =>
      body(response) as {
        ok: true;
        data: { items: CollectionDoc[]; total: number; page: number; pageSize: number };
      },
  );
  const pageIds = pages.map((page) => page.data.items.map((item) => item._id));

  assert.deepEqual(pageIds[0], expectedIds.slice(0, 30));
  assert.deepEqual(pageIds[1], expectedIds.slice(30));
  assert.deepEqual(pageIds.flat(), expectedIds);
  assert.deepEqual(
    pages.map((page) => ({
      total: page.data.total,
      page: page.data.page,
      pageSize: page.data.pageSize,
    })),
    [
      { total: 55, page: 1, pageSize: 30 },
      { total: 55, page: 2, pageSize: 30 },
    ],
  );
});

test('catalog order is role-invariant while vipPrice remains entitlement-gated', async () => {
  setup();
  const callers = [
    { role: 'anonymous', token: '', entitled: false },
    { role: 'viewer', token: await memberToken('viewer'), entitled: false },
    { role: 'member', token: await memberToken('member'), entitled: true },
    { role: 'contributor', token: await memberToken('contributor'), entitled: true },
    { role: 'admin', token: await memberToken('admin'), entitled: true },
  ] as const;
  const expectedIds = Array.from({ length: 55 }, (_, index) => `p-${index + 1}`)
    .sort()
    .slice(0, 12);

  for (const caller of callers) {
    const path = '/api/products?pageSize=12';
    const event = caller.token ? authEvent(path, caller.token) : { httpMethod: 'GET', path };
    const response = await handlePublicApiEvent(event, { jwtSecret: JWT_SECRET });
    const items = (body(response) as { ok: true; data: { items: CollectionDoc[] } }).data.items;

    assert.deepEqual(
      items.map((item) => item._id),
      expectedIds,
      `${caller.role} receives the canonical catalog order`,
    );
    assert.equal(
      caller.entitled
        ? items.every((item) => 'vipPrice' in item)
        : items.every((item) => !('vipPrice' in item)),
      true,
      `${caller.role} VIP projection matches current entitlement`,
    );
  }
});

// --- Public projection: no role-gated pricing / internal fields --------------

test('catalog list ships only allowlisted public fields (no vipPrice / imageIds / timestamps)', async () => {
  setup();
  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/products', queryStringParameters: { pageSize: '1' } },
    {},
  );
  const json = body(response) as { ok: true; data: { items: CollectionDoc[] } };
  const item = json.data.items[0] as CollectionDoc;

  // Publicly rendered fields survive the projection…
  assert.equal(item.unitPrice, 12);
  assert.equal(item.wholesalePrice, 10);
  assert.ok(Array.isArray(item.images));
  // …role-gated pricing and internal/raw fields never leave the server.
  assert.equal('vipPrice' in item, false);
  assert.equal('imageIds' in item, false);
  assert.equal('createdAt' in item, false);
  assert.equal('updatedAt' in item, false);
});

test('catalog list and detail filter malformed image ids before applying the shared limit', async () => {
  const store = seedStore();
  const first = store.products?.find((product) => product._id === 'p-1');
  assert.ok(first);
  const validImageIds = Array.from(
    { length: CATALOG_IMAGE_MAX_COUNT + 2 },
    (_, index) => ` legacy-image-${index + 1} `,
  );
  first.imageIds = [null, 2, '', false, {}, ...validImageIds];
  setup(store);

  const responses = await Promise.all(
    ['/api/products?pageSize=1', '/api/products/p-1'].map((path) =>
      handlePublicApiEvent({ httpMethod: 'GET', path }, { apiBaseUrl: 'https://api.example.test' }),
    ),
  );
  const listJson = body(responses[0] as HttpResponse) as {
    ok: true;
    data: { items: CollectionDoc[] };
  };
  const detailJson = body(responses[1] as HttpResponse) as { ok: true; data: CollectionDoc };
  const listDoc = listJson.data.items[0];
  assert.ok(listDoc, 'list route returns a document');
  const imagesByRoute = [listDoc.images as string[], detailJson.data.images as string[]];
  const expected = validImageIds
    .slice(0, CATALOG_IMAGE_MAX_COUNT)
    .map((id) => `https://api.example.test/api/images/${id.trim()}`);

  assert.deepEqual(imagesByRoute, [expected, expected]);
});

test('legacy visibility scan uses the same normalized first-18 image boundary as projection', async () => {
  const store = seedStore();
  const first = store.products?.find((product) => product._id === 'p-1');
  assert.ok(first);
  first.imageIds = [
    ' linked-image ',
    ...Array.from({ length: 17 }, (_, index) => `in-bound-${index + 2}`),
    'out-of-bound-image',
  ];
  store.images = [
    ...(store.images ?? []),
    {
      _id: 'out-of-bound-image',
      name: 'out.svg',
      mimeType: 'image/svg+xml',
      data: Buffer.from('<svg/>').toString('base64'),
    },
  ];
  setup(store);

  const trimmed = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/linked-image' },
    {},
  );
  const outside = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/out-of-bound-image' },
    {},
  );

  assert.equal(trimmed.statusCode, 200);
  assert.equal(outside.statusCode, 404);
});

test('legacy visibility scan pages on stable _id order across the 100-row boundary', async () => {
  const store = seedStore();
  store.products = Array.from({ length: 101 }, (_, index) => ({
    _id: `p-${String(index).padStart(3, '0')}`,
    name: `Product ${index}`,
    category: 'wired',
    published: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    imageIds: index === 100 ? ['page-two-image'] : [],
  }));
  store.images = [
    ...(store.images ?? []),
    {
      _id: 'page-two-image',
      name: 'page-two.svg',
      mimeType: 'image/svg+xml',
      data: Buffer.from('<svg/>').toString('base64'),
    },
  ];
  const adapter = setup(store);

  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/images/page-two-image' },
    {},
  );

  assert.equal(response.statusCode, 200);
  const productScans = adapter.listQueries.filter((query) => query.collection === 'products');
  assert.ok(productScans.length >= 2, 'legacy scan crossed the 100-row boundary');
  for (const query of productScans) {
    assert.deepEqual(query.sort, [{ field: '_id', dir: 'asc' }]);
  }
});

test('catalog detail ships only allowlisted public fields', async () => {
  setup();
  const response = await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/products/p-1' }, {});
  const json = body(response) as { ok: true; data: CollectionDoc };

  assert.equal(response.statusCode, 200);
  assert.equal(json.data.wholesalePrice, 10);
  assert.equal('vipPrice' in json.data, false);
  assert.equal('imageIds' in json.data, false);
});

test('catalog responses Vary on Authorization so a shared cache never leaks VIP data', async () => {
  setup();
  for (const path of ['/api/products?pageSize=1', '/api/products/p-1']) {
    const response = await handlePublicApiEvent(
      { httpMethod: 'GET', path },
      { jwtSecret: JWT_SECRET },
    );
    assert.equal(response.headers.Vary, 'Origin, Authorization');
    assert.equal(response.headers['Cache-Control'], 'private, no-cache');
  }
});

// --- Authenticated catalog path: server-side role-gated VIP pricing ----------

/** Token whose sub points at the seeded users row matching `role`. */
async function memberToken(role: Role = 'member'): Promise<string> {
  return signSession(JWT_SECRET, {
    sub: `u-${role || 'member'}`,
    email: 'm@example.com',
    name: 'M',
    role,
  });
}

test('authenticated catalog attaches vipPrice for an entitled (member) viewer', async () => {
  setup();
  const token = await memberToken('member');
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {
    jwtSecret: JWT_SECRET,
  });
  const json = body(response) as { ok: true; data: { items: CollectionDoc[] } };
  const item = json.data.items[0] as CollectionDoc;
  assert.equal(item.vipPrice, 8); // gated tier now present
  assert.equal(item.wholesalePrice, 10); // public tiers still present
  assert.equal('imageIds' in item, false); // internal fields still withheld
});

test('authenticated catalog DETAIL attaches vipPrice for an entitled viewer', async () => {
  setup();
  const token = await memberToken('admin');
  const response = await handlePublicApiEvent(authEvent('/api/products/p-1', token), {
    jwtSecret: JWT_SECRET,
  });
  const json = body(response) as { ok: true; data: CollectionDoc };
  assert.equal(json.data.vipPrice, 8);
});

test('viewer role does NOT unlock vipPrice (canSeeVipPricing is false)', async () => {
  setup();
  const token = await memberToken('viewer');
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {
    jwtSecret: JWT_SECRET,
  });
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  assert.equal('vipPrice' in (item ?? {}), false);
});

test('an invalid / forged token fails closed to the anonymous projection', async () => {
  setup();
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', 'not.a.jwt'), {
    jwtSecret: JWT_SECRET,
  });
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  assert.equal('vipPrice' in (item ?? {}), false);
});

test('a token signed with the WRONG secret does not unlock vipPrice', async () => {
  setup();
  const token = await signSession('some-other-secret', {
    sub: 'u-2',
    email: 'x@example.com',
    name: 'X',
    role: 'member',
  });
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {
    jwtSecret: JWT_SECRET,
  });
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  assert.equal('vipPrice' in (item ?? {}), false);
});

test('a valid member token is ignored when the function has no jwtSecret configured', async () => {
  setup();
  const token = await memberToken('member');
  // No jwtSecret in config → anonymous-only, even with a real token present.
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {});
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  assert.equal('vipPrice' in (item ?? {}), false);
});

test('an EXPIRED member token fails closed to the anonymous projection', async () => {
  setup();
  const token = await signSession(
    JWT_SECRET,
    { sub: 'u-member', email: 'm@example.com', name: 'M', role: 'member' },
    -1,
  );
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {
    jwtSecret: JWT_SECRET,
  });
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  assert.equal('vipPrice' in (item ?? {}), false);
});

// --- V3 revocation on the catalog path: the users ROW is authoritative -------

async function vipItemFor(token: string): Promise<boolean> {
  const response = await handlePublicApiEvent(authEvent('/api/products?pageSize=1', token), {
    jwtSecret: JWT_SECRET,
  });
  assert.equal(response.statusCode, 200); // revocation degrades, never errors
  const item = (body(response) as { data: { items: CollectionDoc[] } }).data.items[0];
  return 'vipPrice' in (item ?? {});
}

test('a SUSPENDED user loses vipPrice on their next request despite a valid token', async () => {
  const store = seedStore();
  store.users = [{ _id: 'u-member', email: 'm@example.com', role: 'member', status: 'suspended' }];
  setup(store);
  assert.equal(await vipItemFor(await memberToken('member')), false);
});

test('a DELETED user (no users row) loses vipPrice despite a valid token', async () => {
  setup();
  const token = await signSession(JWT_SECRET, {
    sub: 'u-ghost',
    email: 'g@example.com',
    name: 'G',
    role: 'member',
  });
  assert.equal(await vipItemFor(token), false);
});

test('a DEMOTED user drops vipPrice immediately (row role wins over token role)', async () => {
  setup();
  // Token still claims member, but the row (u-viewer) says viewer.
  const token = await signSession(JWT_SECRET, {
    sub: 'u-viewer',
    email: 'v@example.com',
    name: 'V',
    role: 'member',
  });
  assert.equal(await vipItemFor(token), false);
});

test('a PROMOTED user gains vipPrice without re-login (row role wins)', async () => {
  setup();
  // Token still claims viewer, but the row (u-member) says member.
  const token = await signSession(JWT_SECRET, {
    sub: 'u-member',
    email: 'm@example.com',
    name: 'M',
    role: 'viewer',
  });
  assert.equal(await vipItemFor(token), true);
});

test('a legacy users row without a status field keeps VIP access (mirrors login)', async () => {
  setup();
  const token = await signSession(JWT_SECRET, {
    sub: 'u-legacy',
    email: 'l@example.com',
    name: 'L',
    role: 'member',
  });
  assert.equal(await vipItemFor(token), true);
});

test('catalog stays up (anonymous projection) when the users lookup fails', async () => {
  class ThrowingUsersAdapter extends MemoryAdapter {
    override async get(collection: string, id: string): Promise<CollectionDoc | null> {
      if (collection === 'users') throw new Error('fake db: users unavailable');
      return super.get(collection, id);
    }
  }
  setAdapter(new ThrowingUsersAdapter(seedStore()));
  setMediaStorage(fakeMediaStorage);
  assert.equal(await vipItemFor(await memberToken('member')), false);
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
  assert.equal(linked.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(linked.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  assert.equal(linked.isBase64Encoded, true);
  assert.equal(hidden.statusCode, 404);
  assert.equal(unlinked.statusCode, 404);
});

test('accepts gateway-stripped public API paths', async () => {
  setup();

  const health = await handlePublicApiEvent({ httpMethod: 'GET', path: '/health' }, {});
  const products = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/products', queryStringParameters: { pageSize: '1' } },
    {},
  );
  const detail = await handlePublicApiEvent({ httpMethod: 'GET', path: '/products/p-1' }, {});
  const image = await handlePublicApiEvent({ httpMethod: 'GET', path: '/images/linked-image' }, {});

  assert.equal(health.statusCode, 200);
  const healthBody = JSON.parse(health.body) as {
    ok: boolean;
    data?: { status?: string; service?: string; releaseId?: string; buildTime?: string };
  };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.data?.status, 'ok');
  assert.equal(healthBody.data?.service, 'public-api');
  assert.equal(typeof healthBody.data?.releaseId, 'string');
  assert.notEqual(healthBody.data?.releaseId?.length, 0);
  assert.equal(typeof healthBody.data?.buildTime, 'string');
  assert.notEqual(healthBody.data?.buildTime?.length, 0);
  assert.equal(products.statusCode, 200);
  assert.equal(detail.statusCode, 200);
  assert.equal(image.statusCode, 200);
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

// --- MIU-04 Phase C: provider/refCount delivery branching -------------------

async function imageReq(id: string): Promise<HttpResponse> {
  return handlePublicApiEvent({ httpMethod: 'GET', path: `/api/images/${id}` }, {});
}

test('storage-backed active image with refCount>0 renders via the media proxy', async () => {
  setup();
  const res = await imageReq('storage-active');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.isBase64Encoded, true);
  assert.equal(res.body, STORAGE_BYTES['cloud://active']); // proxied bytes
});

test('image delivery never reflects a non-allowlisted mimeType into Content-Type', async () => {
  setup();
  const res = await imageReq('legacy-scripty-mime');
  assert.equal(res.statusCode, 200);
  // text/html degrades to octet-stream and nosniff blocks browser re-guessing.
  assert.equal(res.headers['Content-Type'], 'application/octet-stream');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('storage-backed image with refCount 0 returns 404 (canonical, no scan)', async () => {
  setup();
  assert.equal((await imageReq('storage-zero')).statusCode, 404);
});

test('pending storage-backed image returns 404 even with refCount>0', async () => {
  setup();
  assert.equal((await imageReq('storage-pending')).statusCode, 404);
});

test('storage-backed image whose bytes are unfetchable returns 404 (not 500)', async () => {
  setup();
  assert.equal((await imageReq('storage-nobytes')).statusCode, 404);
});

test('legacy-base64 row with a present refCount of 0 is hidden (canonical, no scan)', async () => {
  setup();
  assert.equal((await imageReq('legacy-refcount-zero')).statusCode, 404);
});

test('legacy-base64 row without a refCount still renders via the catalog-scan fallback', async () => {
  // linked-image has no publishedRefCount and is referenced by a published
  // product, so the compatibility scan keeps it visible until backfill runs.
  setup();
  assert.equal((await imageReq('linked-image')).statusCode, 200);
});

test('placeholder image is public by id regardless of refcount/status', async () => {
  setup();
  const res = await imageReq('_placeholder');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/svg+xml');
});

test('storage-backed image with a corrupt (non-finite) refCount fails closed (404)', async () => {
  setup();
  assert.equal((await imageReq('storage-corrupt-refcount')).statusCode, 404);
});

test('legacy-base64 row with refCount>0 renders via the canonical path (no scan)', async () => {
  setup();
  // The id is in no catalog, so the scan fallback would 404; a 200 proves the
  // canonical visibleByRefCount branch rendered it.
  assert.equal((await imageReq('legacy-refcount-positive')).statusCode, 200);
});

test('Phase B↔C contract: bumping publishedRefCount makes a storage image deliverable', async () => {
  setup();
  assert.equal((await imageReq('storage-link-e2e')).statusCode, 404); // refCount 0 → hidden
  await incrementField('images', 'storage-link-e2e', 'publishedRefCount', 1);
  const res = await imageReq('storage-link-e2e');
  assert.equal(res.statusCode, 200); // reader consumes the counter the writer maintains
  assert.equal(res.body, STORAGE_BYTES['cloud://active']);
});

// --- MIU-04 post-D review hardening: strict counter + provider guards --------

test('storage-backed image with a numeric-STRING refCount fails closed (404)', async () => {
  setup();
  // "1" is a contract violation (writer stores a number); must not coerce.
  assert.equal((await imageReq('storage-string-refcount')).statusCode, 404);
});

test('legacy row with a numeric-STRING refCount fails closed (404)', async () => {
  setup();
  assert.equal((await imageReq('legacy-string-refcount')).statusCode, 404);
});

test('image with an unknown storageProvider fails closed (404)', async () => {
  setup();
  assert.equal((await imageReq('storage-unknown-provider')).statusCode, 404);
});

test('legacy row with a present-but-corrupt refCount does NOT fall back to the scan (404)', async () => {
  // A published product references it, so the pre-fix scan fallback would have
  // rendered it; a PRESENT-but-invalid counter is canonical corruption → 404.
  const store: Store = {
    products: [
      {
        _id: 'p-corrupt',
        name: 'Pc',
        category: 'wired',
        published: true,
        imageIds: ['legacy-corrupt'],
      },
    ],
    overstock: [],
    images: [
      {
        _id: 'legacy-corrupt',
        name: 'c.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
        publishedRefCount: 'oops',
      },
    ],
  };
  setup(store);
  assert.equal((await imageReq('legacy-corrupt')).statusCode, 404);
});

// --- Alibaba linked catalog projection (docs/alibaba-linked-catalog-sync, MIU 9)

const LINKED_PRICING = {
  schemaVersion: 'alibaba-catalog-pricing-v1',
  source: 'alibaba',
  currency: 'USD',
  mode: 'fixed',
  amountMinor: 250,
  sourceMoq: 100,
  // Offer provenance — must be stripped by the public sub-projection.
  sourceOfferKey: 'offer-key-secret',
  sourceProductId: 'source-987',
  sourceSkuId: 'sku-1',
  sourceUpdatedAt: '2026-08-01T02:00:00.000Z',
  syncedAt: '2026-08-06T12:00:00.000Z',
};

function seedLinkedStore(): Store {
  const store = seedStore();
  const linked = store.products?.find((product) => product._id === 'p-1');
  if (linked) {
    linked.alibabaPrimarySourceKey = 'a'.repeat(64);
    linked.alibabaPrimaryOfferKey = 'internal-offer-key';
    linked.alibabaCatalogPricing = { ...LINKED_PRICING };
    linked.alibabaSourceStatus = 'available';
    linked.alibabaSourceLastSyncedAt = '2026-08-06T12:00:00.000Z';
  }
  return store;
}

test('unlinked products ship ZERO alibaba keys (legacy payload byte-stable)', async () => {
  setup();
  const response = await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/products/p-2' }, {});
  const json = body(response) as { ok: true; data: CollectionDoc };
  assert.equal(
    Object.keys(json.data).some((key) => key.startsWith('alibaba')),
    false,
    'no alibaba keys on an unlinked payload',
  );
});

test('linked products ship the additive fields with offer provenance STRIPPED', async () => {
  setup(seedLinkedStore());
  const response = await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/products/p-1' }, {});
  const json = body(response) as { ok: true; data: CollectionDoc };
  const item = json.data;
  // The REAL sourceKey hash never ships (review R2 #10) — link identity only.
  assert.equal(item.alibabaPrimarySourceKey, 'linked');
  assert.equal(item.alibabaSourceStatus, 'available');
  assert.equal('alibabaPrimaryOfferKey' in item, false, 'offer key never ships');
  const pricing = item.alibabaCatalogPricing as Record<string, unknown>;
  assert.equal(pricing.mode, 'fixed');
  assert.equal(pricing.amountMinor, 250);
  assert.equal(pricing.sourceMoq, 100);
  assert.equal('sourceOfferKey' in pricing, false, 'provenance stripped');
  assert.equal('sourceProductId' in pricing, false, 'provenance stripped');
  assert.equal('sourceSkuId' in pricing, false, 'provenance stripped');
  // Legacy fields still present in the payload (compatibility invariant 1) —
  // the UI branch decides what renders, the API never drops them.
  assert.equal(item.unitPrice, 12);
});

test('anonymous and authenticated callers receive IDENTICAL alibaba pricing; VIP gating unchanged', async () => {
  setup(seedLinkedStore());
  const anonymous = body(
    await handlePublicApiEvent(
      { httpMethod: 'GET', path: '/api/products/p-1' },
      { jwtSecret: JWT_SECRET },
    ),
  ) as { ok: true; data: CollectionDoc };
  const token = await memberToken('member');
  const authenticated = body(
    await handlePublicApiEvent(authEvent('/api/products/p-1', token), { jwtSecret: JWT_SECRET }),
  ) as { ok: true; data: CollectionDoc };
  assert.deepEqual(
    authenticated.data.alibabaCatalogPricing,
    anonymous.data.alibabaCatalogPricing,
    'identical alibaba pricing for all viewers',
  );
  assert.equal('vipPrice' in anonymous.data, false, 'VIP stays gated for anonymous');
  assert.equal(authenticated.data.vipPrice, 8, 'VIP still attaches for the entitled viewer');
});

test('overstock payloads never carry alibaba keys (shared allowlist, unchanged surface)', async () => {
  setup(seedLinkedStore());
  const response = await handlePublicApiEvent(
    { httpMethod: 'GET', path: '/api/overstock/o-1' },
    {},
  );
  const json = body(response) as { ok: true; data: CollectionDoc };
  assert.equal(
    Object.keys(json.data).some((key) => key.startsWith('alibaba')),
    false,
  );
});
