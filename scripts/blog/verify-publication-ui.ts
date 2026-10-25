import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { ArticleMediaRecordSchema, articleImageIds } from '../../packages/articles/src/media.ts';
import {
  articleMediaPath,
  parsePublishedArticle,
} from '../../packages/articles/src/publication.ts';
import { ArticleReleaseViewSchema } from '../../packages/articles/src/release.ts';
import { fetchFully } from '../smoke-http.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { verifyArticleQueueProbe } from './queue-probe.mjs';
import { blogWorkerSdk } from './worker-source.ts';
const policy = assertBlogBootstrapInvocation(process.env);
const serverDelivery = process.env.E2E_BLOG_DELIVERY_MODE === 'server';
function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const proof = record(JSON.parse(await readFile('output/blog-publication/request.json', 'utf8')));
assert(['create', 'retry', 'update', 'withdraw', 'check'].includes(String(proof.operation)));
assert(typeof proof.articleId === 'string' && /^[A-Za-z0-9:_-]+$/.test(proof.articleId));
assert(typeof proof.slug === 'string' && /^oem-project-brief-acceptance-\d+$/.test(proof.slug));
assert.equal(proof.title, 'Preparing an OEM headphone project brief');
assert(typeof proof.imageSha256 === 'string' && /^[a-f0-9]{64}$/.test(proof.imageSha256));
const sdk = blogWorkerSdk({
  env: process.env.TCB_ENV_ID ?? '',
  region: 'ap-shanghai',
  secretId: process.env.TENCENTCLOUD_SECRETID ?? '',
  secretKey: process.env.TENCENTCLOUD_SECRETKEY ?? '',
});
const db = sdk.database();
async function row(collection: string, id: string) {
  const result = await db.runTransaction(
    async (tx: {
      collection(name: string): { doc(id: string): { get(): Promise<{ data: unknown }> } };
    }) => (await tx.collection(collection).doc(id).get()).data,
  );
  return record(result);
}
const raw = await row('articleDrafts', proof.articleId);
const draft = parseArticleDraft(raw.draft);
assert.equal(draft.id, proof.articleId);
assert.equal(draft.content.slug, proof.slug);
assert.equal(draft.content.title, proof.title);
assert.equal(draft.content.authorName, 'Diversity Technology Limited');
const head = await row('articleReleaseHeads', proof.articleId);
assert.equal(head.articleId, proof.articleId);
assert.equal(typeof head.taskId, 'string');
const task = await row('articleReleaseTasks', String(head.taskId));
assert.equal(task.articleId, proof.articleId);
assert.equal(task.slug, proof.slug);
if (proof.operation === 'check') {
  assert(
    ['SUCCEEDED', 'FAILED'].includes(String(task.state)),
    'Delivery is not in a confirmed terminal state',
  );
  if (task.state === 'FAILED') assert.equal(task.error, 'RESTORED');
} else {
  const requested = ArticleReleaseViewSchema.parse(proof.task);
  assert.equal(task.id, requested.id);
  assert.equal(task.revision, requested.revision);
  assert.equal(task.state, serverDelivery ? 'SUCCEEDED' : 'QUEUED');
}
const ids = articleImageIds(draft.content.body);
assert.equal(ids.length, 1);
const imageId = ids[0];
assert(imageId);
const mediaRaw = await row('articleMedia', imageId);
const { _id, ...rest } = mediaRaw;
const media = ArticleMediaRecordSchema.parse(rest);
assert.equal(_id, ids[0]);
assert.equal(media.articleId, proof.articleId);
assert.equal(media.status, 'active');
if (media.status !== 'active') throw Error('Original image is no longer active');
const image = await sdk.downloadFile({ fileID: media.storage.storageFileId });
assert(Buffer.isBuffer(image.fileContent));
assert.equal(createHash('sha256').update(image.fileContent).digest('hex'), proof.imageSha256);
if (serverDelivery) {
  assert.equal(task.state, 'SUCCEEDED');
  assert.equal(task.receipt, null);
  assert.equal(task.workerId, null);
  const accepted = await row('articleAccepted', draft.id);
  assert.equal(accepted.taskId, task.id);
  if (proof.operation === 'withdraw') {
    assert.equal(accepted.publication, null);
    assert.equal(draft.published, null);
  } else {
    const publication = parsePublishedArticle(accepted.publication);
    assert.equal(publication.articleId, draft.id);
    assert.equal(publication.revision, draft.revision);
    assert(JSON.stringify(publication.content.body).includes('Before requesting a quotation'));
  }
  const get = (path: string) =>
    fetchFully('GET', `${policy.siteOrigin}${path}`, {
      redirect: 'error',
      timeoutMs: 30000,
      maxBytes: 3 * 1024 * 1024,
    });
  const withdrawn = proof.operation === 'withdraw';
  if (withdrawn) {
    const retiredImage = articleMediaPath(media.id, {
      sha256: media.checksumSha256,
      mimeType: media.mimeType,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
    });
    assert.equal((await get(`/blog${retiredImage}`)).status, 404);
    assert.equal(
      (await get(`/api/articles/media/${media.id}/${retiredImage.split('/').at(-1)}`)).status,
      404,
    );
  }
  const html = await get(`/blog/${proof.slug}/`);
  assert.equal(html.status, withdrawn ? 404 : 200);
  const api = await get(`/api/articles/slug/${proof.slug}`);
  assert.equal(api.status, withdrawn ? 404 : 200);
  if (!withdrawn) {
    assert(html.body.toString().includes(String(proof.title)));
    assert(
      html.body
        .toString()
        .includes(`rel="canonical" href="${policy.siteOrigin}/blog/${proof.slug}/"`),
    );
    assert(html.body.toString().includes('"@type":"Article"'));
    const apiArticle = parsePublishedArticle(JSON.parse(api.body.toString()).data);
    assert.equal(apiArticle.revision, draft.revision);
    for (const [id, asset] of Object.entries(apiArticle.media)) {
      const served = await get(`/blog${articleMediaPath(id, asset)}`);
      assert.equal(served.status, 200);
      assert.equal(createHash('sha256').update(served.body).digest('hex'), proof.imageSha256);
    }
  }
  const sitemap = await get('/blog/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.body.toString().includes(`/blog/${proof.slug}/`), !withdrawn);
  await writeFile(
    'output/blog-publication/server-proof.json',
    JSON.stringify(
      {
        articleId: draft.id,
        taskId: task.id,
        revision: draft.revision,
        htmlStatus: html.status,
        apiStatus: api.status,
        sitemapStatus: sitemap.status,
        withdrawn,
        noBuildReceipt: task.receipt === null,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
} else {
  const queue = await verifyArticleQueueProbe({ key: process.env.BLOG_QUEUE_STATUS_KEY });
  assert(queue.enabled && !queue.hasUnknown, 'Article queue is not ready');
  if (proof.operation !== 'check')
    assert(queue.hasQueued, 'The real requested task was not observable');
  await writeFile('output/blog-publication/queue-proof.json', JSON.stringify(queue, null, 2), {
    flag: 'wx',
  });
}
await writeFile(
  'output/blog-publication/database-proof.json',
  JSON.stringify(
    {
      articleId: draft.id,
      revision: draft.revision,
      taskId: task.id,
      state: task.state,
      error: task.error,
      published: draft.published,
      originalImageRetained: true,
      imageBytes: image.fileContent.length,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  'Owned article request, real stored draft and original image bytes independently verified.',
);
