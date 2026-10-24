import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { storedCatalogImageInputDigest } from '@vibelingan-channel/db/catalog-image-input';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { decodeCatalogImagePixels } from '@vibelingan-channel/media-storage/pixels';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import {
  hasImageUploadCompletion,
  retargetImageUploadCompletion,
} from '../../../packages/db/src/image-upload.ts';
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

async function protectedFileFixture(t: { after(fn: () => void): void }) {
  const f = await fixture(t);
  const source = await f.adapter.get('images', 'image');
  assert.ok(source && typeof source.storageFileId === 'string');
  const begin = await f.run({
    action: 'begin-image-protection',
    jobId: f.jobId,
    lease: f.lease,
    imageId: 'image',
    imageInputDigest: f.health.inputDigest,
  });
  assert.ok(begin.ok && 'protection' in begin);
  const sourceFileId = source.storageFileId;
  const intent = begin.protection;
  const raw = await f.storage.getObjectAsBase64(source.storageFileId, {
    maxBytes: f.health.byteSize,
    timeoutMs: 5000,
  });
  const body = Buffer.from(raw.body, 'base64');
  assert.equal(createHash('sha256').update(body).digest('hex'), f.health.checksumSha256);
  const copied = await f.storage.putObject(
    {
      namespace: 'catalog-sealed',
      logicalId: `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
      fileName: 'original.png',
      mimeType: 'image/png',
      content: body,
    },
    {
      beforeWrite: async (target) => {
        assert.equal(target.byteSize, body.length);
        assert.ok(
          (
            await f.run({
              action: 'checkpoint-image-protection',
              jobId: f.jobId,
              lease: f.lease,
              imageId: 'image',
              intentId: intent._id,
              target: { ...target, byteSize: body.length },
            })
          ).ok,
        );
      },
    },
  );
  assert.equal(
    copied.storagePath,
    catalogProtectedStoragePath(
      `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
      'original.png',
    ),
  );
  assert.notEqual(copied.storageFileId, source.storageFileId);
  const targetBytes = Buffer.from(
    (
      await f.storage.getObjectAsBase64(copied.storageFileId, {
        maxBytes: f.health.byteSize,
        timeoutMs: 5000,
      })
    ).body,
    'base64',
  );
  const pixels = await decodeCatalogImagePixels(targetBytes, 'image/png');
  assert.equal(pixels.status, 'decoded');
  if (pixels.status !== 'decoded') throw Error('default target decoder failed');
  const health = {
    status: 'verified' as const,
    kind: 'stored-image-health-v1' as const,
    imageId: 'image',
    inputDigest: storedCatalogImageInputDigest({ ...source, ...copied }),
    byteSize: targetBytes.length,
    checksumSha256: pixels.checksumSha256,
    width: pixels.width,
    height: pixels.height,
    pages: pixels.pages,
  };
  const command = {
    action: 'commit-image-protection' as const,
    jobId: f.jobId,
    lease: f.lease,
    imageId: 'image',
    intentId: intent._id,
    health,
  };
  return { ...f, source, sourceFileId, intent, copied, health, command };
}
test('actual byte activation -> protected file copy/checkpoint/native pixels -> atomic target switch -> default reload -> cursor persists', async (t) => {
  const f = await protectedFileFixture(t);
  const product = await f.adapter.get('products', 'p');
  const committed = await f.run(f.command);
  assert.ok(committed.ok && 'protection' in committed);
  assert.equal(committed.protection.state, 'committed');
  const actual = await readStoredCatalogImageHealth('image');
  assert.deepEqual(actual, f.health);
  assert.equal((await f.adapter.get('images', 'image'))?.imageMutationOwner, '');
  const planDigest = 'b'.repeat(64);
  await f.run({ action: 'bind-media-plan', jobId: f.jobId, lease: f.lease, planDigest, total: 1 });
  const checked = await f.run({
    action: 'advance-media-check',
    jobId: f.jobId,
    lease: f.lease,
    planDigest,
    index: 0,
    imageId: 'image',
    imageInputDigest: f.health.inputDigest,
    health: f.health,
  });
  assert.ok(checked.ok && 'media' in checked);
  assert.equal(checked.media.cursor, 1);
  assert.equal(checked.media.verified, 1);
  assert.deepEqual(await f.adapter.get('products', 'p'), product);
  assert.equal(
    (
      await f.storage.getObjectAsBase64(f.sourceFileId, {
        maxBytes: f.health.byteSize,
        timeoutMs: 5000,
      })
    ).body,
    (
      await f.storage.getObjectAsBase64(f.copied.storageFileId, {
        maxBytes: f.health.byteSize,
        timeoutMs: 5000,
      })
    ).body,
  );
  const reopened = new JsonFileAdapter(f.file);
  assert.deepEqual(await reopened.get('images', 'image'), await f.adapter.get('images', 'image'));
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
test('file target-switch persistence failure restores pointer, journal and job together', async (t) => {
  const f = await protectedFileFixture(t);
  const before = readFileSync(f.file, 'utf8');
  Object.defineProperty(f.adapter, 'persist', {
    value: () => {
      throw Error('protection-switch-disk-fault');
    },
  });
  await assert.rejects(f.run(f.command), /protection-switch-disk-fault/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const reopened = new JsonFileAdapter(f.file);
  assert.equal((await reopened.get('images', 'image'))?.storageFileId, f.sourceFileId);
  const intent = await reopened.get('catalogImageObservations', f.intent._id);
  assert.equal(intent?.state, 'targeted');
  assert.equal(
    (
      await f.storage.getObjectAsBase64(f.copied.storageFileId, {
        maxBytes: f.health.byteSize,
        timeoutMs: 5000,
      })
    ).body,
    bytes.toString('base64'),
  );
});
test('lost target-switch ACK discovers the committed marker and does not copy or reserve again', async (t) => {
  const f = await protectedFileFixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lose = true;
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    const r = await manage(a, cmd, now);
    if (cmd.action === 'commit-image-protection' && lose) {
      lose = false;
      throw Error('lost-protection-switch-ack');
    }
    return r;
  };
  await assert.rejects(f.run(f.command), /lost-protection-switch-ack/);
  const actual = await readStoredCatalogImageHealth('image');
  assert.equal(actual.status, 'verified');
  if (actual.status !== 'verified') throw Error('actual protected reload failed');
  const resumed = await f.run({
    action: 'begin-image-protection',
    jobId: f.jobId,
    lease: f.lease,
    imageId: 'image',
    imageInputDigest: actual.inputDigest,
  });
  assert.ok(resumed.ok && 'protection' in resumed);
  assert.equal(resumed.protection._id, f.intent._id);
  assert.equal(resumed.protection.state, 'committed');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
  assert.equal(rows.images[0].storageFileId, f.copied.storageFileId);
});

test('ordinary upload completion remains idempotent after a protected target switch', async (t) => {
  const f = await protectedFileFixture(t);
  assert.ok((await f.run(f.command)).ok);
  const repeated = await finalizeCatalogImageUpload('image', 'admin');
  assert.ok(repeated.ok, JSON.stringify(repeated));
  assert.equal(repeated.data.imageId, 'image');
  assert.equal(repeated.data.image.storageFileId, f.copied.storageFileId);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

test('receipt retargeting cannot bless different bytes, uploader or upload identity', async (t) => {
  const f = await fixture(t);
  const original = await f.adapter.get('images', 'image');
  assert.ok(original);
  assert.equal(hasImageUploadCompletion(original), true);
  for (const change of [
    { byteSize: f.health.byteSize + 1 },
    { checksumSha256: 'b'.repeat(64) },
    { uploadedByUserId: 'foreign' },
    { uploadIntentId: 'another-intent' },
    { purpose: 'oem-file' },
    { mimeType: 'image/gif' },
    { _id: 'other-image' },
    { status: 'pending' },
  ]) {
    const moved: CollectionDoc = {
      ...original,
      storageFileId: 'local-disk:different.png',
      ...change,
    };
    assert.equal(
      hasImageUploadCompletion(retargetImageUploadCompletion(original, moved)),
      false,
      Object.keys(change)[0],
    );
  }
});

test('two actual file adapters preparing a shared image admit exactly one owner', async (t) => {
  const f = await fixture(t);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  saved.products.push({
    _id: 'second',
    name: 'Second clock',
    published: false,
    productFamily: 'misc',
    imageIds: ['image'],
  });
  writeFileSync(f.file, JSON.stringify(saved));
  const started = await f.run({ action: 'start', actorId: 'admin', productId: 'second' });
  assert.ok(started.ok && 'progress' in started);
  const dispatch = await f.run({
    action: 'dispatch',
    actorId: 'admin',
    jobId: started.progress.jobId,
  });
  assert.ok(dispatch.ok && 'call' in dispatch);
  const claimed = await f.run({ action: 'claim', call: dispatch.call, owner: 'second-worker' });
  assert.ok(claimed.ok && 'lease' in claimed);
  const beforeProtection = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(beforeProtection.products[1]._id, 'second');
  assert.equal(beforeProtection.products[1].catalogPreparationRequest.productId, 'second');
  const other = new JsonFileAdapter(f.file);
  const imageInputDigest = f.health.inputDigest;
  const outcomes = await Promise.allSettled([
    f.run({
      action: 'begin-image-protection',
      jobId: f.jobId,
      lease: f.lease,
      imageId: 'image',
      imageInputDigest,
    }),
    other.manageCatalogPreparationJob(f.authority, {
      action: 'begin-image-protection',
      jobId: started.progress.jobId,
      lease: claimed.lease,
      imageId: 'image',
      imageInputDigest,
    }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled' && r.value.ok).length, 1);
  assert.equal(
    outcomes.filter((r) => r.status === 'fulfilled' && !r.value.ok && r.value.code === 'BUSY')
      .length,
    1,
  );
  const reopened = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(reopened.catalogImageObservations.length, 1);
  assert.equal(reopened.catalogImageObservations[0].owner, reopened.images[0].imageMutationOwner);
  assert.equal(reopened.images[0].storageFileId, saved.images[0].storageFileId);
  assert.deepEqual(reopened.products, beforeProtection.products);
});
