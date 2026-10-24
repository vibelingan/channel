import { type AdminConfig, handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import { errorStatus } from '@vibelingan-channel/fn-admin/http-adapter';
import {
  type InquiryErrorCode,
  inquiryErrorMessages,
} from '@vibelingan-channel/shared/catalog-inquiry';
import express from 'express';
import { z } from 'zod';
import type { JsonFileAdapter } from './json-adapter.ts';

const envelope = z
  .object({
    action: z.enum(['login', 'me', 'inquiry', 'inquiryCapabilities']),
    data: z.unknown().optional(),
    token: z.string().max(8192).optional(),
  })
  .strict();
const origins = new Set(['http://127.0.0.1:4328', 'http://localhost:4328']);
const messages: Partial<Record<InquiryErrorCode, string>> = {
  ...inquiryErrorMessages,
  UNAUTHORIZED: 'Please sign in again.',
  FORBIDDEN: 'Admin permission is required.',
  VALIDATION_ERROR: 'Check the requested action and note.',
  NOT_FOUND: 'Inquiry not found.',
  INVALID_RECORD: 'Stored inquiry needs investigation; no data was changed.',
  VERSION_CONFLICT: 'Another update was saved. Reload the latest inquiry before trying again.',
  IDEMPOTENCY_CONFLICT: 'This operation reference was used for different changes.',
  INVALID_TRANSITION: 'This status change is not allowed.',
  HISTORY_LIMIT: 'The inquiry history limit has been reached.',
};
function fail(res: express.Response, status: number, code: InquiryErrorCode) {
  return res.status(status).json({
    ok: false,
    error: { code, message: messages[code] ?? 'Request could not be completed.' },
  });
}
/** Sample server ONLY. Ordinary login/me use the existing hardened handler;
 * generic CRUD, password mail, uploads, sync and OEM actions are not exposed. */
export function registerLocalInquiryRoutes(
  app: express.Express,
  _db: JsonFileAdapter,
  config: AdminConfig,
) {
  let windowStart = 0;
  let attempts = 0;
  app.all(
    '/api/admin',
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Origin');
      if (
        !origins.has(req.get('origin') ?? '') ||
        !['127.0.0.1', 'localhost'].includes(req.hostname)
      ) {
        fail(res, 403, 'FORBIDDEN');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', req.get('origin') ?? '');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      if (req.method !== 'POST') {
        fail(res, 405, 'FORBIDDEN');
        return;
      }
      if (!req.is('application/json')) {
        fail(res, 415, 'VALIDATION_ERROR');
        return;
      }
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        attempts = 0;
        windowStart = now;
      }
      if (++attempts > 200) {
        res.setHeader('Retry-After', '60');
        fail(res, 429, 'RATE_LIMITED');
        return;
      }
      next();
    },
    express.json({ limit: '16kb' }),
    async (req: express.Request, res: express.Response) => {
      try {
        const parsed = envelope.safeParse(req.body);
        if (!parsed.success) {
          fail(res, 403, 'FORBIDDEN');
          return;
        }
        const result = await handleAdminRequest(
          {
            action: parsed.data.action,
            data: parsed.data.data,
            ...(parsed.data.token ? { token: parsed.data.token } : {}),
          },
          { ...config, enableInquiries: true },
          { sourceIp: req.socket.remoteAddress ?? '' },
        );
        res.status(errorStatus(result)).json(result);
      } catch {
        fail(res, 500, 'INTERNAL_ERROR');
      }
    },
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      fail(
        res,
        error instanceof Error && 'type' in error && error.type === 'entity.too.large' ? 413 : 400,
        'VALIDATION_ERROR',
      );
    },
  );
}
