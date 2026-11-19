import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseArticleContent } from '@vibelingan-channel/articles';
import {
  articleMobileMediaPath,
  articleWebMediaObjectInput,
  articleWebMediaSource,
  articleWebMediaSourceDigest,
} from '@vibelingan-channel/articles/web-media';
import { createCloudBasePublicArticles } from './article-public-reader.ts';
import { articleTransaction, createCloudBaseArticleRepository } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { registerArticleResponsiveMedia } from './article-web-media.ts';

const content = parseArticleContent({
  title: 'Public guide',
  slug: 'public-guide',
  authorName: 'Sean',
  excerpt: 'Guide summary',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public body' }] }],
    },
  },
});
const storage = {
  getObjectAsBase64: async () => {
    throw Error('unexpected storage read');
  },
};
test('real SDK writes and reads the publication without exposing private drafts', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  const draft = await repo.create({ actorId: 'admin', requestId: 'new', content });
  assert.equal(await reader.get('public-guide'), null);
  assert.deepEqual(await reader.list(), { articles: [], next: null });
  const published = await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  assert.equal(published.state, 'SUCCEEDED');
  const article = await reader.get('public-guide');
  assert.equal(article?.content.title, content.title);
  const list = await reader.list();
  assert.equal(list.articles.length, 1);
  assert.equal(list.articles[0]?.articleId, draft.id);
  assert(!JSON.stringify(list).includes('Public body'));
  assert(!JSON.stringify(article).includes('createdBy'));
  await repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: 1,
    content: { ...content, title: 'Private work in progress' },
  });
  assert.equal((await reader.get('public-guide'))?.content.title, content.title);
  await repo.releases.request('admin', {
    operation: 'withdraw',
    articleId: draft.id,
    expectedRevision: 2,
    requestId: 'withdraw',
  });
  assert.equal(await reader.get('public-guide'), null);
  assert.equal((await reader.list()).articles.length, 0);
});

test('a text-only article is rendered without reading image registrations and disappears on withdrawal', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  const draft = await repo.create({ actorId: 'admin', requestId: 'render-one', content });
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'render-publish',
  });
  const old = await reader.get(content.slug);
  const before = f.calls.length;
  assert.deepEqual(await reader.getRender(content.slug), {
    schemaVersion: 1,
    article: old,
    presentation: { media: {} },
  });
  const reads = f.calls.slice(before).filter((c) => c.api === 'database.getDocument');
  assert.deepEqual(
    reads.map((c) => c.params.collectionName),
    ['articleSlugs', 'articleAccepted'],
  );
  await repo.releases.request('admin', {
    operation: 'withdraw',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'render-withdraw',
  });
  assert.equal(await reader.getRender(content.slug), null);
});

test('real SDK pagination returns twelve bounded summaries without documents or duplicates', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  for (let i = 0; i < 14; i++) {
    const draft = await repo.create({
      actorId: 'admin',
      requestId: `draft-${i}`,
      content: { ...content, slug: `public-guide-${i}` },
    });
    await repo.releases.request('admin', {
      operation: 'publish',
      articleId: draft.id,
      expectedRevision: 1,
      requestId: `publish-${i}`,
    });
  }
  const first = await reader.list();
  assert.equal(first.articles.length, 12);
  assert(first.next);
  const second = await reader.list(first.next);
  assert.equal(second.articles.length, 2);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.articles, ...second.articles].map((a) => a.articleId)).size, 14);
  const calls = f.calls.filter((c) => c.api === 'database.getDocument' && c.params.projection);
  assert(calls.length >= 2);
  for (const call of calls) assert(!String(call.params.projection).includes('body'));
});

test('commit errors and malformed records cannot masquerade as a successful publish or empty list', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const reader = createCloudBasePublicArticles(f.db, storage);
  const draft = await repo.create({ actorId: 'admin', requestId: 'new', content });
  f.control.failNextCommit = true;
  await assert.rejects(
    repo.releases.request('admin', {
      operation: 'publish',
      articleId: draft.id,
      expectedRevision: 1,
      requestId: 'publish',
    }),
  );
  assert.equal(await reader.get('public-guide'), null);
  f.control.returnedReadError = true;
  await assert.rejects(reader.list());
});

test('public images require an accepted reference and are checked again after downloading', async (t) => {
  const f = articleSdkFixture(t);
  const bytes = Buffer.from('verified bytes');
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const draft = await repo.create({
    actorId: 'admin',
    requestId: 'image-draft',
    content: parseArticleContent({
      ...content,
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Image guide' }] },
            { type: 'articleImage', attrs: { mediaId: 'image-one', alt: 'Factory', caption: '' } },
          ],
        },
      },
    }),
  });
  const target = { storageFileId: 'cloud://private/image-one', storagePath: 'articles/image-one' };
  f.put('articleMedia', 'image-one', {
    id: 'image-one',
    articleId: draft.id,
    purpose: 'article-image',
    requestHash: 'a'.repeat(64),
    createdBy: 'admin',
    createdAt: draft.createdAt,
    expiresAt: new Date(Date.now() + 100000).toISOString(),
    pendingStorage: target,
    storage: target,
    status: 'active',
    fileName: 'photo.png',
    mimeType: 'image/png',
    byteSize: bytes.length,
    checksumSha256,
    width: 2,
    height: 2,
  });
  let withdraw = false;
  let reads = 0;
  const reader = createCloudBasePublicArticles(f.db, {
    getObjectAsBase64: async () => {
      reads++;
      if (withdraw)
        await repo.releases.request('admin', {
          operation: 'withdraw',
          articleId: draft.id,
          expectedRevision: 1,
          requestId: 'withdraw',
        });
      return { body: bytes.toString('base64') };
    },
  });
  const file = `${checksumSha256}.png`;
  assert.equal(await reader.media('image-one', file), null);
  assert.equal(reads, 0);
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  assert.deepEqual(await reader.media('image-one', file), {
    body: bytes.toString('base64'),
    mimeType: 'image/png',
  });
  withdraw = true;
  assert.equal(await reader.media('image-one', file), null);
  assert.equal(reads, 2);
});

async function webFixture(
  t: Parameters<typeof articleSdkFixture>[0],
  sameWebpBytes = false,
  mediaId = 'web-image-one',
  large = false,
) {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const bytes = Buffer.from('original article pixels');
  const webBytes = sameWebpBytes ? bytes : Buffer.from('prepared web pixels');
  const mobileBytes = Buffer.from('small');
  const width = large ? 1280 : 64;
  const height = width / 2;
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const draft = await repo.create({
    actorId: 'admin',
    requestId: 'web-image-draft',
    content: parseArticleContent({
      ...content,
      slug: 'web-image-guide',
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [
            {
              type: 'articleImage',
              attrs: {
                mediaId,
                alt: 'Original human alt',
                caption: 'Original human caption',
              },
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Accepted text remains unchanged.' }],
            },
          ],
        },
      },
    }),
  });
  const originalStorage = {
    storageFileId: 'cloud://private/articles/2026/11/original/photo.png',
    storagePath: 'articles/2026/11/original/photo.png',
  };
  const image = {
    id: mediaId,
    articleId: draft.id,
    purpose: 'article-image' as const,
    requestHash: 'a'.repeat(64),
    createdBy: 'admin',
    createdAt: draft.createdAt,
    expiresAt: new Date(Date.now() + 100_000).toISOString(),
    pendingStorage: originalStorage,
    storage: originalStorage,
    status: 'active' as const,
    fileName: 'photo.png',
    mimeType: sameWebpBytes ? ('image/webp' as const) : ('image/png' as const),
    byteSize: bytes.length,
    checksumSha256: digest(bytes),
    width,
    height,
  };
  f.put('articleMedia', image.id, image);
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'web-image-publish',
  });
  const source = articleWebMediaSource(image);
  const input = articleWebMediaObjectInput(source, digest(webBytes));
  const webPath = `articles/2026/11/${input.logicalId}/${input.fileName}`;
  const ready = {
    status: 'ready' as const,
    policyVersion: 'article-web-v1' as const,
    sourceDigest: articleWebMediaSourceDigest(source),
    source,
    web: {
      storageProvider: 'cloudbase-storage' as const,
      storageFileId: `cloud://private/${webPath}`,
      storagePath: webPath,
      mimeType: 'image/webp' as const,
      byteSize: webBytes.length,
      width,
      height,
      checksumSha256: digest(webBytes),
    },
  };
  const sidecar = { schemaVersion: 1, articleId: draft.id, media: { [image.id]: ready } };
  f.put('articleWebMedia', draft.id, sidecar);
  const mobileInput = articleWebMediaObjectInput(source, digest(mobileBytes));
  const mobilePath = `articles/2026/11/${mobileInput.logicalId}/${mobileInput.fileName}`;
  const compact = {
    ...ready,
    web: {
      ...ready.web,
      storageFileId: `cloud://private/${mobilePath}`,
      storagePath: mobilePath,
      width: 768,
      height: 384,
      byteSize: mobileBytes.length,
      checksumSha256: digest(mobileBytes),
    },
  };
  const reads: string[] = [];
  let duringRead = async () => {};
  let corrupt = false;
  const reader = createCloudBasePublicArticles(f.db, {
    getObjectAsBase64: async (fileId, options) => {
      reads.push(fileId);
      const selected =
        fileId === originalStorage.storageFileId
          ? bytes
          : fileId === compact.web.storageFileId
            ? mobileBytes
            : webBytes;
      assert.equal(options.maxBytes, selected.length);
      await duringRead();
      return {
        body: (corrupt ? Buffer.from('wrong') : selected).toString('base64'),
        ...(options.measure ? { timings: { lookupMs: 11, downloadMs: 19 } } : {}),
      };
    },
  });
  return {
    f,
    repo,
    draft,
    image,
    sidecar,
    ready,
    reader,
    reads,
    bytes,
    webBytes,
    mobileBytes,
    compact,
    file: `web-v1-${ready.web.checksumSha256}.webp`,
    setDuringRead(value: () => Promise<void>) {
      duringRead = value;
    },
    corrupt() {
      corrupt = true;
    },
  };
}

test('render view has one sidecar read, no original-record scan or bytes, and no private storage fields', async (t) => {
  const x = await webFixture(t);
  const before = x.f.calls.length;
  let timingReported = false;
  const result = await x.reader.getRender('web-image-guide', (timings) => {
    assert(timings.slugMs >= 0 && timings.publicationMs >= 0);
    assert(timings.webMediaMs !== undefined && timings.webMediaMs >= 0);
    assert(timings.publicationReadMs !== undefined && timings.publicationReadMs >= 0);
    assert(timings.publicationValidationMs !== undefined && timings.publicationValidationMs >= 0);
    assert(timings.publicationMs >= timings.publicationReadMs + timings.publicationValidationMs);
    assert(timings.totalMs >= timings.slugMs + timings.publicationMs + timings.webMediaMs);
    timingReported = true;
  });
  assert(timingReported);
  assert.equal(
    result?.presentation.media[x.image.id]?.url,
    `/media/articles/${x.image.id}/${x.file}`,
  );
  assert.equal(result?.article.content.body.document.content[0]?.type, 'articleImage');
  assert.deepEqual(result?.article, await x.reader.get('web-image-guide'));
  const reads = x.f.calls.slice(before).filter((c) => c.api === 'database.getDocument');
  assert.equal(reads.filter((c) => c.params.collectionName === 'articleWebMedia').length, 1);
  assert.equal(reads.filter((c) => c.params.collectionName === 'articleMedia').length, 0);
  assert.deepEqual(x.reads, []);
  assert.doesNotMatch(
    JSON.stringify(result),
    /storageFileId|storagePath|cloud:\/\/|createdBy|pendingStorage/,
  );
});

test('web media reads exactly the ready bytes and rechecks the current source, publication and registration', async (t) => {
  const x = await webFixture(t);
  const before = x.f.calls.length;
  assert.deepEqual(await x.reader.media(x.image.id, x.file), {
    body: x.webBytes.toString('base64'),
    mimeType: 'image/webp',
  });
  assert.deepEqual(x.reads, [x.ready.web.storageFileId]);
  const calls = x.f.calls.slice(before).filter((c) => c.api === 'database.getDocument');
  for (const name of ['articleMedia', 'articleAccepted', 'articleWebMedia'])
    assert.equal(calls.filter((c) => c.params.collectionName === name).length, 2);
  assert.equal(await x.reader.media(x.image.id, `web-v1-${'0'.repeat(64)}.webp`), null);
  assert.equal(x.reads.length, 1);
});

test('a warm public web image reuses only the bytes and still checks withdrawal', async (t) => {
  const x = await webFixture(t);
  const cold = await x.reader.media(x.image.id, x.file, { measure: true });
  assert.equal(cold?.timings?.downloadMs, 19);

  const start = x.f.calls.length;
  const warm = await x.reader.media(x.image.id, x.file, { measure: true });
  assert.equal(warm?.body, cold?.body);
  assert.equal(warm?.timings?.storageMs, 0);
  assert.equal(warm?.timings?.referenceBeforeMs, 0);
  assert.ok(warm?.timings && warm.timings.referenceAfterMs > 0);
  assert.equal(warm?.timings?.downloadMs, undefined);
  assert.deepEqual(x.reads, [x.ready.web.storageFileId]);
  const checks = x.f.calls.slice(start).filter((c) => c.api === 'database.getDocument');
  assert.deepEqual(
    checks.map((c) => c.params.collectionName),
    ['articleMedia', 'articleAccepted', 'articleWebMedia'],
  );

  await x.repo.releases.request('admin', {
    operation: 'withdraw',
    articleId: x.draft.id,
    expectedRevision: 1,
    requestId: 'withdraw-warm-image',
  });
  assert.equal(await x.reader.media(x.image.id, x.file, { measure: true }), null);
  assert.equal(x.reads.length, 1);
});

test('web byte reuse expires and changes to the ready object force a new read', async (t) => {
  const x = await webFixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await x.reader.media(x.image.id, x.file);
  now += 60_001;
  await x.reader.media(x.image.id, x.file);
  assert.equal(x.reads.length, 2);
  const storagePath = x.ready.web.storagePath.replace('/2026/11/', '/2026/12/');
  const storageFileId = `cloud://private/${storagePath}`;
  x.f.put('articleWebMedia', x.draft.id, {
    ...x.sidecar,
    media: {
      [x.image.id]: { ...x.ready, web: { ...x.ready.web, storagePath, storageFileId } },
    },
  });
  assert.equal((await x.reader.media(x.image.id, x.file))?.body, x.webBytes.toString('base64'));
  assert.equal(x.reads.at(-1), storageFileId);
  assert.equal(x.reads.length, 3);
});

test('withdrawal during a web object read prevents returning its bytes', async (t) => {
  const x = await webFixture(t);
  x.setDuringRead(async () => {
    await x.repo.releases.request('admin', {
      operation: 'withdraw',
      articleId: x.draft.id,
      expectedRevision: 1,
      requestId: 'web-withdraw',
    });
  });
  assert.equal(await x.reader.media(x.image.id, x.file), null);
});

test('requested public media diagnostics preserve bytes and reauthorization without leaking object identities', async (t) => {
  const x = await webFixture(t);
  const plainStart = x.f.calls.length;
  await x.reader.media(x.image.id, x.file);
  const plainReads = x.f.calls.slice(plainStart).filter((c) => c.api === 'database.getDocument');
  const measured = await webFixture(t);
  const before = measured.f.calls.length;
  const result = await measured.reader.media(measured.image.id, measured.file, { measure: true });
  assert.equal(result?.body, measured.webBytes.toString('base64'));
  assert.equal(result?.mimeType, 'image/webp');
  assert.ok(result?.timings, 'The reader must return requested public phase timings');
  assert.equal(result.timings.lookupMs, 11);
  assert.equal(result.timings.downloadMs, 19);
  for (const key of [
    'referenceBeforeMs',
    'storageMs',
    'validationMs',
    'referenceAfterMs',
    'totalMs',
  ] as const)
    assert.ok(Number.isFinite(result.timings[key]) && result.timings[key] >= 0);
  assert.doesNotMatch(JSON.stringify(result.timings), /cloud:|private|storageFileId|articleId/);
  const reads = measured.f.calls.slice(before).filter((c) => c.api === 'database.getDocument');
  assert.equal(reads.length, plainReads.length, 'Measuring must not change the read budget');
});

test('measuring a read cannot release bytes or timings after an article is withdrawn during storage', async (t) => {
  const x = await webFixture(t);
  x.setDuringRead(async () => {
    await x.repo.releases.request('admin', {
      operation: 'withdraw',
      articleId: x.draft.id,
      expectedRevision: 1,
      requestId: 'measured-web-withdraw',
    });
  });
  assert.equal(await x.reader.media(x.image.id, x.file, { measure: true }), null);
});

test('replacement of the active source or ready registration while downloading never releases old web bytes', async (t) => {
  const x = await webFixture(t);
  x.setDuringRead(async () => {
    x.f.put('articleMedia', x.image.id, {
      ...x.image,
      storage: { ...x.image.storage, storageFileId: 'cloud://private/replaced' },
    });
  });
  await assert.rejects(x.reader.media(x.image.id, x.file));
});

test('a changed ready object location is reauthorized even when its checksum and public URL stay identical', async (t) => {
  const x = await webFixture(t);
  x.setDuringRead(async () => {
    const storagePath = x.ready.web.storagePath.replace('/2026/11/', '/2026/12/');
    const ready = {
      ...x.ready,
      web: { ...x.ready.web, storagePath, storageFileId: `cloud://private/${storagePath}` },
    };
    x.f.put('articleWebMedia', x.draft.id, { ...x.sidecar, media: { [x.image.id]: ready } });
  });
  assert.equal(await x.reader.media(x.image.id, x.file), null);
});

test('publication revision changes with the same body hash still cancel an in-flight web response', async (t) => {
  const x = await webFixture(t);
  x.setDuringRead(async () => {
    const accepted = x.f.rows.get(`articleAccepted/${x.draft.id}`);
    assert.ok(accepted && typeof accepted.publication === 'object' && accepted.publication);
    x.f.put('articleAccepted', x.draft.id, {
      ...accepted,
      publication: { ...accepted.publication, revision: 2 },
    });
  });
  assert.equal(await x.reader.media(x.image.id, x.file), null);
});

test('a corrupt ready object fails instead of falling back to original bytes', async (t) => {
  const x = await webFixture(t);
  x.corrupt();
  await assert.rejects(x.reader.media(x.image.id, x.file), /bytes mismatch/);
  assert.deepEqual(x.reads, [x.ready.web.storageFileId]);
});

test('web-prefixed URLs never fall back even when the original WebP has exactly the same checksum', async (t) => {
  const x = await webFixture(t, true);
  x.f.put('articleWebMedia', x.draft.id, { schemaVersion: 1, articleId: x.draft.id, media: {} });
  assert.equal(await x.reader.media(x.image.id, x.file), null);
  assert.deepEqual(x.reads, []);
  assert.deepEqual(await x.reader.media(x.image.id, `${x.image.checksumSha256}.webp`), {
    body: x.bytes.toString('base64'),
    mimeType: 'image/webp',
  });
});

test('malformed sidecars fail the new render read while the old article GET stays unchanged', async (t) => {
  const x = await webFixture(t);
  x.f.put('articleWebMedia', x.draft.id, { ...x.sidecar, storageFileId: 'must-not-leak' });
  await assert.rejects(x.reader.getRender('web-image-guide'));
  assert.equal((await x.reader.get('web-image-guide'))?.articleId, x.draft.id);
});

test('unreferenced active images named constructor or toString return null without reading storage', async (t) => {
  const x = await webFixture(t);
  for (const id of ['constructor', 'toString']) {
    x.f.put('articleMedia', id, { ...x.image, id });
    assert.equal(await x.reader.media(id, `${x.image.checksumSha256}.png`), null);
    assert.equal(await x.reader.media(id, x.file), null);
  }
  assert.deepEqual(x.reads, []);
});

test('an own constructor media entry serves its ready image but an empty ready map returns null', async (t) => {
  const x = await webFixture(t, false, 'constructor');
  assert.deepEqual(await x.reader.media(x.image.id, x.file), {
    body: x.webBytes.toString('base64'),
    mimeType: 'image/webp',
  });
  x.f.put('articleWebMedia', x.draft.id, { schemaVersion: 1, articleId: x.draft.id, media: {} });
  assert.equal(await x.reader.media(x.image.id, x.file), null);
  assert.equal(x.reads.length, 1);
});

test('registered mobile hero uses a single sidecar read and keeps legacy delivery and withdrawal intact', async (t) => {
  const x = await webFixture(t, false, 'web-image-one', true);
  const mobileUrl = articleMobileMediaPath(x.image.id, x.compact.web.checksumSha256);
  const mobileFile = mobileUrl.split('/').at(-1) ?? '';
  const initial = await x.reader.getRender('web-image-guide', undefined, true);
  assert.equal(initial?.schemaVersion, 1);
  assert.equal(await x.reader.media(x.image.id, mobileFile), null);

  const transaction = articleTransaction(x.f.db);
  assert.equal(await registerArticleResponsiveMedia(transaction, x.compact), 'registered');
  assert.equal(await registerArticleResponsiveMedia(transaction, x.compact), 'unchanged');
  const start = x.f.calls.length;
  const render = await x.reader.getRender('web-image-guide', undefined, true);
  assert.equal(render?.schemaVersion, 2);
  assert(render?.schemaVersion === 2);
  assert.equal(render.mobile.url, mobileUrl);
  assert.deepEqual(render.article, initial?.article);
  assert.deepEqual(render.presentation, initial?.presentation);
  assert.deepEqual(
    x.f.calls
      .slice(start)
      .filter((c) => c.api === 'database.getDocument')
      .map((c) => c.params.collectionName),
    ['articleSlugs', 'articleAccepted', 'articleWebMedia'],
  );
  assert.deepEqual(await x.reader.getRender('web-image-guide'), initial);
  const registryKey = [...x.f.rows.keys()].find((key) =>
    key.startsWith('articleWebMedia/_responsive_'),
  );
  assert(registryKey);
  const validRecord = x.f.rows.get(registryKey);
  assert(validRecord);
  x.f.rows.set(registryKey, { ...validRecord, mobile: { broken: true } });
  assert.deepEqual(await x.reader.getRender('web-image-guide', undefined, true), initial);
  await assert.rejects(x.reader.media(x.image.id, mobileFile));
  x.f.rows.set(registryKey, validRecord);
  assert.equal((await x.reader.media(x.image.id, x.file))?.body, x.webBytes.toString('base64'));
  assert.equal(
    (await x.reader.media(x.image.id, mobileFile))?.body,
    x.mobileBytes.toString('base64'),
  );

  const warmStart = x.f.calls.length;
  const warmMobile = await x.reader.media(x.image.id, mobileFile, { measure: true });
  assert.equal(warmMobile?.body, x.mobileBytes.toString('base64'));
  assert.equal(warmMobile?.timings?.storageMs, 0);
  assert.deepEqual(
    x.f.calls
      .slice(warmStart)
      .filter((c) => c.api === 'database.getDocument')
      .map((c) => c.params.collectionName),
    ['articleMedia', 'articleAccepted', 'articleWebMedia'],
  );

  // Withdraw between the first reference read and bytes being ready to return.
  const cold = createCloudBasePublicArticles(x.f.db, {
    async getObjectAsBase64() {
      await x.repo.releases.request('admin', {
        operation: 'withdraw',
        articleId: x.draft.id,
        expectedRevision: 1,
        requestId: 'withdraw-responsive-while-reading',
      });
      return { body: x.mobileBytes.toString('base64') };
    },
  });
  assert.equal(await cold.media(x.image.id, mobileFile), null);
  assert.equal(await x.reader.media(x.image.id, mobileFile), null, 'hot bytes are also revoked');
  assert.equal(await x.reader.media(x.image.id, x.file), null);
  assert.equal(await x.reader.getRender('web-image-guide', undefined, true), null);
  await assert.rejects(registerArticleResponsiveMedia(transaction, x.compact));
});
