import express from 'express';
import type { JsonFileAdapter } from './json-adapter.ts';

/** Never registered by the general server or deployed functions. Explicit opt-in
 * on the loopback-only sample server; no public read endpoint for buyer PII. */
export function registerLocalQuoteRoutes(app: express.Express, db: JsonFileAdapter) {
  const allowed = new Set(['http://127.0.0.1:4328', 'http://localhost:4328']);
  let windowStart = 0;
  let attempts = 0;
  app.all(
    '/api/catalog-quote-requests',
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Origin');
      if (!allowed.has(req.get('origin') ?? '')) {
        res.status(403).json({ ok: false, code: 'origin' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', req.get('origin') ?? '');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Local-Catalog-Quote');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      if (req.method !== 'POST') {
        res.status(405).end();
        return;
      }
      if (req.get('x-local-catalog-quote') !== '1' || !req.is('application/json')) {
        res.status(415).json({ ok: false, code: 'content-type' });
        return;
      }
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        attempts = 0;
      }
      if (++attempts > 60) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ ok: false, code: 'rate-limit' });
        return;
      }
      next();
    },
    express.json({ limit: '16kb' }),
    async (req: express.Request, res: express.Response) => {
      try {
        const result = await db.submitCatalogQuote(req.body);
        res.status(result.ok ? 200 : result.code === 'validation' ? 400 : 409).json(result);
      } catch {
        res.status(500).json({ ok: false, code: 'save-failed' });
      }
    },
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const tooLarge =
        error instanceof Error && 'type' in error && error.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ ok: false, code: 'invalid-json' });
    },
  );
}
