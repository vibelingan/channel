import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createArticleImageService } from '../../packages/articles/src/import-media.ts';
import { createArticleImportService } from '../../packages/articles/src/import-store.ts';
import {
  articleTransaction,
  createCloudBaseArticleRepository,
} from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = Buffer.from('verified-png-fixture');
async function fixture(t: test.TestContext) {
  const f = articleSdkFixture(t);
  let now = Date.parse('2026-10-27T00:00:00Z');
  const credential = `image-key.${'f'.repeat(64)}`;
  f.put('articleIntegrations', 'image-key', {
    _id: 'image-key',
    siteId: 'supplychainsai.com',
    integrationId: 'image-connection',
    secretDigest: sha('f'.repeat(64)),
    enabled: true,
    expiresAt: new Date(now + 86400000).toISOString(),
    configRevision: 1,
  });
  f.put('articleIntegrations', 'media-access-image-key', {
    _id: 'media-access-image-key',
    siteId: 'supplychainsai.com',
    keyId: 'image-key',
    integrationId: 'image-connection',
    enabled: true,
  });
  const transaction = articleTransaction(f.db);
  const imports = createArticleImportService(transaction, () => now);
  const receipt = await imports.create(credential, {
    idempotencyKey: 'kb-203',
    externalTaskId: 'vibekb:2:203',
    title: 'Existing article',
    slug: 'existing-article',
    format: 'markdown',
    body: '## Prepare\n\nKeep the human words.\n\n## Final tip\n\nConfirm details.',
  });
  const objects = new Map<string, Buffer>();
  let downloads = 0;
  let seals = 0;
  let pauseRead: Promise<void> | undefined;
  const storage = {
    mint: async (path: string) => ({
      storageFileId: `cloud://fixture/${path}`,
      storagePath: path,
      upload: {
        method: 'PUT' as const,
        url: `https://fixture.cos.ap-shanghai.myqcloud.com/${path}`,
        headers: { authorization: 'test' },
      },
    }),
    read: async (id: string) => {
      downloads++;
      if (pauseRead) await pauseRead;
      const b = objects.get(id);
      if (!b) throw Error('object missing');
      return b;
    },
    validate: (b: Buffer, file: { byteSize: number; checksumSha256: string }) => {
      if (b.length !== file.byteSize || sha(b) !== file.checksumSha256) throw Error('bad bytes');
      return { width: 100, height: 80 };
    },
    seal: async (
      id: string,
      checksum: string,
      b: Buffer,
      checkpoint: (target: { storageFileId: string; storagePath: string }) => Promise<void>,
    ) => {
      seals++;
      const target = {
        storageFileId: `cloud://fixture/sealed/${id}`,
        storagePath: `articles/${id}/${checksum}`,
      };
      await checkpoint(target);
      objects.set(target.storageFileId, b);
      return target;
    },
  };
  const service = createArticleImageService(transaction, storage, () => now);
  const file = {
    fileName: 'image.png',
    mimeType: 'image/png',
    byteSize: bytes.length,
    checksumSha256: sha(bytes),
  };
  const intent = () =>
    service.intent(credential, receipt.operationId, { requestId: 'cover', file });
  async function upload() {
    const r = await intent();
    objects.set(r.storageFileId, bytes);
    return r;
  }
  return {
    f,
    service,
    credential,
    receipt,
    upload,
    intent,
    objects,
    file,
    setNow: (value: number) => {
      now = value;
    },
    get now() {
      return now;
    },
    get downloads() {
      return downloads;
    },
    get seals() {
      return seals;
    },
    pause: (value: Promise<void>) => {
      pauseRead = value;
    },
    repo: createCloudBaseArticleRepository(f.db),
  };
}
test('real SDK transactions attach an image once, preserve text and keep admin preview record shape', async (t) => {
  const f = await fixture(t);
  const before = await f.service.state(f.credential, f.receipt.operationId);
  const i = await f.upload();
  assert.equal((await f.intent()).mediaId, i.mediaId);
  const complete = await f.service.complete(f.credential, f.receipt.operationId, {
    mediaId: i.mediaId,
  });
  assert.equal(complete.status, 'active');
  assert.equal(
    (await f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId })).mediaId,
    i.mediaId,
  );
  assert.equal(f.downloads, 1);
  const input = {
    requestId: 'images-203',
    expectedRevision: before.revision,
    expectedDocumentHash: before.documentHash,
    images: [
      {
        mediaId: i.mediaId,
        insertAt: 0,
        alt: 'Headphones and a notebook',
        caption: '',
        align: 'center',
      },
    ],
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.service.attach(f.credential, f.receipt.operationId, input)),
  );
  assert.equal(new Set(results.map((r) => r.revision)).size, 1);
  assert.equal(results[0].revision, 2);
  const after = await f.service.state(f.credential, f.receipt.operationId);
  assert.equal(after.body.document.content.filter((n) => n.type === 'articleImage').length, 1);
  assert.equal(after.body.document.content[1]?.type, 'heading');
  const row = await f.repo.get({ actorId: 'admin', articleId: f.receipt.articleId });
  assert.equal(row?.content.title, 'Existing article');
  assert.equal(row?.published, null);
  const media = await f.repo.media?.execute('admin', f.receipt.articleId, {
    operation: 'get',
    mediaId: i.mediaId,
  });
  assert.equal(media?.status, 'active');
  await assert.rejects(
    f.service.attach(f.credential, f.receipt.operationId, {
      ...input,
      requestId: 'another-id',
      expectedRevision: after.revision,
      expectedDocumentHash: after.documentHash,
    }),
    (e) => e instanceof Error && Reflect.get(e, 'code') === 'CONFLICT',
  );
});
test('human edits between upload and attach are kept', async (t) => {
  const f = await fixture(t);
  const s = await f.service.state(f.credential, f.receipt.operationId);
  const i = await f.upload();
  await f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId });
  const draft = await f.repo.get({ actorId: 'admin', articleId: f.receipt.articleId });
  assert(draft);
  await f.repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: draft.revision,
    content: { ...draft.content, title: 'Human title' },
  });
  await assert.rejects(
    f.service.attach(f.credential, f.receipt.operationId, {
      requestId: 'images',
      expectedRevision: s.revision,
      expectedDocumentHash: s.documentHash,
      images: [{ mediaId: i.mediaId, insertAt: 0, alt: 'Correct alt' }],
    }),
    (e) => e instanceof Error && Reflect.get(e, 'code') === 'CONFLICT',
  );
  assert.equal(
    (await f.repo.get({ actorId: 'admin', articleId: draft.id }))?.content.title,
    'Human title',
  );
});
test('bad bytes, revoked key, wrong article and missing capability cannot activate or bind media', async (t) => {
  const f = await fixture(t);
  const i = await f.upload();
  f.objects.set(i.storageFileId, Buffer.from('wrong'));
  await assert.rejects(
    f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId }),
  );
  assert.equal(f.seals, 0);
  await assert.rejects(
    f.service.state(`image-key.${'a'.repeat(64)}`, f.receipt.operationId),
    (e) => e instanceof Error && Reflect.get(e, 'code') === 'UNAUTHORIZED',
  );
  await assert.rejects(
    f.service.complete(f.credential, `article-import-${'0'.repeat(64)}`, { mediaId: i.mediaId }),
  );
  f.f.put('articleIntegrations', 'media-access-image-key', {
    _id: 'media-access-image-key',
    siteId: 'supplychainsai.com',
    keyId: 'image-key',
    integrationId: 'image-connection',
    enabled: false,
  });
  await assert.rejects(
    f.intent(),
    (e) => e instanceof Error && Reflect.get(e, 'code') === 'UNAUTHORIZED',
  );
});
test('validation has a recoverable lease and one winner; a loser never downloads bytes', async (t) => {
  const f = await fixture(t);
  const i = await f.upload();
  let release!: () => void;
  f.pause(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const first = f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId });
  while (f.downloads === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId }),
    (e) => e instanceof Error && Reflect.get(e, 'code') === 'CONFLICT',
  );
  assert.equal(f.downloads, 1);
  release();
  await first;
  assert.equal(f.seals, 1);
});

test('an acknowledged attachment replay never restores an image removed by a person', async (t) => {
  const f = await fixture(t);
  const s = await f.service.state(f.credential, f.receipt.operationId);
  const i = await f.upload();
  await f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId });
  const input = {
    requestId: 'original-image-job',
    expectedRevision: s.revision,
    expectedDocumentHash: s.documentHash,
    images: [{ mediaId: i.mediaId, insertAt: 0, alt: 'Actual existing image' }],
  };
  await f.service.attach(f.credential, f.receipt.operationId, input);
  const draft = await f.repo.get({ actorId: 'admin', articleId: f.receipt.articleId });
  assert(draft);
  await f.repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: draft.revision,
    content: { ...draft.content, title: 'Keep human correction', body: s.body },
  });
  const replay = await f.service.attach(f.credential, f.receipt.operationId, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.complete, false);
  const final = await f.repo.get({ actorId: 'admin', articleId: draft.id });
  assert.equal(final?.revision, 3);
  assert.equal(final?.content.title, 'Keep human correction');
  assert.deepEqual(final?.content.body, s.body);
});
test('an interrupted verification is reclaimed after its lease; revocation while reading forbids sealing', async (t) => {
  const f = await fixture(t);
  const i = await f.upload();
  f.objects.delete(i.storageFileId);
  await assert.rejects(
    f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId }),
  );
  await assert.rejects(
    f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId }),
    (e) => Reflect.get(e, 'code') === 'CONFLICT',
  );
  f.setNow(f.now + 5 * 60000 + 1);
  f.objects.set(i.storageFileId, bytes);
  await f.service.complete(f.credential, f.receipt.operationId, { mediaId: i.mediaId });
  assert.equal(f.seals, 1);
  const other = await fixture(t);
  const j = await other.upload();
  let release!: () => void;
  other.pause(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const pending = other.service.complete(other.credential, other.receipt.operationId, {
    mediaId: j.mediaId,
  });
  while (other.downloads === 0) await new Promise((r) => setTimeout(r, 1));
  other.f.put('articleIntegrations', 'media-access-image-key', {
    _id: 'media-access-image-key',
    siteId: 'supplychainsai.com',
    keyId: 'image-key',
    integrationId: 'image-connection',
    enabled: false,
  });
  release();
  await assert.rejects(pending, (e) => Reflect.get(e, 'code') === 'UNAUTHORIZED');
  assert.equal(other.objects.has(`cloud://fixture/sealed/${j.mediaId}`), false);
});

test('an expired upload grant can be renewed with the same image identity without consuming another quota', async (t) => {
  const f = await fixture(t);
  const first = await f.upload();
  f.setNow(f.now + 20 * 60000);
  const next = await f.intent();
  assert.equal(next.mediaId, first.mediaId);
  assert(Date.parse(next.expiresAt) > f.now);
  await f.service.complete(f.credential, f.receipt.operationId, { mediaId: first.mediaId });
  assert.equal(f.seals, 1);
});
