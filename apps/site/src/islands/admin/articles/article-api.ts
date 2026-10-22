import { type ArticleContent, ArticleContentSchema } from '@vibelingan-channel/articles';
import type { ArticleDraft, PublishedArticleReference } from '@vibelingan-channel/articles/drafts';
import { z } from 'zod';
import { AdminApiError, call } from '../api.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const revision = z.number().int().positive().safe();
const time = z.string().datetime({ precision: 3 });
const published: z.ZodType<PublishedArticleReference> = z
  .object({
    revision,
    slug: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: time,
    modifiedAt: time,
  })
  .strict();
const summary = z
  .object({
    id,
    revision,
    title: z.string(),
    excerpt: z.string(),
    authorName: z.string(),
    createdAt: time,
    updatedAt: time,
    published: published.nullable(),
  })
  .strict();
const draft: z.ZodType<ArticleDraft, z.ZodTypeDef, unknown> = summary
  .omit({ title: true, excerpt: true, authorName: true })
  .extend({
    content: ArticleContentSchema,
    createdBy: id,
    updatedBy: id,
  })
  .strict();
export type DraftSummary = z.infer<typeof summary>;
export const ArticleListSchema = z
  .object({ items: z.array(summary).max(50), nextCursor: z.string().nullable() })
  .strict();
const detail = z.object({ draft, publication: published.nullable() }).strict();

export function readDraftResponse(value: unknown, articleId?: string): ArticleDraft {
  const result = draft.safeParse(value);
  if (!result.success || (articleId && result.data.id !== articleId))
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'The saved draft could not be confirmed. Retry the same request.',
    );
  return result.data;
}
export async function listArticleDrafts(query: string, cursor: string | null, signal: AbortSignal) {
  const response = ArticleListSchema.safeParse(
    await call(
      'articleDrafts',
      { operation: 'list', query, limit: 20, ...(cursor ? { cursor } : {}) },
      signal,
    ),
  );
  if (!response.success)
    throw new AdminApiError('INVALID_RESPONSE', 'The article list could not be read.');
  return response.data;
}
export async function getArticleDraft(articleId: string, signal: AbortSignal) {
  const result = detail.safeParse(
    await call('articleDrafts', { operation: 'get', articleId }, signal),
  );
  if (!result.success)
    throw new AdminApiError('INVALID_RESPONSE', 'The article could not be opened.');
  return readDraftResponse(result.data.draft, articleId);
}
export type DraftWrite =
  | { operation: 'create'; requestId: string; content: ArticleContent }
  | { operation: 'save'; articleId: string; expectedRevision: number; content: ArticleContent };
export async function writeArticleDraft(input: DraftWrite) {
  return readDraftResponse(
    await call('articleDrafts', input),
    input.operation === 'save' ? input.articleId : undefined,
  );
}
export async function previewArticleDraft(articleId: string, expectedRevision: number) {
  const response = z
    .object({
      articleId: id,
      revision,
      body: ArticleContentSchema.shape.body,
      mediaIds: z.array(id),
    })
    .strict()
    .safeParse(await call('articleDrafts', { operation: 'preview', articleId, expectedRevision }));
  if (
    !response.success ||
    response.data.articleId !== articleId ||
    response.data.revision !== expectedRevision
  )
    throw new AdminApiError('INVALID_RESPONSE', 'The preview revision could not be confirmed.');
  return response.data;
}
