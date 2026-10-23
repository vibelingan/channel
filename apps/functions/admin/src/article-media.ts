import { createHash } from 'node:crypto';
import {
  ArticleDraftError,
  type ArticleRepository,
} from '@vibelingan-channel/articles/draft-repository';
import {
  ARTICLE_IMAGE_MAX_BYTES,
  ArticleImageFileSchema,
  type ArticleMediaRecord,
  ArticleMediaRecordSchema,
  articleIdentity,
  articleMediaView,
} from '@vibelingan-channel/articles/media';
import { mediaStorage, objectStoragePath } from '@vibelingan-channel/media-storage';
import { signatureMatchesMime, sniffMagicBytes } from '@vibelingan-channel/shared';
import { imageSize } from 'image-size';
import { z } from 'zod';

const base = z.object({ articleId: articleIdentity });
const requestSchema = z.discriminatedUnion('operation', [
  base
    .extend({
      operation: z.literal('intent'),
      requestId: articleIdentity,
      file: ArticleImageFileSchema,
    })
    .strict(),
  base.extend({ operation: z.literal('complete'), mediaId: articleIdentity }).strict(),
  base.extend({ operation: z.literal('preview'), mediaId: articleIdentity }).strict(),
]);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () =>
  new ArticleDraftError(
    'VALIDATION_ERROR',
    'The image bytes, type, checksum or dimensions are invalid. Use a JPEG, PNG or WebP up to 3 MiB.',
  );

export async function executeArticleMediaRequest(
  repository: ArticleRepository,
  actorId: string,
  input: unknown,
): Promise<unknown> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw new ArticleDraftError('VALIDATION_ERROR', 'Invalid article image request.');
  const request = parsed.data;
  const media = repository.media;
  if (!media)
    throw new ArticleDraftError('INTERNAL_ERROR', 'Article image storage is not configured.');
  // Check ownership before minting credentials or reading bytes.
  if (!(await repository.get({ actorId, articleId: request.articleId })))
    throw new ArticleDraftError('NOT_FOUND', 'Article draft was not found.');
  if (request.operation === 'intent') {
    const id = `article-media-${digest(JSON.stringify([actorId, request.articleId, request.requestId]))}`;
    const existing = await media.execute(actorId, request.articleId, {
      operation: 'get',
      mediaId: id,
    });
    const requestHash = digest(JSON.stringify(request.file));
    if (existing && existing.requestHash !== requestHash)
      throw new ArticleDraftError(
        'CONFLICT',
        'This image request was already used for a different file.',
      );
    if (existing?.status === 'active')
      return { status: 'active', media: articleMediaView(existing) };
    const storagePath =
      existing?.pendingStorage.storagePath ??
      objectStoragePath({ namespace: 'articles', logicalId: id, fileName: 'pending-upload' });
    const expiresAt = existing?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
    if (Date.parse(expiresAt) <= Date.now())
      throw new ArticleDraftError('CONFLICT', 'Image upload expired. Select the file again.');
    const credential = await mediaStorage().getUploadCredential(storagePath);
    const candidate = ArticleMediaRecordSchema.parse({
      ...request.file,
      id,
      articleId: request.articleId,
      purpose: 'article-image',
      requestHash,
      createdBy: actorId,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'pending',
      pendingStorage: { storageFileId: credential.storageFileId, storagePath },
    });
    if (candidate.status !== 'pending') throw new Error('Invalid pending image');
    const reserved = await media.execute(actorId, request.articleId, {
      operation: 'reserve',
      record: candidate,
    });
    if (reserved?.status === 'active')
      return { status: 'active', media: articleMediaView(reserved) };
    if (!reserved || reserved.pendingStorage.storageFileId !== credential.storageFileId)
      throw new ArticleDraftError('CONFLICT', 'Image storage identity changed.');
    return {
      status: 'pending',
      mediaId: id,
      articleId: request.articleId,
      expiresAt,
      upload: { method: credential.method, url: credential.uploadUrl, headers: credential.headers },
    };
  }
  let record = await media.execute(actorId, request.articleId, {
    operation: 'get',
    mediaId: request.mediaId,
  });
  if (!record) throw new ArticleDraftError('NOT_FOUND', 'Article image was not found.');
  if (request.operation === 'complete' && record.status === 'pending') {
    if (Date.parse(record.expiresAt) <= Date.now())
      throw new ArticleDraftError('CONFLICT', 'Image upload expired. Select the file again.');
    const bytes = await readBytes(record.pendingStorage.storageFileId);
    if (
      bytes.length !== record.byteSize ||
      bytes.length > ARTICLE_IMAGE_MAX_BYTES ||
      digest(bytes) !== record.checksumSha256 ||
      !signatureMatchesMime(sniffMagicBytes(bytes), record.mimeType)
    )
      throw invalid();
    let dimensions: ReturnType<typeof imageSize>;
    try {
      dimensions = imageSize(bytes);
    } catch {
      throw invalid();
    }
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > 16384 ||
      dimensions.height > 16384 ||
      dimensions.width * dimensions.height > 32_000_000
    )
      throw invalid();
    // Copy the verified bytes off the still-writable signed upload target.
    const stored = await mediaStorage().putObject({
      namespace: 'articles',
      logicalId: record.id,
      fileName: `${record.checksumSha256}.image`,
      mimeType: record.mimeType,
      content: bytes,
    });
    const active: ArticleMediaRecord = {
      ...record,
      status: 'active',
      storage: { storageFileId: stored.storageFileId, storagePath: stored.storagePath },
      width: dimensions.width,
      height: dimensions.height,
    };
    record = await media.execute(actorId, request.articleId, {
      operation: 'activate',
      record: active,
    });
  }
  if (!record || record.status !== 'active')
    throw new ArticleDraftError(
      'NOT_FOUND',
      'Article image is not ready. Complete the upload first.',
    );
  if (request.operation === 'complete') return articleMediaView(record);
  const bytes = await readBytes(record.storage.storageFileId);
  if (bytes.length !== record.byteSize || digest(bytes) !== record.checksumSha256)
    throw new ArticleDraftError('NOT_FOUND', 'Article image bytes are unavailable.');
  // Recheck after the potentially slow storage read, including current permissions.
  await media.execute(actorId, request.articleId, { operation: 'get', mediaId: record.id });
  return { ...articleMediaView(record), dataBase64: bytes.toString('base64') };
}
async function readBytes(fileId: string): Promise<Buffer> {
  try {
    const object = await mediaStorage().getObjectAsBase64(fileId);
    if (object.body.length > Math.ceil(ARTICLE_IMAGE_MAX_BYTES / 3) * 4) throw invalid();
    return Buffer.from(object.body, 'base64');
  } catch (error) {
    if (error instanceof ArticleDraftError) throw error;
    throw new ArticleDraftError(
      'NOT_FOUND',
      'Uploaded image bytes are not available yet. Retry the same upload.',
    );
  }
}
