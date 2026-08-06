import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type {
  AdapterListQuery,
  DbAdapter,
  ImageMutationAcquireResult,
  ImageMutationReleaseResult,
} from '@vibelingan-channel/db';
import {
  setAdapter,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from '@vibelingan-channel/db';
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  objectStoragePath,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import {
  ALIBABA_IMAGE_IMPORT_OWNER,
  importCandidateImage,
  isBlockedAddress,
  removeImportedCandidate,
} from './media-import.ts';

// --- harness -----------------------------------------------------------------

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private nextId = 1;
  constructor(readonly store: Store) {}
  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    // Just enough for the reference scan: `_id > cursor` walk, `_id` asc.
    let items = [...this.docs(query.collection)];
    for (const clause of query.filter?.clauses ?? []) {
      if (clause.op === 'gt') {
        items = items.filter((doc) => String(doc[clause.field]) > String(clause.value));
      } else if (clause.op === 'eq') {
        items = items.filter((doc) => doc[clause.field] === clause.value);
      }
    }
    items.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    const page = items.slice(0, query.pageSize);
    return { items: page, total: items.length, page: 1, pageSize: query.pageSize };
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d._id === id) ?? null;
  }
  async findByField(
    collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d[field] === value) ?? null;
  }
  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    if (this.store.__failCreate) throw new Error('simulated doc failure');
    const doc = { _id: `img-${this.nextId++}`, ...data } as CollectionDoc;
    this.docs(collection).push(doc);
    return doc;
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return false;
    docs.splice(index, 1);
    return true;
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
  async acquireImageMutation(
    imageId: string,
    owner: string,
    startedAt: string,
  ): Promise<ImageMutationAcquireResult> {
    const docs = this.docs('images');
    const index = docs.findIndex((doc) => doc._id === imageId);
    if (index < 0) return 'missing';
    const existing = docs[index] as CollectionDoc;
    const transition = transitionImageMutationAcquire(existing, owner, startedAt);
    if (transition.result !== 'acquired') return transition.result;
    docs[index] = { ...existing, ...transition.patch };
    return 'acquired';
  }
  async releaseImageMutation(imageId: string, owner: string): Promise<ImageMutationReleaseResult> {
    const docs = this.docs('images');
    const index = docs.findIndex((doc) => doc._id === imageId);
    if (index < 0) return 'missing';
    const existing = docs[index] as CollectionDoc;
    const transition = transitionImageMutationRelease(existing, owner);
    if (transition.result !== 'released') return transition.result;
    docs[index] = { ...existing, ...transition.patch };
    return 'released';
  }
}

class MemoryMediaStorage implements MediaStorageAdapter {
  readonly puts: PutMediaObjectInput[] = [];
  readonly deletes: string[] = [];
  async putObject(input: PutMediaObjectInput) {
    this.puts.push(input);
    const storagePath = objectStoragePath(input);
    return {
      storageProvider: 'local-disk' as const,
      storageMode: 'local-disk' as const,
      storageFileId: `mem://${storagePath}`,
      storagePath,
    };
  }
  async getObjectAsBase64(): Promise<{ body: string }> {
    throw new Error('not used');
  }
  async getTempUrl(): Promise<{ url: string }> {
    throw new Error('not used');
  }
  async deleteObject(fileId: string): Promise<void> {
    this.deletes.push(fileId);
  }
  async getUploadCredential(): Promise<never> {
    throw new Error('not used');
  }
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

let store: Store = {};
let storage = new MemoryMediaStorage();
function setup(): void {
  store = {};
  storage = new MemoryMediaStorage();
  setAdapter(new MemoryAdapter(store));
  setMediaStorage(storage);
}

const PUBLIC_DNS = async () => ['104.16.1.1'];

function fakeImageFetch(
  bytes: Buffer = PNG_BYTES,
  routes: Record<string, { status: number; location?: string }> = {},
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const key = String(url);
    urls.push(key);
    const route = routes[key];
    if (route) {
      return new Response(null, {
        status: route.status,
        headers: route.location ? { location: route.location } : {},
      });
    }
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

// --- address blocking --------------------------------------------------------

test('blocked address matrix: loopback/private/link-local/CGN/multicast/v6/mapped', () => {
  for (const blocked of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
  ]) {
    assert.equal(isBlockedAddress(blocked), true, blocked);
  }
  for (const allowed of ['104.16.1.1', '8.8.8.8', '2606:4700::6810:101', '172.32.0.1']) {
    assert.equal(isBlockedAddress(allowed), false, allowed);
  }
});

// --- URL + DNS gating --------------------------------------------------------

test('rejects non-HTTPS, disallowed hosts, userinfo, and odd ports before any fetch', async () => {
  setup();
  const { fetchImpl, urls } = fakeImageFetch();
  const deps = { fetchImpl, resolveDns: PUBLIC_DNS };
  assert.deepEqual(await importCandidateImage('http://sc04.alicdn.com/a.png', deps), {
    ok: false,
    reason: 'invalid-url',
  });
  assert.deepEqual(await importCandidateImage('https://evil.example.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assert.deepEqual(await importCandidateImage('https://evilalibaba.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assert.deepEqual(await importCandidateImage('https://user:pw@sc04.alicdn.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assert.deepEqual(await importCandidateImage('https://sc04.alicdn.com:8443/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assert.equal(urls.length, 0, 'nothing was fetched');
});

test('DNS resolving to a private address blocks the fetch (rebinding defense)', async () => {
  setup();
  const { fetchImpl, urls } = fakeImageFetch();
  const result = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: async () => ['104.16.1.1', '10.0.0.7'],
  });
  assert.deepEqual(result, { ok: false, reason: 'dns-blocked' });
  assert.equal(urls.length, 0);
});

// --- redirects ---------------------------------------------------------------

test('redirects are validated hop-by-hop; off-allowlist targets are blocked', async () => {
  setup();
  const start = 'https://sc04.alicdn.com/a.png';
  const { fetchImpl } = fakeImageFetch(PNG_BYTES, {
    [start]: { status: 302, location: 'https://internal.example.com/a.png' },
  });
  const result = await importCandidateImage(start, { fetchImpl, resolveDns: PUBLIC_DNS });
  assert.deepEqual(result, { ok: false, reason: 'host-not-allowed' });
});

test('an allowlisted redirect chain is followed; endless chains stop', async () => {
  setup();
  const a = 'https://sc04.alicdn.com/a.png';
  const b = 'https://sc05.alicdn.com/b.png';
  const { fetchImpl, urls } = fakeImageFetch(PNG_BYTES, {
    [a]: { status: 302, location: b },
  });
  const result = await importCandidateImage(a, { fetchImpl, resolveDns: PUBLIC_DNS });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(urls, [a, b], 'both hops fetched, each after validation');

  const loop = 'https://sc04.alicdn.com/loop.png';
  const { fetchImpl: loopFetch } = fakeImageFetch(PNG_BYTES, {
    [loop]: { status: 302, location: loop },
  });
  const looped = await importCandidateImage(loop, { fetchImpl: loopFetch, resolveDns: PUBLIC_DNS });
  assert.deepEqual(looped, { ok: false, reason: 'too-many-redirects' });
});

// --- content verification ----------------------------------------------------

test('non-image bytes are rejected regardless of headers; oversize bodies are capped', async () => {
  setup();
  const html = Buffer.from('<html>not an image</html>');
  const { fetchImpl } = fakeImageFetch(html);
  assert.deepEqual(
    await importCandidateImage('https://sc04.alicdn.com/x.png', {
      fetchImpl,
      resolveDns: PUBLIC_DNS,
    }),
    { ok: false, reason: 'bad-content' },
  );

  const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024, 1)]);
  const { fetchImpl: hugeFetch } = fakeImageFetch(huge);
  assert.deepEqual(
    await importCandidateImage('https://sc04.alicdn.com/big.png', {
      fetchImpl: hugeFetch,
      resolveDns: PUBLIC_DNS,
    }),
    { ok: false, reason: 'too-large' },
  );
});

// --- lifecycle ---------------------------------------------------------------

test('a verified import lands as an ACTIVE, unreferenced, sentinel-owned candidate', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const result = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
    now: () => '2026-08-06T13:00:00.000Z',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deduplicated, false);
  const image = store.images?.[0] as CollectionDoc;
  assert.equal(image.status, 'active', 'pending would be orphan-swept (R1 M12)');
  assert.equal(image.publishedRefCount, 0, 'public-invisible via refcount gate');
  assert.equal(image.uploadedByUserId, ALIBABA_IMAGE_IMPORT_OWNER);
  assert.equal(image.mimeType, 'image/png', 'MIME derived from magic bytes');
  assert.equal(image.purpose, 'catalog-image');
  assert.equal(image.checksumSha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
  assert.equal(storage.puts[0]?.namespace, 'catalog');
});

test('identical bytes deduplicate by checksum (one object, one row)', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const deps = { fetchImpl, resolveDns: PUBLIC_DNS };
  const first = await importCandidateImage('https://sc04.alicdn.com/a.png', deps);
  const second = await importCandidateImage('https://sc05.alicdn.com/other-name.png', deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.deduplicated, true);
  assert.equal(second.imageId, first.imageId);
  assert.equal(store.images?.length, 1);
  assert.equal(storage.puts.length, 1);
});

test('a doc-write failure compensates by deleting the stored object first', async () => {
  setup();
  store.__failCreate = [] as unknown as CollectionDoc[];
  const { fetchImpl } = fakeImageFetch();
  const result = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.deepEqual(result, { ok: false, reason: 'write-failed' });
  assert.equal(storage.deletes.length, 1, 'object compensated');
  assert.equal(store.images?.length ?? 0, 0);
});

// --- removal action ----------------------------------------------------------

test('removal deletes only unreferenced sentinel-owned candidates (object first)', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  // A referenced candidate refuses removal.
  const images = store.images as CollectionDoc[];
  images[0] = { ...(images[0] as CollectionDoc), publishedRefCount: 2 };
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'still-referenced',
  });

  images[0] = { ...(images[0] as CollectionDoc), publishedRefCount: 0 };
  const removed = await removeImportedCandidate(imported.imageId);
  assert.deepEqual(removed, { ok: true, imageId: imported.imageId });
  assert.equal(store.images?.length, 0);
  assert.equal(storage.deletes.length, 1);

  // Operator uploads (non-sentinel owner) are untouchable through this path.
  store.images = [
    { _id: 'user-img', uploadedByUserId: 'admin-1', publishedRefCount: 0 } as CollectionDoc,
  ];
  assert.deepEqual(await removeImportedCandidate('user-img'), {
    ok: false,
    reason: 'not-imported',
  });
});

test('removal is blocked by an UNPUBLISHED document reference (refCount 0)', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  // An unpublished product holds the image: publishedRefCount stays 0 (only
  // published refs count), but removal would dangle the draft's imageIds.
  store.products = [
    { _id: 'p-draft', published: false, imageIds: [imported.imageId] } as CollectionDoc,
  ];
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'still-referenced',
  });
  assert.equal(store.images?.length, 1, 'doc survives');
  assert.equal(storage.deletes.length, 0, 'object survives');

  store.products = [];
  const removed = await removeImportedCandidate(imported.imageId);
  assert.equal(removed.ok, true);
});

test('a storage delete failure is TERMINAL: the doc survives and a retry succeeds', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  const originalDelete = storage.deleteObject.bind(storage);
  let failNext = true;
  storage.deleteObject = async (fileId: string) => {
    if (failNext) {
      failNext = false;
      throw new Error('simulated storage outage');
    }
    return originalDelete(fileId);
  };

  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'delete-failed',
  });
  assert.equal(store.images?.length, 1, 'doc NEVER removed before the object');

  // The mutation lock was released on failure — the retry can acquire it.
  const retried = await removeImportedCandidate(imported.imageId);
  assert.deepEqual(retried, { ok: true, imageId: imported.imageId });
  assert.equal(store.images?.length, 0);
});

test('a held mutation lock refuses removal as busy', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  const adapter = new MemoryAdapter(store);
  const held = await adapter.acquireImageMutation(
    imported.imageId,
    'other-owner',
    new Date().toISOString(),
  );
  assert.equal(held, 'acquired');
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'busy',
  });
});
