import { z } from 'zod';
import { type ArticleContent, ArticleContentSchema } from './article.ts';
import { readArticleInput } from './document.ts';
import {
  type ArticleCandidate,
  type ArticleDraft,
  type PublishedArticleReference,
  saveArticleDraft,
} from './drafts.ts';

export interface ArticleDraftSummary {
  id: string;
  revision: number;
  title: string;
  excerpt: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  published: PublishedArticleReference | null;
}

export interface ArticleRepository {
  create(input: {
    actorId: string;
    requestId: string;
    content: ArticleContent;
  }): Promise<ArticleDraft>;
  get(input: { actorId: string; articleId: string }): Promise<ArticleDraft | null>;
  save(input: {
    actorId: string;
    articleId: string;
    expectedRevision: number;
    content: ArticleContent;
  }): Promise<ArticleDraft | null>;
  list(input: { actorId: string; limit: number; query: string; cursor?: string }): Promise<{
    items: ArticleDraftSummary[];
    nextCursor: string | null;
  }>;
  /** Private administrative read; this does not establish live delivery. */
  getPublication(input: {
    actorId: string;
    articleId: string;
    revision: number;
  }): Promise<ArticleCandidate | null>;
}

const articleErrorBrand = Symbol.for('vibelingan.channel.article-draft-error');
const articleErrorCodes = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
]);

export class ArticleDraftError extends Error {
  readonly [articleErrorBrand] = true;
  constructor(
    readonly code:
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VALIDATION_ERROR'
      | 'INTERNAL_ERROR',
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'ArticleDraftError';
  }
}

/** The CJS admin and ESM local adapter can load separate copies of this class. */
export function isArticleDraftError(error: unknown): error is ArticleDraftError {
  if (typeof error !== 'object' || error === null || Reflect.get(error, articleErrorBrand) !== true)
    return false;
  const code: unknown = Reflect.get(error, 'code');
  const message: unknown = Reflect.get(error, 'message');
  const revision: unknown = Reflect.get(error, 'currentRevision');
  return (
    typeof code === 'string' &&
    articleErrorCodes.has(code) &&
    typeof message === 'string' &&
    (revision === undefined ||
      (typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0))
  );
}

const publishedSchema = z
  .object({
    revision: z.number().int().positive().safe(),
    slug: z.string(),
    contentHash: z.string(),
    publishedAt: z.string(),
    modifiedAt: z.string(),
  })
  .strict();
const draftSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive().safe(),
    content: ArticleContentSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string(),
    updatedBy: z.string(),
    published: publishedSchema.nullable(),
  })
  .strict();

/** Revalidate data from persistence before it reaches a caller. */
export function parseArticleDraft(value: unknown): ArticleDraft {
  const draft = readArticleInput(draftSchema, value);
  return saveArticleDraft(draft, {
    expectedRevision: draft.revision,
    editorId: draft.updatedBy,
    now: draft.updatedAt,
    content: draft.content,
  });
}
