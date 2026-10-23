import { isArticleDraftError } from '@vibelingan-channel/articles/draft-repository';
import { executeArticleDraftRequest } from '@vibelingan-channel/articles/draft-service';
import { executeArticleReleaseRequest } from '@vibelingan-channel/articles/release-service';
import { verifySession } from '@vibelingan-channel/auth/jwt';
import { createBlogDummyDatabase } from '@vibelingan-channel/db/article-dummy';
import {
  type ArticleDatabase,
  createCloudBaseArticleRepository,
} from '@vibelingan-channel/db/article-repository';
import { z } from 'zod';
import { executeArticleMediaRequest } from './article-media.ts';

const request = z
  .object({
    action: z.enum(['health', 'me', 'articleDrafts', 'articleMedia', 'articleReleases']),
    data: z.unknown().optional(),
    token: z.string().max(8192).optional(),
  })
  .strict();
export function createBlogDummyHandler(config: {
  db: ArticleDatabase;
  envId: string;
  codeSha: string;
  jwtSecret: string;
  expiresAt: number;
  clock?: () => number;
}) {
  if (!/^[a-f0-9]{40}$/.test(config.codeSha) || config.jwtSecret.length < 32)
    throw new Error('Dummy code identity and private session secret required');
  const db = createBlogDummyDatabase(config.db, config.envId);
  const repository = createCloudBaseArticleRepository(db);
  const releases = repository.releases;
  if (!releases) throw new Error('Article release storage is unavailable');
  return async (input: unknown) => {
    const clock = config.clock ?? Date.now;
    if (clock() >= config.expiresAt)
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This isolated test window has ended.' },
      };
    const value = request.safeParse(input);
    if (!value.success || Buffer.byteLength(JSON.stringify(input)) > 384 * 1024)
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'This endpoint accepts isolated article test actions only.',
        },
      };
    const { action, data, token } = value.data;
    if (action === 'health')
      return {
        ok: true,
        data: {
          function: 'seo-blog-dummy',
          codeSha: config.codeSha,
          envId: config.envId,
          expiresAt: new Date(config.expiresAt).toISOString(),
        },
      };
    const claims = token ? await verifySession(config.jwtSecret, token) : null;
    if (!claims)
      return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } };
    try {
      const user = await db.runTransaction(async (tx) => {
        const raw: unknown = await tx.collection('users').doc(claims.sub).get();
        const result = z
          .object({ data: z.record(z.unknown()).nullable() })
          .passthrough()
          .parse(raw);
        return result.data;
      });
      if (!user || user._id !== claims.sub || user.status === 'suspended')
        return {
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'This session is no longer valid.' },
        };
      if (user.role !== 'admin')
        return {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin permission is required.' },
        };
      if (action === 'me')
        return {
          ok: true,
          data: {
            user: {
              id: claims.sub,
              email: claims.email,
              username: claims.name,
              role: 'admin',
              status: 'active',
            },
          },
        };
      if (
        action === 'articleReleases' &&
        z
          .object({ operation: z.literal('capabilities') })
          .strict()
          .safeParse(data).success
      )
        return { ok: true, data: { enabled: true } };
      return {
        ok: true,
        data:
          action === 'articleDrafts'
            ? await executeArticleDraftRequest(repository, claims.sub, data)
            : action === 'articleMedia'
              ? await executeArticleMediaRequest(repository, claims.sub, data)
              : await executeArticleReleaseRequest(releases, claims.sub, data),
      };
    } catch (error) {
      if (isArticleDraftError(error))
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...('currentRevision' in error ? { currentRevision: error.currentRevision } : {}),
          },
        };
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The isolated article request could not be confirmed.',
        },
      };
    }
  };
}
