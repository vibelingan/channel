import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { completeImageJob, imageInsertionIndex } from './image-client.mjs';
import { kbImportOperation } from './kb-draft.mjs';
const config = {
  apiOrigin: 'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
  siteOrigin: 'https://supplychainsai.com',
  integrationId: 'connection',
  credential: `key.${'f'.repeat(64)}`,
};
const body = {
  schemaVersion: 1,
  document: {
    type: 'doc',
    content: [{ type: 'heading', content: [{ type: 'text', text: 'Final tip' }] }],
  },
};
test('image job resumes with the original baseline after a lost attachment response and never changes its request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'image-client-'));
  t.after(() => rm(root, { recursive: true }));
  const bytes = Buffer.from('owned-image');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const fileName = `${hash}.png`;
  await writeFile(join(root, fileName), bytes, { mode: 0o600 });
  const job = {
    version: 1,
    documentId: 203,
    workspaceId: '2',
    images: [
      {
        fileName,
        byteSize: bytes.length,
        checksumSha256: hash,
        mimeType: 'image/png',
        alt: 'Headphones on a desk',
        placement: { type: 'start' },
      },
    ],
  };
  const path = join(root, 'job.json');
  await writeFile(path, JSON.stringify(job), { mode: 0o600 });
  const articleId = kbImportOperation(
    { siteId: config.siteOrigin.slice(8), integrationId: config.integrationId, workspaceId: '2' },
    203,
    '2',
  ).replace('article-import-', 'article-');
  let uploaded = false;
  let attached = false;
  let lose = true;
  const requests = [];
  const mediaId = `article-media-${'a'.repeat(64)}`;
  const response = (value) => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ ok: true, data: value })),
    headers: new Headers(),
  });
  const request = async (method, url, options) => {
    if (method === 'PUT') {
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.body, bytes);
      assert.equal(options.headers.Signature, 'sig');
      uploaded = true;
      return { status: 200, body: Buffer.alloc(0), headers: new Headers() };
    }
    if (url.endsWith('/state'))
      return response({
        articleId,
        revision: attached ? 2 : 1,
        documentHash: (attached ? 'b' : 'c').repeat(64),
        body: attached
          ? {
              schemaVersion: 1,
              document: {
                type: 'doc',
                content: [
                  {
                    type: 'articleImage',
                    attrs: { mediaId, alt: 'Headphones on a desk', caption: '', align: 'center' },
                  },
                  ...body.document.content,
                ],
              },
            }
          : body,
      });
    if (url.endsWith('/intent'))
      return response({
        status: uploaded ? 'active' : 'pending',
        mediaId,
        storageFileId: 'cloud://file',
        expiresAt: '2026-10-28T00:00:00.000Z',
        upload: uploaded
          ? null
          : {
              method: 'PUT',
              url: 'https://fixture.cos.ap-shanghai.myqcloud.com/file',
              headers: {
                Signature: 'sig',
                authorization: 'sig',
                'x-cos-security-token': 'temporary',
                'x-cos-meta-fileid': 'file',
                key: 'file',
              },
            },
      });
    if (url.endsWith('/complete'))
      return response({
        status: 'active',
        mediaId,
        articleId,
        mimeType: 'image/png',
        byteSize: bytes.length,
        width: 10,
        height: 10,
      });
    if (url.endsWith('/attach')) {
      const input = JSON.parse(options.body);
      requests.push(input);
      attached = true;
      if (lose) throw Error('reply lost');
      return response({
        articleId,
        revision: 2,
        currentRevision: 2,
        documentHash: 'b'.repeat(64),
        mediaIds: [mediaId],
        complete: true,
        replayed: true,
        appliedAt: '2026-10-27T00:00:00.000Z',
        editUrl: `${config.siteOrigin}/admin/?section=articles&article=${articleId}`,
      });
    }
    throw Error('Unexpected endpoint');
  };
  await assert.rejects(completeImageJob(path, config, { request }));
  lose = false;
  const result = await completeImageJob(path, config, { request });
  assert.equal(result.complete, true);
  assert.equal(result.imageCount, 1);
  assert(requests.length >= 2);
  assert(requests.every((x) => JSON.stringify(x) === JSON.stringify(requests[0])));
  assert.equal(requests.at(-1).expectedRevision, 1);
});
test('placement requires an exact unique heading and never guesses a nearby section', () => {
  assert.equal(imageInsertionIndex(body, { type: 'before-heading', heading: 'Final Tip' }), 0);
  assert.throws(() => imageInsertionIndex(body, { type: 'before-heading', heading: 'tip' }));
  assert.throws(() =>
    imageInsertionIndex(
      {
        ...body,
        document: {
          ...body.document,
          content: [...body.document.content, ...body.document.content],
        },
      },
      { type: 'before-heading', heading: 'Final tip' },
    ),
  );
});
