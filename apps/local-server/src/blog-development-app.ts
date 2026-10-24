import {
  type ArticleRepository,
  isArticleDraftError,
} from '@vibelingan-channel/articles/draft-repository';
import { executeArticleDraftRequest } from '@vibelingan-channel/articles/draft-service';
import { executeArticleMediaRequest } from '@vibelingan-channel/fn-admin/article-media';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { z } from 'zod';

const envelope = z
  .object({
    action: z.enum(['login', 'me', 'articleDrafts', 'articleMedia', 'articleReleases']),
    token: z.string().max(8192).optional(),
    data: z.unknown().optional(),
  })
  .strict();
const userResponse = z.object({
  ok: z.literal(true),
  data: z
    .object({
      user: z
        .object({ id: z.string().min(1), role: z.string(), status: z.string().optional() })
        .passthrough(),
    })
    .passthrough(),
});
export function createBlogDevelopmentApp(config: {
  repository: ArticleRepository;
  frontendOrigin: string;
  envId: string;
  auth: (input: unknown) => Promise<unknown>;
}): Express {
  const app = express();
  const frontend = new URL(config.frontendOrigin);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(frontend.hostname) ||
    frontend.origin !== config.frontendOrigin
  )
    throw new Error('Blog development requires an exact loopback frontend origin.');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname) ||
      (req.headers.origin && req.headers.origin !== config.frontendOrigin)
    ) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This local origin is not allowed.' },
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      data: { mode: 'blog-cloudbase', envId: config.envId, articleReleases: false },
    }),
  );
  app.post('/api/admin', async (req, res) => {
    try {
      const value = envelope.safeParse(req.body);
      if (!value.success) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Only Blog development actions are enabled.' },
        });
        return;
      }
      const input = value.data;
      if (input.action === 'login' || input.action === 'me') {
        res.json(await config.auth(input));
        return;
      }
      const current = userResponse.safeParse(
        await config.auth({ action: 'me', token: input.token }),
      );
      if (!current.success || current.data.data.user.status === 'suspended') {
        res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Sign in with your existing account.' },
        });
        return;
      }
      if (current.data.data.user.role !== 'admin') {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin permission is required.' },
        });
        return;
      }
      if (input.action === 'articleReleases') {
        const capability = z
          .object({ operation: z.literal('capabilities') })
          .strict()
          .safeParse(input.data);
        res.status(capability.success ? 200 : 403).json(
          capability.success
            ? { ok: true, data: { enabled: false } }
            : {
                ok: false,
                error: {
                  code: 'FORBIDDEN',
                  message: 'Website deployment is disabled in local Blog development.',
                },
              },
        );
        return;
      }
      const actorId = current.data.data.user.id;
      const data =
        input.action === 'articleDrafts'
          ? await executeArticleDraftRequest(config.repository, actorId, input.data)
          : await executeArticleMediaRequest(config.repository, actorId, input.data);
      res.json({ ok: true, data });
    } catch (error) {
      const code = isArticleDraftError(error) ? error.code : 'INTERNAL_ERROR';
      res
        .status(
          {
            UNAUTHORIZED: 401,
            FORBIDDEN: 403,
            CONFLICT: 409,
            NOT_FOUND: 404,
            VALIDATION_ERROR: 400,
            RATE_LIMITED: 429,
            INTERNAL_ERROR: 500,
          }[code],
        )
        .json({
          ok: false,
          error: {
            code,
            message: isArticleDraftError(error)
              ? error.message
              : 'The CloudBase article request could not be confirmed.',
            ...(isArticleDraftError(error) && error.currentRevision !== undefined
              ? { currentRevision: error.currentRevision }
              : {}),
          },
        });
    }
  });
  app.use((_req, res) =>
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This route is not part of Blog development.' },
    }),
  );
  const invalidBody: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid or oversized JSON request.' },
    });
  };
  app.use(invalidBody);
  return app;
}
