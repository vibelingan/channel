import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureProviderHostingBackup } from './capture-hosting-backup.mjs';
import { assertHostingBackupCurrent } from './verify-hosting-backup-current.mjs';

const target = { envId: 'fixture-env', site: 'https://fixture.example' };
const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'hosting-backup-current-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = {
    entries: [
      { path: 'index.html', bytes: 4, etag: md5('home'), lastModified: '2026-11-05T00:00:00Z' },
      // The platform's own history is outside the website backup and never compared.
      {
        path: '.cloudbase-backup/history/index.html',
        bytes: 3,
        etag: 'old',
        lastModified: '2026-11-05T00:00:00Z',
      },
    ],
    configuration: {
      website: {
        WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } },
        Bucket: 'fixture-bucket',
        CdnDomain: 'fixture.cdn.example',
      },
      gateway: {
        Domains: [{ Domain: 'fixture.example', UpdateTime: '2026-11-05T00:00:00Z' }],
      },
    },
  };
  const provider = {
    target,
    readInventory: async () => structuredClone(state.entries),
    readConfiguration: async () => structuredClone(state.configuration),
    readBackupObject: async () => ({
      status: 200,
      body: Buffer.from('home'),
      headers: new Headers(),
    }),
  };
  const directory = join(root, 'backup');
  await captureProviderHostingBackup({ provider, target, output: directory });
  return { state, provider, directory };
}

test('an unchanged live site still matches the backup taken during CI', async (t) => {
  const f = await setup(t);
  assert.deepEqual(await assertHostingBackupCurrent({ ...f, target }), { entries: 1 });
  // Server-managed timestamps are not a configuration change.
  f.state.configuration.gateway.Domains[0].UpdateTime = '2026-11-06T00:00:00Z';
  f.state.entries[1].etag = 'newer-platform-history';
  assert.deepEqual(await assertHostingBackupCurrent({ ...f, target }), { entries: 1 });
});

test('any changed, added or removed hosted file stops the deploy before writing', async (t) => {
  for (const change of [
    (s) => {
      s.entries[0].etag = md5('changed');
    },
    (s) => {
      s.entries[0].lastModified = '2026-11-06T00:00:00Z';
    },
    (s) => {
      s.entries.push({ path: 'new.html', bytes: 1, etag: md5('x'), lastModified: 'now' });
    },
    (s) => {
      s.entries.shift();
    },
  ]) {
    const f = await setup(t);
    change(f.state);
    await assert.rejects(assertHostingBackupCurrent({ ...f, target }), /changed after the backup/);
  }
});

test('a hosting configuration change or another target stops the deploy before writing', async (t) => {
  const f = await setup(t);
  f.state.configuration.website.WebsiteConfiguration.ErrorDocument = { Key: 'errors/404.html' };
  await assert.rejects(
    assertHostingBackupCurrent({ ...f, target }),
    /configuration changed after the backup/,
  );
  const g = await setup(t);
  const other = { envId: 'other-env', site: target.site };
  await assert.rejects(
    assertHostingBackupCurrent({ ...g, provider: { ...g.provider, target: other }, target: other }),
    /another target/,
  );
});
