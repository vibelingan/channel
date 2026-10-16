import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { preparationUsingImage, setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { prepareStoredCatalogImage } from '../../functions/admin/src/catalog-image-protection.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import {
  ALIBABA_IMAGE_IMPORT_OWNER,
  removeImportedCandidate,
} from '../../functions/alibaba-catalog-sync/src/media-import.ts';
import { JsonFileAdapter } from './json-adapter.ts';
async function fixture(t: { after(fn: () => void): void }, kind: 'admin' | 'source') {
  const directory = mkdtempSync(join(tmpdir(), 'channel-preparation-hold-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(directory, 'media'));
  setMediaStorage(storage);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
    'base64',
  );
  const target = await storage.putObject({
    namespace: 'catalog',
    logicalId: 'source-only',
    fileName: 'image.png',
    mimeType: 'image/png',
    content: bytes,
  });
  const product = {
    _id: 'p',
    name: 'Clock',
    imageIds: [],
    productFamily: 'misc',
    published: false,
  };
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin', status: 'active' }],
      products: [product],
      images: [
        {
          _id: 'source-only',
          ...target,
          status: 'active',
          mimeType: 'image/png',
          byteSize: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          publishedRefCount: 0,
          uploadedByUserId: kind === 'source' ? ALIBABA_IMAGE_IMPORT_OWNER : 'admin',
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'hold-worker-secret',
    environmentId: 'local-test',
  });
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command);
  const start = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(start.ok && 'progress' in start);
  const jobId = start.progress.jobId;
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId, lease: c.lease };
  const token = await signSession('hold-admin-secret', {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.invalid',
  });
  let deletes = 0;
  const remove = storage.deleteObject.bind(storage);
  storage.deleteObject = async (...args) => {
    deletes++;
    return remove(...args);
  };
  async function deleteImage() {
    if (kind === 'source') return removeImportedCandidate('source-only');
    return handleAdminRequest(
      { action: 'abandonUpload', token, data: { imageId: 'source-only' } },
      { jwtSecret: 'hold-admin-secret' },
    );
  }
  return {
    adapter,
    run,
    scope,
    authority,
    storage,
    file,
    product,
    deleteImage,
    get deletes() {
      return deletes;
    },
  };
}
for (const kind of ['admin', 'source'] as const)
  test(`${kind} actual deletion preserves source-only held bytes; cancellation allows normal cleanup`, async (t) => {
    const f = await fixture(t, kind);
    assert.ok(
      (await f.run({ action: 'reserve-image-check', ...f.scope, imageId: 'source-only' })).ok,
    );
    assert.equal(await preparationUsingImage('source-only'), 'p');
    assert.equal((await f.deleteImage()).ok, false);
    assert.equal(f.deletes, 0);
    assert.equal((await f.adapter.get('images', 'source-only'))?.imageMutationOwner, '');
    assert.ok(
      (
        await f.run({
          action: 'cancel',
          actorId: 'admin',
          jobId: f.scope.jobId,
          expectedLeaseVersion: 1,
        })
      ).ok,
    );
    assert.equal(await preparationUsingImage('source-only'), null);
    assert.equal((await f.deleteImage()).ok, true);
    assert.equal(f.deletes, 1);
    assert.equal(await f.adapter.get('images', 'source-only'), null);
    assert.deepEqual(await f.adapter.get('products', 'p'), f.product);
  });
for (const kind of ['admin', 'source'] as const)
  test(`${kind} delete that already scanned before reservation keeps its mutex visible to the late checker`, async (t) => {
    const f = await fixture(t, kind);
    const list = f.adapter.list.bind(f.adapter);
    let raced = false;
    let health: unknown;
    f.adapter.list = async (q) => {
      const page = await list(q);
      if (!raced && q.collection === 'catalogImageObservations') {
        raced = true;
        assert.ok(
          (await f.run({ action: 'reserve-image-check', ...f.scope, imageId: 'source-only' })).ok,
        );
        health = (
          await prepareStoredCatalogImage(f.authority, { ...f.scope, imageId: 'source-only' })
        ).health;
      }
      return page;
    };
    assert.equal((await f.deleteImage()).ok, true);
    assert.equal(raced, true);
    assert.deepEqual(health, { status: 'retry', reason: 'busy' });
    assert.equal(f.deletes, 1);
    assert.deepEqual(await f.adapter.get('products', 'p'), f.product);
    const rows = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(
      rows.catalogImageObservations.some(
        (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
      ),
      false,
    );
  });
test('unknown ACK and database reopen preserve one hold, not image or product writes', async (t) => {
  const f = await fixture(t, 'source');
  const command = { action: 'reserve-image-check' as const, ...f.scope, imageId: 'source-only' };
  const first = await f.run(command);
  assert.ok(first.ok);
  const before = readFileSync(f.file, 'utf8');
  const reopened = new JsonFileAdapter(f.file);
  setAdapter(reopened);
  assert.equal(await preparationUsingImage('source-only'), 'p');
  assert.ok((await reopened.manageCatalogPreparationJob(f.authority, command)).ok);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
  assert.deepEqual(rows.images, JSON.parse(before).images);
  assert.deepEqual(rows.products, JSON.parse(before).products);
});
