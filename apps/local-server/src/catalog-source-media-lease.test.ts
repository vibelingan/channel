import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { JsonFileAdapter } from './json-adapter.ts';
async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-leased-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [{ _id: 'p', name: 'Clock', published: false, productFamily: 'misc' }],
    }),
  );
  const now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'leased-source-test',
    environmentId: 'local',
    now: () => now,
  });
  const adapter = new JsonFileAdapter(file);
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command, now);
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const jobId = s.progress.jobId;
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'source-worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId, lease: c.lease };
  const base = {
    sourceUrl: 'https://sc04.alicdn.com/leased-source.png',
    operationId: 'source-operation',
    imageId: 'source-image',
    now: new Date(now).toISOString(),
  };
  const source = (
    command: Extract<
      Parameters<typeof adapter.manageCatalogPreparationJob>[1],
      { action: 'manage-source-media' }
    >['command'],
  ) => run({ action: 'manage-source-media', ...scope, command });
  const target = {
    storageProvider: 'local-disk' as const,
    storageMode: 'local-disk' as const,
    storageFileId: 'local-disk:source.png',
    storagePath: 'source.png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    mimeType: 'image/png' as const,
    name: 'Source photo',
  };
  return { file, adapter, authority, run, scope, base, source, target, now };
}
test('actual JSON source claim/checkpoint/activation persists through reopen without product changes', async (t) => {
  const f = await fixture(t);
  const before = await f.adapter.get('products', 'p');
  assert.deepEqual(await f.source({ ...f.base, action: 'claim' }), {
    ok: true,
    sourceMedia: { status: 'claimed' },
  });
  assert.ok((await f.source({ ...f.base, action: 'checkpoint', target: f.target })).ok);
  const command = { ...f.base, action: 'activate' as const, target: f.target };
  const result = await f.source(command);
  assert.deepEqual(result, {
    ok: true,
    sourceMedia: { status: 'ready', imageId: 'source-image', deduplicated: false },
  });
  const reopened = new JsonFileAdapter(f.file);
  assert.equal((await reopened.get('images', 'source-image'))?.status, 'active');
  assert.deepEqual(await reopened.get('products', 'p'), before);
  assert.deepEqual(
    await reopened.manageCatalogPreparationJob(
      f.authority,
      { action: 'manage-source-media', ...f.scope, command },
      f.now,
    ),
    result,
  );
});
test('source claim file persistence failure rolls back image, URL claim and job fence', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.file, 'utf8');
  Object.defineProperty(f.adapter, 'persist', {
    configurable: true,
    value: () => {
      throw Error('source-file-failure');
    },
  });
  await assert.rejects(f.source({ ...f.base, action: 'claim' }), /source-file-failure/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const reopened = new JsonFileAdapter(f.file);
  assert.equal(await reopened.get('images', 'source-image'), null);
  assert.equal(Reflect.deleteProperty(f.adapter, 'persist'), true);
  assert.ok((await f.source({ ...f.base, action: 'claim' })).ok);
});
test('source reuse removes only the unuploaded pending image through the preparation transaction', async (t) => {
  const f = await fixture(t);
  await f.source({ ...f.base, action: 'claim' });
  await f.source({ ...f.base, action: 'checkpoint', target: f.target });
  await f.source({ ...f.base, action: 'activate', target: f.target });
  const second = {
    ...f.base,
    sourceUrl: 'https://sc04.alicdn.com/same-pixels.png',
    operationId: 'second-operation',
    imageId: 'pending-duplicate',
  };
  assert.ok((await f.source({ ...second, action: 'claim' })).ok);
  assert.equal(
    await f.adapter.acquireImageMutation('source-image', second.operationId, f.base.now),
    'acquired',
  );
  const result = await f.source({
    ...second,
    action: 'reuse',
    existingImageId: 'source-image',
    checksumSha256: f.target.checksumSha256,
  });
  assert.deepEqual(result, {
    ok: true,
    sourceMedia: { status: 'ready', imageId: 'source-image', deduplicated: true },
  });
  assert.equal(await f.adapter.get('images', 'pending-duplicate'), null);
  assert.equal(
    (await f.adapter.get('images', 'source-image'))?.storageFileId,
    f.target.storageFileId,
  );
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('two JSON adapters with different product leases race the same URL: one claim, one busy', async (t) => {
  const f = await fixture(t);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.products.push({
    _id: 'second',
    name: 'Another clock',
    published: false,
    productFamily: 'misc',
  });
  writeFileSync(f.file, JSON.stringify(rows));
  const other = new JsonFileAdapter(f.file);
  const s = await other.manageCatalogPreparationJob(
    f.authority,
    { action: 'start', actorId: 'admin', productId: 'second' },
    f.now,
  );
  assert.ok(s.ok && 'progress' in s);
  const d = await other.manageCatalogPreparationJob(
    f.authority,
    { action: 'dispatch', actorId: 'admin', jobId: s.progress.jobId },
    f.now,
  );
  assert.ok(d.ok && 'call' in d);
  const c = await other.manageCatalogPreparationJob(
    f.authority,
    { action: 'claim', call: d.call, owner: 'other-worker' },
    f.now,
  );
  assert.ok(c.ok && 'lease' in c);
  const results = await Promise.allSettled([
    f.source({ ...f.base, action: 'claim' }),
    other.manageCatalogPreparationJob(
      f.authority,
      {
        action: 'manage-source-media',
        jobId: s.progress.jobId,
        lease: c.lease,
        command: {
          ...f.base,
          action: 'claim',
          imageId: 'other-image',
          operationId: 'other-operation',
        },
      },
      f.now,
    ),
  ]);
  assert.equal(
    results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        r.value.ok &&
        'sourceMedia' in r.value &&
        r.value.sourceMedia.status === 'claimed',
    ).length,
    1,
  );
  assert.equal(
    results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        r.value.ok &&
        'sourceMedia' in r.value &&
        r.value.sourceMedia.status === 'busy',
    ).length,
    1,
  );
  const after = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(after.images.length, 1);
  assert.ok(after.products.every((p: { published: boolean }) => p.published === false));
});
