import { z } from 'zod';
import { parseArticleContent } from './article.ts';
import { type ArticleNode, ArticleValidationError } from './document.ts';
import { ArticleDraftError, type ArticleRepository } from './draft-repository.ts';
import { ARTICLE_IMAGE_MAX_COUNT, articleImageIds } from './media.ts';

export const MAX_ARTICLE_REQUEST_BYTES = 256 * 1024;

const requestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      requestId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9:_-]+$/),
      content: z.unknown(),
    })
    .strict(),
  z.object({ operation: z.literal('get'), articleId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      operation: z.literal('save'),
      articleId: z.string().min(1).max(128),
      expectedRevision: z.number().int().positive().safe(),
      content: z.unknown(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('list'),
      limit: z.number().int().min(1).max(50).default(20),
      query: z.string().trim().max(100).default(''),
      cursor: z.string().min(1).max(1024).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('preview'),
      articleId: z.string().min(1).max(128),
      expectedRevision: z.number().int().positive().safe(),
    })
    .strict(),
]);

export async function executeArticleDraftRequest(
  repository: ArticleRepository,
  actorId: string,
  input: unknown,
): Promise<unknown> {
  try {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      throw new ArticleDraftError('VALIDATION_ERROR', 'Article draft request must be JSON.');
    }
    if (!encoded)
      throw new ArticleDraftError(
        'VALIDATION_ERROR',
        'Article draft request must be a JSON object.',
      );
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ARTICLE_REQUEST_BYTES)
      throw new ArticleDraftError('VALIDATION_ERROR', 'Article draft request exceeds 256 KiB.');
    const request = requestSchema.parse(input);
    if (request.operation === 'create' || request.operation === 'save') {
      const content = parseArticleContent(request.content);
      const ids = articleImageIds(content.body);
      if (ids.length > ARTICLE_IMAGE_MAX_COUNT)
        throw new ArticleDraftError(
          'VALIDATION_ERROR',
          'An article supports at most 20 different images.',
        );
      if (ids.length && request.operation === 'create')
        throw new ArticleDraftError(
          'VALIDATION_ERROR',
          'Save the new draft before uploading article images.',
        );
      if (request.operation === 'save')
        for (const mediaId of ids) {
          const image = await repository.media?.execute(actorId, request.articleId, {
            operation: 'get',
            mediaId,
          });
          if (!image || image.status !== 'active')
            throw new ArticleDraftError(
              'VALIDATION_ERROR',
              'Complete every image upload before saving this article.',
            );
        }
    }
    if (request.operation === 'create') {
      return await repository.create({
        actorId,
        requestId: request.requestId,
        content: parseArticleContent(request.content),
      });
    }
    if (request.operation === 'list')
      return await repository.list({
        actorId,
        limit: request.limit,
        query: request.query,
        ...(request.cursor ? { cursor: request.cursor } : {}),
      });
    const draft =
      request.operation === 'save'
        ? await repository.save({
            actorId,
            articleId: request.articleId,
            expectedRevision: request.expectedRevision,
            content: parseArticleContent(request.content),
          })
        : await repository.get({ actorId, articleId: request.articleId });
    if (!draft) throw new ArticleDraftError('NOT_FOUND', 'Article draft was not found.');
    if (request.operation === 'save') return draft;
    if (request.operation === 'preview') {
      if (draft.revision !== request.expectedRevision)
        throw new ArticleDraftError(
          'CONFLICT',
          'The draft changed. Reload before previewing.',
          draft.revision,
        );
      const mediaIds = new Set<string>();
      const visit = (node: ArticleNode): void => {
        if (node.type === 'articleImage') mediaIds.add(node.attrs.mediaId);
        else if ('content' in node) node.content.forEach(visit);
      };
      visit(draft.content.body.document);
      return {
        articleId: draft.id,
        revision: draft.revision,
        body: draft.content.body,
        mediaIds: [...mediaIds],
      };
    }
    return { draft, publication: draft.published };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof ArticleValidationError) {
      throw new ArticleDraftError('VALIDATION_ERROR', 'Invalid article draft request.');
    }
    throw error;
  }
}
