import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { ArticleMediaRecordSchema, articleImageIds } from '../../packages/articles/src/media.ts';
import { ArticleReleaseViewSchema } from '../../packages/articles/src/release.ts';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { blogWorkerSdk } from './worker-source.ts';
assertBlogBootstrapInvocation(process.env);
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
  assert.equal(task.state, 'QUEUED');
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
