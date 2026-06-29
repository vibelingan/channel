/**
 * Local development API server.
 *
 * Mirrors the production CloudBase admin function but runs against a file-backed
 * database so you can develop, edit data, and reproduce the remote behaviour
 * entirely offline. Same request protocol as the cloud function:
 *   POST /api/admin  ->  { action, data, token }
 */
import { resolve } from 'node:path';
import { setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import type { AdminConfig, AdminRequest } from '@vibelingan-channel/fn-admin/handler';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { optionalEnv } from '@vibelingan-channel/shared';
import type { FilterClause } from '@vibelingan-channel/shared';
import express from 'express';
import { JsonFileAdapter } from './json-adapter.ts';
import { seed } from './seed.ts';

const PORT = Number(optionalEnv('PORT', '3002'));
const DB_FILE = resolve(process.cwd(), optionalEnv('LOCAL_DB_FILE', './data/db.local.json'));
const MEDIA_DIR = resolve(process.cwd(), optionalEnv('LOCAL_MEDIA_DIR', './data/media'));

// Dev defaults so the server runs with zero configuration.
const config: AdminConfig = {
  jwtSecret: optionalEnv('JWT_SECRET', 'dev-secret-do-not-use-in-production'),
  loginUrl: optionalEnv('LOGIN_URL', 'http://localhost:4321/login'),
};

const adapter = new JsonFileAdapter(DB_FILE);
setAdapter(adapter);
setMediaStorage(new LocalDiskMediaStorage(MEDIA_DIR));
await seed(adapter);

const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS for the Astro dev server (when not using its proxy).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});
app.options('/api/admin', (_req, res) => res.sendStatus(204));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: 'local', db: DB_FILE });
});

app.post('/api/admin', async (req, res) => {
  const body = req.body as AdminRequest;
  const result = await handleAdminRequest(body ?? { action: '' }, config);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Public, read-only catalog endpoints (no auth). These mirror what a public
// CloudBase function will later expose for the storefront. A single helper
// serves any catalog-style collection (products, overstock, …).
// ---------------------------------------------------------------------------

/**
 * Resolve a catalog document's `imageIds` (references into the `images`
 * collection) into client-facing URLs that stream the stored bytes. Catalog
 * documents never persist file paths — only image ids — mirroring how
 * wx-server-sdk will store image binaries in production.
 */
function resolveImages(doc: Record<string, unknown>): Record<string, unknown> {
  const ids = Array.isArray(doc.imageIds) ? (doc.imageIds as unknown[]) : [];
  return { ...doc, images: ids.map((id) => `/api/images/${String(id)}`) };
}

// Serve image bytes stored (base64) in the `images` collection.
app.get('/api/images/:id', async (req, res) => {
  const doc = await adapter.get('images', req.params.id);
  if (!doc || typeof doc.data !== 'string') {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', String(doc.mimeType ?? 'application/octet-stream'));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(doc.data, 'base64'));
});

// Download file bytes stored (base64) in the `files` collection. Sent as an
// attachment with the original filename so admins can save OEM drawings.
app.get('/api/files/:id', async (req, res) => {
  const doc = await adapter.get('files', req.params.id);
  if (!doc || typeof doc.data !== 'string') {
    res.status(404).end();
    return;
  }
  const name = String(doc.name ?? 'file').replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', String(doc.mimeType ?? 'application/octet-stream'));
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(doc.data, 'base64'));
});

function registerCatalog(collection: string, basePath: string): void {
  app.get(basePath, async (req, res) => {
    const categoriesParam = String(req.query.category ?? '').trim();
    const categories = categoriesParam ? categoriesParam.split(',').filter(Boolean) : null;
    const search = String(req.query.search ?? '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(
      48,
      Math.max(1, Number.parseInt(String(req.query.pageSize ?? '24'), 10) || 24),
    );

    // Public storefront only ever sees published items; optional category and
    // free-text search are applied server-side so large catalogs paginate well.
    const clauses: FilterClause[] = [{ field: 'published', op: 'eq', value: true }];
    if (categories) {
      clauses.push({ field: 'category', op: 'in', value: categories });
    }
    const result = await adapter.list({
      collection,
      page,
      pageSize,
      search,
      filter: { combinator: 'and', clauses },
    });
    const items = result.items.map(resolveImages);
    res.json({
      ok: true,
      data: { items, total: result.total, page: result.page, pageSize: result.pageSize },
    });
  });

  app.get(`${basePath}/:id`, async (req, res) => {
    const doc = await adapter.get(collection, req.params.id);
    if (!doc || doc.published !== true) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
      return;
    }
    res.json({ ok: true, data: resolveImages(doc) });
  });
}

registerCatalog('products', '/api/products');
registerCatalog('overstock', '/api/overstock');

app.listen(PORT, () => {
  console.log('');
  console.log('  channel local API server');
  console.log(`  ➜  http://localhost:${PORT}/api/admin`);
  console.log(`  ➜  db file: ${DB_FILE}`);
  console.log('  ➜  seeded admin login: admin@channel.local / admin');
  console.log('');
});
