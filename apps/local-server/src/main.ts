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
import {
  getCatalogImage,
  getCatalogItem,
  listCatalog,
} from '@vibelingan-channel/fn-public-api/handler';
import type { PublicCatalog } from '@vibelingan-channel/fn-public-api/handler';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { optionalEnv } from '@vibelingan-channel/shared';
import express from 'express';
import { JsonFileAdapter } from './json-adapter.ts';
import { seed } from './seed.ts';

const PORT = Number(optionalEnv('PORT', '3002'));
const DB_FILE = resolve(process.cwd(), optionalEnv('LOCAL_DB_FILE', './data/db.local.json'));
const MEDIA_DIR = resolve(process.cwd(), optionalEnv('LOCAL_MEDIA_DIR', './data/media'));
const TCB_ENV = optionalEnv('TCB_ENV', '');

// Dev defaults so the server runs with zero configuration.
const config: AdminConfig = {
  jwtSecret: optionalEnv('JWT_SECRET', 'dev-secret-do-not-use-in-production'),
  loginUrl: optionalEnv('LOGIN_URL', 'http://localhost:4321/login'),
};

const adapter = new JsonFileAdapter(DB_FILE);
setAdapter(adapter);

// The DB stays file-backed locally, but media UPLOADS always mint a real
// CloudBase pre-signed credential (project decision: one upload path
// everywhere). When TCB_ENV is configured, wire the CloudBase media adapter so
// createUploadIntent/completeUpload work locally too; the dynamic import keeps
// wx-server-sdk out of the default (no-CloudBase) dev run. Otherwise fall back to
// local-disk for byte DELIVERY only — uploads then fail loudly.
if (TCB_ENV) {
  const { cloudStorageSdk, initCloudBase } = await import('@vibelingan-channel/db/cloudbase');
  const { createCloudBaseMediaStorage } = await import(
    '@vibelingan-channel/media-storage/cloudbase'
  );
  initCloudBase(TCB_ENV);
  setMediaStorage(createCloudBaseMediaStorage(cloudStorageSdk()));
  console.log(
    `[local-server] media storage: CloudBase (TCB_ENV=${TCB_ENV}) — real uploads + delivery`,
  );
} else {
  setMediaStorage(new LocalDiskMediaStorage(MEDIA_DIR));
  console.log('[local-server] media storage: local-disk (delivery only; set TCB_ENV for uploads)');
}

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

// PUBLIC image delivery — delegates to the SAME logic as production
// (`getCatalogImage`): provider/refCount/status gating, the legacy catalog-scan
// fallback, the placeholder special-case, and fail-closed behavior, all driven by
// the wired `mediaStorage()` adapter. Sharing the helper keeps local dev from
// masking the production public gate (no parity to drift). Admin previews of
// unpublished images use the authed `getImagePreview` action, not this route.
// Every header the handler sets (Content-Type allowlist, nosniff, caching) is
// forwarded verbatim so local delivery matches production byte-for-byte.
app.get('/api/images/:id', async (req, res) => {
  const result = await getCatalogImage(req.params.id);
  if (result.ok && 'body' in result) {
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
    res.send(Buffer.from(result.body, 'base64'));
    return;
  }
  res.status(404).end();
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

// Catalog routes delegate to the SAME handler as production (`listCatalog` /
// `getCatalogItem`) for the same parity reason as the image route above — in
// particular the public field allowlist (no vipPrice / imageIds / internal
// fields on the unauthenticated surface) must not drift between the two.
function registerCatalog(collection: PublicCatalog, basePath: string): void {
  app.get(basePath, async (req, res) => {
    const categoriesParam = String(req.query.category ?? '').trim();
    const result = await listCatalog(
      collection,
      {
        ...(categoriesParam ? { categories: categoriesParam.split(',').filter(Boolean) } : {}),
        search: String(req.query.search ?? '').trim(),
        page: Number.parseInt(String(req.query.page ?? '1'), 10) || 1,
        pageSize: Number.parseInt(String(req.query.pageSize ?? '24'), 10) || 24,
      },
      {},
    );
    res.json(result);
  });

  app.get(`${basePath}/:id`, async (req, res) => {
    const result = await getCatalogItem(collection, req.params.id, {});
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
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
