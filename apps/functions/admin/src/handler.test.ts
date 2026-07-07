import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
  type MediaStorageAdapter,
  type UploadCredential,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import {
  type ApiResult,
  CATALOG_IMAGE_MAX_BYTES,
  type CollectionDoc,
  type ListResult,
  OEM_FILE_MAX_BYTES,
  OEM_MAX_PENDING_INTENTS_PER_SOURCE,
  matchesFilter,
  ok,
} from '@vibelingan-channel/shared';
import { type AdminConfig, type RequestContext, handleAdminRequest } from './handler.ts';

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

/** Invoke a PUBLIC action (no token), optionally with request context (client IP). */
function callPublic(action: string, data: unknown, context?: RequestContext) {
  return handleAdminRequest({ action, data }, config, context);
}

const validOemIntent = {
  fileName: 'part.step',
  mimeType: 'application/octet-stream',
  byteSize: 4096,
};

/** Extract the `data` payload of a successful ApiResult (asserts ok first). */
function okData<T = Record<string, unknown>>(res: ApiResult<unknown>): T {
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  return res.data as T;
}

test('health returns safe release metadata without a session', async () => {
  setup();
  const res = await handleAdminRequest({ action: 'health' }, config);
  const data = okData<{
    status: string;
    service: string;
    releaseId: string;
    buildTime: string;
  }>(res);

  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'admin');
  assert.equal(typeof data.releaseId, 'string');
  assert.notEqual(data.releaseId.length, 0);
  assert.equal(typeof data.buildTime, 'string');
  assert.notEqual(data.buildTime.length, 0);
});

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

// --- MIU-Upload (U1): createUploadIntent / completeUpload --------------------

/** Configurable media-storage fake: canned credential + object bytes, with
 *  switches for the mint-failure and missing-object paths. */
function makeFakeMediaStorage(
  opts: {
    uploadThrows?: boolean;
    objectBytes?: Buffer | null;
    omitByteSize?: boolean; // exercise the byteSize ?? bytes.byteLength fallback
    reportByteSize?: number; // report a size without allocating (oversize test)
    credential?: Partial<UploadCredential>;
    tempUrl?: { url: string; expiresAt?: string };
    tempUrlThrows?: boolean;
    deleteFailFor?: string[]; // storage ids whose deleteObject should reject
  } = {},
): MediaStorageAdapter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async putObject() {
      throw new Error('fake: putObject not used in admin upload tests');
    },
    async getTempUrl(): Promise<{ url: string; expiresAt?: string }> {
      if (opts.tempUrlThrows) throw new Error('fake: temp URL mint failed');
      return (
        opts.tempUrl ?? {
          url: 'https://cos.example/temp/oem',
          expiresAt: '2026-01-01T00:01:00.000Z',
        }
      );
    },
    async deleteObject(fileId: string) {
      if (opts.deleteFailFor?.includes(fileId)) throw new Error('fake: delete rejected');
      deleted.push(fileId);
    },
    async getUploadCredential(cloudPath: string): Promise<UploadCredential> {
      if (opts.uploadThrows) throw new Error('fake: credential mint failed');
      return {
        uploadUrl: 'https://cos.example/post',
        method: 'POST',
        formFields: {
          Signature: 'q-sign-algorithm=...',
          'x-cos-security-token': 'sts-token',
          'x-cos-meta-fileid': 'cos-meta',
          key: cloudPath,
        },
        storageFileId: `cloud://env.bucket/${cloudPath}`,
        ...opts.credential,
      };
    },
    async getObjectAsBase64(_fileId: string): Promise<{ body: string; byteSize?: number }> {
      if (opts.objectBytes === null) throw new Error('fake: object not found');
      const buf = opts.objectBytes ?? jpegBytes('IMG');
      const body = buf.toString('base64');
      if (opts.omitByteSize) return { body };
      return { body, byteSize: opts.reportByteSize ?? buf.byteLength };
    },
  };
}

/** Payload bytes behind a real JPEG magic-byte prefix, so the landed object
 *  passes completeUpload's signature-vs-declared-MIME sniff. */
function jpegBytes(payload: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(payload)]);
}

const validUpload = { fileName: 'photo.jpg', mimeType: 'image/jpeg', byteSize: 2048 };

test('createUploadIntent mints a credential and writes a pending image doc', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();
  const res = await call('createUploadIntent', validUpload, token);
  const data = okData<{
    imageId: string;
    uploadIntentId: string;
    storageFileId: string;
    upload: { method: 'POST'; url: string; fields: Record<string, string> };
  }>(res);

  assert.ok(data.imageId);
  assert.equal(data.upload.method, 'POST');
  assert.equal(data.upload.url, 'https://cos.example/post');
  assert.equal(data.upload.fields.Signature, 'q-sign-algorithm=...');
  assert.equal(data.upload.fields['x-cos-security-token'], 'sts-token');
  assert.equal(data.upload.fields['x-cos-meta-fileid'], 'cos-meta');

  const doc = store.images?.find((i) => i._id === data.imageId);
  assert.equal(doc?.status, 'pending');
  assert.equal(doc?.storageProvider, 'cloudbase-storage');
  assert.equal(doc?.publishedRefCount, 0);
  assert.equal(doc?.uploadIntentId, data.uploadIntentId);
  assert.equal(doc?.storageFileId, data.storageFileId);
  assert.ok(
    typeof doc?.storagePath === 'string' && (doc.storagePath as string).startsWith('catalog/'),
  );
});

test('createUploadIntent rejects a disallowed mime (svg) and writes nothing', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();
  const res = await call(
    'createUploadIntent',
    { fileName: 'x.svg', mimeType: 'image/svg+xml', byteSize: 100 },
    token,
  );
  expectErr(res, 'VALIDATION_ERROR');
  assert.equal((store.images ?? []).length, 0);
});

test('createUploadIntent is forbidden for a non-editor role (viewer)', async () => {
  setup(imageStore([]));
  setMediaStorage(makeFakeMediaStorage());
  const token = await signSession('test-secret', {
    sub: 'v-1',
    email: 'v@example.com',
    name: 'viewer',
    role: 'viewer',
  });
  expectErr(await call('createUploadIntent', validUpload, token), 'FORBIDDEN');
});

test('createUploadIntent: a credential-mint failure leaves no orphan doc', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage({ uploadThrows: true }));
  const token = await adminToken();
  // Minted before any DB write → the failure surfaces but nothing is persisted.
  expectErr(await call('createUploadIntent', validUpload, token), 'INTERNAL_ERROR');
  assert.equal((store.images ?? []).length, 0);
});

test('completeUpload verifies bytes, records size+checksum, flips pending → active', async () => {
  const store = imageStore([]);
  setup(store);
  const bytes = jpegBytes('the real image bytes');
  setMediaStorage(makeFakeMediaStorage({ objectBytes: bytes }));
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(
    await call('createUploadIntent', { ...validUpload, byteSize: bytes.byteLength }, token),
  );
  const res = await call('completeUpload', { imageId: intent.imageId }, token);
  assert.equal(res.ok, true);
  const doc = store.images?.find((i) => i._id === intent.imageId);
  assert.equal(doc?.status, 'active');
  assert.equal(doc?.byteSize, bytes.byteLength);
  assert.equal(doc?.checksumSha256, createHash('sha256').update(bytes).digest('hex'));
});

test('completeUpload leaves the doc PENDING (retryable) when the object is not yet retrievable', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage({ objectBytes: null })); // mint ok, object not (yet) there
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(await call('createUploadIntent', validUpload, token));
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'NOT_FOUND');
  // Not dead-ended to failed — a transient/eventually-consistent miss can retry;
  // a truly abandoned intent is reaped by orphan cleanup (MIU-06).
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.status, 'pending');
});

test('completeUpload rejects an over-cap landed object (server re-checks size)', async () => {
  const store = imageStore([]);
  setup(store);
  // Declared small at intent (passes), but the object that landed is over the cap.
  setMediaStorage(
    makeFakeMediaStorage({
      objectBytes: Buffer.from('x'),
      reportByteSize: CATALOG_IMAGE_MAX_BYTES + 1,
    }),
  );
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(await call('createUploadIntent', validUpload, token));
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'VALIDATION_ERROR');
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.status, 'failed');
});

test('completeUpload records the SERVER-measured size, not the client-declared one', async () => {
  const store = imageStore([]);
  setup(store);
  const landed = jpegBytes('the actual landed bytes are longer than the declared 8');
  setMediaStorage(makeFakeMediaStorage({ objectBytes: landed }));
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(
    await call('createUploadIntent', { ...validUpload, byteSize: 8 }, token), // declared 8 (a lie)
  );
  await call('completeUpload', { imageId: intent.imageId }, token);
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.byteSize, landed.byteLength);
});

test('completeUpload byteSize falls back to the decoded length when the adapter omits it', async () => {
  const store = imageStore([]);
  setup(store);
  const landed = jpegBytes('bytes-without-a-reported-size');
  setMediaStorage(makeFakeMediaStorage({ objectBytes: landed, omitByteSize: true }));
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(
    await call('createUploadIntent', { ...validUpload, byteSize: landed.byteLength }, token),
  );
  await call('completeUpload', { imageId: intent.imageId }, token);
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.byteSize, landed.byteLength);
});

test('completeUpload requires an imageId (BAD_REQUEST)', async () => {
  setup(imageStore([]));
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();
  expectErr(await call('completeUpload', {}, token), 'BAD_REQUEST');
});

test('createUploadIntent allows a contributor (positive auth case)', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage());
  const token = await signSession('test-secret', {
    sub: 'c-1',
    email: 'c@example.com',
    name: 'contributor',
    role: 'contributor',
  });
  const res = await call('createUploadIntent', validUpload, token);
  assert.equal(res.ok, true);
  assert.equal((store.images ?? []).length, 1);
  assert.equal(store.images?.[0]?.status, 'pending');
});

test('completeUpload marks the doc failed on a checksum mismatch', async () => {
  const store = imageStore([]);
  setup(store);
  const bytes = Buffer.from('actual landed bytes');
  setMediaStorage(makeFakeMediaStorage({ objectBytes: bytes }));
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(
    await call(
      'createUploadIntent',
      { ...validUpload, byteSize: bytes.byteLength, checksumSha256: 'deadbeef' }, // wrong
      token,
    ),
  );
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'VALIDATION_ERROR');
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.status, 'failed');
});

test('completeUpload: unknown id → NOT_FOUND; finalizing twice → CONFLICT', async () => {
  const store = imageStore([]);
  setup(store);
  setMediaStorage(makeFakeMediaStorage({ objectBytes: jpegBytes('x') }));
  const token = await adminToken();
  expectErr(await call('completeUpload', { imageId: 'does-not-exist' }, token), 'NOT_FOUND');
  const intent = okData<{ imageId: string }>(await call('createUploadIntent', validUpload, token));
  await call('completeUpload', { imageId: intent.imageId }, token); // → active
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'CONFLICT');
});

test('completeUpload rejects landed bytes that are not the declared image type (HTML payload)', async () => {
  // The pre-signed credential fixes only the KEY, so the browser can PUT
  // arbitrary bytes. An HTML/JS document behind photo.jpg must fail the magic-
  // byte sniff, mark the row failed, and delete the object — otherwise it would
  // later be served from the API origin with an attacker-useful Content-Type.
  const store = imageStore([]);
  setup(store);
  const fake = makeFakeMediaStorage({
    objectBytes: Buffer.from('<html><script>alert(document.domain)</script></html>'),
  });
  setMediaStorage(fake);
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(await call('createUploadIntent', validUpload, token));
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'VALIDATION_ERROR');
  const doc = store.images?.find((i) => i._id === intent.imageId);
  assert.equal(doc?.status, 'failed');
  assert.deepEqual(fake.deleted, [doc?.storageFileId]);
});

test('completeUpload rejects bytes whose signature is a DIFFERENT image type than declared', async () => {
  // PNG bytes behind an image/jpeg intent: still an image, but the declared
  // MIME (which becomes the delivery Content-Type) does not match the content.
  const store = imageStore([]);
  setup(store);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-payload'),
  ]);
  const fake = makeFakeMediaStorage({ objectBytes: png });
  setMediaStorage(fake);
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(await call('createUploadIntent', validUpload, token));
  expectErr(await call('completeUpload', { imageId: intent.imageId }, token), 'VALIDATION_ERROR');
  const doc = store.images?.find((i) => i._id === intent.imageId);
  assert.equal(doc?.status, 'failed');
  // Same cleanup contract as the HTML-payload path: the rejected object is deleted.
  assert.deepEqual(fake.deleted, [doc?.storageFileId]);
});

test('completeUpload ACCEPTS a valid PNG under an image/png intent (sniff does not over-reject)', async () => {
  // Guards against the sniff gate rejecting a legitimate non-JPEG type: a real
  // PNG declared as image/png must sniff-match and activate.
  const store = imageStore([]);
  setup(store);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-payload'),
  ]);
  setMediaStorage(makeFakeMediaStorage({ objectBytes: png }));
  const token = await adminToken();
  const intent = okData<{ imageId: string }>(
    await call(
      'createUploadIntent',
      { fileName: 'photo.png', mimeType: 'image/png', byteSize: png.byteLength },
      token,
    ),
  );
  const res = await call('completeUpload', { imageId: intent.imageId }, token);
  assert.equal(res.ok, true);
  assert.equal(store.images?.find((i) => i._id === intent.imageId)?.status, 'active');
});

test('generic update cannot rewrite images.mimeType (readOnly in the registry)', async () => {
  // A contributor relabeling landed bytes as text/html was the second half of
  // the stored-XSS chain; mimeType is server-managed via the media actions only.
  const store = imageStore(['img-1']);
  setup(store);
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();
  expectErr(
    await call(
      'update',
      { collection: 'images', id: 'img-1', values: { mimeType: 'text/html' } },
      token,
    ),
    'VALIDATION_ERROR',
  );
  assert.equal(store.images?.find((i) => i._id === 'img-1')?.mimeType, 'image/jpeg');
});

// --- MIU-05 (U2b): admin-authenticated image preview -------------------------

test('getImagePreview returns legacy base64 bytes (admin-authed, no refcount gate)', async () => {
  const store: Store = {
    users: [],
    images: [
      {
        _id: 'imgL',
        name: 'l.svg',
        mimeType: 'image/svg+xml',
        data: Buffer.from('<svg/>').toString('base64'),
      },
    ],
  };
  setup(store);
  setMediaStorage(makeFakeMediaStorage());
  const data = okData<{ id: string; mimeType: string; dataBase64: string }>(
    await call('getImagePreview', { id: 'imgL' }, await adminToken()),
  );
  assert.equal(data.mimeType, 'image/svg+xml');
  assert.equal(data.dataBase64, Buffer.from('<svg/>').toString('base64'));
});

test('getImagePreview proxies an UNPUBLISHED storage image (refCount 0) — the admin-preview fix', async () => {
  const store: Store = {
    users: [],
    images: [
      {
        _id: 'imgS',
        name: 's.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://x',
        status: 'active',
        publishedRefCount: 0, // public route would 404; admin preview must NOT
      },
    ],
  };
  setup(store);
  const bytes = Buffer.from('storage-preview-bytes');
  setMediaStorage(makeFakeMediaStorage({ objectBytes: bytes }));
  const data = okData<{ dataBase64: string }>(
    await call('getImagePreview', { id: 'imgS' }, await adminToken()),
  );
  assert.equal(data.dataBase64, bytes.toString('base64'));
});

test('getImagePreview refuses non-servable storage rows (pending/failed/deleted/unknown provider)', async () => {
  // Each has FETCHABLE bytes — so a 404 proves the refusal is by status/provider,
  // not a fetch miss. Pre-activation previews are the client's job (object URL);
  // failed/deleted/unknown-provider must never be served.
  const row = (id: string, status: string, storageProvider = 'cloudbase-storage') => ({
    _id: id,
    name: `${id}.png`,
    mimeType: 'image/png',
    storageProvider,
    storageFileId: 'cloud://x',
    status,
    publishedRefCount: 0,
  });
  const store: Store = {
    users: [],
    images: [
      row('imgPending', 'pending'),
      row('imgFailed', 'failed'),
      row('imgDeleted', 'deleted'),
      row('imgUnknown', 'active', 'mystery-provider'),
    ],
  };
  setup(store);
  setMediaStorage(makeFakeMediaStorage({ objectBytes: Buffer.from('fetchable-bytes') }));
  const token = await adminToken();
  for (const id of ['imgPending', 'imgFailed', 'imgDeleted', 'imgUnknown']) {
    expectErr(await call('getImagePreview', { id }, token), 'NOT_FOUND');
  }
});

test('getImagePreview: viewer forbidden; unknown id → 404; unfetchable object → 404', async () => {
  const store: Store = {
    users: [],
    images: [
      {
        _id: 'imgN',
        name: 'n.png',
        mimeType: 'image/png',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://missing',
        status: 'active',
        publishedRefCount: 1,
      },
    ],
  };
  setup(store);
  setMediaStorage(makeFakeMediaStorage({ objectBytes: null })); // object unfetchable
  const viewer = await signSession('test-secret', {
    sub: 'v-1',
    email: 'v@example.com',
    name: 'viewer',
    role: 'viewer',
  });
  expectErr(await call('getImagePreview', { id: 'imgN' }, viewer), 'FORBIDDEN');
  const admin = await adminToken();
  expectErr(await call('getImagePreview', { id: 'does-not-exist' }, admin), 'NOT_FOUND');
  expectErr(await call('getImagePreview', { id: 'imgN' }, admin), 'NOT_FOUND');
});

// --- MIU-06 (Phase 1): orphan cleanup ----------------------------------------

/** Media-storage fake that records deleteObject calls and can fail specific ids. */
function makeTrackingStorage(failFor: string[] = []): MediaStorageAdapter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async putObject() {
      throw new Error('fake: putObject unused');
    },
    async getTempUrl() {
      throw new Error('fake: getTempUrl unused');
    },
    async getUploadCredential() {
      throw new Error('fake: getUploadCredential unused');
    },
    async getObjectAsBase64() {
      throw new Error('fake: getObjectAsBase64 unused');
    },
    async deleteObject(fileId: string) {
      if (failFor.includes(fileId)) throw new Error('fake: delete rejected');
      deleted.push(fileId);
    },
  };
}

const ORPHAN_OLD = '2000-01-01T00:00:00.000Z';

function orphanStore(): Store {
  return {
    users: [],
    images: [
      // abandoned, old, with a storage object → reaped + object deleted
      {
        _id: 'op',
        name: 'op.jpg',
        mimeType: 'image/jpeg',
        status: 'pending',
        publishedRefCount: 0,
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://b/op',
        createdAt: ORPHAN_OLD,
      },
      {
        _id: 'of',
        name: 'of.jpg',
        mimeType: 'image/jpeg',
        status: 'failed',
        publishedRefCount: 0,
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://b/of',
        createdAt: ORPHAN_OLD,
      },
      // old pending with no storage object yet (direct upload never happened) → reaped, no delete
      {
        _id: 'on',
        name: 'on.jpg',
        mimeType: 'image/jpeg',
        status: 'pending',
        publishedRefCount: 0,
        createdAt: ORPHAN_OLD,
      },
      // recent pending → within TTL, kept
      {
        _id: 'recent',
        name: 'r.jpg',
        mimeType: 'image/jpeg',
        status: 'pending',
        publishedRefCount: 0,
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://b/recent',
        createdAt: new Date().toISOString(),
      },
      // active, old → never reaped (live catalog)
      {
        _id: 'active',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        status: 'active',
        publishedRefCount: 1,
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://b/active',
        createdAt: ORPHAN_OLD,
      },
    ],
  };
}

test('cleanupOrphanImages reaps stale pending/failed docs and deletes their storage objects', async () => {
  const store = setup(orphanStore());
  const storage = makeTrackingStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('cleanupOrphanImages', {}, token));

  assert.deepEqual([...(data.removed as string[])].sort(), ['of', 'on', 'op']);
  assert.equal(data.docsRemoved, 3);
  assert.deepEqual([...storage.deleted].sort(), ['cloud://b/of', 'cloud://b/op']); // 'on' had no object
  assert.deepEqual(data.storageFailed, []);
  assert.deepEqual((store.images ?? []).map((d) => d._id).sort(), ['active', 'recent']);
});

test('cleanupOrphanImages dryRun reports candidates without deleting anything', async () => {
  const store = setup(orphanStore());
  const storage = makeTrackingStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('cleanupOrphanImages', { dryRun: true }, token));
  assert.equal(data.dryRun, true);
  assert.deepEqual([...(data.removed as string[])].sort(), ['of', 'on', 'op']);
  assert.equal(data.docsRemoved, 0);
  assert.deepEqual(storage.deleted, []);
  assert.equal((store.images ?? []).length, 5);
});

test('cleanupOrphanImages keeps a doc whose storage delete fails (retryable) and reports it', async () => {
  const store = setup(orphanStore());
  setMediaStorage(makeTrackingStorage(['cloud://b/op'])); // op's object delete rejects
  const token = await adminToken();

  const data = okData(await call('cleanupOrphanImages', {}, token));
  assert.deepEqual(
    (data.storageFailed as Array<{ id: string }>).map((f) => f.id),
    ['op'],
  );
  assert.ok((store.images ?? []).some((d) => d._id === 'op')); // kept for retry
  assert.equal(
    (store.images ?? []).some((d) => d._id === 'of'),
    false,
  );
  assert.equal(
    (store.images ?? []).some((d) => d._id === 'on'),
    false,
  );
});

test('cleanupOrphanImages is admin-only', async () => {
  setup(orphanStore());
  setMediaStorage(makeTrackingStorage());
  const contributor = await signSession('test-secret', {
    sub: 'c-1',
    email: 'c@example.com',
    name: 'contributor',
    role: 'contributor',
  });
  expectErr(await call('cleanupOrphanImages', {}, contributor), 'FORBIDDEN');
});

test('cleanupOrphanImages respects olderThanMs (a huge TTL reaps nothing)', async () => {
  const store = setup(orphanStore());
  setMediaStorage(makeTrackingStorage());
  const token = await adminToken();
  // cutoff far in the past → even the 2000-era rows are newer than it → none reaped.
  const data = okData(
    await call('cleanupOrphanImages', { olderThanMs: 100 * 365 * 24 * 3600 * 1000 }, token),
  );
  assert.equal(data.docsRemoved, 0);
  assert.deepEqual(data.removed, []);
  assert.equal((store.images ?? []).length, 5);
});

test('cleanupOrphanImages honors a limit above the DB page cap by collecting stable pages', async () => {
  const store = setup({
    users: [],
    images: Array.from({ length: 105 }, (_, i) => ({
      _id: `old-${String(i).padStart(3, '0')}`,
      name: `old-${i}.jpg`,
      mimeType: 'image/jpeg',
      status: 'pending',
      publishedRefCount: 0,
      createdAt: ORPHAN_OLD,
    })),
  });
  setMediaStorage(makeTrackingStorage());
  const token = await adminToken();

  const data = okData(await call('cleanupOrphanImages', { limit: 105 }, token));

  assert.equal(data.scanned, 105);
  assert.equal(data.total, 105);
  assert.equal(data.docsRemoved, 105);
  assert.equal((store.images ?? []).length, 0);
});

// --- MIU-06 (Phase 2): legacy data → storage migration -----------------------

/** Media-storage fake that records putObject uploads; can fail a given logicalId. */
function makeMigrationStorage(
  opts: { putThrowsFor?: string[]; deleteThrows?: boolean } = {},
): MediaStorageAdapter & {
  uploaded: Array<{ logicalId: string; fileName: string; byteSize: number }>;
  deleted: string[];
} {
  const uploaded: Array<{ logicalId: string; fileName: string; byteSize: number }> = [];
  const deleted: string[] = [];
  return {
    uploaded,
    deleted,
    async putObject(input) {
      if (opts.putThrowsFor?.includes(input.logicalId)) throw new Error('fake: upload rejected');
      const byteSize = input.content instanceof Uint8Array ? input.content.byteLength : 0;
      uploaded.push({ logicalId: input.logicalId, fileName: input.fileName, byteSize });
      return {
        storageProvider: 'cloudbase-storage',
        storageMode: 'classic-nosql-storage',
        storageFileId: `cloud://env.bucket/catalog/${input.logicalId}/${input.fileName}`,
        storagePath: `catalog/${input.logicalId}/${input.fileName}`,
        byteSize,
      };
    },
    async getObjectAsBase64() {
      throw new Error('fake: unused');
    },
    async getTempUrl() {
      throw new Error('fake: unused');
    },
    async deleteObject(fileId: string) {
      if (opts.deleteThrows) throw new Error('fake: delete rejected');
      deleted.push(fileId);
    },
    async getUploadCredential() {
      throw new Error('fake: unused');
    },
  };
}

/** Wrap a MemoryAdapter but force `update` to fail, to exercise the migration's
 *  post-upload compensation path (object uploaded, then staging fails). */
function setupFailingUpdate(store: Store, mode: 'null' | 'throw'): Store {
  const mem = new MemoryAdapter(store);
  const adapter: DbAdapter = {
    list: (q) => mem.list(q),
    get: (c, i) => mem.get(c, i),
    findByField: (c, f, v) => mem.findByField(c, f, v),
    create: (c, d) => mem.create(c, d),
    remove: (c, i) => mem.remove(c, i),
    incrementField: (c, i, f, d) => mem.incrementField(c, i, f, d),
    async update() {
      if (mode === 'throw') throw new Error('fake: update rejected');
      return null;
    },
  };
  setAdapter(adapter);
  return store;
}

function oneLegacyStore(): Store {
  return {
    users: [],
    images: [
      {
        _id: 'leg1',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        data: LEGACY_B64,
        publishedRefCount: 0,
      },
    ],
  };
}

const LEGACY_B64 = Buffer.from('hello-legacy-image').toString('base64');

function legacyStore(): Store {
  return {
    users: [],
    images: [
      // legacy inline-data, not migrated → migrate
      {
        _id: 'leg1',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        data: LEGACY_B64,
        publishedRefCount: 0,
      },
      { _id: 'leg2', name: 'b.png', mimeType: 'image/png', data: LEGACY_B64, publishedRefCount: 0 },
      // already-staged legacy → excluded by the filter (idempotency)
      {
        _id: 'done1',
        name: 'c.jpg',
        mimeType: 'image/jpeg',
        data: LEGACY_B64,
        migrationStorageFileId: 'cloud://x/done',
        publishedRefCount: 0,
      },
      // storage-backed (no inline data) → not a candidate
      {
        _id: 'sb1',
        name: 'd.jpg',
        mimeType: 'image/jpeg',
        status: 'active',
        storageProvider: 'cloudbase-storage',
        storageFileId: 'cloud://x/sb',
        publishedRefCount: 1,
      },
    ],
  };
}

test('migrateLegacyImages stages legacy images: uploads + records migration fields, keeps data/provider', async () => {
  const store = setup(legacyStore());
  const storage = makeMigrationStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.deepEqual([...(data.migrated as string[])].sort(), ['leg1', 'leg2']);
  assert.equal(data.migratedCount, 2);
  assert.deepEqual(data.skipped, []);
  assert.deepEqual(storage.uploaded.map((u) => u.logicalId).sort(), ['leg1', 'leg2']);

  const leg1 = store.images?.find((i) => i._id === 'leg1');
  assert.equal(typeof leg1?.migrationStorageFileId, 'string'); // staged
  assert.ok(leg1?.migratedAt);
  assert.equal(leg1?.data, LEGACY_B64); // inline data KEPT (rollback-safe)
  assert.equal(leg1?.storageProvider, undefined); // provider untouched
  // already-staged + storage-backed rows untouched
  assert.equal(
    store.images?.find((i) => i._id === 'done1')?.migrationStorageFileId,
    'cloud://x/done',
  );
  assert.equal(
    storage.uploaded.some((u) => u.logicalId === 'sb1'),
    false,
  );
});

test('migrateLegacyImages dryRun reports candidates without uploading or writing', async () => {
  const store = setup(legacyStore());
  const storage = makeMigrationStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('migrateLegacyImages', { dryRun: true }, token));
  assert.deepEqual([...(data.migrated as string[])].sort(), ['leg1', 'leg2']);
  assert.equal(data.migratedCount, 0);
  assert.deepEqual(storage.uploaded, []);
  assert.equal(store.images?.find((i) => i._id === 'leg1')?.migrationStorageFileId, undefined);
});

test('migrateLegacyImages is idempotent — a second run migrates nothing', async () => {
  setup(legacyStore());
  setMediaStorage(makeMigrationStorage());
  const token = await adminToken();
  await call('migrateLegacyImages', {}, token);
  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.equal(data.scanned, 0);
  assert.deepEqual(data.migrated, []);
});

test('migrateLegacyImages skips malformed base64 but continues the batch', async () => {
  const store = setup({
    users: [],
    images: [
      {
        _id: 'bad',
        name: 'x.jpg',
        mimeType: 'image/jpeg',
        data: '!!!not-base64!!!',
        publishedRefCount: 0,
      },
      {
        _id: 'good',
        name: 'y.jpg',
        mimeType: 'image/jpeg',
        data: LEGACY_B64,
        publishedRefCount: 0,
      },
    ],
  });
  setMediaStorage(makeMigrationStorage());
  const token = await adminToken();
  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.deepEqual(
    (data.skipped as Array<{ id: string }>).map((s) => s.id),
    ['bad'],
  );
  assert.deepEqual(data.migrated, ['good']);
  assert.ok(store.images?.find((i) => i._id === 'good')?.migrationStorageFileId);
});

test('migrateLegacyImages is admin-only', async () => {
  setup(legacyStore());
  setMediaStorage(makeMigrationStorage());
  const contributor = await signSession('test-secret', {
    sub: 'c-1',
    email: 'c@example.com',
    name: 'contributor',
    role: 'contributor',
  });
  expectErr(await call('migrateLegacyImages', {}, contributor), 'FORBIDDEN');
});

test('migrateLegacyImages rolls back the uploaded object when staging returns null (row vanished)', async () => {
  setupFailingUpdate(oneLegacyStore(), 'null');
  const storage = makeMigrationStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.deepEqual(data.migrated, []);
  assert.equal(storage.uploaded.length, 1); // the object WAS uploaded
  assert.deepEqual(storage.deleted, ['cloud://env.bucket/catalog/leg1/migrated-a.jpg']); // then rolled back
  const skipped = data.skipped as Array<{ id: string; reason: string }>;
  assert.equal(skipped[0]?.id, 'leg1');
  assert.match(skipped[0]?.reason ?? '', /rolled back/);
});

test('migrateLegacyImages rolls back the uploaded object when staging throws', async () => {
  setupFailingUpdate(oneLegacyStore(), 'throw');
  const storage = makeMigrationStorage();
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.deepEqual(data.migrated, []);
  assert.deepEqual(storage.deleted, ['cloud://env.bucket/catalog/leg1/migrated-a.jpg']);
  assert.match(
    (data.skipped as Array<{ reason: string }>)[0]?.reason ?? '',
    /staging failed after upload/,
  );
});

test('migrateLegacyImages reports a leaked object when the rollback delete also fails', async () => {
  setupFailingUpdate(oneLegacyStore(), 'throw');
  const storage = makeMigrationStorage({ deleteThrows: true });
  setMediaStorage(storage);
  const token = await adminToken();

  const data = okData(await call('migrateLegacyImages', {}, token));
  assert.deepEqual(data.migrated, []);
  assert.deepEqual(storage.deleted, []); // delete threw → no confirmed deletion
  assert.match(
    (data.skipped as Array<{ reason: string }>)[0]?.reason ?? '',
    /ROLLBACK FAILED|leaked/,
  );
});

// --- MIU-08: getOemFileDownloadUrl (admin OEM-file delivery) -----------------

/** A finalized, deliverable OEM file row (all download guards satisfied). */
function activeOemFile(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'file1',
    name: 'assembly.step',
    mimeType: 'application/octet-stream',
    purpose: 'oem-drawing',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://env.bucket/oem/2026/06/intent1/assembly.step',
    status: 'active',
    ownerProjectId: 'oemProjects-1',
    ...overrides,
  };
}

test('getOemFileDownloadUrl returns a short-TTL temp URL + attachment disposition', async () => {
  setup({ users: [], files: [activeOemFile()] });
  setMediaStorage(makeFakeMediaStorage({ tempUrl: { url: 'https://cos/temp/x', expiresAt: 'E' } }));
  const token = await adminToken();

  const data = okData<{
    fileId: string;
    url: string;
    expiresAt?: string;
    fileName: string;
    mimeType: string;
    contentDisposition: string;
  }>(await call('getOemFileDownloadUrl', { fileId: 'file1' }, token));

  assert.equal(data.fileId, 'file1');
  assert.equal(data.url, 'https://cos/temp/x');
  assert.equal(data.expiresAt, 'E');
  assert.equal(data.fileName, 'assembly.step');
  assert.equal(data.mimeType, 'application/octet-stream');
  assert.equal(data.contentDisposition, 'attachment; filename="assembly.step"');
});

test('getOemFileDownloadUrl fails closed for every non-deliverable row', async () => {
  const cases: Array<{ label: string; doc: CollectionDoc }> = [
    { label: 'pending (never finalized)', doc: activeOemFile({ status: 'pending' }) },
    { label: 'failed (rejected)', doc: activeOemFile({ status: 'failed' }) },
    { label: 'deleted', doc: activeOemFile({ status: 'deleted' }) },
    { label: 'wrong purpose', doc: activeOemFile({ purpose: 'catalog-image' }) },
    { label: 'no owner project', doc: activeOemFile({ ownerProjectId: undefined }) },
    { label: 'empty owner project', doc: activeOemFile({ ownerProjectId: '' }) },
    { label: 'legacy-base64 provider', doc: activeOemFile({ storageProvider: 'legacy-base64' }) },
    { label: 'unknown provider', doc: activeOemFile({ storageProvider: 'bogus' }) },
    { label: 'missing storageFileId', doc: activeOemFile({ storageFileId: undefined }) },
  ];
  for (const { label, doc } of cases) {
    setup({ users: [], files: [doc] });
    setMediaStorage(makeFakeMediaStorage());
    const token = await adminToken();
    const res = await call('getOemFileDownloadUrl', { fileId: 'file1' }, token);
    assert.equal(res.ok, false, `expected ${label} to be rejected`);
    if (!res.ok) assert.equal(res.error.code, 'NOT_FOUND', `expected NOT_FOUND for ${label}`);
  }
});

test('getOemFileDownloadUrl sanitizes a header-injecting filename', async () => {
  setup({ users: [], files: [activeOemFile({ name: 'a"b\r\nc.pdf' })] });
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();

  const data = okData<{ fileName: string; contentDisposition: string }>(
    await call('getOemFileDownloadUrl', { fileId: 'file1' }, token),
  );
  // CR/LF and quotes are stripped, so the header value cannot be split/injected.
  assert.equal(data.fileName, 'abc.pdf');
  assert.equal(data.contentDisposition, 'attachment; filename="abc.pdf"');
  // No CR/LF can reach the header (the quotes here are the disposition's own
  // legitimate delimiters; the filename itself is asserted quote-free above).
  assert.equal(/[\r\n]/.test(data.contentDisposition), false);
});

test('getOemFileDownloadUrl requires read permission', async () => {
  setup({ users: [], files: [activeOemFile()] });
  setMediaStorage(makeFakeMediaStorage());
  const memberToken = await signSession('test-secret', {
    sub: 'member-1',
    email: 'member@example.com',
    name: 'member',
    role: 'member',
  });
  expectErr(await call('getOemFileDownloadUrl', { fileId: 'file1' }, memberToken), 'FORBIDDEN');
});

test('getOemFileDownloadUrl returns NOT_FOUND when the temp URL mint fails', async () => {
  setup({ users: [], files: [activeOemFile()] });
  setMediaStorage(makeFakeMediaStorage({ tempUrlThrows: true }));
  const token = await adminToken();
  expectErr(await call('getOemFileDownloadUrl', { fileId: 'file1' }, token), 'NOT_FOUND');
});

test('getOemFileDownloadUrl validates input and missing rows', async () => {
  setup({ users: [], files: [] });
  setMediaStorage(makeFakeMediaStorage());
  const token = await adminToken();
  expectErr(await call('getOemFileDownloadUrl', {}, token), 'BAD_REQUEST');
  expectErr(await call('getOemFileDownloadUrl', { fileId: 'nope' }, token), 'NOT_FOUND');
});

// --- MIU-08: createOemFileUploadIntent (public intent + abuse controls) -------

/** A `files` row shaped like one intent already created this minute by a source. */
function oemWindowDoc(id: string, sourceHash?: string): CollectionDoc {
  return {
    _id: id,
    name: 'a.step',
    mimeType: 'application/octet-stream',
    purpose: 'oem-drawing',
    status: 'active',
    createdAt: new Date().toISOString(),
    ...(sourceHash ? { uploadSourceHash: sourceHash } : {}),
  };
}

/** A live (non-expired) pending intent held by a source. */
function oemPendingDoc(id: string, sourceHash: string, expiresAt: string): CollectionDoc {
  return {
    _id: id,
    name: 'a.step',
    mimeType: 'application/octet-stream',
    purpose: 'oem-drawing',
    status: 'pending',
    uploadExpiresAt: expiresAt,
    uploadSourceHash: sourceHash,
  };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test('createOemFileUploadIntent mints a credential, writes a pending row, returns a one-time secret', async () => {
  const store = setup({ users: [], files: [] });
  setMediaStorage(makeFakeMediaStorage());

  const data = okData<{
    fileId: string;
    uploadIntentId: string;
    uploadSecret: string;
    upload: { method: string; url: string; fields: Record<string, string> };
  }>(await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '1.2.3.4' }));

  assert.ok(data.fileId);
  assert.ok(data.uploadIntentId);
  assert.ok(data.uploadSecret.length >= 32);
  assert.equal(data.upload.method, 'POST');
  assert.equal(data.upload.url, 'https://cos.example/post');

  const doc = store.files?.find((f) => f._id === data.fileId);
  assert.ok(doc);
  assert.equal(doc?.status, 'pending');
  assert.equal(doc?.purpose, 'oem-drawing');
  assert.equal(doc?.storageProvider, 'cloudbase-storage');
  // The single-winner claim counter is initialised to 0 so finalization
  // increments a concrete field. (The live failure was an SDK bug — wx-server-sdk
  // `db.command.inc` not applying in the CloudBase runtime, fixed in the db
  // adapter — not absent-field semantics; keeping `0` mirrors publishedRefCount.)
  assert.equal(doc?.finalizeClaim, 0);
  assert.equal(typeof doc?.uploadExpiresAt, 'string');
  // The plaintext secret is NEVER stored — only its SHA-256 hash.
  assert.notEqual(doc?.uploadSecretHash, data.uploadSecret);
  assert.equal(doc?.uploadSecretHash, sha256(data.uploadSecret));
  // The client IP is hashed, never persisted raw.
  assert.equal(doc?.uploadSourceHash, sha256('1.2.3.4'));
  assert.notEqual(doc?.uploadSourceHash, '1.2.3.4');
});

test('createOemFileUploadIntent sweeps expired pending OEM uploads (object first; keep on failure; no over-delete; leave live rows)', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const oem = (id: string, expiresAt: string, storageFileId?: string): CollectionDoc => ({
    _id: id,
    name: 'x.step',
    mimeType: 'application/zip',
    purpose: 'oem-drawing',
    status: 'pending',
    uploadExpiresAt: expiresAt,
    ...(storageFileId ? { storageFileId, storageProvider: 'cloudbase-storage' } : {}),
  });
  const store = setup({
    users: [],
    files: [
      oem('exp-obj', past, 'cloud://b/exp-obj'), // expired + object -> swept + object deleted
      oem('exp-noobj', past), // expired + no object -> row retired, no delete call
      oem('exp-fail', past, 'cloud://b/failme'), // expired + object delete FAILS -> kept for retry
      oem('live', future, 'cloud://b/live'), // NOT expired -> untouched
    ],
  });
  const storage = makeFakeMediaStorage({ deleteFailFor: ['cloud://b/failme'] });
  setMediaStorage(storage);

  // A brand-new intent triggers the piggyback sweep and still succeeds.
  const data = okData<{ fileId: string }>(
    await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '9.9.9.9' }),
  );
  assert.ok(data.fileId);

  const ids = new Set((store.files ?? []).map((f) => String(f._id)));
  assert.equal(ids.has('exp-obj'), false); // expired row with object is swept
  assert.equal(ids.has('exp-noobj'), false); // expired row without object is retired
  assert.equal(ids.has('exp-fail'), true); // kept when its object delete fails (retryable)
  assert.equal(ids.has('live'), true); // unexpired pending row untouched
  assert.ok(storage.deleted.includes('cloud://b/exp-obj')); // object deleted first
  assert.equal(storage.deleted.includes('cloud://b/failme'), false); // no over-delete on failure
  assert.equal(storage.deleted.includes('cloud://b/live'), false); // live object untouched
});

test('createOemFileUploadIntent rejects an unsupported type or oversize file before minting', async () => {
  const store = setup({ users: [], files: [] });
  setMediaStorage(makeFakeMediaStorage({ uploadThrows: true })); // would throw IF it minted
  expectErr(
    await callPublic('createOemFileUploadIntent', {
      fileName: 'malware.exe',
      mimeType: 'application/octet-stream',
      byteSize: 10,
    }),
    'VALIDATION_ERROR',
  );
  expectErr(
    await callPublic('createOemFileUploadIntent', {
      fileName: 'big.pdf',
      mimeType: 'application/pdf',
      byteSize: OEM_FILE_MAX_BYTES + 1,
    }),
    'VALIDATION_ERROR',
  );
  // Nothing was written (validation fails closed before any DB/credential work).
  assert.equal(store.files?.length, 0);
});

test('createOemFileUploadIntent enforces the per-source fixed-window rate limit', async () => {
  const src = sha256('9.9.9.9');
  // Five intents already created this minute by the same source (the per-source cap).
  const store = setup({
    users: [],
    files: Array.from({ length: 5 }, (_, i) => oemWindowDoc(`w${i}`, src)),
  });
  setMediaStorage(makeFakeMediaStorage());

  const limited = await callPublic('createOemFileUploadIntent', validOemIntent, {
    sourceIp: '9.9.9.9',
  });
  expectErr(limited, 'RATE_LIMITED');
  if (!limited.ok) {
    assert.ok((limited.error.retryAfterSeconds ?? 0) >= 1);
  }
  // Reserve-first: the rejected reservation is rolled back, not left behind.
  assert.equal(store.files?.length, 5);
  // A different source is under the global ceiling and still allowed.
  assert.equal(
    (await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '8.8.8.8' })).ok,
    true,
  );
});

test('createOemFileUploadIntent enforces the global rate ceiling when the source is unknown', async () => {
  // 30 intents this minute (the global ceiling) with no per-source signal.
  setup({ users: [], files: Array.from({ length: 30 }, (_, i) => oemWindowDoc(`g${i}`)) });
  setMediaStorage(makeFakeMediaStorage());
  // No sourceIp -> only the global ceiling applies; the 31st is blocked.
  const limited = await callPublic('createOemFileUploadIntent', validOemIntent);
  expectErr(limited, 'RATE_LIMITED');
  if (!limited.ok) {
    assert.ok((limited.error.retryAfterSeconds ?? 0) >= 1);
  }
});

test('createOemFileUploadIntent enforces the per-source pending-intent cap', async () => {
  const src = sha256('7.7.7.7');
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  setup({
    users: [],
    files: Array.from({ length: 3 }, (_, i) => oemPendingDoc(`p${i}`, src, future)),
  });
  setMediaStorage(makeFakeMediaStorage());
  const limited = await callPublic('createOemFileUploadIntent', validOemIntent, {
    sourceIp: '7.7.7.7',
  });
  expectErr(limited, 'RATE_LIMITED');
  if (!limited.ok) {
    assert.ok((limited.error.retryAfterSeconds ?? 0) >= 1);
  }
});

test('createOemFileUploadIntent ignores EXPIRED pending intents when applying the cap', async () => {
  const src = sha256('7.7.7.7');
  const past = new Date(Date.now() - 1000).toISOString();
  // Five pending rows but all expired (uploadExpiresAt < now) -> none count.
  setup({
    users: [],
    files: Array.from({ length: 5 }, (_, i) => oemPendingDoc(`x${i}`, src, past)),
  });
  setMediaStorage(makeFakeMediaStorage());
  assert.equal(
    (await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '7.7.7.7' })).ok,
    true,
  );
});

test('createOemFileUploadIntent returns INTERNAL_ERROR when the credential mint fails', async () => {
  const store = setup({ users: [], files: [] });
  setMediaStorage(makeFakeMediaStorage({ uploadThrows: true }));
  expectErr(
    await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '1.2.3.4' }),
    'INTERNAL_ERROR',
  );
  // The reservation is rolled back when the mint fails — no leaked pending row.
  assert.equal(store.files?.length, 0);
});

test('createOemFileUploadIntent rolls back the reservation when storageFileId attach fails', async () => {
  for (const mode of ['null', 'throw'] as const) {
    const store = setupFailingUpdate({ users: [], files: [] }, mode);
    setMediaStorage(makeFakeMediaStorage());
    expectErr(
      await callPublic('createOemFileUploadIntent', validOemIntent, { sourceIp: '6.6.6.6' }),
      'INTERNAL_ERROR',
    );
    assert.equal(store.files?.length, 0, `${mode} attach failure should not leak a reservation`);
  }
});

test('createOemFileUploadIntent admits at most the cap as reservations accumulate', async () => {
  // Reserve-first bound: each admitted intent persists as a pending row that the
  // NEXT request counts, so the per-source pending cap admits exactly N then
  // blocks — proving a concurrent burst cannot overshoot the ceiling.
  const store = setup({ users: [], files: [] });
  setMediaStorage(makeFakeMediaStorage());
  const ctx = { sourceIp: '5.5.5.5' };
  for (let i = 0; i < OEM_MAX_PENDING_INTENTS_PER_SOURCE; i++) {
    assert.equal(
      (await callPublic('createOemFileUploadIntent', validOemIntent, ctx)).ok,
      true,
      `reservation ${i + 1} should be admitted`,
    );
  }
  // The cap is full; the next reservation is rejected AND rolled back.
  expectErr(await callPublic('createOemFileUploadIntent', validOemIntent, ctx), 'RATE_LIMITED');
  assert.equal(store.files?.length, OEM_MAX_PENDING_INTENTS_PER_SOURCE);
});

// --- MIU-08 Increment 3: submitProject OEM finalization ----------------------

// Magic-byte fixtures (see packages/shared/src/media-content.ts `sniffMagicBytes`).
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const STEP_BYTES = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n'); // CAD → sniff 'unknown'
const OEM_STORAGE_ID = 'cloud://env.bucket/oem/2026/07/intent1/drawing.pdf';
const OEM_SECRET = 'a'.repeat(64);
const sha256Bytes = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Media-storage fake that serves configurable bytes and RECORDS deletes. */
function makeFinalizeStorage(
  opts: { bytes?: Buffer; getThrows?: boolean; deleteThrows?: boolean } = {},
): MediaStorageAdapter & { deleted: string[]; reads: string[] } {
  const deleted: string[] = [];
  const reads: string[] = [];
  return {
    deleted,
    reads,
    async putObject() {
      throw new Error('fake: putObject unused');
    },
    async getTempUrl() {
      throw new Error('fake: getTempUrl unused');
    },
    async getUploadCredential() {
      throw new Error('fake: getUploadCredential unused');
    },
    async getObjectAsBase64(fileId: string) {
      reads.push(fileId);
      if (opts.getThrows) throw new Error('fake: object not retrievable');
      const buf = opts.bytes ?? PDF_BYTES;
      return { body: buf.toString('base64'), byteSize: buf.byteLength };
    },
    async deleteObject(fileId: string) {
      if (opts.deleteThrows) throw new Error('fake: delete rejected');
      deleted.push(fileId);
    },
  };
}

/** A pending OEM upload row bound to `OEM_SECRET`. */
function pendingOemRow(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'file1',
    name: 'drawing.pdf',
    mimeType: 'application/pdf',
    purpose: 'oem-drawing',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: OEM_STORAGE_ID,
    storagePath: 'oem/2026/07/intent1/drawing.pdf',
    status: 'pending',
    uploadIntentId: 'intent1',
    uploadSecretHash: sha256(OEM_SECRET),
    uploadExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function finalizeInput(overrides: Record<string, unknown> = {}) {
  return {
    company: 'ACME',
    contact: 'Jo',
    email: 'jo@acme.com',
    drawingFileId: 'file1',
    uploadIntentId: 'intent1',
    uploadSecret: OEM_SECRET,
    ...overrides,
  };
}

test('submitProject storage finalize activates the drawing, creates the project, consumes the secret', async () => {
  const store = setup({ users: [], files: [pendingOemRow()], oemProjects: [] });
  const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
  setMediaStorage(storage);

  const data = okData<{ id: string }>(await callPublic('submitProject', finalizeInput()));
  const project = store.oemProjects?.find((p) => p._id === data.id);
  assert.equal(project?.drawing, 'file1');
  assert.equal(project?.status, 'new');

  const file = store.files?.find((f) => f._id === 'file1');
  assert.equal(file?.status, 'active');
  assert.equal(file?.ownerProjectId, data.id);
  assert.equal(file?.byteSize, PDF_BYTES.byteLength); // SERVER-recomputed
  assert.equal(file?.checksumSha256, sha256Bytes(PDF_BYTES));
  assert.equal(file?.uploadSecretHash, ''); // consumed
  assert.equal(file?.finalizeClaim, 1); // single-winner claim
  assert.deepEqual(storage.deleted, []); // success never deletes
});

test('submitProject accepts a CAD file by extension when the bytes sniff unknown', async () => {
  const store = setup({
    users: [],
    files: [pendingOemRow({ name: 'part.step', mimeType: 'application/octet-stream' })],
    oemProjects: [],
  });
  setMediaStorage(makeFinalizeStorage({ bytes: STEP_BYTES }));
  const data = okData<{ id: string }>(await callPublic('submitProject', finalizeInput()));
  assert.ok(store.oemProjects?.find((p) => p._id === data.id));
  assert.equal(store.files?.find((f) => f._id === 'file1')?.status, 'active');
});

test('submitProject legacy drawingData derives mimeType from a byte sniff, not the client string', async () => {
  // Anonymous caller tries to persist an HTML payload labelled text/html via the
  // legacy inline path. The stored mimeType must be sniff-derived (octet-stream
  // for non-image bytes), never the attacker-supplied value — files.mimeType is
  // reflected by OEM download delivery.
  const store = setup({ users: [], files: [], oemProjects: [] });
  setMediaStorage(makeFinalizeStorage());
  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  const data = okData<{ id: string }>(
    await callPublic('submitProject', {
      company: 'ACME',
      contact: 'Jo',
      email: 'jo@acme.com',
      drawingName: 'evil.html',
      drawingType: 'text/html',
      drawingData: html,
    }),
  );
  const project = store.oemProjects?.find((p) => p._id === data.id);
  const file = store.files?.find((f) => f._id === project?.drawing);
  assert.equal(file?.mimeType, 'application/octet-stream');

  // A real PNG under a lying drawingType is stored as its true canonical MIME.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
    'base64',
  );
  const data2 = okData<{ id: string }>(
    await callPublic('submitProject', {
      company: 'ACME',
      contact: 'Jo',
      email: 'jo@acme.com',
      drawingName: 'real.png',
      drawingType: 'text/html',
      drawingData: png,
    }),
  );
  const project2 = store.oemProjects?.find((p) => p._id === data2.id);
  const file2 = store.files?.find((f) => f._id === project2?.drawing);
  assert.equal(file2?.mimeType, 'image/png');
});

test('submitProject rejects a WRONG SECRET without deleting or failing the object (no unauth DoS)', async () => {
  const store = setup({ users: [], files: [pendingOemRow()], oemProjects: [] });
  const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
  setMediaStorage(storage);
  expectErr(
    await callPublic('submitProject', finalizeInput({ uploadSecret: 'b'.repeat(64) })),
    'FORBIDDEN',
  );
  // Critical: a caller who lacks the secret must not be able to mutate/destroy the
  // legit upload just by knowing its fileId + intentId.
  assert.equal(store.files?.find((f) => f._id === 'file1')?.status, 'pending'); // NOT failed
  assert.deepEqual(storage.deleted, []); // NOT deleted
  assert.equal(store.oemProjects?.length, 0);
});

test('submitProject rejects structural failures without mutating the row or object', async () => {
  const cases: Array<{ label: string; row: CollectionDoc | undefined; code: string }> = [
    { label: 'not found', row: undefined, code: 'NOT_FOUND' },
    { label: 'not pending', row: pendingOemRow({ status: 'active' }), code: 'CONFLICT' },
    { label: 'wrong purpose', row: pendingOemRow({ purpose: 'catalog-image' }), code: 'NOT_FOUND' },
    { label: 'wrong intent', row: pendingOemRow({ uploadIntentId: 'other' }), code: 'NOT_FOUND' },
    {
      label: 'expired',
      row: pendingOemRow({ uploadExpiresAt: new Date(Date.now() - 1000).toISOString() }),
      code: 'CONFLICT',
    },
    {
      label: 'non-oem path',
      row: pendingOemRow({ storagePath: 'catalog/x/y.pdf' }),
      code: 'NOT_FOUND',
    },
    {
      label: 'missing secret hash',
      row: pendingOemRow({ uploadSecretHash: '' }),
      code: 'NOT_FOUND',
    },
  ];
  for (const { label, row, code } of cases) {
    const store = setup({ users: [], files: row ? [row] : [], oemProjects: [] });
    const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
    setMediaStorage(storage);
    const res = await callPublic('submitProject', finalizeInput());
    assert.equal(res.ok, false, `${label} should reject`);
    if (!res.ok) assert.equal(res.error.code, code, `${label} code`);
    assert.deepEqual(storage.deleted, [], `${label} must not delete`);
    if (row) {
      assert.notEqual(
        store.files?.find((f) => f._id === 'file1')?.status,
        'failed',
        `${label} must not fail the row`,
      );
    }
    assert.equal(store.oemProjects?.length, 0, `${label} no project`);
  }
});

test('submitProject fails the row + deletes the object for post-secret byte failures', async () => {
  const oversized = Buffer.concat([PDF_BYTES, Buffer.alloc(OEM_FILE_MAX_BYTES)]); // > cap
  const cases: Array<{ label: string; row: CollectionDoc; bytes: Buffer }> = [
    { label: 'oversize', row: pendingOemRow(), bytes: oversized },
    {
      label: 'checksum mismatch',
      row: pendingOemRow({ checksumSha256: 'deadbeef' }),
      bytes: PDF_BYTES,
    },
    { label: 'sniff mismatch', row: pendingOemRow(), bytes: PNG_BYTES }, // pdf name, png bytes
    { label: 'CAD disguise', row: pendingOemRow({ name: 'x.dwg' }), bytes: ZIP_BYTES }, // dwg name, zip bytes
    { label: 'empty', row: pendingOemRow(), bytes: Buffer.alloc(0) },
  ];
  for (const { label, row, bytes } of cases) {
    const store = setup({ users: [], files: [row], oemProjects: [] });
    const storage = makeFinalizeStorage({ bytes });
    setMediaStorage(storage);
    expectErr(await callPublic('submitProject', finalizeInput()), 'VALIDATION_ERROR');
    assert.equal(
      store.files?.find((f) => f._id === 'file1')?.status,
      'failed',
      `${label} row failed`,
    );
    assert.deepEqual(storage.deleted, [OEM_STORAGE_ID], `${label} object deleted`);
    // The single-winner claim ran BEFORE the destructive validation (Codex P1).
    assert.equal(
      store.files?.find((f) => f._id === 'file1')?.finalizeClaim,
      1,
      `${label} claim consumed before destructive validation`,
    );
    assert.equal(store.oemProjects?.length, 0, `${label} no project`);
  }
});

test('submitProject treats an unreadable object as terminal (claim consumed, row failed, re-upload)', async () => {
  const store = setup({ users: [], files: [pendingOemRow()], oemProjects: [] });
  const storage = makeFinalizeStorage({ getThrows: true });
  setMediaStorage(storage);
  // The claim is taken BEFORE the download, so an unreadable object is terminal for
  // the (now consumed) intent: the row is failed + best-effort deleted; re-upload.
  expectErr(await callPublic('submitProject', finalizeInput()), 'VALIDATION_ERROR');
  const file = store.files?.find((f) => f._id === 'file1');
  assert.equal(file?.status, 'failed');
  assert.equal(file?.finalizeClaim, 1); // claimed before the download attempt
  assert.deepEqual(storage.deleted, [OEM_STORAGE_ID]); // best-effort cleanup
  assert.equal(store.oemProjects?.length, 0);
});

test('submitProject consume-once: a concurrent loser (claim already 1) is rejected with no side effects', async () => {
  const store = setup({ users: [], files: [pendingOemRow({ finalizeClaim: 1 })], oemProjects: [] });
  const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
  setMediaStorage(storage);
  expectErr(await callPublic('submitProject', finalizeInput()), 'CONFLICT');
  // The loser loses the claim BEFORE any storage call: it must NOT download the
  // object (no ~10 MiB amplification), delete it, or create a project.
  assert.deepEqual(storage.reads, []); // never downloaded
  assert.deepEqual(storage.deleted, []);
  assert.equal(store.oemProjects?.length, 0);
  // The atomic gate ran (claim advanced 1→2) but the row is otherwise untouched.
  assert.equal(store.files?.find((f) => f._id === 'file1')?.finalizeClaim, 2);
  assert.equal(store.files?.find((f) => f._id === 'file1')?.status, 'pending');
});

test('submitProject downloads the object at most once per intent (winner-only storage read)', async () => {
  const store = setup({ users: [], files: [pendingOemRow()], oemProjects: [] });
  const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
  setMediaStorage(storage);
  // First finalize wins and reads the object exactly once.
  okData(await callPublic('submitProject', finalizeInput()));
  assert.equal(storage.reads.length, 1);
  // A repeat finalize of the same intent is rejected at the status gate (the row is
  // now `active`) BEFORE any second download — so the read never runs twice.
  expectErr(await callPublic('submitProject', finalizeInput()), 'CONFLICT');
  assert.equal(storage.reads.length, 1);
  assert.equal(store.oemProjects?.length, 1); // exactly one project
});

test('submitProject compensation: activation failure rolls back the project and surfaces an error', async () => {
  const store = setupFailingUpdate(
    { users: [], files: [pendingOemRow()], oemProjects: [] },
    'null',
  );
  setMediaStorage(makeFinalizeStorage({ bytes: PDF_BYTES }));
  expectErr(await callPublic('submitProject', finalizeInput()), 'INTERNAL_ERROR');
  // The project must not survive holding a non-active drawing.
  assert.equal(store.oemProjects?.length, 0);
});

test('submitProject rejects an incomplete storage triad', async () => {
  setup({ users: [], files: [pendingOemRow()], oemProjects: [] });
  setMediaStorage(makeFinalizeStorage({ bytes: PDF_BYTES }));
  expectErr(
    await callPublic('submitProject', {
      company: 'A',
      contact: 'B',
      email: 'a@b.com',
      drawingFileId: 'file1', // no intent/secret
    }),
    'VALIDATION_ERROR',
  );
});

test('submitProject legacy base64 path still works (no storage calls)', async () => {
  const store = setup({ users: [], files: [], oemProjects: [] });
  const storage = makeFinalizeStorage({ bytes: PDF_BYTES });
  setMediaStorage(storage);
  const data = okData<{ id: string }>(
    await callPublic('submitProject', {
      company: 'A',
      contact: 'B',
      email: 'a@b.com',
      drawingName: 'legacy.pdf',
      drawingType: 'application/pdf',
      drawingData: Buffer.from('legacy-bytes').toString('base64'),
    }),
  );
  const project = store.oemProjects?.find((p) => p._id === data.id);
  const file = store.files?.find((f) => f._id === project?.drawing);
  assert.equal(typeof file?.data, 'string'); // inline base64
  assert.deepEqual(storage.deleted, []); // no storage interaction
});

test('submitProject no-drawing path creates a project with an empty drawing', async () => {
  const store = setup({ users: [], files: [], oemProjects: [] });
  setMediaStorage(makeFinalizeStorage());
  const data = okData<{ id: string }>(
    await callPublic('submitProject', { company: 'A', contact: 'B', email: 'a@b.com' }),
  );
  assert.equal(store.oemProjects?.find((p) => p._id === data.id)?.drawing, '');
  assert.equal(store.files?.length, 0);
});

test('submitProject rejects missing/invalid required text fields', async () => {
  setup({ users: [], files: [], oemProjects: [] });
  setMediaStorage(makeFinalizeStorage());
  expectErr(
    await callPublic('submitProject', { contact: 'B', email: 'a@b.com' }),
    'VALIDATION_ERROR',
  );
  expectErr(
    await callPublic('submitProject', { company: 'A', contact: 'B', email: 'not-an-email' }),
    'VALIDATION_ERROR',
  );
});
