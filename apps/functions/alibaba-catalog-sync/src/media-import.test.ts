import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { type SourceMediaImportCommand, runSourceMediaImport } from '@vibelingan-channel/db';
import { type ImageDeletionCommand, runImageDeletion } from '@vibelingan-channel/db';
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
  type PutMediaObjectOptions,
  objectStoragePath,
  setMediaStorage,
} from '@vibelingan-channel/media-storage';
import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from '../../../../packages/db/src/catalog-image-references.ts';
import {
  ALIBABA_IMAGE_IMPORT_OWNER,
  type MediaImportFailure,
  type MediaImportResult,
  importCandidateImage,
  isBlockedAddress,
  removeImportedCandidate,
} from './media-import.ts';

/** These assertions check the rejection reason; persistence metadata is internal. */
function assertImportFailure(
  actual: MediaImportResult,
  expected: { ok: false; reason: MediaImportFailure },
) {
  assert.equal(actual.ok, expected.ok);
  if (!actual.ok) assert.equal(actual.reason, expected.reason);
}

// --- harness -----------------------------------------------------------------

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private sourceMediaQueue: Promise<void> = Promise.resolve();
  async manageSourceMediaImport(command: SourceMediaImportCommand) {
    const operation = this.sourceMediaQueue.then(async () => {
      if (command.action === 'claim' && this.store.__failCreate)
        throw new Error('simulated reservation failure');
      const copy = structuredClone(this.store);
      const result = await runSourceMediaImport(
        {
          get: async (collection, id) =>
            structuredClone(copy[collection]?.find((row) => row._id === id) ?? null),
          set: async (collection, row) => {
            copy[collection] ??= [];
            const rows = copy[collection];
            const index = rows.findIndex((existing) => existing._id === row._id);
            if (index < 0) rows.push(structuredClone(row));
            else rows[index] = structuredClone(row);
          },
          remove: async (collection, id) => {
            const rows = copy[collection];
            const index = rows?.findIndex((row) => row._id === id) ?? -1;
            if (!rows || index < 0) throw new Error('Unconfirmed pending image removal');
            rows.splice(index, 1);
          },
        },
        command,
      );
      for (const key of Object.keys(this.store)) delete this.store[key];
      Object.assign(this.store, copy);
      return result;
    });
    this.sourceMediaQueue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

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
  async upsertDocWithId(collection: string, id: string, data: Record<string, unknown>) {
    const row = { ...data, _id: id };
    const rows = this.docs(collection);
    const index = rows.findIndex((item) => item._id === id);
    if (index < 0) rows.push(row);
    else rows[index] = row;
    return row;
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
  async manageImageDeletion(command: ImageDeletionCommand) {
    return runImageDeletion(
      {
        get: (collection, id) => this.get(collection, id),
        set: async (collection, row) => {
          await this.upsertDocWithId(collection, row._id, row);
        },
        remove: async (collection, id) => {
          if (!(await this.remove(collection, id))) throw new Error('Unconfirmed image removal');
        },
      },
      command,
    );
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
  async putObject(input: PutMediaObjectInput, options: PutMediaObjectOptions = {}) {
    const storagePath = objectStoragePath(input);
    const target = {
      storageProvider: 'local-disk' as const,
      storageMode: 'local-disk' as const,
      storageFileId: `mem://${storagePath}`,
      storagePath,
    };
    await options.beforeWrite?.(target);
    this.puts.push(input);
    return target;
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

test('each source URL retains its owned image binding, including byte-deduplicated URLs', async () => {
  setup();
  let firstImageId: string | undefined;
  for (const sourceUrl of ['https://img.alicdn.com/one.png', 'https://img.alicdn.com/two.png']) {
    const result = await importCandidateImage(sourceUrl, {
      ...fakeImageFetch(),
      resolveDns: PUBLIC_DNS,
    });
    assert.equal(result.ok, true);
    const link = store.catalogSourceLinks?.find((row) => row.sourceUrl === sourceUrl);
    assert.ok(result.ok);
    firstImageId ??= result.imageId;
    assert.equal(link?.imageId, firstImageId);
    assert.equal(link?.provider, 'alibaba');
  }
  assert.equal(storage.puts.length, 1);
});

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
  assertImportFailure(await importCandidateImage('http://sc04.alicdn.com/a.png', deps), {
    ok: false,
    reason: 'invalid-url',
  });
  assertImportFailure(await importCandidateImage('https://evil.example.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assertImportFailure(await importCandidateImage('https://evilalibaba.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assertImportFailure(await importCandidateImage('https://user:pw@sc04.alicdn.com/a.png', deps), {
    ok: false,
    reason: 'host-not-allowed',
  });
  assertImportFailure(await importCandidateImage('https://sc04.alicdn.com:8443/a.png', deps), {
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
  assertImportFailure(result, { ok: false, reason: 'dns-blocked' });
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
  assertImportFailure(result, { ok: false, reason: 'host-not-allowed' });
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
  assertImportFailure(looped, { ok: false, reason: 'too-many-redirects' });
});

// --- content verification ----------------------------------------------------

test('non-image bytes are rejected regardless of headers; oversize bodies are capped', async () => {
  setup();
  const html = Buffer.from('<html>not an image</html>');
  const { fetchImpl } = fakeImageFetch(html);
  assertImportFailure(
    await importCandidateImage('https://sc04.alicdn.com/x.png', {
      fetchImpl,
      resolveDns: PUBLIC_DNS,
    }),
    { ok: false, reason: 'bad-content' },
  );

  const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024, 1)]);
  const { fetchImpl: hugeFetch } = fakeImageFetch(huge);
  assertImportFailure(
    await importCandidateImage('https://sc04.alicdn.com/big.png', {
      fetchImpl: hugeFetch,
      resolveDns: PUBLIC_DNS,
    }),
    { ok: false, reason: 'too-large' },
  );
});

test('a download that stalls after its headers gives up instead of hanging (PT-G)', async () => {
  setup();
  const stalled: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(PNG_BYTES.subarray(0, 8));
          // Never closes: the rest of the photo never arrives.
        },
      }),
      { status: 200 },
    );
  const started = Date.now();
  assertImportFailure(
    await importCandidateImage('https://sc04.alicdn.com/slow.png', {
      fetchImpl: stalled,
      resolveDns: PUBLIC_DNS,
      bodyTimeoutMs: 50,
    }),
    { ok: false, reason: 'fetch-failed' },
  );
  assert.ok(Date.now() - started < 2_000);
});

test('a photo gone at Alibaba is reported as not found, a server error as a passing failure', async () => {
  setup();
  for (const [status, reason] of [
    [403, 'not-found'],
    [404, 'not-found'],
    [410, 'not-found'],
    [429, 'fetch-failed'],
    [503, 'fetch-failed'],
  ] as const) {
    assertImportFailure(
      await importCandidateImage('https://sc04.alicdn.com/gone.png', {
        fetchImpl: async () => new Response('', { status }),
        resolveDns: PUBLIC_DNS,
      }),
      { ok: false, reason },
    );
  }
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
  assert.equal(image.status, 'active', 'only a confirmed copy is active');
  assert.equal(image.publishedRefCount, 0, 'public-invisible via refcount gate');
  assert.equal(image.uploadedByUserId, ALIBABA_IMAGE_IMPORT_OWNER);
  assert.equal(image.mimeType, 'image/png', 'MIME derived from magic bytes');
  assert.equal(image.purpose, 'catalog-image');
  assert.equal(image.checksumSha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
  assert.equal(storage.puts[0]?.namespace, 'catalog');
});

test('an animated GIF from Alibaba is copied as a GIF (owner 2026-10-09)', async () => {
  setup();
  const gif = Buffer.from('GIF89a\x16\x03\x3a\x05\xf7\x00\x00', 'latin1');
  const { fetchImpl } = fakeImageFetch(gif);
  const result = await importCandidateImage('https://sc04.alicdn.com/kf/H7ca8.jpg', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(result.ok, true, 'named .jpg, but the bytes decide');
  const image = store.images?.[0] as CollectionDoc;
  assert.equal(image.mimeType, 'image/gif');
  assert.match(String(image.name), /\.gif$/);
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

test('an unconfirmed pending reservation writes no bytes and needs no compensation', async () => {
  setup();
  store.__failCreate = [];
  const { fetchImpl } = fakeImageFetch();
  const result = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assertImportFailure(result, { ok: false, reason: 'write-failed' });
  assert.equal(storage.puts.length, 0, 'reservation must precede every byte');
  assert.equal(storage.deletes.length, 0);
  assert.equal(store.images?.length ?? 0, 0);
});

// --- removal action ----------------------------------------------------------

test('a photo whose approval finishes between the removal checks is kept (DEC-21)', async () => {
  setup();
  const { fetchImpl } = fakeImageFetch();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    fetchImpl,
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const images = store.images as CollectionDoc[];
  images[0] = { ...(images[0] as CollectionDoc), publishedRefCount: 0 };
  const publication = {
    state: 'approved',
    header: { _id: 'p-1', images: [`/api/images/${imported.imageId}`] },
  };
  store.products = [{ _id: 'p-1', published: false }];
  store.catalogDetailApprovals = [
    {
      _id: 'job-1',
      productId: 'p-1',
      state: 'staging',
      createdAt: new Date().toISOString(),
      publication,
    } as CollectionDoc,
  ];
  // The approval commits (product and job in one transaction) right after the
  // removal has read the products: whichever check comes second must see it.
  const shared = store;
  let committed = false;
  class CommitDuringScan extends MemoryAdapter {
    override async list(query: AdapterListQuery) {
      const page = await super.list(query);
      if (query.collection === 'products' && !committed) {
        committed = true;
        shared.products = [{ _id: 'p-1', published: false, catalogDetailPublication: publication }];
        shared.catalogDetailApprovals = [
          {
            _id: 'job-1',
            productId: 'p-1',
            state: 'complete',
            createdAt: new Date().toISOString(),
            publication,
          } as CollectionDoc,
        ];
      }
      return page;
    }
  }
  setAdapter(new CommitDuringScan(store));
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'still-referenced',
  });
  assert.equal(store.images?.length, 1);
  assert.equal(storage.deletes.length, 0);
});

test('removal deletes only unreferenced sentinel-owned candidates', async () => {
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
  // An unfinished approval that would publish it still uses it (DEC-21).
  store.catalogDetailApprovals = [
    {
      _id: 'job-1',
      productId: 'p-1',
      state: 'staging',
      createdAt: new Date().toISOString(),
      publication: {
        state: 'approved',
        header: { _id: 'p-1', images: [`/api/images/${imported.imageId}`] },
      },
    } as CollectionDoc,
  ];
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'still-referenced',
  });
  store.catalogDetailApprovals = [];
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

test('a storage delete failure retains quarantined metadata and a retry succeeds', async () => {
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

  // Retry resumes the durable terminal intent without waiting for a lock timeout.
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

test('removal quarantines the image before deleting its first byte', async () => {
  setup();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    ...fakeImageFetch(),
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const originalDelete = storage.deleteObject.bind(storage);
  storage.deleteObject = async (fileId) => {
    assert.equal(store.images?.find((row) => row._id === imported.imageId)?.status, 'deleted');
    return originalDelete(fileId);
  };
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: true,
    imageId: imported.imageId,
  });
});

test('an unconfirmed row removal retains a quarantined retry target', async () => {
  setup();
  const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
    ...fakeImageFetch(),
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  class UnconfirmedRemoval extends MemoryAdapter {
    failNext = true;
    override async remove(collection: string, id: string) {
      if (collection === 'images' && this.failNext) {
        this.failNext = false;
        return false;
      }
      return super.remove(collection, id);
    }
  }
  setAdapter(new UnconfirmedRemoval(store));
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: false,
    reason: 'delete-failed',
  });
  assert.equal(store.images?.find((row) => row._id === imported.imageId)?.status, 'deleted');
  assert.deepEqual(await removeImportedCandidate(imported.imageId), {
    ok: true,
    imageId: imported.imageId,
  });
  assert.equal(store.images?.length, 0);
});

test('injected source persistence owns every import phase and retries the exact unknown ACK command', async () => {
  setup();
  const adapter = new MemoryAdapter(store);
  setAdapter(adapter);
  const persist = adapter.manageSourceMediaImport.bind(adapter);
  adapter.manageSourceMediaImport = async () => {
    throw Error('unscoped source persistence forbidden');
  };
  const commands: SourceMediaImportCommand[] = [];
  let lost = false;
  const result = await importCandidateImage('https://sc04.alicdn.com/scoped.png', {
    resolveDns: PUBLIC_DNS,
    fetchImpl: async () => new Response(new Uint8Array(PNG_BYTES)),
    persistImport: async (command) => {
      commands.push(structuredClone(command));
      const reply = await persist(command);
      if (!lost) {
        lost = true;
        throw Error('committed claim ACK lost');
      }
      return reply;
    },
  });
  assert.ok(result.ok);
  assert.deepEqual(
    commands.map((c) => c.action),
    ['claim', 'claim', 'checkpoint', 'activate'],
  );
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(storage.puts.length, 1);
});

for (const kind of ['addition', 'removal', 'missing', 'cancel'] as const)
  test(`imported candidate cleanup respects complete reference state ${kind}`, async () => {
    setup();
    const { fetchImpl } = fakeImageFetch();
    const imported = await importCandidateImage('https://sc04.alicdn.com/a.png', {
      fetchImpl,
      resolveDns: PUBLIC_DNS,
    });
    assert.ok(imported.ok);
    const image = store.images?.find((row) => row._id === imported.imageId);
    assert.ok(image);
    const removing = kind === 'removal';
    const plan = buildCatalogImageReferencePlan(
      '1'.repeat(64),
      removing ? [imported.imageId] : [],
      removing ? [] : [imported.imageId],
    );
    image.publishedRefCount = removing ? 1 : 0;
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [catalogImageReferenceEntry(plan, 0)],
    };
    store.catalogDetailApprovals =
      kind === 'missing'
        ? []
        : [kind === 'cancel' ? catalogImageReferenceCancelProof(plan.proof) : plan.proof];
    const result = await removeImportedCandidate(imported.imageId);
    if (kind === 'removal' || kind === 'cancel') {
      assert.deepEqual(result, { ok: true, imageId: imported.imageId });
      assert.equal(store.images?.length, 0);
      assert.equal(storage.deletes.length, 1);
      assert.ok(store.catalogDetailApprovals.some((row) => row._id === plan.proof._id));
    } else {
      assert.deepEqual(result, { ok: false, reason: 'still-referenced' });
      assert.equal(store.images?.length, 1);
      assert.equal(storage.deletes.length, 0);
    }
  });
