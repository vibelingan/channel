import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import { finalizeCatalogImageUpload } from '../../functions/admin/src/catalog-image-upload.ts';
import { JsonFileAdapter } from './json-adapter.ts';
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
async function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-image-observation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(directory, 'media'));
  setMediaStorage(storage);
  const target = await storage.putObject({
    namespace: 'catalog',
    logicalId: 'image',
    fileName: 'sample.png',
    mimeType: 'image/png',
    content: bytes,
  });
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        { _id: 'p', name: 'Clock', productFamily: 'misc', published: false, imageIds: ['image'] },
      ],
      images: [
        {
          _id: 'image',
          ...target,
          status: 'pending',
          uploadedByUserId: 'admin',
          uploadIntentId: 'owned-intent',
          purpose: 'catalog-image',
          mimeType: 'image/png',
          publishedRefCount: 0,
          byteSize: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  assert.ok((await finalizeCatalogImageUpload('image', 'admin')).ok);
  const authority = createCatalogPreparationAuthority({
    secret: 'local-observation-test',
    environmentId: 'local',
  });
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command);
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const jobId = s.progress.jobId;
  const call = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(call.ok && 'call' in call);
  const claim = await run({ action: 'claim', call: call.call, owner: 'worker' });
  assert.ok(claim.ok && 'lease' in claim);
  const health = await readStoredCatalogImageHealth('image');
  assert.equal(health.status, 'verified');
  if (health.status !== 'verified') throw Error('default native health failed');
  const command = {
    action: 'put-image-check' as const,
    jobId,
    lease: claim.lease,
    imageId: 'image',
    imageInputDigest: health.inputDigest,
    health,
  };
  return { file, adapter, storage, authority, run, jobId, lease: claim.lease, health, command };
}
test('ordinary byte activation -> default file reader/native pixels -> persisted observation -> reopened worker', async (t) => {
  const f = await fixture(t);
  const image = await f.adapter.get('images', 'image');
  const product = await f.adapter.get('products', 'p');
  assert.equal(f.health.width, 24);
  assert.equal(f.health.height, 16);
  assert.equal(f.health.checksumSha256, createHash('sha256').update(bytes).digest('hex'));
  const saved = await f.run(f.command);
  assert.ok(saved.ok && 'observation' in saved && saved.observation);
  assert.equal(saved.observation.kind, 'unsealed-image-observation-v1');
  assert.ok((await f.run({ action: 'release', jobId: f.jobId, lease: f.lease })).ok);
  const reopened = new JsonFileAdapter(f.file);
  const fresh = createCatalogPreparationAuthority({
    secret: 'local-observation-test',
    environmentId: 'local',
  });
  const call = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(call.ok && 'call' in call);
  const next = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'claim',
    call: call.call,
    owner: 'new-worker',
  });
  assert.ok(next.ok && 'lease' in next);
  const result = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'get-image-check',
    jobId: f.jobId,
    lease: next.lease,
    imageId: 'image',
  });
  assert.deepEqual(result, saved);
  assert.deepEqual(await reopened.get('images', 'image'), image);
  assert.deepEqual(await reopened.get('products', 'p'), product);
});
test('file persist failure rolls back observation and job write revision together', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.file, 'utf8');
  Object.defineProperty(f.adapter, 'persist', {
    value: () => {
      throw Error('observation-disk-fault');
    },
  });
  await assert.rejects(f.run(f.command), /observation-disk-fault/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const reopened = new JsonFileAdapter(f.file);
  const response = await reopened.manageCatalogPreparationJob(f.authority, {
    action: 'get-image-check',
    jobId: f.jobId,
    lease: f.lease,
    imageId: 'image',
  });
  assert.deepEqual(response, { ok: true, observation: null });
});
test('lost observation ACK replays the stored result without duplicate records', async (t) => {
  const f = await fixture(t);
  const original = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lose = true;
  f.adapter.manageCatalogPreparationJob = async (authority, command, now) => {
    const result = await original(authority, command, now);
    if (command.action === 'put-image-check' && lose) {
      lose = false;
      throw Error('lost-observation-ack');
    }
    return result;
  };
  await assert.rejects(f.run(f.command), /lost-observation-ack/);
  const replay = await f.run(f.command);
  assert.ok(replay.ok && 'observation' in replay && replay.observation);
  const parsed: unknown = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object');
  const observations: unknown = Reflect.get(parsed, 'catalogImageObservations');
  assert.ok(Array.isArray(observations));
  assert.equal(observations.length, 1);
});
