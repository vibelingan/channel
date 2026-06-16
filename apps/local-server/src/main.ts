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
import { optionalEnv } from '@vibelingan-channel/shared';
import express from 'express';
import { JsonFileAdapter } from './json-adapter.ts';
import { seed } from './seed.ts';

const PORT = Number(optionalEnv('PORT', '3002'));
const DB_FILE = resolve(process.cwd(), optionalEnv('LOCAL_DB_FILE', './data/db.local.json'));

// Dev defaults so the server runs with zero configuration.
const config: AdminConfig = {
  jwtSecret: optionalEnv('JWT_SECRET', 'dev-secret-do-not-use-in-production'),
  ...(optionalEnv('ADMIN_PASSWORD_HASH')
    ? { adminPasswordHash: optionalEnv('ADMIN_PASSWORD_HASH') }
    : {}),
  adminPasswordPlain: optionalEnv('ADMIN_PASSWORD', 'admin'),
};

const adapter = new JsonFileAdapter(DB_FILE);
setAdapter(adapter);
seed(adapter);

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for the Astro dev server (when not using its proxy).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

app.listen(PORT, () => {
  console.log('');
  console.log('  channel local API server');
  console.log(`  ➜  http://localhost:${PORT}/api/admin`);
  console.log(`  ➜  db file: ${DB_FILE}`);
  console.log(`  ➜  admin password: ${config.adminPasswordPlain ?? '(hash configured)'}`);
  console.log('');
});
