import { z } from 'zod';
import { ArticleDraftError, parseArticleDraft } from './draft-repository.ts';
import { type ArticleDraft, articleContentHash, saveArticleDraft } from './drafts.ts';
import {
  type ArticleIntegration,
  authorizedIntegration,
  parseIntegrationCredential,
} from './import-credentials.ts';
import { validateStoredArticleImport } from './import-store.ts';
import { ArticleImportError, importHash, prepareArticleImport } from './import.ts';
import { articleImageIds } from './media.ts';
import { parsePublishedArticle } from './publication.ts';
import { createArticleReleaseStore } from './release-store.ts';
import type { ArticleStore, ArticleStoreTransaction } from './transaction-store.ts';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationIdentity = z.string().regex(/^article-import-[a-f0-9]{64}$/);
const accessSchema = z
  .object({
    _id: z.string(),
    siteId: z.literal('supplychainsai.com'),
    keyId: z.string(),
    integrationId: z.string(),
    enabled: z.boolean(),
  })
  .strict();
export const publicationAccessId = (keyId: string) => `publication-access-${keyId}`;
export const ArticleImportPublicationRequestSchema = z
  .object({
    operation: z.enum(['publish', 'withdraw']),
    requestId: identity,
    expectedRevision: z.number().int().positive().safe(),
    expectedContentHash: hash,
    expectedSourceHash: hash,
    approval: z
      .object({
        decision: z.enum(['publish-now', 'withdraw-now']),
        messageRef: z.string().trim().min(1).max(200),
        instruction: z.string().trim().min(1).max(1000),
      })
      .strict(),
  })
  .strict()
  .refine((r) => r.approval.decision === `${r.operation}-now`);
export interface ArticleImportPublicationReceipt {
  operationId: string;
  articleId: string;
  revision: number;
  contentHash: string;
  state: 'ready' | 'published' | 'withdrawn';
  publicUrl: string | null;
  sourceHash: string;
  publishedModifiedAt: string | null;
  publishedRevision: number | null;
  publishedContentHash: string | null;
  canPublish: boolean;
  replayed: boolean;
  releaseId: string | null;
}
const fail = (code: ArticleImportError['code'], message: string): never => {
  throw new ArticleImportError(code, message);
};
function parsed<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  schema: S,
  value: unknown,
): z.output<S> {
  const p = schema.safeParse(value);
  if (!p.success) return fail('INVALID_REQUEST', 'Invalid publication request.');
  return p.data;
}
function known(error: unknown): ArticleImportError | null {
  if (error instanceof ArticleImportError) return error;
  if (error instanceof ArticleDraftError) {
    if (['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
      return new ArticleImportError('UNAUTHORIZED', 'Publication access is unavailable.');
    if (error.code === 'CONFLICT') return new ArticleImportError('CONFLICT', error.message);
    if (error.code === 'NOT_FOUND')
      return new ArticleImportError('NOT_FOUND', 'Owned article was not found.');
    if (error.code === 'VALIDATION_ERROR')
      return new ArticleImportError('INVALID_REQUEST', error.message);
  }
  return null;
}
async function owned(store: ArticleStore, credential: string, operationId: string, time: number) {
  const auth = parseIntegrationCredential(credential);
  const key = await authorizedIntegration(store, auth, time);
  if (!key) return fail('UNAUTHORIZED', 'Publication access is unavailable.');
  const access = accessSchema.safeParse(
    await store.read('articleIntegrations', publicationAccessId(key._id)),
  );
  if (
    !access.success ||
    !access.data.enabled ||
    access.data._id !== publicationAccessId(key._id) ||
    access.data.keyId !== key._id ||
    access.data.integrationId !== key.integrationId
  )
    return fail('UNAUTHORIZED', 'Publication access is unavailable.');
  const value = await store.read('articleImports', operationId);
  if (
    !value ||
    typeof value !== 'object' ||
    Reflect.get(value, 'integrationId') !== key.integrationId
  )
    return fail('NOT_FOUND', 'Owned article was not found.');
  const imported = await validateStoredArticleImport(store, value, key);
  if (imported._id !== operationId) throw Error('Publication import identity differs');
  const draftValue = await store.read('articleDrafts', imported.articleId);
  const draft = parseArticleDraft(
    draftValue && typeof draftValue === 'object' ? Reflect.get(draftValue, 'draft') : null,
  );
  return { key, imported, draft };
}
async function snapshot(
  store: ArticleStore,
  operationId: string,
  key: ArticleIntegration,
  draft: ArticleDraft,
  sourceHash: string,
): Promise<ArticleImportPublicationReceipt> {
  const accepted = await store.read('articleAccepted', draft.id);
  const head = await store.read('articleReleaseHeads', draft.id);
  const published =
    accepted && typeof accepted === 'object' ? Reflect.get(accepted, 'publication') : null;
  const article =
    published === null || published === undefined ? null : parsePublishedArticle(published);
  if (
    article &&
    (article.articleId !== draft.id ||
      article.contentHash !== draft.published?.contentHash ||
      article.revision !== draft.published?.revision)
  )
    throw Error('Current publication reference differs');
  if (!article && draft.published) throw Error('Current publication is unavailable');
  const wasPublished =
    head && typeof head === 'object' && Reflect.get(head, 'firstPublishedAt') != null;
  return {
    operationId,
    articleId: draft.id,
    revision: draft.revision,
    sourceHash,
    publishedModifiedAt: article?.modifiedAt ?? null,
    contentHash: articleContentHash(draft.content),
    state: article ? 'published' : wasPublished ? 'withdrawn' : 'ready',
    publicUrl: article ? `https://supplychainsai.com/blog/${article.content.slug}/` : null,
    publishedRevision: article?.revision ?? null,
    publishedContentHash: article?.contentHash ?? null,
    canPublish: draft.updatedBy === `integration:${key.integrationId}`,
    replayed: false,
    releaseId:
      head && typeof head === 'object' && typeof Reflect.get(head, 'taskId') === 'string'
        ? Reflect.get(head, 'taskId')
        : null,
  };
}
const auditSchema = z
  .object({
    _id: z.string(),
    kind: z.literal('publication'),
    siteId: z.literal('supplychainsai.com'),
    integrationId: z.string(),
    operationId: operationIdentity,
    requestHash: hash,
    releaseId: identity,
    createdAt: z.string().datetime(),
    messageRefHash: hash,
  })
  .strict();

/** Publication is a separately granted server capability; old draft keys remain draft-only. */
export function createArticleImportPublicationService(
  transaction: ArticleStoreTransaction,
  clock = Date.now,
) {
  async function transact<T>(work: (store: ArticleStore) => Promise<T>): Promise<T> {
    try {
      const result = await transaction(async (raw) => {
        let wrote = false;
        const reads = new Map<string, Promise<unknown>>();
        const store: ArticleStore = {
          read: (collection, id) => {
            const name = `${collection}/${id}`;
            let value = reads.get(name);
            if (!value) {
              value = raw.read(collection, id);
              reads.set(name, value);
            }
            return value;
          },
          write: async (collection, id, value) => {
            wrote = true;
            await raw.write(collection, id, value);
          },
        };
        try {
          return { value: await work(store) };
        } catch (error) {
          const expected = known(error);
          // Never turn a write/commit failure into a successful partial transaction.
          if (!wrote && expected) return { failure: expected };
          throw error;
        }
      });
      if ('failure' in result) throw result.failure;
      return result.value;
    } catch (error) {
      throw (
        known(error) ??
        new ArticleImportError(
          'UNAVAILABLE',
          'Publication could not be confirmed. Keep the same request.',
        )
      );
    }
  }
  return {
    state: (credential: string, operationId: string) =>
      transact(async (store) => {
        parsed(operationIdentity, operationId);
        const { key, draft, imported } = await owned(store, credential, operationId, clock());
        return snapshot(store, operationId, key, draft, imported.requestHash);
      }),
    sync: async (
      credential: string,
      operationId: string,
      value: unknown,
    ): Promise<ArticleImportPublicationReceipt> => {
      parsed(operationIdentity, operationId);
      const input = parsed(
        z
          .object({
            requestId: identity,
            expectedRevision: z.number().int().positive().safe(),
            expectedContentHash: hash,
            expectedSourceHash: hash,
            source: z.unknown(),
          })
          .strict(),
        value,
      );
      const prepared = prepareArticleImport(input.source);
      return transact(async (store) => {
        const time = clock();
        const { key, imported, draft } = await owned(store, credential, operationId, time);
        const before = await snapshot(store, operationId, key, draft, imported.requestHash);
        const id = `source-sync-request-${importHash([key.integrationId, input.requestId])}`;
        const digest = importHash([operationId, input]);
        const prior = await store.read('articleImports', id);
        if (prior !== null) {
          const saved = z
            .object({
              _id: z.literal(id),
              kind: z.literal('source-sync'),
              integrationId: z.literal(key.integrationId),
              operationId: z.literal(operationId),
              requestHash: hash,
            })
            .strict()
            .parse(prior);
          if (saved.requestHash !== digest)
            return fail(
              'CONFLICT',
              'This source update request was already used for other content.',
            );
          return { ...before, replayed: true };
        }
        if (
          draft.updatedBy !== `integration:${key.integrationId}` ||
          draft.revision !== input.expectedRevision ||
          before.contentHash !== input.expectedContentHash ||
          imported.requestHash !== input.expectedSourceHash
        )
          return fail(
            'CONFLICT',
            'The website draft changed. Preserve human changes instead of replacing it.',
          );
        const oldSource = prepareArticleImport(imported.source);
        if (
          prepared.source.idempotencyKey !== oldSource.source.idempotencyKey ||
          prepared.source.externalTaskId !== oldSource.source.externalTaskId
        )
          return fail('CONFLICT', 'Source identity cannot be replaced.');
        if (prepared.requestHash === imported.requestHash) return { ...before, replayed: true };
        if (
          articleImageIds(draft.content.body).length &&
          importHash(prepared.content.body) !== importHash(oldSource.content.body)
        )
          return fail(
            'CONFLICT',
            'The text changed after image placement. Confirm the intended layout; images will not be silently removed.',
          );
        const content = {
          ...prepared.content,
          body:
            importHash(prepared.content.body) === importHash(oldSource.content.body)
              ? draft.content.body
              : prepared.content.body,
        };
        const next = saveArticleDraft(draft, {
          expectedRevision: draft.revision,
          editorId: `integration:${key.integrationId}`,
          now: new Date(time).toISOString(),
          content,
        });
        const rawDraft = await store.read('articleDrafts', draft.id);
        if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft))
          throw Error('Owned draft disappeared');
        const { _id: _draftId, ...draftBody } = z.record(z.unknown()).parse(rawDraft);
        const { _id: _importId, ...importBody } = imported;
        await store.write('articleDrafts', draft.id, {
          ...draftBody,
          draft: next,
          searchTitle: next.content.title.toLowerCase(),
        });
        await store.write('articleImports', operationId, {
          ...importBody,
          source: prepared.source,
          requestHash: prepared.requestHash,
        });
        await store.write('articleImports', id, {
          kind: 'source-sync',
          integrationId: key.integrationId,
          operationId,
          requestHash: digest,
        });
        return {
          ...before,
          revision: next.revision,
          contentHash: articleContentHash(next.content),
          sourceHash: prepared.requestHash,
        };
      });
    },
    change: async (
      credential: string,
      operationId: string,
      value: unknown,
    ): Promise<ArticleImportPublicationReceipt> => {
      parsed(operationIdentity, operationId);
      const input = parsed(ArticleImportPublicationRequestSchema, value);
      const auth = parseIntegrationCredential(credential);
      const actorId = `publisher:${auth.keyId}`;
      const requestHash = importHash([operationId, input]);
      const auditId = `publication-request-${importHash([actorId, input.requestId])}`;
      const state: {
        proof:
          | {
              key: ArticleIntegration;
              draft: ArticleDraft;
              before: ArticleImportPublicationReceipt;
              audit: z.infer<typeof auditSchema> | null;
              limits: { id: string; body: Record<string, unknown> }[];
            }
          | undefined;
        receipt?: ArticleImportPublicationReceipt;
      } = { proof: undefined };
      function requireProof() {
        const proof = state.proof;
        if (!proof) throw Error('Publication authority was not established');
        return proof;
      }
      const guarded: ArticleStoreTransaction = <T>(work: (store: ArticleStore) => Promise<T>) =>
        transact(async (store) => {
          state.proof = undefined;
          const result = await work(store);
          const proof = requireProof();
          const task = z
            .object({
              id: identity,
              state: z.literal('SUCCEEDED'),
              updatedAt: z.string().datetime(),
            })
            .passthrough()
            .parse(result);
          if (proof.audit) {
            if (proof.audit.releaseId !== task.id) throw Error('Publication receipt differs');
            state.receipt = { ...proof.before, replayed: true };
          } else {
            const published = input.operation === 'publish';
            state.receipt = {
              ...proof.before,
              state: published ? 'published' : 'withdrawn',
              publicUrl: published
                ? `https://supplychainsai.com/blog/${proof.draft.content.slug}/`
                : null,
              publishedRevision: published ? proof.draft.revision : null,
              publishedContentHash: published ? articleContentHash(proof.draft.content) : null,
              publishedModifiedAt: published ? task.updatedAt : null,
              releaseId: task.id,
              replayed: false,
            };
            for (const counter of proof.limits)
              await store.write('articleImportLimits', counter.id, counter.body);
            await store.write('articleImports', auditId, {
              kind: 'publication',
              siteId: proof.key.siteId,
              integrationId: proof.key.integrationId,
              operationId,
              requestHash,
              releaseId: task.id,
              createdAt: new Date(clock()).toISOString(),
              messageRefHash: importHash(input.approval.messageRef),
            });
          }
          return result;
        });
      const release = createArticleReleaseStore(guarded, clock, {
        mode: 'server',
        authorizeRequest: async (store, actor, request) => {
          const { key, draft, imported } = await owned(store, credential, operationId, clock());
          if (
            actor !== actorId ||
            request.articleId !== draft.id ||
            request.operation !== input.operation
          )
            throw Error('Publication authority target differs');
          const rawAudit = await store.read('articleImports', auditId);
          const audit = rawAudit === null ? null : auditSchema.parse(rawAudit);
          if (
            audit &&
            (audit._id !== auditId ||
              audit.requestHash !== requestHash ||
              audit.integrationId !== key.integrationId ||
              audit.operationId !== operationId)
          )
            return fail(
              'CONFLICT',
              'This publication request was already used for another result.',
            );
          const before = await snapshot(store, operationId, key, draft, imported.requestHash);
          if (
            !audit &&
            (draft.updatedBy !== `integration:${key.integrationId}` ||
              draft.revision !== input.expectedRevision ||
              before.contentHash !== input.expectedContentHash ||
              before.sourceHash !== input.expectedSourceHash)
          )
            return fail(
              'CONFLICT',
              'The prepared article changed. Preserve human edits and confirm the intended version.',
            );
          const limits: { id: string; body: Record<string, unknown> }[] = [];
          if (!audit) {
            const time = clock();
            for (const [kind, milliseconds, maximum] of [
              ['minute', 60000, 10],
              ['day', 86400000, 100],
            ] as const) {
              const id = `publication-limit-${importHash([key.integrationId, kind])}`;
              const current = z
                .object({
                  _id: z.literal(id),
                  integrationId: z.literal(key.integrationId),
                  kind: z.literal(kind),
                  window: z.number().int().nonnegative().safe(),
                  count: z.number().int().nonnegative().safe(),
                })
                .strict()
                .nullable()
                .parse(await store.read('articleImportLimits', id));
              const window = Math.floor(time / milliseconds);
              if (current && current.window > window)
                throw Error('Publication clock moved backwards');
              const count = current?.window === window ? current.count : 0;
              if (count >= maximum)
                throw new ArticleImportError(
                  'RATE_LIMITED',
                  'Publication limit reached.',
                  Math.ceil(((window + 1) * milliseconds - time) / 1000),
                );
              limits.push({
                id,
                body: { integrationId: key.integrationId, kind, window, count: count + 1 },
              });
            }
          }
          state.proof = { key, draft, before, audit, limits };
        },
      });
      await release.request(actorId, {
        operation: input.operation,
        articleId: operationId.replace('article-import-', 'article-'),
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
      });
      if (!state.receipt)
        throw new ArticleImportError('UNAVAILABLE', 'Publication receipt is unavailable.');
      return state.receipt;
    },
  };
}
