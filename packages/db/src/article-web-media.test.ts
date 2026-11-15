import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveArticleMedia } from '@vibelingan-channel/articles/media';
import type { ArticleStore } from '@vibelingan-channel/articles/transaction-store';
import {
  articleWebMediaObjectInput,
  articleWebMediaSource,
  articleWebMediaSourceDigest,
} from '../../articles/src/web-media.ts';
import { objectStoragePath } from '../../media-storage/src/index.ts';
import { articleTransaction } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { readArticleWebMedia, registerArticleWebMedia } from './article-web-media.ts';

function original(id = 'image-one'): ActiveArticleMedia {
  const storagePath = `articles/2026/11/${id}/original.png`;
  return {
    id,
    articleId: 'article-one',
    status: 'active',
    purpose: 'article-image',
    fileName: 'Original.png',
    mimeType: 'image/png',
    byteSize: 200_000,
    checksumSha256: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdBy: 'admin',
    createdAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-17T00:00:00.000Z',
    pendingStorage: {
      storageFileId: 'cloud://fixture/articles/pending',
      storagePath: 'articles/pending',
    },
    storage: { storageFileId: `cloud://fixture/${storagePath}`, storagePath },
    width: 2000,
    height: 1000,
  };
}
function ready(image = original()) {
  const source = articleWebMediaSource(image);
  const checksumSha256 = 'c'.repeat(64);
  const path = objectStoragePath({
    ...articleWebMediaObjectInput(source, checksumSha256),
    now: new Date('2026-11-16T00:00:00.000Z'),
  });
  return {
    status: 'ready',
    policyVersion: 'article-web-v1',
    sourceDigest: articleWebMediaSourceDigest(source),
    source,
    web: {
      storageProvider: 'cloudbase-storage',
      storageFileId: `cloud://fixture/${path}`,
      storagePath: path,
      mimeType: 'image/webp',
      byteSize: 30_000,
      width: 1280,
      height: 640,
      checksumSha256,
    },
  };
}

test('actual SDK registers a ready mapping once and preserves original and published records', async (t) => {
  const f = articleSdkFixture(t);
  const image = original();
  const entry = ready(image);
  f.put('articleMedia', image.id, image);
  f.put('articleAccepted', image.articleId, {
    publication: { revision: 4, contentHash: 'unchanged' },
  });
  const before = structuredClone(f.rows);
  const tx = articleTransaction(f.db);
  assert.equal(await registerArticleWebMedia(tx, entry), 'registered');
  assert.equal(await registerArticleWebMedia(tx, entry), 'unchanged');
  for (const [key, value] of before) assert.deepEqual(f.rows.get(key), value);
  const value = await tx((store) => readArticleWebMedia(store, image.articleId));
  assert.deepEqual(value, {
    schemaVersion: 1,
    articleId: image.articleId,
    media: { [image.id]: entry },
  });
  const writes = f.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.params.collectionName, 'articleWebMedia');
});

test('actual SDK concurrent registrations merge distinct images instead of replacing the map', async (t) => {
  const f = articleSdkFixture(t);
  const images = [original('first'), original('second')];
  for (const image of images) f.put('articleMedia', image.id, image);
  const tx = articleTransaction(f.db);
  const results = await Promise.all(
    images.map((image) => registerArticleWebMedia(tx, ready(image))),
  );
  assert.deepEqual(results, ['registered', 'registered']);
  const value = await tx((store) => readArticleWebMedia(store, 'article-one'));
  assert.deepEqual(
    value?.media,
    Object.fromEntries(images.map((image) => [image.id, ready(image)])),
  );
  assert.ok(f.calls.filter((call) => call.api === 'database.startTransaction').length >= 3);
});

test('actual SDK retries re-read the original and refuse a replaced source', async (t) => {
  const f = articleSdkFixture(t);
  const image = original();
  f.put('articleMedia', image.id, image);
  f.control.beforeCommit = () => {
    f.control.beforeCommit = undefined;
    f.put('articleMedia', image.id, { ...image, checksumSha256: 'd'.repeat(64) });
  };
  await assert.rejects(registerArticleWebMedia(articleTransaction(f.db), ready(image)));
  assert.equal(f.rows.has('articleWebMedia/article-one'), false);
  assert.equal(f.rows.get(`articleMedia/${image.id}`)?.checksumSha256, 'd'.repeat(64));
});

test('registration rejects foreign ownership, different ready output and non-canonical storage paths', async (t) => {
  const f = articleSdkFixture(t);
  const image = original();
  const entry = ready(image);
  f.put('articleMedia', image.id, image);
  const tx = articleTransaction(f.db);
  await registerArticleWebMedia(tx, entry);
  const before = structuredClone(f.rows);
  const otherOutput = 'd'.repeat(64);
  const otherPath = objectStoragePath({
    ...articleWebMediaObjectInput(entry.source, otherOutput),
    now: new Date('2026-11-16T00:00:00.000Z'),
  });
  for (const changed of [
    { ...entry, source: { ...entry.source, articleId: 'other' } },
    {
      ...entry,
      web: {
        ...entry.web,
        storagePath: otherPath,
        storageFileId: `cloud://fixture/${otherPath}`,
        checksumSha256: otherOutput,
      },
    },
    {
      ...entry,
      web: {
        ...entry.web,
        storagePath: 'articles/2026/11/arbitrary/file.webp',
        storageFileId: 'cloud://fixture/articles/2026/11/arbitrary/file.webp',
      },
    },
  ])
    await assert.rejects(registerArticleWebMedia(tx, changed));
  assert.deepEqual(f.rows, before);
});

test('sidecar reads distinguish a missing record from malformed data or storage failures', async () => {
  let reads = 0;
  const store: Pick<ArticleStore, 'read'> = {
    read: async (collection, id) => {
      reads++;
      assert.equal(collection, 'articleWebMedia');
      assert.equal(id, 'article-one');
      return null;
    },
  };
  assert.equal(await readArticleWebMedia(store, 'article-one'), null);
  assert.equal(reads, 1);
  for (const value of [
    undefined,
    { _id: 'wrong' },
    { _id: 'article-one', schemaVersion: 2 },
    { _id: 'article-one', schemaVersion: 1, articleId: 'article-one', media: {}, extra: true },
  ]) {
    await assert.rejects(readArticleWebMedia({ read: async () => value }, 'article-one'));
  }
  const failure = Error('COLLECTION_NOT_EXISTS');
  await assert.rejects(
    readArticleWebMedia(
      {
        read: async () => {
          throw failure;
        },
      },
      'article-one',
    ),
    (error: unknown) => error === failure,
  );
});

test('the twenty-image cap and failed SDK writes never change existing mappings', async (t) => {
  const f = articleSdkFixture(t);
  const media = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => {
      const image = original(`image-${i}`);
      return [image.id, ready(image)];
    }),
  );
  f.put('articleWebMedia', 'article-one', { schemaVersion: 1, articleId: 'article-one', media });
  const image = original('twenty-first');
  f.put('articleMedia', image.id, image);
  const before = structuredClone(f.rows);
  await assert.rejects(registerArticleWebMedia(articleTransaction(f.db), ready(image)));
  assert.deepEqual(f.rows, before);
  for (const failure of ['zeroNextWrite', 'failNextCommit'] as const) {
    const g = articleSdkFixture(t);
    g.put('articleMedia', image.id, image);
    g.control[failure] = true;
    await assert.rejects(registerArticleWebMedia(articleTransaction(g.db), ready(image)));
    assert.equal(g.rows.has('articleWebMedia/article-one'), false);
  }
});

test('local-disk output uses the same canonical storage recipe and metadata-only edits do not replace it', async (t) => {
  const f = articleSdkFixture(t);
  const cloud = original();
  const image = {
    ...cloud,
    storage: { ...cloud.storage, storageFileId: `local-disk:${cloud.storage.storagePath}` },
  };
  f.put('articleMedia', image.id, image);
  const entry = ready(image);
  const local = {
    ...entry,
    web: {
      ...entry.web,
      storageProvider: 'local-disk',
      storageFileId: `local-disk:${entry.web.storagePath}`,
    },
  };
  const tx = articleTransaction(f.db);
  assert.equal(await registerArticleWebMedia(tx, local), 'registered');
  f.put('articleMedia', image.id, {
    ...image,
    fileName: 'Edited name.png',
    createdAt: image.expiresAt,
  });
  assert.equal(await registerArticleWebMedia(tx, local), 'unchanged');
  const writes = f.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.equal(writes.length, 1);
});

test('a legal inherited-property media ID can join an existing sidecar exactly once', async (t) => {
  const f = articleSdkFixture(t);
  const initial = original();
  const inheritedName = original('constructor');
  for (const image of [initial, inheritedName]) f.put('articleMedia', image.id, image);
  const tx = articleTransaction(f.db);
  await registerArticleWebMedia(tx, ready(initial));
  assert.equal(await registerArticleWebMedia(tx, ready(inheritedName)), 'registered');
  assert.equal(await registerArticleWebMedia(tx, ready(inheritedName)), 'unchanged');
  const sidecar = await tx((store) => readArticleWebMedia(store, initial.articleId));
  assert.deepEqual(sidecar?.media.constructor, ready(inheritedName));
  assert.deepEqual(sidecar?.media[initial.id], ready(initial));
});
