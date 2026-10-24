import { z } from 'zod';
import { articleIdentity } from './media.ts';

const revision = z.number().int().positive().safe();
export const releaseTime = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });
export const releaseHash = z.string().regex(/^[a-f0-9]{64}$/);
export const ArticleReleaseRequestSchema = z
  .object({
    operation: z.enum(['publish', 'withdraw']),
    articleId: articleIdentity,
    expectedRevision: revision,
    requestId: articleIdentity,
  })
  .strict();
export type ArticleReleaseRequest = z.infer<typeof ArticleReleaseRequestSchema>;
export const ArticleReleaseStateSchema = z.enum([
  'QUEUED',
  'BUILDING',
  'DEPLOYING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
]);
export const ArticleReleaseViewSchema = z
  .object({
    id: articleIdentity,
    articleId: articleIdentity,
    operation: z.enum(['publish', 'withdraw']),
    revision,
    state: ArticleReleaseStateSchema,
    requestedAt: releaseTime,
    updatedAt: releaseTime,
    error: z
      .enum(['BUILD_FAILED', 'RESTORED', 'CHECK_REQUIRED', 'CANCELLED', 'DELIVERY_STOPPED'])
      .nullable(),
  })
  .strict();
export type ArticleReleaseView = z.infer<typeof ArticleReleaseViewSchema>;
export function articleReleaseActive(state: ArticleReleaseView['state']): boolean {
  return !['SUCCEEDED', 'FAILED'].includes(state);
}
export const ArticleReleaseControlSchema = z
  .object({
    operation: z.enum(['retry', 'cancel']),
    articleId: articleIdentity,
    taskId: articleIdentity,
    requestId: articleIdentity,
  })
  .strict();
export type ArticleReleaseControl = z.infer<typeof ArticleReleaseControlSchema>;
export interface ArticleReleases {
  control(actorId: string, request: ArticleReleaseControl): Promise<ArticleReleaseView>;
  request(actorId: string, request: ArticleReleaseRequest): Promise<ArticleReleaseView>;
  latest(actorId: string, articleId: string): Promise<ArticleReleaseView | null>;
}
