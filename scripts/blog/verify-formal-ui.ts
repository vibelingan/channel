import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { ArticleMediaRecordSchema, articleImageIds } from '../../packages/articles/src/media.ts';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { blogWorkerSdk } from './worker-source.ts';
assertBlogBootstrapInvocation(process.env);
const proof = JSON.parse(await readFile('output/blog-bootstrap/ui-proof.json', 'utf8'));
assert(proof && /^[A-Za-z0-9:_-]+$/.test(proof.articleId));
assert.equal(typeof proof.title, 'string');
assert.equal(typeof proof.text, 'string');
assert.equal(proof.revision, 3);
assert(/^[a-f0-9]{64}$/.test(proof.imageSha256));
const sdk = blogWorkerSdk({
  env: process.env.TCB_ENV_ID ?? '',
  region: 'ap-shanghai',
  secretId: process.env.TENCENTCLOUD_SECRETID ?? '',
  secretKey: process.env.TENCENTCLOUD_SECRETKEY ?? '',
});
const db = sdk.database();
const row = await db.runTransaction(
  async (tx: {
    collection(name: string): { doc(id: string): { get(): Promise<{ data: unknown }> } };
  }) => (await tx.collection('articleDrafts').doc(proof.articleId).get()).data,
);
const draft = parseArticleDraft(row.draft);
assert.equal(draft.id, proof.articleId);
assert.equal(draft.revision, proof.revision);
assert.equal(draft.content.title, proof.title);
assert.equal(draft.published, null);
assert(JSON.stringify(draft.content.body).includes(proof.text));
assert(!JSON.stringify(draft).includes('Concurrent unsaved private text'));
const ids = articleImageIds(draft.content.body);
assert.equal(ids.length, 1);
const imageId = ids[0];
assert(imageId);
const raw = await db.runTransaction(
  async (tx: {
    collection(name: string): { doc(id: string): { get(): Promise<{ data: unknown }> } };
  }) => (await tx.collection('articleMedia').doc(imageId).get()).data,
);
const { _id, ...value } = raw;
const media = ArticleMediaRecordSchema.parse(value);
assert.equal(_id, ids[0]);
assert.equal(media.articleId, draft.id);
assert.equal(media.status, 'active');
if (media.status !== 'active') throw Error('Image not active');
assert(media.storage.storageFileId.startsWith(`cloud://${process.env.TCB_ENV_ID}.`));
const image = await sdk.downloadFile({ fileID: media.storage.storageFileId });
assert(Buffer.isBuffer(image.fileContent));
assert.equal(createHash('sha256').update(image.fileContent).digest('hex'), proof.imageSha256);
await writeFile(
  'output/blog-bootstrap/database-proof.json',
  JSON.stringify(
    {
      articleId: draft.id,
      revision: draft.revision,
      private: true,
      imageId: media.id,
      imageBytes: image.fileContent.length,
      imageSha256: proof.imageSha256,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  'Independent CloudBase database and image-byte checks passed; private acceptance records retained.',
);
