import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { handleAdminRequest } from './handler.ts';

test('article image requests require a saved owning draft and current admin permission', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'article-media-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }] }));
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  const jwtSecret = 'article-media-test-secret';
  const token = await signSession(jwtSecret, {
    sub: 'admin',
    role: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
  });
  const result = await handleAdminRequest(
    {
      action: 'articleMedia',
      token,
      data: { operation: 'preview', articleId: 'missing', mediaId: 'missing' },
    },
    { jwtSecret, articleRepository: db.articleRepository },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Missing article unexpectedly exists');
  assert.equal(result.error.code, 'NOT_FOUND');
});

import { createHash } from 'node:crypto';
import { ArticleMediaRecordSchema } from '@vibelingan-channel/articles/media';
import { get, updateDoc } from '@vibelingan-channel/db';
import { type UploadCredential, setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { getCatalogImage } from '../../public-api/src/handler.ts';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=',
  'base64',
);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class UploadStore extends LocalDiskMediaStorage {
  credentials = 0;
  override async getUploadCredential(path: string): Promise<UploadCredential> {
    this.credentials++;
    return {
      uploadUrl: `http://127.0.0.1/upload/${encodeURIComponent(path)}`,
      method: 'PUT',
      storageFileId: `local-disk:${path}`,
      headers: {
        Signature: 'test',
        'x-cos-security-token': 'test',
        'x-cos-meta-fileid': 'test',
        authorization: 'test',
        key: encodeURIComponent(path),
      },
    };
  }
}
async function mediaSetup(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'article-media-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  writeFileSync(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }] }));
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  const storage = new UploadStore(join(dir, 'media'));
  setMediaStorage(storage);
  const jwtSecret = 'article-media-test-secret';
  const token = await signSession(jwtSecret, {
    sub: 'admin',
    role: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
  });
  const config = { jwtSecret, articleRepository: db.articleRepository };
  const call = (data: unknown, presented = token) =>
    handleAdminRequest({ action: 'articleMedia', token: presented, data }, config);
  const draft = await db.articleRepository.create({
    actorId: 'admin',
    requestId: 'draft',
    content: {
      title: 'Media draft',
      slug: '',
      excerpt: '',
      authorName: '',
      seoTitle: '',
      seoDescription: '',
      body: { schemaVersion: 1, document: { type: 'doc', content: [] } },
    },
  });
  const metadata = {
    fileName: 'pixel.png',
    mimeType: 'image/png',
    byteSize: pixel.length,
    checksumSha256: hash(pixel),
  };
  async function intent(requestId = 'upload', file = metadata) {
    const result = await call({ operation: 'intent', articleId: draft.id, requestId, file });
    assert.ok(result.ok, JSON.stringify(result));
    const value = result.data as { mediaId: string };
    const raw = await db.get('articleMedia', value.mediaId);
    assert.ok(raw);
    const { _id, ...body } = raw;
    return ArticleMediaRecordSchema.parse(body);
  }
  async function land(record: Awaited<ReturnType<typeof intent>>, bytes = pixel) {
    await storage.putObject({
      namespace: 'articles',
      logicalId: record.id,
      fileName: 'pending-upload',
      mimeType: record.mimeType,
      content: bytes,
    });
  }
  return { db, file, storage, token, config, call, draft, metadata, intent, land };
}
test('verified immutable article bytes stay private, retry once, and survive an old upload overwrite', async (t) => {
  const f = await mediaSetup(t);
  const pending = await f.intent();
  assert.equal(
    (await f.call({ operation: 'preview', articleId: f.draft.id, mediaId: pending.id })).ok,
    false,
  );
  await f.land(pending);
  const request = { operation: 'complete', articleId: f.draft.id, mediaId: pending.id };
  const results = await Promise.all([f.call(request), f.call(request)]);
  assert.ok(
    results.every((r) => r.ok),
    JSON.stringify(results),
  );
  assert.deepEqual(results[0], results[1]);
  await f.land(pending, Buffer.from('overwritten temporary object'));
  const preview = await f.call({
    operation: 'preview',
    articleId: f.draft.id,
    mediaId: pending.id,
  });
  assert.ok(preview.ok);
  assert.equal(Reflect.get(preview.data as object, 'dataBase64'), pixel.toString('base64'));
  assert.equal(JSON.stringify(preview).includes('storageFileId'), false);
  assert.equal(JSON.stringify(preview).includes('local-disk'), false);
  assert.equal((await getCatalogImage(pending.id)).ok, false);
  assert.equal(
    (
      await f.call({
        operation: 'intent',
        articleId: f.draft.id,
        requestId: 'upload',
        file: f.metadata,
      })
    ).ok,
    true,
  );
  const store = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(store.articleMedia.length, 1);
});
import { readFileSync } from 'node:fs';

test('bad bytes, wrong checksum, oversized metadata and expired intents cannot activate', async (t) => {
  const f = await mediaSetup(t);
  for (const [id, bytes] of [
    ['html', Buffer.from('<script>oops</script>')],
    ['truncated', pixel.subarray(0, 9)],
  ] as const) {
    const pending = await f.intent(id, {
      ...f.metadata,
      byteSize: bytes.length,
      checksumSha256: hash(bytes),
    });
    await f.land(pending, bytes);
    const result = await f.call({
      operation: 'complete',
      articleId: f.draft.id,
      mediaId: pending.id,
    });
    assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR', JSON.stringify(result));
  }
  const pending = await f.intent('checksum');
  await f.land(pending, Buffer.from('wrong'));
  assert.equal(
    (await f.call({ operation: 'complete', articleId: f.draft.id, mediaId: pending.id })).ok,
    false,
  );
  const invalid = await f.call({
    operation: 'intent',
    articleId: f.draft.id,
    requestId: 'large',
    file: { ...f.metadata, byteSize: 3 * 1024 * 1024 + 1 },
  });
  assert.ok(!invalid.ok && invalid.error.code === 'VALIDATION_ERROR');
  const expired = await f.intent('expired');
  t.mock.method(Date, 'now', () => Date.parse(expired.expiresAt) + 1);
  const result = await f.call({
    operation: 'complete',
    articleId: f.draft.id,
    mediaId: expired.id,
  });
  assert.ok(!result.ok && result.error.code === 'CONFLICT');
});

test('article media rejects foreign ownership, changed request content and revoked sessions', async (t) => {
  const f = await mediaSetup(t);
  const pending = await f.intent();
  await f.land(pending);
  const changed = await f.call({
    operation: 'intent',
    articleId: f.draft.id,
    requestId: 'upload',
    file: { ...f.metadata, fileName: 'other.png' },
  });
  assert.ok(!changed.ok && changed.error.code === 'CONFLICT');
  const other = await f.db.articleRepository.create({
    actorId: 'admin',
    requestId: 'second',
    content: f.draft.content,
  });
  const foreign = await f.call({ operation: 'complete', articleId: other.id, mediaId: pending.id });
  assert.ok(!foreign.ok && foreign.error.code === 'NOT_FOUND');
  const request = { operation: 'complete', articleId: f.draft.id, mediaId: pending.id };
  const anonymous = await f.call(request, '');
  assert.ok(!anonymous.ok && anonymous.error.code === 'UNAUTHORIZED');
  await updateDoc('users', 'admin', { role: 'contributor' });
  const revoked = await f.call(request);
  assert.ok(!revoked.ok && revoked.error.code === 'FORBIDDEN');
  assert.equal((await f.db.get('articleMedia', pending.id))?.status, 'pending');
});

test('draft writes reject pending or foreign images and keep the previous saved revision', async (t) => {
  const f = await mediaSetup(t);
  const image = await f.intent();
  const content = {
    ...f.draft.content,
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          {
            type: 'articleImage',
            attrs: { mediaId: image.id, alt: 'pixel', caption: '', align: 'center' },
          },
        ],
      },
    },
  };
  const request = {
    action: 'articleDrafts',
    token: f.token,
    data: { operation: 'save', articleId: f.draft.id, expectedRevision: 1, content },
  };
  const pending = await handleAdminRequest(request, f.config);
  assert.ok(!pending.ok && pending.error.code === 'VALIDATION_ERROR');
  await f.land(image);
  assert.ok((await f.call({ operation: 'complete', articleId: f.draft.id, mediaId: image.id })).ok);
  assert.ok((await handleAdminRequest(request, f.config)).ok);
  const other = await f.db.articleRepository.create({
    actorId: 'admin',
    requestId: 'other',
    content: f.draft.content,
  });
  const foreign = await handleAdminRequest(
    { ...request, data: { ...request.data, articleId: other.id } },
    f.config,
  );
  assert.ok(!foreign.ok && foreign.error.code === 'NOT_FOUND');
  assert.equal(
    (await f.db.articleRepository.get({ actorId: 'admin', articleId: other.id }))?.revision,
    1,
  );
  assert.equal(await get('images', image.id), null);
});

test('private image delivery rechecks permission after a slow byte read', async (t) => {
  const f = await mediaSetup(t);
  const image = await f.intent();
  await f.land(image);
  assert.ok((await f.call({ operation: 'complete', articleId: f.draft.id, mediaId: image.id })).ok);
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  t.mock.method(f.storage, 'getObjectAsBase64', async (fileId: string) => {
    const value = await read(fileId);
    await updateDoc('users', 'admin', { role: 'contributor' });
    return value;
  });
  const response = await f.call({ operation: 'preview', articleId: f.draft.id, mediaId: image.id });
  assert.ok(!response.ok && response.error.code === 'FORBIDDEN');
  assert.equal(JSON.stringify(response).includes('dataBase64'), false);
});

test('oversized and cross-purpose CRUD cannot expose the internal media collection', async (t) => {
  const f = await mediaSetup(t);
  const image = await f.intent();
  for (const action of [
    'list',
    'get',
    'remove',
    'create',
    'update',
    'batchRemove',
    'batchUpdate',
  ]) {
    const response = await handleAdminRequest(
      {
        action,
        token: f.token,
        data: {
          collection: 'articleMedia',
          id: image.id,
          ids: [image.id],
          values: { status: 'deleted' },
        },
      },
      f.config,
    );
    assert.ok(
      !response.ok && ['FORBIDDEN', 'UNKNOWN_COLLECTION'].includes(response.error.code),
      JSON.stringify(response),
    );
  }
  assert.ok(
    await f.db.articleRepository.media?.execute('admin', f.draft.id, {
      operation: 'get',
      mediaId: image.id,
    }),
  );
  const response = await f.call({
    operation: 'intent',
    articleId: f.draft.id,
    requestId: 'svg',
    file: { ...f.metadata, mimeType: 'image/svg+xml' },
  });
  assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR');
});
