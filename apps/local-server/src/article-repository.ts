import { createHash, randomUUID } from 'node:crypto';
import { parseArticleContent } from '@vibelingan-channel/articles';
import {
  ArticleDraftError,
  type ArticleRepository,
  parseArticleDraft,
} from '@vibelingan-channel/articles/draft-repository';
import {
  createArticleDraft,
  prepareArticlePublication,
  saveArticleDraft,
} from '@vibelingan-channel/articles/drafts';
import { runArticleMediaCommand } from '@vibelingan-channel/articles/media-store';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';

type Store = Record<string, CollectionDoc[]>;
export type ArticleTransaction = <T>(
  operation: (
    store: Store,
  ) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
) => Promise<T>;

export const MAX_ARTICLE_RECORD_BYTES = 384 * 1024;
const storedRowSchema = z
  .object({
    _id: z.string().min(1).max(128),
    draft: z.unknown(),
    requestActorId: z.string().min(1).max(128),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const candidateSchema = z
  .object({
    articleId: z.string().min(1).max(128),
    revision: z.number().int().positive().safe(),
    content: z.unknown(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    frozenAt: z.string(),
  })
  .strict();

function checkRecordSize(row: unknown): void {
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > MAX_ARTICLE_RECORD_BYTES)
    throw new ArticleDraftError('VALIDATION_ERROR', 'Article draft record exceeds 384 KiB.');
}

function readDraftRecords(store: Store) {
  try {
    const ids = new Set<string>();
    const requests = new Set<string>();
    const rows = (store.articleDrafts ?? []).map((input) => {
      checkRecordSize(input);
      const row = storedRowSchema.parse(input);
      const draft = parseArticleDraft(row.draft);
      const requestKey = JSON.stringify([row.requestActorId, row.requestId]);
      if (
        row._id !== draft.id ||
        row.requestActorId !== draft.createdBy ||
        ids.has(row._id) ||
        requests.has(requestKey)
      )
        throw new Error('Inconsistent article identity');
      ids.add(row._id);
      requests.add(requestKey);
      return { ...row, draft };
    });
    store.articleDrafts = rows;
    return rows;
  } catch {
    throw new ArticleDraftError(
      'INTERNAL_ERROR',
      'Article draft storage contains an invalid record.',
    );
  }
}

function requireAdmin(store: Store, actorId: string): void {
  const user = store.users?.find((row) => row._id === actorId);
  if (!user || user.status === 'suspended')
    throw new ArticleDraftError('UNAUTHORIZED', 'This session is no longer valid.');
  if (user.role !== 'admin')
    throw new ArticleDraftError('FORBIDDEN', 'Admin permission is required.');
}

export function createLocalArticleRepository(transaction: ArticleTransaction): ArticleRepository {
  return {
    media: {
      execute: (actorId, articleId, command) =>
        transaction(async (store) => {
          let changed = false;
          const value = await runArticleMediaCommand(
            {
              read: async (collection, id) =>
                store[collection]?.find((row) => row._id === id) ?? null,
              write: async (collection, id, value) => {
                store[collection] ??= [];
                const rows = store[collection];
                const index = rows.findIndex((row) => row._id === id);
                const row = { ...value, _id: id };
                if (index < 0) rows.push(row);
                else rows[index] = row;
                changed = true;
              },
            },
            actorId,
            articleId,
            command,
          );
          return { value, changed };
        }),
    },
    create: (input) =>
      transaction((store) => {
        requireAdmin(store, input.actorId);
        const rows = readDraftRecords(store);
        const requestHash = createHash('sha256')
          .update(JSON.stringify(input.content))
          .digest('hex');
        const existing = rows.find(
          (row) => row.requestActorId === input.actorId && row.requestId === input.requestId,
        );
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ArticleDraftError(
              'CONFLICT',
              'This request ID was already used for different article content.',
            );
          return { value: parseArticleDraft(existing.draft), changed: false };
        }
        const draft = createArticleDraft({
          id: randomUUID(),
          editorId: input.actorId,
          now: new Date().toISOString(),
          content: input.content,
        });
        const row = {
          _id: draft.id,
          draft,
          requestActorId: input.actorId,
          requestId: input.requestId,
          requestHash,
        };
        checkRecordSize(row);
        rows.push(row);
        return { value: structuredClone(draft), changed: true };
      }),
    get: (input) =>
      transaction((store) => {
        requireAdmin(store, input.actorId);
        const row = readDraftRecords(store).find((item) => item._id === input.articleId);
        return { value: row ? parseArticleDraft(row.draft) : null, changed: false };
      }),
    save: (input) =>
      transaction((store) => {
        requireAdmin(store, input.actorId);
        const row = readDraftRecords(store).find((item) => item._id === input.articleId);
        if (!row) return { value: null, changed: false };
        const current = parseArticleDraft(row.draft);
        if (current.revision !== input.expectedRevision)
          throw new ArticleDraftError(
            'CONFLICT',
            'The draft changed. Reload before saving.',
            current.revision,
          );
        const saved = saveArticleDraft(current, {
          expectedRevision: input.expectedRevision,
          editorId: input.actorId,
          now: new Date().toISOString(),
          content: input.content,
        });
        checkRecordSize({ ...row, draft: saved });
        row.draft = saved;
        return { value: saved, changed: saved.revision !== current.revision };
      }),
    list: (input) =>
      transaction((store) => {
        requireAdmin(store, input.actorId);
        const query = input.query.toLowerCase();
        let afterId = '';
        if (input.cursor) {
          try {
            if (Buffer.from(input.cursor, 'base64url').toString('base64url') !== input.cursor)
              throw new Error('Non-canonical cursor');
            const decoded = z
              .object({ afterId: z.string().min(1).max(128), query: z.string().max(200) })
              .strict()
              .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
            if (decoded.query !== query) throw new Error('Cursor query changed');
            afterId = decoded.afterId;
          } catch {
            throw new ArticleDraftError('VALIDATION_ERROR', 'Invalid article list cursor.');
          }
        }
        const rows = readDraftRecords(store)
          .map((row) => row.draft)
          .filter(
            (draft) => draft.id > afterId && draft.content.title.toLowerCase().includes(query),
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const selected = rows.slice(0, input.limit);
        const last = selected.at(-1);
        return {
          value: {
            items: selected.map((draft) => ({
              id: draft.id,
              revision: draft.revision,
              title: draft.content.title,
              excerpt: draft.content.excerpt,
              authorName: draft.content.authorName,
              createdAt: draft.createdAt,
              updatedAt: draft.updatedAt,
              published: draft.published,
            })),
            nextCursor:
              rows.length > input.limit && last
                ? Buffer.from(JSON.stringify({ afterId: last.id, query })).toString('base64url')
                : null,
          },
          changed: false,
        };
      }),
    getPublication: (input) =>
      transaction((store) => {
        requireAdmin(store, input.actorId);
        const row = store.articlePublications?.find(
          (item) => item._id === `${input.articleId}:${input.revision}`,
        );
        if (!row) return { value: null, changed: false };
        try {
          checkRecordSize(row);
          const candidate = candidateSchema.parse(row.candidate);
          if (candidate.articleId !== input.articleId || candidate.revision !== input.revision)
            throw new Error('Snapshot identity mismatch');
          const draft = createArticleDraft({
            id: candidate.articleId,
            editorId: input.actorId,
            now: candidate.frozenAt,
            content: parseArticleContent(candidate.content),
          });
          draft.revision = candidate.revision;
          const checked = prepareArticlePublication(draft, candidate.frozenAt);
          if (checked.contentHash !== candidate.contentHash)
            throw new Error('Snapshot content hash mismatch');
          return { value: checked, changed: false };
        } catch {
          throw new ArticleDraftError(
            'INTERNAL_ERROR',
            'Article publication storage contains an invalid snapshot.',
          );
        }
      }),
  };
}
