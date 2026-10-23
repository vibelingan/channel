/** Server-only CloudBase persistence; no resource creation or publication side effects. */
import { createHash } from 'node:crypto';
import { parseArticleContent } from '@vibelingan-channel/articles';
import {
  ArticleDraftError,
  type ArticleRepository,
  isArticleDraftError,
  parseArticleDraft,
  parseArticleDraftSummary,
} from '@vibelingan-channel/articles/draft-repository';
import {
  createArticleDraft,
  prepareArticlePublication,
  saveArticleDraft,
} from '@vibelingan-channel/articles/drafts';
import { runArticleMediaCommand } from '@vibelingan-channel/articles/media-store';
import { z } from 'zod';

interface ArticleDocumentReference {
  get(): Promise<unknown>;
  set(data: Record<string, unknown>): Promise<unknown>;
}
interface ArticleQuery {
  where(condition: Record<string, unknown>): ArticleQuery;
  orderBy(field: string, direction: 'asc'): ArticleQuery;
  limit(count: number): ArticleQuery;
  field(projection: Record<string, boolean>): ArticleQuery;
  get(): Promise<unknown>;
}
export interface ArticleDatabase {
  collection(name: string): ArticleQuery;
  command: { gt(value: string): unknown };
  RegExp: new (options: { regexp: string }) => unknown;
  runTransaction<T>(
    operation: (transaction: {
      collection(name: string): { doc(id: string): ArticleDocumentReference };
    }) => Promise<T>,
  ): Promise<T>;
}
type Transaction = Parameters<Parameters<ArticleDatabase['runTransaction']>[0]>[0];
const MAX_RECORD_BYTES = 384 * 1024;
const identity = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
const rowSchema = z
  .object({
    _id: identity,
    draft: z.unknown(),
    requestActorId: identity,
    requestId,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchTitle: z.string().max(400),
  })
  .strict();
const listProjection = {
  _id: true,
  searchTitle: true,
  'draft.id': true,
  'draft.revision': true,
  'draft.content.title': true,
  'draft.content.excerpt': true,
  'draft.content.authorName': true,
  'draft.createdAt': true,
  'draft.updatedAt': true,
  'draft.published': true,
};
const listRowSchema = z
  .object({
    _id: identity,
    searchTitle: z.string().max(400),
    draft: z
      .object({
        id: identity,
        revision: z.number(),
        content: z
          .object({ title: z.string(), excerpt: z.string(), authorName: z.string() })
          .strict(),
        createdAt: z.string(),
        updatedAt: z.string(),
        published: z.unknown(),
      })
      .strict(),
  })
  .strict();

function decodeCursor(cursor: string | undefined, query: string): string {
  if (cursor === undefined) return '';
  try {
    if (cursor.length > 1024 || Buffer.from(cursor, 'base64url').toString('base64url') !== cursor)
      throw internal();
    const decoded = z
      .object({ afterId: identity, query: z.string().max(200) })
      .strict()
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (decoded.query !== query) throw internal();
    return decoded.afterId;
  } catch {
    throw new ArticleDraftError('VALIDATION_ERROR', 'Invalid article list cursor.');
  }
}

function internal(): ArticleDraftError {
  return new ArticleDraftError(
    'INTERNAL_ERROR',
    'Article draft storage is unavailable or contains invalid data.',
  );
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isArticleDraftError(error)) throw error;
    throw internal();
  }
}

function checkSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RECORD_BYTES)
    throw new ArticleDraftError('VALIDATION_ERROR', 'Article draft record exceeds 384 KiB.');
}

async function read(reference: ArticleDocumentReference): Promise<unknown> {
  const result = await reference.get();
  if (
    typeof result !== 'object' ||
    result === null ||
    !Object.hasOwn(result, 'data') ||
    Reflect.get(result, 'code') ||
    Reflect.get(result, 'data') === undefined
  )
    throw internal();
  return Reflect.get(result, 'data');
}

async function requireAdmin(transaction: Transaction, actorId: string): Promise<void> {
  const user = await read(transaction.collection('users').doc(actorId));
  if (user === null)
    throw new ArticleDraftError('UNAUTHORIZED', 'This session is no longer valid.');
  if (typeof user !== 'object' || Array.isArray(user) || Reflect.get(user, '_id') !== actorId)
    throw internal();
  if (Reflect.get(user, 'status') === 'suspended')
    throw new ArticleDraftError('UNAUTHORIZED', 'This session is no longer valid.');
  if (Reflect.get(user, 'role') !== 'admin')
    throw new ArticleDraftError('FORBIDDEN', 'Admin permission is required.');
}

function stored(value: unknown, articleId: string) {
  try {
    checkSize(value);
    const row = rowSchema.parse(value);
    const draft = parseArticleDraft(row.draft);
    if (
      row._id !== articleId ||
      draft.id !== articleId ||
      row.requestActorId !== draft.createdBy ||
      row.searchTitle !== draft.content.title.toLowerCase()
    )
      throw internal();
    return { ...row, draft };
  } catch {
    throw internal();
  }
}

async function write(
  reference: ArticleDocumentReference,
  row: z.infer<typeof rowSchema>,
): Promise<void> {
  checkSize(row);
  const { _id, ...body } = row;
  const result = await reference.set(body);
  if (typeof result !== 'object' || result === null || Reflect.get(result, 'code'))
    throw internal();
  if (Reflect.get(result, 'updated') === 1) return;
  const upserted: unknown = Reflect.get(result, 'upserted');
  if (Array.isArray(upserted) && upserted.length === 1 && upserted[0]?._id === _id) return;
  throw internal();
}

export function createCloudBaseArticleRepository(db: ArticleDatabase): ArticleRepository {
  return {
    media: {
      execute: (actorId, articleId, command) =>
        safe(() =>
          db.runTransaction((transaction) =>
            runArticleMediaCommand(
              {
                read: (collection, id) => read(transaction.collection(collection).doc(id)),
                write: async (collection, id, value) => {
                  const result = await transaction.collection(collection).doc(id).set(value);
                  if (typeof result !== 'object' || result === null || Reflect.get(result, 'code'))
                    throw internal();
                  const inserted: unknown = Reflect.get(result, 'upserted');
                  if (
                    Reflect.get(result, 'updated') !== 1 &&
                    !(Array.isArray(inserted) && inserted.length === 1 && inserted[0]?._id === id)
                  )
                    throw internal();
                },
              },
              actorId,
              articleId,
              command,
            ),
          ),
        ),
    },
    create: (input) =>
      safe(async () => {
        const actorId = identity.parse(input.actorId);
        const operationId = requestId.parse(input.requestId);
        const content = parseArticleContent(input.content);
        const id = `article-${createHash('sha256')
          .update(JSON.stringify([actorId, operationId]))
          .digest('hex')}`;
        const requestHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
        return db.runTransaction(async (transaction) => {
          await requireAdmin(transaction, actorId);
          const reference = transaction.collection('articleDrafts').doc(id);
          const existing = await read(reference);
          if (existing !== null) {
            const row = stored(existing, id);
            if (
              row.requestActorId !== actorId ||
              row.requestId !== operationId ||
              row.requestHash !== requestHash
            )
              throw new ArticleDraftError(
                'CONFLICT',
                'This request ID was already used for different article content.',
              );
            return row.draft;
          }
          const draft = createArticleDraft({
            id,
            editorId: actorId,
            now: new Date().toISOString(),
            content,
          });
          await write(reference, {
            _id: id,
            draft,
            requestActorId: actorId,
            requestId: operationId,
            requestHash,
            searchTitle: content.title.toLowerCase(),
          });
          return draft;
        });
      }),
    get: (input) =>
      safe(() =>
        db.runTransaction(async (transaction) => {
          await requireAdmin(transaction, identity.parse(input.actorId));
          const articleId = identity.parse(input.articleId);
          const row = await read(transaction.collection('articleDrafts').doc(articleId));
          return row === null ? null : stored(row, articleId).draft;
        }),
      ),
    save: (input) =>
      safe(() =>
        db.runTransaction(async (transaction) => {
          await requireAdmin(transaction, identity.parse(input.actorId));
          const articleId = identity.parse(input.articleId);
          const reference = transaction.collection('articleDrafts').doc(articleId);
          const value = await read(reference);
          if (value === null) return null;
          const row = stored(value, articleId);
          if (row.draft.revision !== input.expectedRevision)
            throw new ArticleDraftError(
              'CONFLICT',
              'The draft changed. Reload before saving.',
              row.draft.revision,
            );
          const saved = saveArticleDraft(row.draft, {
            expectedRevision: input.expectedRevision,
            editorId: input.actorId,
            now: new Date().toISOString(),
            content: parseArticleContent(input.content),
          });
          if (saved.revision !== row.draft.revision)
            await write(reference, {
              ...row,
              draft: saved,
              searchTitle: saved.content.title.toLowerCase(),
            });
          return saved;
        }),
      ),
    list: (input) =>
      safe(async () => {
        const actorId = identity.parse(input.actorId);
        const query = z.string().trim().max(100).parse(input.query).toLowerCase();
        const limit = z.number().int().min(1).max(50).parse(input.limit);
        const afterId = decodeCursor(input.cursor, query);
        await db.runTransaction((transaction) => requireAdmin(transaction, actorId));
        const filter: Record<string, unknown> = {};
        if (afterId) filter._id = db.command.gt(afterId);
        if (query)
          filter.searchTitle = new db.RegExp({
            regexp: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          });
        const result = await db
          .collection('articleDrafts')
          .where(filter)
          .orderBy('_id', 'asc')
          .limit(limit + 1)
          .field(listProjection)
          .get();
        if (typeof result !== 'object' || result === null || Reflect.get(result, 'code'))
          throw internal();
        const rows: unknown = Reflect.get(result, 'data');
        if (!Array.isArray(rows) || rows.length > limit + 1) throw internal();
        const summaries = rows.map((value) => {
          const row = listRowSchema.parse(value);
          if (row._id !== row.draft.id || row.searchTitle !== row.draft.content.title.toLowerCase())
            throw internal();
          return parseArticleDraftSummary({
            id: row.draft.id,
            revision: row.draft.revision,
            ...row.draft.content,
            createdAt: row.draft.createdAt,
            updatedAt: row.draft.updatedAt,
            published: row.draft.published,
          });
        });
        // A collection query is separate from document transactions; re-anchor before release.
        await db.runTransaction((transaction) => requireAdmin(transaction, actorId));
        const items = summaries.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            summaries.length > limit && last
              ? Buffer.from(JSON.stringify({ afterId: last.id, query })).toString('base64url')
              : null,
        };
      }),
    getPublication: (input) =>
      safe(() =>
        db.runTransaction(async (transaction) => {
          await requireAdmin(transaction, identity.parse(input.actorId));
          const articleId = identity.parse(input.articleId);
          const revision = z.number().int().positive().safe().parse(input.revision);
          const row = await read(
            transaction.collection('articlePublications').doc(`${articleId}:${revision}`),
          );
          if (row === null) return null;
          try {
            checkSize(row);
            const stored = z
              .object({ _id: z.literal(`${articleId}:${revision}`), candidate: z.unknown() })
              .strict()
              .parse(row);
            const candidate = z
              .object({
                articleId: z.literal(articleId),
                revision: z.literal(revision),
                content: z.unknown(),
                contentHash: z.string().regex(/^[a-f0-9]{64}$/),
                frozenAt: z.string(),
              })
              .strict()
              .parse(stored.candidate);
            const draft = createArticleDraft({
              id: articleId,
              editorId: input.actorId,
              now: candidate.frozenAt,
              content: parseArticleContent(candidate.content),
            });
            draft.revision = revision;
            const checked = prepareArticlePublication(draft, candidate.frozenAt);
            if (checked.contentHash !== candidate.contentHash) throw internal();
            return checked;
          } catch {
            throw internal();
          }
        }),
      ),
  };
}
