import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ArticleBlock } from './document.ts';
import { parseArticleDraft } from './draft-repository.ts';
import { type ArticleDraft, articleContentHash, saveArticleDraft } from './drafts.ts';
import {
  type ArticleIntegration,
  authorizedIntegration,
  parseIntegrationCredential,
} from './import-credentials.ts';
import { ArticleImportError, importHash } from './import.ts';
import {
  ARTICLE_IMAGE_MAX_BYTES,
  ARTICLE_IMAGE_MAX_COUNT,
  type ArticleImageFile,
  ArticleImageFileSchema,
  type ArticleMediaRecord,
  ArticleMediaRecordSchema,
  articleIdentity,
  articleImageIds,
  articleMediaView,
} from './media.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';

export const ARTICLE_IMAGE_JOBS = 'articleImportImageJobs';
export const mediaAccessId = (keyId: string) => `media-access-${keyId}`;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operation = z.string().regex(/^article-import-[a-f0-9]{64}$/);
const policy = z
  .object({
    _id: z.string(),
    siteId: z.literal('supplychainsai.com'),
    keyId: z.string(),
    integrationId: z.string(),
    enabled: z.boolean(),
  })
  .strict();
const target = z
  .object({ storageFileId: z.string().min(1).max(2048), storagePath: z.string().min(1).max(1024) })
  .strict();
const jobSchema = z
  .object({
    _id: z.string(),
    kind: z.literal('image'),
    operationId: operation,
    articleId: articleIdentity,
    integrationId: z.string(),
    mediaId: articleIdentity,
    requestHash: digest,
    phase: z.enum(['pending', 'validating', 'active', 'failed']),
    attempts: z.number().int().nonnegative().max(12),
    lease: z
      .object({ token: z.string().uuid(), until: z.number().int().nonnegative() })
      .strict()
      .optional(),
    target: target.optional(),
  })
  .strict();
const intentInput = z.object({ requestId: articleIdentity, file: ArticleImageFileSchema }).strict();
const completeInput = z.object({ mediaId: articleIdentity }).strict();
const imageInput = z
  .object({
    mediaId: articleIdentity,
    insertAt: z.number().int().nonnegative(),
    alt: z.string().trim().min(1).max(300),
    caption: z.string().max(500).default(''),
    align: z.enum(['left', 'center', 'right']).default('center'),
  })
  .strict();
const attachInput = z
  .object({
    requestId: articleIdentity,
    expectedRevision: z.number().int().positive().safe(),
    expectedDocumentHash: digest,
    images: z.array(imageInput).min(1).max(ARTICLE_IMAGE_MAX_COUNT),
  })
  .strict();
const attachmentSchema = z
  .object({
    _id: z.string(),
    kind: z.literal('attachment'),
    operationId: operation,
    articleId: articleIdentity,
    integrationId: z.string(),
    requestHash: digest,
    revision: z.number().int().positive(),
    documentHash: digest,
    mediaIds: z.array(articleIdentity),
    appliedAt: z.string().datetime(),
  })
  .strict();
export interface ArticleImageStorage {
  mint(path: string): Promise<{
    storageFileId: string;
    storagePath: string;
    upload: { method: 'PUT'; url: string; headers: Record<string, string> };
  }>;
  read(fileId: string): Promise<Buffer>;
  validate(bytes: Buffer, file: ArticleImageFile): { width: number; height: number };
  seal(
    id: string,
    checksum: string,
    bytes: Buffer,
    checkpoint: (value: z.infer<typeof target>) => Promise<void>,
  ): Promise<z.infer<typeof target>>;
}
const error = (code: ArticleImportError['code'], message: string): never => {
  throw new ArticleImportError(code, message);
};
function parse<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) return error('INVALID_REQUEST', 'Invalid article image request.');
  return result.data;
}
async function write(
  store: ArticleStore,
  collection: string,
  value: Record<string, unknown> & { _id: string },
) {
  const { _id, ...body } = value;
  await store.write(collection, _id, body);
}

/** Only this integration's imported private draft is an image target. No administrator impersonation. */
async function owned(store: ArticleStore, credential: string, operationId: string, now: number) {
  const auth = parseIntegrationCredential(credential);
  const key = await authorizedIntegration(store, auth, now);
  if (!key) return error('UNAUTHORIZED', 'Draft integration is unavailable.');
  const capability = policy.safeParse(
    await store.read('articleIntegrations', mediaAccessId(key._id)),
  );
  if (
    !capability.success ||
    !capability.data.enabled ||
    capability.data._id !== mediaAccessId(key._id) ||
    capability.data.keyId !== key._id ||
    capability.data.integrationId !== key.integrationId
  )
    return error('UNAUTHORIZED', 'Draft image access is unavailable.');
  const raw = await store.read('articleImports', operationId);
  if (
    !raw ||
    typeof raw !== 'object' ||
    Reflect.get(raw, '_id') !== operationId ||
    Reflect.get(raw, 'integrationId') !== key.integrationId ||
    Reflect.get(raw, 'siteId') !== key.siteId
  )
    return error('NOT_FOUND', 'Imported draft was not found.');
  if (Reflect.get(raw, 'requestHash') !== importHash(Reflect.get(raw, 'source')))
    throw Error('Invalid stored import source');
  const articleId = operationId.replace('article-import-', 'article-');
  if (Reflect.get(raw, 'articleId') !== articleId) throw Error('Invalid imported draft identity');
  const row = z.record(z.unknown()).parse(await store.read('articleDrafts', articleId));
  const draft = parseArticleDraft(row.draft);
  if (
    row._id !== articleId ||
    draft.id !== articleId ||
    draft.createdBy !== `integration:${key.integrationId}`
  )
    throw Error('Invalid image owner');
  if (draft.published !== null)
    return error('CONFLICT', 'Only private drafts accept agent images.');
  return { key, articleId, row, draft };
}
function mediaRow(value: unknown, articleId: string, mediaId: string): ArticleMediaRecord {
  if (!value || typeof value !== 'object' || Reflect.get(value, '_id') !== mediaId)
    return error('NOT_FOUND', 'Article image was not found.');
  const { _id, ...body } = z.record(z.unknown()).parse(value);
  const media = ArticleMediaRecordSchema.parse(body);
  if (media.id !== mediaId || media.articleId !== articleId)
    return error('NOT_FOUND', 'Article image was not found.');
  return media;
}
function jobId(mediaId: string) {
  return `job-${mediaId}`;
}
async function imageJob(
  store: ArticleStore,
  owner: Awaited<ReturnType<typeof owned>>,
  operationId: string,
  mediaId: string,
) {
  const raw = await store.read(ARTICLE_IMAGE_JOBS, jobId(mediaId));
  if (raw === null) return error('NOT_FOUND', 'Image operation was not found.');
  const job = jobSchema.parse(raw);
  if (
    job.operationId !== operationId ||
    job.articleId !== owner.articleId ||
    job.integrationId !== owner.key.integrationId ||
    job.mediaId !== mediaId
  )
    return error('NOT_FOUND', 'Image operation was not found.');
  const media = mediaRow(await store.read('articleMedia', mediaId), owner.articleId, mediaId);
  if (
    media.createdBy !== `integration:${owner.key.integrationId}` ||
    media.requestHash !== job.requestHash
  )
    throw Error('Invalid integration image identity');
  return { job, media };
}
function stateView(draft: ArticleDraft) {
  return {
    articleId: draft.id,
    revision: draft.revision,
    documentHash: articleContentHash(draft.content),
    body: draft.content.body,
  };
}

export function createArticleImageService(
  transaction: ArticleStoreTransaction,
  storage: ArticleImageStorage,
  clock = Date.now,
) {
  // The database adapter wraps unknown exceptions. Carry known business errors out as data.
  async function tx<T>(work: (store: ArticleStore) => Promise<T>): Promise<T> {
    const result = await transaction(async (store) => {
      try {
        return { kind: 'success' as const, value: await work(store) };
      } catch (e) {
        if (e instanceof ArticleImportError)
          return {
            kind: 'failure' as const,
            failure: { code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds },
          };
        throw e;
      }
    });
    if (result.kind === 'failure')
      throw new ArticleImportError(
        result.failure.code,
        result.failure.message,
        result.failure.retryAfterSeconds,
      );
    return result.value;
  }
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ArticleImportError) throw e;
      throw new ArticleImportError(
        'UNAVAILABLE',
        'Article image operation could not be confirmed.',
      );
    }
  }
  const checked = (id: string) => parse(operation, id);
  const state = (credential: string, id: string) =>
    safe(async () =>
      tx(async (store) => stateView((await owned(store, credential, checked(id), clock())).draft)),
    );
  const intent = (credential: string, id: string, input: unknown) =>
    safe(async () => {
      checked(id);
      const request = parse(intentInput, input);
      const pre = await tx(async (store) => owned(store, credential, id, clock()));
      const mediaId = `article-media-${importHash([pre.key.integrationId, id, request.requestId])}`;
      const requestHash = importHash(request.file);
      const path = `articles/${mediaId}/pending-upload`;
      const previous = await tx(async (store) => {
        const owner = await owned(store, credential, id, clock());
        const raw = await store.read(ARTICLE_IMAGE_JOBS, jobId(mediaId));
        if (raw === null) return null;
        const r = await imageJob(store, owner, id, mediaId);
        if (r.job.requestHash !== requestHash)
          return error('CONFLICT', 'This image request already identifies another file.');
        return r;
      });
      if (previous?.media.status === 'active')
        return {
          status: 'active' as const,
          mediaId,
          storageFileId: previous.media.storage.storageFileId,
          expiresAt: previous.media.expiresAt,
          upload: null,
        };
      if (previous?.job.phase === 'failed')
        return error('INVALID_REQUEST', 'The image failed verification.');
      const minted = await storage.mint(path);
      const now = clock();
      const expiresAt = new Date(now + 15 * 60000).toISOString();
      await tx(async (store) => {
        const owner = await owned(store, credential, id, clock());
        const raw = await store.read(ARTICLE_IMAGE_JOBS, jobId(mediaId));
        if (raw !== null) {
          const r = await imageJob(store, owner, id, mediaId);
          if (
            r.job.requestHash !== requestHash ||
            r.media.pendingStorage.storageFileId !== minted.storageFileId
          )
            return error('CONFLICT', 'Image upload changed.');
          if (r.job.phase === 'failed')
            return error('INVALID_REQUEST', 'The image failed verification.');
          if (r.media.status === 'pending')
            await write(store, 'articleMedia', { _id: mediaId, ...r.media, expiresAt });
          return;
        }
        const quotas: Record<string, unknown>[] = [];
        for (const [kind, scope, max] of [
          ['article', owner.articleId, 20],
          ['day', `${owner.key.integrationId}:${Math.floor(now / 86400000)}`, 100],
        ] as const) {
          const quotaId = `quota-${importHash([kind, scope])}`;
          const quota = await store.read(ARTICLE_IMAGE_JOBS, quotaId);
          const count =
            quota === null
              ? 0
              : z
                  .object({
                    _id: z.literal(quotaId),
                    kind: z.literal('quota'),
                    count: z.number().int().nonnegative(),
                  })
                  .strict()
                  .parse(quota).count;
          if (count >= max)
            throw new ArticleImportError(
              'RATE_LIMITED',
              'The image upload limit was reached.',
              Math.max(1, Math.ceil((86400000 - (now % 86400000)) / 1000)),
            );
          quotas.push({ _id: quotaId, kind: 'quota', count: count + 1 });
        }
        if ((await store.read('articleMedia', mediaId)) !== null)
          throw Error('Media identity already occupied');
        const record = ArticleMediaRecordSchema.parse({
          ...request.file,
          id: mediaId,
          articleId: owner.articleId,
          purpose: 'article-image',
          requestHash,
          createdBy: `integration:${owner.key.integrationId}`,
          createdAt: new Date(now).toISOString(),
          expiresAt,
          status: 'pending',
          pendingStorage: { storageFileId: minted.storageFileId, storagePath: path },
        });
        for (const quota of quotas) {
          const { _id, ...rest } = quota;
          await store.write(ARTICLE_IMAGE_JOBS, z.string().parse(_id), rest);
        }
        await write(store, 'articleMedia', { _id: mediaId, ...record });
        await write(store, ARTICLE_IMAGE_JOBS, {
          _id: jobId(mediaId),
          kind: 'image',
          operationId: id,
          articleId: owner.articleId,
          integrationId: owner.key.integrationId,
          mediaId,
          requestHash,
          phase: 'pending',
          attempts: 0,
        });
      });
      return {
        status: 'pending' as const,
        mediaId,
        storageFileId: minted.storageFileId,
        expiresAt,
        upload: minted.upload,
      };
    });
  const complete = (credential: string, id: string, input: unknown) =>
    safe(async () => {
      checked(id);
      const { mediaId } = parse(completeInput, input);
      const token = randomUUID();
      const claim = await tx(async (store) => {
        const owner = await owned(store, credential, id, clock());
        const r = await imageJob(store, owner, id, mediaId);
        if (r.media.status === 'active') return { done: r.media };
        if (r.job.phase === 'failed' || r.job.attempts >= 12)
          return error('INVALID_REQUEST', 'The image failed verification.');
        if (Date.parse(r.media.expiresAt) <= clock())
          return error('CONFLICT', 'The image upload expired.');
        if (r.job.lease && r.job.lease.until > clock())
          return error('CONFLICT', 'This image is already being verified.');
        const job = {
          ...r.job,
          phase: 'validating' as const,
          attempts: r.job.attempts + 1,
          lease: { token, until: clock() + 5 * 60000 },
        };
        await write(store, ARTICLE_IMAGE_JOBS, job);
        return { pending: r.media, job };
      });
      if ('done' in claim && claim.done)
        return { status: 'active' as const, ...articleMediaView(claim.done) };
      if (!('pending' in claim) || !claim.pending) throw Error('Unconfirmed image claim');
      const pending = claim.pending;
      const bytes = await storage.read(pending.pendingStorage.storageFileId);
      let dimensions: { width: number; height: number };
      try {
        if (bytes.length !== pending.byteSize || bytes.length > ARTICLE_IMAGE_MAX_BYTES)
          throw Error('bad image length');
        dimensions = storage.validate(bytes, pending);
        if (
          dimensions.width < 1 ||
          dimensions.height < 1 ||
          dimensions.width > 16384 ||
          dimensions.height > 16384 ||
          dimensions.width * dimensions.height > 32_000_000
        )
          throw Error('bad image dimensions');
      } catch {
        await tx(async (store) => {
          const owner = await owned(store, credential, id, clock());
          const r = await imageJob(store, owner, id, mediaId);
          if (r.job.lease?.token === token) {
            const { lease, ...rest } = r.job;
            await write(store, ARTICLE_IMAGE_JOBS, { ...rest, phase: 'failed' });
          }
        });
        return error(
          'INVALID_REQUEST',
          'The image bytes, type, checksum or dimensions are invalid.',
        );
      }
      const sealed = await storage.seal(mediaId, pending.checksumSha256, bytes, async (value) => {
        await tx(async (store) => {
          const owner = await owned(store, credential, id, clock());
          const r = await imageJob(store, owner, id, mediaId);
          if (r.job.lease?.token !== token || r.job.lease.until <= clock())
            return error('CONFLICT', 'Image verification ownership changed.');
          if (r.job.target && importHash(r.job.target) !== importHash(value))
            throw Error('Sealed target changed');
          await write(store, ARTICLE_IMAGE_JOBS, { ...r.job, target: value });
        });
      });
      return tx(async (store) => {
        const owner = await owned(store, credential, id, clock());
        const r = await imageJob(store, owner, id, mediaId);
        if (
          r.job.lease?.token !== token ||
          r.job.lease.until <= clock() ||
          importHash(r.job.target) !== importHash(sealed) ||
          r.media.status !== 'pending'
        )
          return error('CONFLICT', 'Image verification ownership changed.');
        const active = ArticleMediaRecordSchema.parse({
          ...r.media,
          status: 'active',
          storage: sealed,
          ...dimensions,
        });
        if (active.status !== 'active') throw Error('Invalid active image');
        await write(store, 'articleMedia', { _id: mediaId, ...active });
        const { lease, ...rest } = r.job;
        await write(store, ARTICLE_IMAGE_JOBS, { ...rest, phase: 'active' });
        return { status: 'active' as const, ...articleMediaView(active) };
      });
    });
  const attach = (credential: string, id: string, input: unknown) =>
    safe(async () => {
      checked(id);
      const request = parse(attachInput, input);
      if (new Set(request.images.map((x) => x.mediaId)).size !== request.images.length)
        return error('INVALID_REQUEST', 'Duplicate image references.');
      return tx(async (store) => {
        const owner = await owned(store, credential, id, clock());
        const receiptId = `attachment-${importHash([owner.key.integrationId, id, request.requestId])}`;
        const requestHash = importHash(request);
        const previous = await store.read(ARTICLE_IMAGE_JOBS, receiptId);
        if (previous !== null) {
          const receipt = attachmentSchema.parse(previous);
          if (
            receipt.operationId !== id ||
            receipt.integrationId !== owner.key.integrationId ||
            receipt.requestHash !== requestHash
          )
            return error('CONFLICT', 'The image attachment request changed.');
          return attachmentView(receipt, owner.draft, true);
        }
        if (
          owner.draft.revision !== request.expectedRevision ||
          articleContentHash(owner.draft.content) !== request.expectedDocumentHash
        )
          return error(
            'CONFLICT',
            'The draft was edited. Existing changes were kept; images were not inserted.',
          );
        const existing = articleImageIds(owner.draft.content.body);
        if (existing.length + request.images.length > ARTICLE_IMAGE_MAX_COUNT)
          return error('INVALID_REQUEST', 'Too many article images.');
        const blocks = owner.draft.content.body.document.content;
        for (const image of request.images) {
          if (image.insertAt > blocks.length || existing.includes(image.mediaId))
            return error('CONFLICT', 'Image placement changed or image is already present.');
          const r = await imageJob(store, owner, id, image.mediaId);
          if (r.media.status !== 'active' || r.job.phase !== 'active')
            return error('CONFLICT', 'Complete every image before inserting.');
        }
        const next: ArticleBlock[] = [];
        for (let i = 0; i <= blocks.length; i++) {
          for (const image of request.images.filter((x) => x.insertAt === i))
            next.push({
              type: 'articleImage',
              attrs: {
                mediaId: image.mediaId,
                alt: image.alt,
                caption: image.caption,
                align: image.align,
              },
            });
          const block = blocks[i];
          if (block) next.push(block);
        }
        const draft = saveArticleDraft(owner.draft, {
          expectedRevision: request.expectedRevision,
          editorId: `integration:${owner.key.integrationId}`,
          now: new Date(clock()).toISOString(),
          content: {
            ...owner.draft.content,
            body: { schemaVersion: 1, document: { type: 'doc', content: next } },
          },
        });
        const { _id, ...body } = owner.row;
        await store.write('articleDrafts', owner.articleId, { ...body, draft });
        const receipt = attachmentSchema.parse({
          _id: receiptId,
          kind: 'attachment',
          operationId: id,
          articleId: owner.articleId,
          integrationId: owner.key.integrationId,
          requestHash,
          revision: draft.revision,
          documentHash: articleContentHash(draft.content),
          mediaIds: request.images.map((x) => x.mediaId),
          appliedAt: new Date(clock()).toISOString(),
        });
        await write(store, ARTICLE_IMAGE_JOBS, receipt);
        return attachmentView(receipt, draft, false);
      });
    });
  return { state, intent, complete, attach };
}
function attachmentView(
  receipt: z.infer<typeof attachmentSchema>,
  draft: ArticleDraft,
  replayed: boolean,
) {
  const present = new Set(articleImageIds(draft.content.body));
  return {
    articleId: receipt.articleId,
    revision: receipt.revision,
    documentHash: receipt.documentHash,
    mediaIds: receipt.mediaIds,
    appliedAt: receipt.appliedAt,
    currentRevision: draft.revision,
    complete: receipt.mediaIds.every((id) => present.has(id)),
    replayed,
    editUrl: `https://supplychainsai.com/admin/?section=articles&article=${receipt.articleId}`,
  };
}
