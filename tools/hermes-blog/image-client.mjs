import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fetchFully } from '../../scripts/smoke-http.mjs';
import { readBlogToolConfig } from './client.mjs';
import { readPrivateJson, writePrivateJson } from './credential-file.mjs';
import { kbImportOperation } from './kb-draft.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const placement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('end') }).strict(),
  z.object({ type: z.literal('before-heading'), heading: z.string().min(1).max(200) }).strict(),
]);
export const imageManifestSchema = z
  .object({
    version: z.literal(1),
    documentId: z.number().int().positive().safe(),
    workspaceId: z.literal('2'),
    images: z
      .array(
        z
          .object({
            fileName: z.string().regex(/^[a-f0-9]{64}\.(?:png|jpg|webp)$/),
            byteSize: z
              .number()
              .int()
              .positive()
              .max(3 * 1024 * 1024),
            checksumSha256: hash,
            mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
            alt: z.string().trim().min(1).max(300),
            caption: z.string().max(500).default(''),
            placement,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const stateSchema = z
  .object({
    articleId: z.string().regex(/^article-[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
    documentHash: hash,
    body: z
      .object({
        schemaVersion: z.literal(1),
        document: z
          .object({ type: z.literal('doc'), content: z.array(z.record(z.unknown())) })
          .strict(),
      })
      .strict(),
  })
  .strict();
const headers = z
  .object({
    Signature: z.string().min(1),
    'x-cos-security-token': z.string().min(1),
    'x-cos-meta-fileid': z.string().min(1),
    authorization: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();
const uploadSchema = z
  .object({ method: z.literal('PUT'), url: z.string().url(), headers })
  .strict();
const intentSchema = z
  .object({
    status: z.enum(['pending', 'active']),
    mediaId: z.string().regex(/^article-media-[a-f0-9]{64}$/),
    storageFileId: z.string().min(1),
    expiresAt: z.string().datetime(),
    upload: uploadSchema.nullable(),
  })
  .strict();
const resultSchema = z
  .object({
    articleId: z.string(),
    revision: z.number().int().positive(),
    documentHash: hash,
    mediaIds: z.array(z.string()),
    appliedAt: z.string().datetime(),
    currentRevision: z.number().int().positive(),
    complete: z.boolean(),
    replayed: z.boolean(),
    editUrl: z.string(),
  })
  .strict();
const progressSchema = z
  .object({
    version: z.literal(1),
    manifestHash: hash,
    baseline: stateSchema,
    images: z
      .array(
        z
          .object({
            checksumSha256: hash,
            mediaId: z.string().regex(/^article-media-[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20),
    result: resultSchema.optional(),
  })
  .strict();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function imageInsertionIndex(body, where) {
  const blocks = body.document.content;
  if (where.type === 'start') return 0;
  if (where.type === 'end') return blocks.length;
  const matches = blocks.flatMap((block, index) =>
    block.type === 'heading' &&
    Array.isArray(block.content) &&
    block.content
      .map((n) => (typeof n.text === 'string' ? n.text : ''))
      .join('')
      .normalize('NFKC')
      .toLowerCase() === where.heading.normalize('NFKC').toLowerCase()
      ? [index]
      : [],
  );
  if (matches.length !== 1) throw Error('图片位置不明确，尚未插图。');
  return matches[0];
}
async function imageBytes(path, image) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error('Image symlink rejected');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.mode & 0o077 ||
      s.nlink !== 1 ||
      s.size !== image.byteSize
    )
      throw Error('Private image differs');
    const b = await file.readFile();
    if (b.length !== image.byteSize || sha(b) !== image.checksumSha256)
      throw Error('Image content changed');
    return b;
  } finally {
    await file.close();
  }
}
/** Runs under the publisher's credential lock. Upload grants never leave this program. */
export async function completeImageJob(jobPath, config, { request = fetchFully } = {}) {
  const trusted = readBlogToolConfig({
    CHANNEL_BLOG_API_ORIGIN: config.apiOrigin,
    CHANNEL_BLOG_SITE_ORIGIN: config.siteOrigin,
    CHANNEL_BLOG_CREDENTIAL: config.credential,
    CHANNEL_BLOG_INTEGRATION_ID: config.integrationId,
  });
  const { value } = await readPrivateJson(jobPath, 32768);
  const manifest = imageManifestSchema.parse(value);
  if (new Set(manifest.images.map((x) => x.checksumSha256)).size !== manifest.images.length)
    throw Error('Duplicate image content');
  const parent = await lstat(dirname(jobPath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077
  )
    throw Error('Private image job directory required');
  const op = kbImportOperation(
    {
      siteId: 'supplychainsai.com',
      integrationId: trusted.integrationId,
      workspaceId: manifest.workspaceId,
    },
    manifest.documentId,
    manifest.workspaceId,
  );
  const articleId = op.replace('article-import-', 'article-');
  const root = `/api/integrations/v1/article-drafts/${op}/images`;
  const checkpointPath = join(dirname(jobPath), 'progress.json');
  const manifestHash = sha(JSON.stringify(manifest));
  let progress;
  try {
    progress = progressSchema.parse((await readPrivateJson(checkpointPath, 512000)).value);
    if (progress.manifestHash !== manifestHash) throw Error('Image manifest changed');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  async function api(action, input) {
    const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
    let r;
    for (let n = 0; n < 3; n++) {
      if (n) await new Promise((resolve) => setTimeout(resolve, 250 * n));
      try {
        r = await request(body ? 'POST' : 'GET', `${trusted.apiOrigin + root}/${action}`, {
          timeoutMs: 20000,
          maxBytes: 256 * 1024,
          redirect: 'error',
          headers: {
            authorization: `Bearer ${trusted.credential}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body } : {}),
        });
      } catch (e) {
        if (n === 2) throw Error('网站图片回复未确认，请沿用原任务重试。');
        continue;
      }
      if (![502, 503, 504].includes(r.status)) break;
    }
    if (r?.status !== 200)
      throw Error(
        `网站图片操作未完成（HTTP ${r?.status ?? 'unknown'}），请保留原任务；不会覆盖现有文章。`,
      );
    const envelope = z
      .object({ ok: z.literal(true), data: z.unknown() })
      .strict()
      .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.body)));
    return envelope.data;
  }
  const current = stateSchema.parse(await api('state'));
  if (current.articleId !== articleId) throw Error('Image target differs');
  if (!progress) {
    progress = { version: 1, manifestHash, baseline: current, images: [] };
    await writePrivateJson(checkpointPath, progress);
  }
  const baseline = stateSchema.parse(progress.baseline);
  if (baseline.articleId !== articleId) throw Error('Stored image target differs');
  for (const image of manifest.images) {
    const bytes = await imageBytes(join(dirname(jobPath), image.fileName), image);
    const intent = intentSchema.parse(
      await api('intent', {
        requestId: `file-${image.checksumSha256}`,
        file: {
          fileName: image.fileName,
          byteSize: image.byteSize,
          checksumSha256: image.checksumSha256,
          mimeType: image.mimeType,
        },
      }),
    );
    if (intent.status === 'pending') {
      if (!intent.upload) throw Error('Missing one-object upload grant');
      const url = new URL(intent.upload.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        url.port ||
        !url.hostname.endsWith('.myqcloud.com') ||
        !url.hostname.includes('.cos.')
      )
        throw Error('Unexpected CloudBase upload target');
      if (intent.upload.headers.Signature !== intent.upload.headers.authorization)
        throw Error('Upload header identity differs');
      const sent = await request('PUT', intent.upload.url, {
        timeoutMs: 60000,
        maxBytes: 32768,
        redirect: 'error',
        headers: intent.upload.headers,
        body: bytes,
      });
      if (sent.status !== 200 || sent.body.length !== 0)
        throw Error('图片上传结果未确认，请沿用同一个文件重试。');
    }
    const completed = z
      .object({
        status: z.literal('active'),
        mediaId: z.literal(intent.mediaId),
        articleId: z.literal(articleId),
        mimeType: z.literal(image.mimeType),
        byteSize: z.literal(image.byteSize),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .parse(await api('complete', { mediaId: intent.mediaId }));
    const old = progress.images.find((x) => x.checksumSha256 === image.checksumSha256);
    if (old && old.mediaId !== completed.mediaId) throw Error('Image receipt changed');
    if (!old)
      progress.images.push({ checksumSha256: image.checksumSha256, mediaId: completed.mediaId });
    await writePrivateJson(checkpointPath, progress);
  }
  const images = manifest.images.map((image) => {
    const done = progress.images.find((x) => x.checksumSha256 === image.checksumSha256);
    if (!done) throw Error('Image is incomplete');
    return {
      mediaId: done.mediaId,
      insertAt: imageInsertionIndex(baseline.body, image.placement),
      alt: image.alt,
      caption: image.caption,
      align: 'center',
    };
  });
  const input = {
    requestId: `images-${manifestHash}`,
    expectedRevision: baseline.revision,
    expectedDocumentHash: baseline.documentHash,
    images,
  };
  const result = resultSchema.parse(await api('attach', input));
  if (
    result.articleId !== articleId ||
    result.editUrl !== `${trusted.siteOrigin}/admin/?section=articles&article=${articleId}` ||
    JSON.stringify(result.mediaIds) !== JSON.stringify(images.map((x) => x.mediaId))
  )
    throw Error('Image attachment receipt differs');
  const observed = stateSchema.parse(await api('state'));
  if (observed.articleId !== articleId) throw Error('Image readback target differs');
  const actual = observed.body.document.content.filter((x) => x.type === 'articleImage');
  const complete =
    result.complete &&
    images.every(
      (image) =>
        actual.filter((node) => node.attrs?.mediaId === image.mediaId).length === 1 &&
        actual.some(
          (node) =>
            node.attrs?.mediaId === image.mediaId &&
            node.attrs?.alt === image.alt &&
            node.attrs?.caption === image.caption,
        ),
    );
  progress.result = result;
  await writePrivateJson(checkpointPath, progress);
  return {
    ok: complete,
    state: complete ? 'ready' : 'changed-after-attachment',
    documentId: manifest.documentId,
    workspaceId: 2,
    ...result,
    complete,
    currentRevision: observed.revision,
    imageCount: result.mediaIds.length,
  };
}
