import {
  type ArticleReleaseControl,
  ArticleReleaseControlSchema,
  type ArticleReleaseRequest,
  ArticleReleaseRequestSchema,
  ArticleReleaseViewSchema,
} from '@vibelingan-channel/articles/release';
import { z } from 'zod';
import { AdminApiError, call } from '../api.ts';

export function readArticleReleaseResponse(input: unknown, articleId: string, revision?: number) {
  const result = z.object({ task: ArticleReleaseViewSchema.nullable() }).strict().safeParse(input);
  if (
    !result.success ||
    (result.data.task &&
      (result.data.task.articleId !== articleId ||
        (revision !== undefined && result.data.task.revision !== revision)))
  )
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'The publication request could not be confirmed. Retry the same request.',
    );
  return result.data.task;
}
export async function getArticleReleaseCapability(signal: AbortSignal) {
  const result = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(await call('articleReleases', { operation: 'capabilities' }, signal));
  if (!result.success)
    throw new AdminApiError('INVALID_RESPONSE', 'Publishing availability could not be checked.');
  return result.data.enabled;
}
export async function getArticleRelease(articleId: string, signal: AbortSignal) {
  return readArticleReleaseResponse(
    await call('articleReleases', { operation: 'get', articleId }, signal),
    articleId,
  );
}
export async function writeArticleRelease(input: ArticleReleaseRequest | ArticleReleaseControl) {
  const request =
    input.operation === 'publish' || input.operation === 'withdraw'
      ? ArticleReleaseRequestSchema.parse(input)
      : ArticleReleaseControlSchema.parse(input);
  const result = readArticleReleaseResponse(
    await call('articleReleases', request),
    input.articleId,
    'expectedRevision' in input ? input.expectedRevision : undefined,
  );
  if (!result)
    throw new AdminApiError(
      'INVALID_RESPONSE',
      'The publication request could not be confirmed. Retry the same request.',
    );
  return result;
}
