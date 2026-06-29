import { strict as assert } from 'node:assert';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  type AdapterListQuery,
  type DbAdapter,
  backfillPublishedRefCounts,
  incrementField,
  nextCounterValue,
  setAdapter,
} from '@vibelingan-channel/db';
import {
  type ApiResult,
  type CollectionDoc,
  type ListResult,
  matchesFilter,
  ok,
} from '@vibelingan-channel/shared';
import { type AdminConfig, handleAdminRequest } from './handler.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private nextId = 1;
  /** Records every list() query so tests can assert pagination parameters. */
  readonly listQueries: AdapterListQuery[] = [];

  constructor(private readonly store: Store) {}

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    this.listQueries.push(query);
    let docs = [...(this.store[query.collection] ?? [])];
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
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
    const doc: CollectionDoc = { _id: `${collection}-${this.nextId}`, ...data };
    this.nextId += 1;
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

const config = {
  jwtSecret: 'test-secret',
  bootstrap: {
    enabled: true,
    adminToken: 'bootstrap-token',
    adminEmail: 'Owner@Example.com',
    adminPasswordHash: '$argon2id$prehashed-admin-password',
  },
} satisfies AdminConfig;

function setup(store: Store = { users: [] }): Store {
  setAdapter(new MemoryAdapter(store));
  return store;
}

function expectErr(result: ApiResult<unknown>, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

test('incrementField atomically adjusts a numeric field; null for a missing doc', async () => {
  const store = setup({
    users: [],
    images: [{ _id: 'img1', name: 'p.jpg', mimeType: 'image/jpeg', publishedRefCount: 0 }],
  });
  assert.equal(await incrementField('images', 'img1', 'publishedRefCount', 1), 1);
  assert.equal(await incrementField('images', 'img1', 'publishedRefCount', 1), 2);
  assert.equal(await incrementField('images', 'img1', 'publishedRefCount', -1), 1);
  assert.equal(store.images?.[0]?.publishedRefCount, 1);
  // An absent field initialises from 0; a missing document returns null.
  assert.equal(await incrementField('images', 'img1', 'newCounter', 5), 5);
  assert.equal(await incrementField('images', 'missing', 'publishedRefCount', 1), null);
});

test('incrementField rejects non-integer deltas (NaN, Infinity, fractional)', () => {
  setup({
    users: [],
    images: [{ _id: 'img1', name: 'p.jpg', mimeType: 'image/jpeg', publishedRefCount: 0 }],
  });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
    // The facade guard throws synchronously, like assertKnown — counters must stay integral.
    assert.throws(
      () => incrementField('images', 'img1', 'publishedRefCount', bad),
      /finite integer/,
    );
  }
});

test('incrementField surfaces a non-numeric stored counter as a corruption error', async () => {
  // Mirrors CloudBase: db.command.inc rejects a non-numeric field instead of
  // silently treating it as 0 (which would diverge from production).
  setup({
    users: [],
    images: [{ _id: 'imgX', name: 'p.jpg', mimeType: 'image/jpeg', publishedRefCount: 'oops' }],
  });
  await assert.rejects(
    () => incrementField('images', 'imgX', 'publishedRefCount', 1),
    /non-numeric counter value/,
  );
});

test('nextCounterValue: init-from-0, add, and corruption guard', () => {
  assert.equal(nextCounterValue(undefined, 3), 3);
  assert.equal(nextCounterValue(null, -2), -2);
  assert.equal(nextCounterValue(4, 1), 5);
  assert.throws(() => nextCounterValue('5', 1), /non-numeric counter value/);
  assert.throws(() => nextCounterValue(Number.NaN, 1), /non-numeric counter value/);
});

test('bootstrapAdmin creates the first active admin from configured hash', async () => {
  const store = setup();

  const result = await handleAdminRequest(
    { action: 'bootstrapAdmin', data: { token: 'bootstrap-token' } },
    config,
  );

  assert.deepEqual(
    result,
    ok({
      user: {
        id: 'users-1',
        email: 'owner@example.com',
        username: 'owner',
        role: 'admin',
        status: 'active',
      },
      bootstrap: { disableRequired: true },
    }),
  );
  assert.equal(store.users?.length, 1);
  assert.deepEqual(store.users?.[0], {
    _id: 'users-1',
    email: 'owner@example.com',
    username: 'owner',
    role: 'admin',
    status: 'active',
    passwordHash: '$argon2id$prehashed-admin-password',
    loginCount: 0,
  });
});

test('bootstrapAdmin rejects invalid data token without writing', async () => {
  const store = setup();

  const result = await handleAdminRequest(
    {
      action: 'bootstrapAdmin',
      data: { token: 'wrong-token' },
      token: 'bootstrap-token',
    },
    config,
  );

  expectErr(result, 'UNAUTHORIZED');
  assert.deepEqual(store.users, []);
});

test('bootstrapAdmin does not overwrite an existing active admin', async () => {
  const existingAdmin = {
    _id: 'admin-1',
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
    status: 'active',
    passwordHash: 'old-hash',
    loginCount: 7,
  };
  const store = setup({ users: [existingAdmin] });

  const result = await handleAdminRequest(
    { action: 'bootstrapAdmin', data: { token: 'bootstrap-token' } },
    config,
  );

  expectErr(result, 'CONFLICT');
  assert.equal(store.users?.length, 1);
  assert.equal(store.users?.[0]?.passwordHash, 'old-hash');
});

test('bootstrapAdmin does not overwrite an existing account with the admin email', async () => {
  const existingUser = {
    _id: 'user-1',
    email: 'owner@example.com',
    username: 'owner-member',
    role: '',
    status: 'active',
    passwordHash: 'member-hash',
    loginCount: 0,
  };
  const store = setup({ users: [existingUser] });

  const result = await handleAdminRequest(
    { action: 'bootstrapAdmin', data: { token: 'bootstrap-token' } },
    config,
  );

  expectErr(result, 'CONFLICT');
  assert.deepEqual(store.users, [existingUser]);
});

// --- MIU-04 Phase B: publishedRefCount visibility maintenance ----------------

/** A store seeded with image docs (publishedRefCount 0) ready to be referenced. */
function imageStore(imageIds: string[]): Store {
  return {
    users: [],
    images: imageIds.map((id) => ({
      _id: id,
      name: `${id}.jpg`,
      mimeType: 'image/jpeg',
      publishedRefCount: 0,
    })),
  };
}

function refCount(store: Store, imageId: string): unknown {
  return store.images?.find((doc) => doc._id === imageId)?.publishedRefCount;
}

function adminToken(): Promise<string> {
  return signSession('test-secret', {
    sub: 'admin-1',
    email: 'admin@example.com',
    name: 'admin',
    role: 'admin',
  });
}

async function call(action: string, data: unknown, token: string) {
  return handleAdminRequest(
    { action, token, data } as Parameters<typeof handleAdminRequest>[0],
    config,
  );
}

test('create published product increments publishedRefCount for each image', async () => {
  const store = imageStore(['imgA', 'imgB']);
  setup(store);
  const token = await adminToken();
  const res = await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P1', category: 'wired', imageIds: ['imgA', 'imgB'], published: true },
    },
    token,
  );
  assert.equal(res.ok, true);
  assert.equal(refCount(store, 'imgA'), 1);
  assert.equal(refCount(store, 'imgB'), 1);
});

test('create unpublished product leaves refcounts untouched', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 0);
});

test('publishing then unpublishing a product increments then decrements', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  assert.equal(refCount(store, 'imgA'), 0);
  await call('update', { collection: 'products', id, values: { published: true } }, token);
  assert.equal(refCount(store, 'imgA'), 1);
  await call('update', { collection: 'products', id, values: { published: false } }, token);
  assert.equal(refCount(store, 'imgA'), 0);
});

test('changing imageIds on a published product moves the refcounts', async () => {
  const store = imageStore(['imgA', 'imgB', 'imgC']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA', 'imgB'], published: true },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  assert.equal(refCount(store, 'imgA'), 1);
  assert.equal(refCount(store, 'imgB'), 1);
  await call(
    'update',
    { collection: 'products', id, values: { imageIds: ['imgA', 'imgC'] } },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 1); // kept
  assert.equal(refCount(store, 'imgB'), 0); // dropped
  assert.equal(refCount(store, 'imgC'), 1); // added
});

test('removing a published product decrements its images', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: true },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  assert.equal(refCount(store, 'imgA'), 1);
  await call('remove', { collection: 'products', id }, token);
  assert.equal(refCount(store, 'imgA'), 0);
});

test('refcount reflects the number of publishing catalog docs', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P1', category: 'wired', imageIds: ['imgA'], published: true },
    },
    token,
  );
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P2', category: 'office', imageIds: ['imgA'], published: true },
    },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 2);
  const firstId = store.products?.[0]?._id as string;
  await call(
    'update',
    { collection: 'products', id: firstId, values: { published: false } },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 1);
});

test('batchUpdate publish then unpublish updates refcounts per doc', async () => {
  const store = imageStore(['imgA', 'imgB']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P1', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P2', category: 'wired', imageIds: ['imgB'], published: false },
    },
    token,
  );
  const ids = (store.products ?? []).map((p) => p._id);
  await call('batchUpdate', { collection: 'products', ids, values: { published: true } }, token);
  assert.equal(refCount(store, 'imgA'), 1);
  assert.equal(refCount(store, 'imgB'), 1);
  await call('batchUpdate', { collection: 'products', ids, values: { published: false } }, token);
  assert.equal(refCount(store, 'imgA'), 0);
  assert.equal(refCount(store, 'imgB'), 0);
});

test('batchRemove decrements refcounts for published docs', async () => {
  const store = imageStore(['imgA', 'imgB']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P1', category: 'wired', imageIds: ['imgA'], published: true },
    },
    token,
  );
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P2', category: 'wired', imageIds: ['imgB'], published: true },
    },
    token,
  );
  const ids = (store.products ?? []).map((p) => p._id);
  await call('batchRemove', { collection: 'products', ids }, token);
  assert.equal(refCount(store, 'imgA'), 0);
  assert.equal(refCount(store, 'imgB'), 0);
});

test('duplicate ids in a batch do not double-count', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  await call(
    'batchUpdate',
    { collection: 'products', ids: [id, id, id], values: { published: true } },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 1); // not 3
});

test('publishing a product that references a missing image is a no-op (no throw)', async () => {
  const store = imageStore([]); // no image docs
  setup(store);
  const token = await adminToken();
  const res = await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['ghost'], published: true },
    },
    token,
  );
  assert.equal(res.ok, true);
});

test('overstock is tracked for image visibility too', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'overstock',
      values: { name: 'O', category: 'electronics', imageIds: ['imgA'], published: true },
    },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 1);
});

// --- MIU-04 Phase B: review-hardening regression guards ----------------------

test('removing an UNpublished product does not decrement (delete-side no-op)', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  await call('remove', { collection: 'products', id }, token);
  assert.equal(refCount(store, 'imgA'), 0);
});

test('changing imageIds on an UNpublished product moves nothing', async () => {
  const store = imageStore(['imgA', 'imgB']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  await call('update', { collection: 'products', id, values: { imageIds: ['imgB'] } }, token);
  assert.equal(refCount(store, 'imgA'), 0);
  assert.equal(refCount(store, 'imgB'), 0);
});

test('the same image listed twice in one imageIds array counts once', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA', 'imgA'], published: true },
    },
    token,
  );
  assert.equal(refCount(store, 'imgA'), 1); // not 2
});

test('null / non-array / empty / empty-string imageIds are handled safely', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  // null, a bare string, [], and [''] all pass the json write schema and must
  // not throw nor produce a spurious increment.
  for (const imageIds of [null, 'imgA', [], ['']]) {
    const res = await call(
      'create',
      {
        collection: 'products',
        values: { name: 'P', category: 'wired', imageIds, published: true },
      },
      token,
    );
    assert.equal(res.ok, true);
  }
  assert.equal(refCount(store, 'imgA'), 0);
  assert.equal(refCount(store, ''), undefined); // empty-string id was filtered out
});

test('batchRemove with duplicate ids does not over-decrement', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: true },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  const res = await call('batchRemove', { collection: 'products', ids: [id, id, id] }, token);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal((res.data as { removed: number }).removed, 1);
  assert.equal(refCount(store, 'imgA'), 0); // exactly once, not −2
});

test('batch ops with a non-existent id only move the real docs', async () => {
  const store = imageStore(['imgA']);
  setup(store);
  const token = await adminToken();
  await call(
    'create',
    {
      collection: 'products',
      values: { name: 'P', category: 'wired', imageIds: ['imgA'], published: false },
    },
    token,
  );
  const id = store.products?.[0]?._id as string;
  const upd = await call(
    'batchUpdate',
    { collection: 'products', ids: [id, 'ghost-id'], values: { published: true } },
    token,
  );
  if (upd.ok) assert.equal((upd.data as { updated: number }).updated, 1);
  assert.equal(refCount(store, 'imgA'), 1);
  const rem = await call('batchRemove', { collection: 'products', ids: [id, 'ghost-id'] }, token);
  if (rem.ok) assert.equal((rem.data as { removed: number }).removed, 1);
  assert.equal(refCount(store, 'imgA'), 0);
});

test('a corrupted sibling counter does not strand other images in a batch remove', async () => {
  // imgA has a corrupted (non-numeric) counter; imgB is healthy at 1. Removing
  // both publishing products must still decrement imgB even though imgA throws.
  const store: Store = {
    users: [],
    images: [
      { _id: 'imgA', name: 'a.jpg', mimeType: 'image/jpeg', publishedRefCount: 'oops' },
      { _id: 'imgB', name: 'b.jpg', mimeType: 'image/jpeg', publishedRefCount: 1 },
    ],
    products: [
      { _id: 'p1', name: 'P1', category: 'wired', imageIds: ['imgA'], published: true },
      { _id: 'p2', name: 'P2', category: 'wired', imageIds: ['imgB'], published: true },
    ],
  };
  setup(store);
  const token = await adminToken();
  const res = await call('batchRemove', { collection: 'products', ids: ['p1', 'p2'] }, token);
  assert.equal(res.ok, true); // the committed deletes are not masked as a 500
  if (res.ok) assert.equal((res.data as { removed: number }).removed, 2);
  assert.equal(refCount(store, 'imgB'), 0); // healthy sibling still decremented
  assert.equal(refCount(store, 'imgA'), 'oops'); // corrupt counter left for backfill
});

// --- MIU-04 Phase D: publishedRefCount backfill ------------------------------

function catalogStore(): Store {
  return {
    users: [],
    images: [
      { _id: 'imgA', name: 'a.png', mimeType: 'image/png' }, // no counter yet
      { _id: 'imgB', name: 'b.png', mimeType: 'image/png', publishedRefCount: 99 }, // stale
      { _id: 'imgC', name: 'c.png', mimeType: 'image/png' }, // unreferenced
    ],
    products: [
      // imgA listed twice in one doc must count once.
      { _id: 'p1', name: 'P1', category: 'wired', imageIds: ['imgA', 'imgA'], published: true },
      { _id: 'p2', name: 'P2', category: 'wired', imageIds: ['imgA', 'imgB'], published: true },
      // unpublished → ignored.
      { _id: 'p3', name: 'P3', category: 'wired', imageIds: ['imgB', 'imgC'], published: false },
    ],
    overstock: [
      { _id: 'o1', name: 'O1', category: 'electronics', imageIds: ['imgB'], published: true },
    ],
  };
}

test('backfillPublishedRefCounts recomputes counters from the published catalog', async () => {
  const store = catalogStore();
  setup(store);
  const report = await backfillPublishedRefCounts();
  assert.equal(report.dryRun, false);
  assert.equal(report.imagesScanned, 3);
  assert.equal(refCount(store, 'imgA'), 2); // p1 (dup → 1) + p2
  assert.equal(refCount(store, 'imgB'), 2); // p2 + o1 (p3 unpublished ignored)
  assert.equal(refCount(store, 'imgC'), 0); // referenced only by an unpublished doc
});

test('backfillPublishedRefCounts dryRun reports changes without writing', async () => {
  const store = catalogStore();
  setup(store);
  const report = await backfillPublishedRefCounts({ dryRun: true });
  assert.equal(report.dryRun, true);
  // imgA null→2, imgB 99→2, imgC null→0 all differ.
  assert.equal(report.changes.length, 3);
  assert.ok(report.changes.some((c) => c.imageId === 'imgB' && c.from === 99 && c.to === 2));
  // Nothing persisted.
  assert.equal(refCount(store, 'imgA'), undefined);
  assert.equal(refCount(store, 'imgB'), 99);
});

test('backfillImageRefCounts action is admin-only (contributor forbidden)', async () => {
  setup({ users: [], images: [] });
  const token = await signSession('test-secret', {
    sub: 'c-1',
    email: 'c@example.com',
    name: 'contributor',
    role: 'contributor',
  });
  expectErr(await call('backfillImageRefCounts', {}, token), 'FORBIDDEN');
});

test('backfillImageRefCounts action runs for an admin (dryRun then apply)', async () => {
  const store = catalogStore();
  setup(store);
  const token = await adminToken();
  const dry = await call('backfillImageRefCounts', { dryRun: true }, token);
  assert.equal(dry.ok, true);
  if (dry.ok) assert.equal((dry.data as { dryRun: boolean }).dryRun, true);
  assert.equal(refCount(store, 'imgA'), undefined); // dry-run wrote nothing
  const applied = await call('backfillImageRefCounts', {}, token);
  assert.equal(applied.ok, true);
  assert.equal(refCount(store, 'imgA'), 2); // applied
});

test('backfillPublishedRefCounts pages past the 100-row boundary correctly', async () => {
  const n = 150;
  const store: Store = {
    users: [],
    images: Array.from({ length: n }, (_, i) => ({
      _id: `img-${i}`,
      name: `img-${i}.png`,
      mimeType: 'image/png',
    })),
    products: Array.from({ length: n }, (_, i) => ({
      _id: `p-${i}`,
      name: `P${i}`,
      category: 'wired',
      imageIds: [`img-${i}`],
      published: true,
    })),
  };
  // An extra published product also references img-0 → count 2 (accumulates
  // across the catalog page split, since p-extra lands on page 2).
  store.products?.push({
    _id: 'p-extra',
    name: 'Pextra',
    category: 'wired',
    imageIds: ['img-0'],
    published: true,
  });
  setup(store);
  const report = await backfillPublishedRefCounts();
  assert.equal(report.imagesScanned, n); // every image visited despite 2 pages
  assert.equal(refCount(store, 'img-0'), 2); // referenced twice
  assert.equal(refCount(store, 'img-100'), 1); // page 2 of the images loop
  assert.equal(refCount(store, 'img-149'), 1); // last row, page 2
});

test('backfill requests _id-sorted pages so CloudBase skip/limit paging is stable', async () => {
  // Construct the adapter directly to inspect the queries the backfill issues.
  const adapter = new MemoryAdapter({
    users: [],
    images: [{ _id: 'i1', name: 'i.png', mimeType: 'image/png' }],
    products: [],
    overstock: [],
  });
  setAdapter(adapter);
  await backfillPublishedRefCounts();
  assert.ok(adapter.listQueries.length > 0);
  for (const q of adapter.listQueries) {
    // Every paged scan must carry the unique-key tiebreaker (the P2 fix).
    assert.deepEqual(q.sort, [{ field: '_id', dir: 'asc' }]);
  }
});
