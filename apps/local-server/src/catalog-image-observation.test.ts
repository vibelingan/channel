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

test('durable media cursor continues after database reopen and a fresh worker authority', async (t) => {
  const f = await fixture(t);
  const planDigest = 'b'.repeat(64);
  assert.ok(
    (
      await f.run({
        action: 'bind-media-plan',
        jobId: f.jobId,
        lease: f.lease,
        planDigest,
        total: 2,
      })
    ).ok,
  );
  const step = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
  const first = await f.run(step);
  assert.ok(first.ok && 'media' in first);
  assert.equal(first.media.cursor, 1);
  assert.ok((await f.run({ action: 'release', jobId: f.jobId, lease: f.lease })).ok);
  const reopened = new JsonFileAdapter(f.file);
  const fresh = createCatalogPreparationAuthority({
    secret: 'local-observation-test',
    environmentId: 'local',
  });
  const dispatch = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(dispatch.ok && 'call' in dispatch);
  const claimed = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'claim',
    call: dispatch.call,
    owner: 'second-worker',
  });
  assert.ok(claimed.ok && 'lease' in claimed);
  const binding = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'bind-media-plan',
    jobId: f.jobId,
    lease: claimed.lease,
    planDigest,
    total: 2,
  });
  assert.deepEqual(binding, first);
  const second = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'advance-media-check',
    jobId: f.jobId,
    lease: claimed.lease,
    planDigest,
    index: 1,
    imageId: 'missing',
    imageInputDigest: null,
    health: { status: 'invalid', reason: 'record' },
  });
  assert.ok(second.ok && 'media' in second);
  assert.equal(second.media.cursor, 2);
  assert.equal(second.media.verified, 1);
  assert.equal(second.media.invalid, 1);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
test('lost media-step ACK replays exactly one observation and cursor increment', async (t) => {
  const f = await fixture(t);
  const planDigest = 'b'.repeat(64);
  await f.run({ action: 'bind-media-plan', jobId: f.jobId, lease: f.lease, planDigest, total: 1 });
  const original = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lose = true;
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    const r = await original(a, cmd, now);
    if (cmd.action === 'advance-media-check' && lose) {
      lose = false;
      throw Error('lost-media-step-ack');
    }
    return r;
  };
  const cmd = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
  await assert.rejects(f.run(cmd), /lost-media-step-ack/);
  const replay = await f.run(cmd);
  assert.ok(replay.ok && 'media' in replay);
  assert.equal(replay.media.cursor, 1);
  assert.equal(replay.media.verified, 1);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
  assert.equal(rows.catalogPreparationJobs[0].media.cursor, 1);
});
test('file failure rolls back cursor and observation together; duplicate concurrent step advances once', async (t) => {
  const f = await fixture(t);
  const planDigest = 'b'.repeat(64);
  await f.run({ action: 'bind-media-plan', jobId: f.jobId, lease: f.lease, planDigest, total: 1 });
  const before = readFileSync(f.file, 'utf8');
  Object.defineProperty(f.adapter, 'persist', {
    configurable: true,
    value: () => {
      throw Error('media-step-disk-fault');
    },
  });
  const cmd = { ...f.command, action: 'advance-media-check' as const, planDigest, index: 0 };
  await assert.rejects(f.run(cmd), /media-step-disk-fault/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(Reflect.deleteProperty(f.adapter, 'persist'), true);
  const other = new JsonFileAdapter(f.file);
  const results = await Promise.allSettled([
    f.run(cmd),
    other.manageCatalogPreparationJob(f.authority, cmd),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'fulfilled');
    if (r.status === 'fulfilled') {
      assert.ok(r.value.ok && 'media' in r.value);
      assert.equal(r.value.media.cursor, 1);
    }
  }
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
  assert.equal(rows.catalogPreparationJobs[0].media.verified, 1);
});
