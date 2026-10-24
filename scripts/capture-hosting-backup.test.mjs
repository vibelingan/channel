import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureHostingBackup } from './capture-hosting-backup.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'hosting-capture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = { envId: 'fixture-env', site: 'https://fixture.example' };
  const calls = [];
  const output = join(root, 'backup');
  const callTool = async (selector, args) => {
    calls.push({ selector, args });
    if (selector === 'cloudbase.auth')
      return { auth_status: 'READY', current_env_id: target.envId };
    if (args.action === 'listFiles')
      return {
        success: true,
        data: {
          files: [
            {
              key: 'index.html',
              size: '4',
              ETag: `"${createHash('md5').update('home').digest('hex')}"`,
              lastModified: '2026-10-20T00:00:00Z',
            },
          ],
          totalCount: 1,
          isTruncated: false,
        },
      };
    if (args.action === 'websiteConfig')
      return {
        success: true,
        data: {
          websiteConfig: { WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } },
        },
      };
    if (args.action === 'listRoutes')
      return { success: true, data: { raw: { Domains: [{ Domain: 'fixture.example' }] } } };
    throw new Error(`Unexpected tool: ${selector} ${args.action}`);
  };
  return {
    output,
    target,
    calls,
    callTool,
    request: async () => ({ status: 200, body: Buffer.from('home'), headers: new Headers() }),
  };
}

test('capture uses bounded HTTP reads and seals only after a second complete inventory', async (t) => {
  const f = setup(t);
  const manifest = await captureHostingBackup(f);
  assert.equal(manifest.entries.length, 1);
  const transfer = JSON.parse(readFileSync(join(f.output, 'transfer-summary.json'), 'utf8'));
  assert.equal(transfer.files, 1);
  assert.equal(transfer.verifiedBytes, 4);
  assert.equal(transfer.retries, 0);
  assert.equal(f.calls.filter((c) => c.selector === 'cloudbase.manageHosting').length, 0);
  assert.equal(f.calls.filter((c) => c.args.action === 'listFiles').length, 2);
  assert.equal(
    f.calls.some((c) =>
      ['upload', 'delete', 'setWebsiteDocument', 'set_env'].includes(c.args.action),
    ),
    false,
  );
});

test('exhausted downloads cannot produce a recovery manifest or allow cloud writes', async (t) => {
  const f = setup(t);
  let attempts = 0;
  f.request = async () => {
    attempts++;
    throw Object.assign(new Error('offline network reset'), { code: 'ECONNRESET' });
  };
  await assert.rejects(captureHostingBackup(f), /offline network reset/);
  assert.equal(attempts, 3);
  assert.equal(existsSync(join(f.output, 'recovery-manifest.json')), false);
  assert.equal(existsSync(join(f.output, 'transfer-summary.json')), false);
  assert.equal(
    f.calls.some((c) => c.selector.startsWith('cloudbase.manage')),
    false,
  );
});

test('wrong authenticated environment fails before file or configuration operations', async (t) => {
  const f = setup(t);
  await assert.rejects(
    captureHostingBackup({ ...f, target: { ...f.target, envId: 'other' } }),
    /differs/,
  );
  assert.equal(f.calls.length, 1);
});

test('truncated pagination without a cursor cannot produce an apparently complete backup', async (t) => {
  const f = setup(t);
  await assert.rejects(
    captureHostingBackup({
      ...f,
      callTool: async (selector, args) =>
        args.action === 'listFiles'
          ? { success: true, data: { files: [], totalCount: 1, isTruncated: true } }
          : f.callTool(selector, args),
    }),
    /pagination/,
  );
});

test('capture seals conflicting object keys and recovery preserves their original URLs', async (t) => {
  const { planHostingRecovery, verifyRecoveryInput } = await import('./hosting-recovery.mjs');
  const f = setup(t);
  const bodies = { 'index.html': 'home', legacy: 'one', 'legacy/file.js': 'two' };
  const original = f.callTool;
  f.callTool = async (selector, args) =>
    args.action === 'listFiles'
      ? {
          success: true,
          data: {
            files: Object.entries(bodies).map(([key, body]) => ({
              key,
              size: String(body.length),
              ETag: `"${createHash('md5').update(body).digest('hex')}"`,
              lastModified: '2026-10-24T00:00:00Z',
            })),
            totalCount: 3,
            isTruncated: false,
          },
        }
      : original(selector, args);
  f.request = async (_method, url) => ({
    status: 200,
    body: Buffer.from(bodies[new URL(url).pathname.slice(1)]),
    headers: new Headers(),
  });
  const manifest = await captureHostingBackup(f);
  const directory = join(f.output, 'files');
  verifyRecoveryInput(manifest, directory, f.target);
  const plan = planHostingRecovery({
    manifest,
    directory,
    target: f.target,
    currentOwnedPaths: [],
    publicProductPaths: [],
  });
  assert.deepEqual(plan.uploads.map((item) => item.path).sort(), Object.keys(bodies).sort());
  const corrupt = structuredClone(manifest);
  corrupt.entries[0].sourcePath = corrupt.entries[1].sourcePath;
  assert.throws(() => verifyRecoveryInput(corrupt, directory, f.target), /mapping/);
});

test('both Manager and normal CLI captures use one reader and never recursively copy platform backup archives', async (t) => {
  const { captureManagerHostingBackup } = await import('./release/hosting-backup-reader.mjs');
  const f = setup(t);
  let reads = 0;
  const entries = [
    {
      path: 'index.html',
      bytes: 4,
      etag: `"${createHash('md5').update('home').digest('hex')}"`,
      lastModified: '2026-10-24T00:00:00Z',
    },
    {
      path: '.cloudbase-backup/history/index.html',
      bytes: 3,
      etag: 'old',
      lastModified: '2026-10-24T00:00:00Z',
    },
  ];
  const provider = {
    target: f.target,
    readInventory: async () => entries,
    readConfiguration: async () => ({
      website: (await f.callTool('website', { action: 'websiteConfig' })).data.websiteConfig,
      gateway: (await f.callTool('gateway', { action: 'listRoutes' })).data.raw,
    }),
    readBackupObject: async (method, url, options) => {
      reads++;
      assert(!url.includes('.cloudbase-backup'));
      return f.request(method, url, options);
    },
  };
  const manifest = await captureManagerHostingBackup({
    provider,
    target: f.target,
    output: f.output,
  });
  assert.equal(manifest.entries.length, 1);
  assert.equal(reads, 1);
  assert.equal(entries.length, 2, 'the original inventory and historical objects are preserved');
});
