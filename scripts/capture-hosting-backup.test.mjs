import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    if (args.action === 'downloadDirectory') return { success: true }; // SDK missed the file
    if (args.action === 'downloadFile') {
      writeFileSync(args.localPath, 'home');
      return { success: true };
    }
    throw new Error(`Unexpected tool: ${selector} ${args.action}`);
  };
  return { output, target, calls, callTool };
}

test('capture repairs a missing SDK download and seals only after a second complete inventory', async (t) => {
  const f = setup(t);
  const manifest = await captureHostingBackup(f);
  assert.equal(manifest.entries.length, 1);
  assert.equal(f.calls.filter((c) => c.args.action === 'downloadFile').length, 1);
  assert.equal(f.calls.filter((c) => c.args.action === 'listFiles').length, 2);
  assert.equal(
    f.calls.some((c) =>
      ['upload', 'delete', 'setWebsiteDocument', 'set_env'].includes(c.args.action),
    ),
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
