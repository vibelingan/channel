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
  type AlibabaSyncFunctionConfig,
  handleAlibabaSyncRequest,
  handleOAuthCallbackRequest,
} from '@vibelingan-channel/fn-alibaba-catalog-sync/handler';
import {
  getCatalogImage,
  getCatalogItem,
  listCatalog,
  resolveCatalogViewer,
} from '@vibelingan-channel/fn-public-api/handler';
import type { PublicApiConfig, PublicCatalog } from '@vibelingan-channel/fn-public-api/handler';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { optionalEnv } from '@vibelingan-channel/shared';
import { releaseInfo } from '@vibelingan-channel/shared/release';
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
  resetPasswordUrl: optionalEnv('RESET_PASSWORD_URL', 'http://localhost:4321/reset'),
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

// Same envelope as the production public-api health (parity with the e2e
// contract), plus local-only diagnostics.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, data: { ...releaseInfo('public-api'), mode: 'local', db: DB_FILE } });
});

app.post('/api/admin', async (req, res) => {
  const body = req.body as AdminRequest;
  // Parity with the CloudBase HTTP adapter: derive a best-effort client IP so
  // the public-endpoint rate limits (login/recover/submitProject) can key on it.
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    ?.trim();
  const sourceIp = forwarded || req.ip || req.socket.remoteAddress || '';
  const result = await handleAdminRequest(body ?? { action: '' }, config, { sourceIp });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Alibaba catalog sync (docs/alibaba-linked-catalog-sync, MIU 13): mirrors the
// production function's routes so the connect flow, run controls, and linking
// are exercisable against local dev. Feature env is optional — unconfigured
// local runs surface the not_configured state exactly like production.
// ---------------------------------------------------------------------------
const alibabaConfig: AlibabaSyncFunctionConfig = {
  jwtSecret: config.jwtSecret,
  siteUrl: optionalEnv('SITE_URL', 'http://localhost:4321'),
  ...(optionalEnv('ALI_APP_KEY') ? { appKey: optionalEnv('ALI_APP_KEY') as string } : {}),
  ...(optionalEnv('ALI_APP_SECRET') ? { appSecret: optionalEnv('ALI_APP_SECRET') as string } : {}),
  ...(optionalEnv('ALI_OAUTH_CALLBACK_URL')
    ? { callbackUrl: optionalEnv('ALI_OAUTH_CALLBACK_URL') as string }
    : {}),
  ...(optionalEnv('ALI_TOKEN_ENCRYPTION_KEY_V1')
    ? { tokenKeyHex: optionalEnv('ALI_TOKEN_ENCRYPTION_KEY_V1') as string }
    : {}),
  ...(optionalEnv('WECOM_WEBHOOK_URL')
    ? { wecomWebhookUrl: optionalEnv('WECOM_WEBHOOK_URL') as string }
    : {}),
};

app.options('/api/alibaba-catalog-sync', (_req, res) => res.sendStatus(204));
app.post('/api/alibaba-catalog-sync', async (req, res) => {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    ?.trim();
  const sourceIp = forwarded || req.ip || req.socket.remoteAddress || '';
  const result = await handleAlibabaSyncRequest(
    (req.body ?? { action: '' }) as Record<string, unknown>,
    alibabaConfig,
    { sourceIp },
  );
  res.json(result);
});
app.get('/api/alibaba-catalog-sync/health', (_req, res) => {
  res.json({ ok: true, data: { ...releaseInfo('alibaba-catalog-sync'), mode: 'local' } });
});
app.get('/api/alibaba-catalog-sync/oauth/callback', async (req, res) => {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    ?.trim();
  const redirect = await handleOAuthCallbackRequest(
    {
      ...(typeof req.query.code === 'string' ? { code: req.query.code } : {}),
      ...(typeof req.query.state === 'string' ? { state: req.query.state } : {}),
    },
    alibabaConfig,
    { sourceIp: forwarded || req.ip || req.socket.remoteAddress || '' },
  );
  res.redirect(302, redirect.location);
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

// Content-Type values the OEM file download may reflect. Same defense-in-depth
// as the public image route: even though these bytes are served as an
// `attachment` (never rendered inline) and `mimeType` is now readOnly, we still
// gate the reflected type to a server allowlist and send `nosniff` so a corrupt
// or legacy `text/html` row can never influence how a browser treats the bytes.
const DOWNLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/octet-stream',
]);

// Download file bytes stored (base64) in the `files` collection. Sent as an
// attachment with the original filename so admins can save OEM drawings.
app.get('/api/files/:id', async (req, res) => {
  const doc = await adapter.get('files', req.params.id);
  if (!doc || typeof doc.data !== 'string') {
    res.status(404).end();
    return;
  }
  const name = String(doc.name ?? 'file').replace(/["\r\n]/g, '');
  const declared = typeof doc.mimeType === 'string' ? doc.mimeType.trim().toLowerCase() : '';
  res.setHeader(
    'Content-Type',
    DOWNLOAD_MIME_TYPES.has(declared) ? declared : 'application/octet-stream',
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(doc.data, 'base64'));
});

// Catalog routes delegate to the SAME handler as production (`listCatalog` /
// `getCatalogItem`) for the same parity reason as the image route above — in
// particular the public field allowlist and the server-side role-gated VIP
// tier (verified from the Bearer token) must not drift between the two.
const catalogConfig: PublicApiConfig = { jwtSecret: config.jwtSecret };

// The catalog responses vary by the caller's token (role-gated VIP tier), so a
// shared cache must key on Authorization — mirrors the production http-adapter.
function setCatalogCacheHeaders(res: express.Response): void {
  res.setHeader('Vary', 'Origin, Authorization');
  res.setHeader('Cache-Control', 'private, no-cache');
}

function registerCatalog(collection: PublicCatalog, basePath: string): void {
  app.get(basePath, async (req, res) => {
    const categoriesParam = String(req.query.category ?? '').trim();
    const viewer = await resolveCatalogViewer(req.headers.authorization, catalogConfig);
    const result = await listCatalog(
      collection,
      {
        ...(categoriesParam ? { categories: categoriesParam.split(',').filter(Boolean) } : {}),
        search: String(req.query.search ?? '').trim(),
        page: Number.parseInt(String(req.query.page ?? '1'), 10) || 1,
        pageSize: Number.parseInt(String(req.query.pageSize ?? '24'), 10) || 24,
      },
      catalogConfig,
      viewer,
    );
    setCatalogCacheHeaders(res);
    res.json(result);
  });

  app.get(`${basePath}/:id`, async (req, res) => {
    const viewer = await resolveCatalogViewer(req.headers.authorization, catalogConfig);
    const result = await getCatalogItem(collection, req.params.id, catalogConfig, viewer);
    setCatalogCacheHeaders(res);
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
