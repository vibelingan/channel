import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type AdapterListQuery,
  type DbAdapter,
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

  constructor(private readonly store: Store) {}

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
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
