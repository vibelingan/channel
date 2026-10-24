import { z } from 'zod';
import { ArticleValidationError } from './document.ts';
import { ArticleDraftError } from './draft-repository.ts';
import { articleIdentity } from './media.ts';
import {
  ArticleReleaseControlSchema,
  ArticleReleaseRequestSchema,
  type ArticleReleases,
} from './release.ts';

const getSchema = z.object({ operation: z.literal('get'), articleId: articleIdentity }).strict();

/** No browser command may claim work, submit a delivery receipt or mark a task successful. */
export async function executeArticleReleaseRequest(
  repository: ArticleReleases,
  actorId: string,
  input: unknown,
) {
  try {
    const encoded = JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded) > 4096)
      throw new ArticleDraftError('VALIDATION_ERROR', 'Article release request exceeds 4 KiB.');
    const get = getSchema.safeParse(input);
    if (get.success) return { task: await repository.latest(actorId, get.data.articleId) };
    const control = ArticleReleaseControlSchema.safeParse(input);
    if (control.success) return { task: await repository.control(actorId, control.data) };
    return { task: await repository.request(actorId, ArticleReleaseRequestSchema.parse(input)) };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof ArticleValidationError)
      throw new ArticleDraftError(
        'VALIDATION_ERROR',
        'Check the article title, author, URL and completed images before publishing.',
      );
    throw error;
  }
}
