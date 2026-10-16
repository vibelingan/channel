import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { transitionImageMutationAcquire } from './adapter.ts';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import { CatalogImageProtectionIntentSchema } from './catalog-image-protection-contract.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { runSourceMediaImport } from './source-media-import.ts';
function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'protection-test',
    environmentId: 'test',
    now: () => now,
  });
  const image: CollectionDoc = {
    _id: 'image',
    status: 'active',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:raw.png',
    storagePath: 'raw.png',
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  };
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock', imageIds: ['image'] },
    'images/image': image,
  };
  const writes: string[] = [];
  const tx = {
    get: async (c: string, id: string) => structuredClone(rows[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      writes.push(c);
      rows[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const run = (cmd: unknown) => runCatalogPreparationJob(tx, authority, cmd, now);
  async function start(owner = 'worker', productId = 'p') {
    const s = await run({ action: 'start', actorId: 'admin', productId });
    assert.ok(s.ok && 'progress' in s);
    const d = await run({ action: 'dispatch', actorId: 'admin', jobId: s.progress.jobId });
    assert.ok(d.ok && 'call' in d);
    const c = await run({ action: 'claim', call: d.call, owner });
    assert.ok(c.ok && 'lease' in c);
    return { jobId: c.progress.jobId, lease: c.lease };
  }
  return {
    rows,
    image,
    writes,
    tx,
    authority,
    run,
    start,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
async function reserved() {
  const f = fixture();
  const scope = await f.start();
  const imageInputDigest = storedCatalogImageInputDigest(f.image);
  const begin = () =>
    f.run({ action: 'begin-image-protection', ...scope, imageId: 'image', imageInputDigest });
  const b = await begin();
  assert.ok(b.ok && 'protection' in b);
  const intent = CatalogImageProtectionIntentSchema.parse(b.protection);
  const path = catalogProtectedStoragePath(
    `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
    'original.png',
  );
  const target = {
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: `local-disk:${path}`,
    storagePath: path,
    byteSize: 123,
  };
  const checkpoint = () =>
    f.run({
      action: 'checkpoint-image-protection',
      ...scope,
      imageId: 'image',
      intentId: intent._id,
      target,
    });
  return { f, scope, imageInputDigest, begin, intent, target, checkpoint };
}
test('begin reserves one stable private intent and owns the image without changing content or refcounts', async () => {
  const h = await reserved();
  assert.deepEqual(await h.begin(), { ok: true, protection: h.intent });
  const image = h.f.rows['images/image'];
  assert.ok(image);
  assert.equal(image.storageFileId, 'local-disk:raw.png');
  assert.equal(image.publishedRefCount, 0);
  assert.equal(image.imageMutationOwner, h.intent.owner);
  assert.equal(h.intent.state, 'reserved');
  assert.equal(
    Object.values(h.f.rows).filter((r) => r.kind === 'catalog-image-protection-intent-v1').length,
    1,
  );
});
test('checkpoint then exact health atomically switches only the current image target and marks the journal', async () => {
  const h = await reserved();
  assert.ok((await h.checkpoint()).ok);
  const next = { ...h.f.image, ...h.target };
  const digest = storedCatalogImageInputDigest(next);
  const health = {
    status: 'verified',
    kind: 'stored-image-health-v1',
    imageId: 'image',
    inputDigest: digest,
    checksumSha256: 'a'.repeat(64),
    byteSize: 123,
    width: 24,
    height: 16,
    pages: 1,
  };
  const cmd = {
    action: 'commit-image-protection',
    ...h.scope,
    imageId: 'image',
    intentId: h.intent._id,
    health,
  };
  const before = structuredClone(h.f.rows['products/p']);
  const result = await h.f.run(cmd);
  assert.ok(result.ok && 'protection' in result);
  assert.equal(result.protection.state, 'committed');
  assert.equal(h.f.rows['images/image']?.storageFileId, h.target.storageFileId);
  assert.equal(h.f.rows['images/image']?.imageMutationOwner, '');
  assert.deepEqual(h.f.rows['products/p'], before);
  assert.deepEqual(await h.f.run(cmd), result);
});
for (const fault of ['fake', 'cancel', 'input', 'target'] as const)
  test(`protection rejects ${fault} without a target switch`, async () => {
    const h = await reserved();
    if (fault === 'cancel')
      await h.f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      });
    if (fault === 'input') {
      const p = h.f.rows['products/p'];
      assert.ok(p);
      p.name = 'Changed';
    }
    if (fault === 'target') {
      const image = h.f.rows['images/image'];
      assert.ok(image);
      image.storageFileId = 'local-disk:replacement.png';
    }
    const result = await h.f.run({
      action: 'checkpoint-image-protection',
      ...h.scope,
      lease: fault === 'fake' ? {} : h.scope.lease,
      imageId: 'image',
      intentId: h.intent._id,
      target: h.target,
    });
    assert.deepEqual(result, { ok: false, code: fault === 'input' ? 'STALE' : 'CONFLICT' });
    assert.equal(
      h.f.rows['images/image']?.storageFileId,
      fault === 'target' ? 'local-disk:replacement.png' : 'local-disk:raw.png',
    );
  });
test('a replacement lease can reclaim a proven old owner; the old worker cannot checkpoint or release its new lock', async () => {
  const h = await reserved();
  h.f.now += 120000;
  const scope = await h.f.start('replacement');
  const begin = await h.f.run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: h.imageInputDigest,
  });
  assert.ok(begin.ok && 'protection' in begin);
  assert.equal(begin.protection._id, h.intent._id);
  assert.equal(begin.protection.attemptId, h.intent.attemptId);
  assert.notEqual(begin.protection.owner, h.intent.owner);
  assert.deepEqual(await h.checkpoint(), { ok: false, code: 'CONFLICT' });
  assert.equal(h.f.rows['images/image']?.imageMutationOwner, begin.protection.owner);
});

test('cancelled or expired grant may only release its own lock, copied and foreign grants cannot', async () => {
  for (const cancelled of [true, false]) {
    const h = await reserved();
    if (cancelled)
      await h.f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      });
    else h.f.now += 120000;
    assert.equal(
      h.f.authority.currentLeaseScope(
        h.scope.lease,
        h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`],
      ),
      null,
    );
    assert.deepEqual(h.f.authority.cleanupLeaseScope(h.scope.lease), {
      jobId: h.scope.jobId,
      leaseOwner: 'worker',
      leaseVersion: 1,
    });
    assert.equal(h.f.authority.cleanupLeaseScope({}), null);
    const foreign = createCatalogPreparationAuthority({
      secret: 'protection-test',
      environmentId: 'test',
    });
    assert.equal(foreign.cleanupLeaseScope(h.scope.lease), null);
    const release = {
      action: 'release-image-protection',
      ...h.scope,
      imageId: 'image',
      intentId: h.intent._id,
    };
    assert.deepEqual(await h.f.run({ ...release, lease: {} }), { ok: false, code: 'CONFLICT' });
    assert.ok((await h.f.run(release)).ok);
    assert.equal(h.f.rows['images/image']?.imageMutationOwner, '');
    assert.equal(h.f.rows['images/image']?.storageFileId, 'local-disk:raw.png');
    assert.deepEqual(await h.checkpoint(), { ok: false, code: 'CONFLICT' });
  }
});
test('stale cleanup cannot release a replacement worker lock', async () => {
  const h = await reserved();
  h.f.now += 120000;
  const scope = await h.f.start('replacement');
  const b = await h.f.run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: h.imageInputDigest,
  });
  assert.ok(b.ok && 'protection' in b);
  assert.deepEqual(
    await h.f.run({
      action: 'release-image-protection',
      ...h.scope,
      imageId: 'image',
      intentId: h.intent._id,
    }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal(h.f.rows['images/image']?.imageMutationOwner, b.protection.owner);
});
test('a corrupt counter arising after checkpoint must not be preserved in a committed protection marker', async () => {
  const h = await reserved();
  await h.checkpoint();
  const image = h.f.rows['images/image'];
  assert.ok(image);
  image.publishedRefCount = -1;
  const digest = storedCatalogImageInputDigest({ ...image, ...h.target });
  const r = await h.f.run({
    action: 'commit-image-protection',
    ...h.scope,
    imageId: 'image',
    intentId: h.intent._id,
    health: {
      status: 'verified',
      kind: 'stored-image-health-v1',
      imageId: 'image',
      inputDigest: digest,
      byteSize: 123,
      checksumSha256: 'a'.repeat(64),
      width: 24,
      height: 16,
      pages: 1,
    },
  });
  assert.deepEqual(r, { ok: false, code: 'CORRUPT' });
  assert.equal(image.storageFileId, 'local-disk:raw.png');
});
test('cleanup refuses a wrong image identity returned by the storage layer', async () => {
  const h = await reserved();
  const get = h.f.tx.get;
  h.f.tx.get = async (c, id) => {
    const r = await get(c, id);
    return c === 'images' && r ? { ...r, _id: 'foreign' } : r;
  };
  const writes = h.f.writes.length;
  assert.deepEqual(
    await h.f.run({
      action: 'release-image-protection',
      ...h.scope,
      imageId: 'image',
      intentId: h.intent._id,
    }),
    { ok: false, code: 'CORRUPT' },
  );
  assert.equal(h.f.writes.length, writes);
});
test('checkpoint lease expiry during reads prevents all writes', async () => {
  const h = await reserved();
  const get = h.f.tx.get;
  h.f.tx.get = async (c, id) => {
    const r = await get(c, id);
    if (c === 'images') h.f.now += 120000;
    return r;
  };
  const writes = h.f.writes.length;
  assert.deepEqual(await h.checkpoint(), { ok: false, code: 'CONFLICT' });
  assert.equal(h.f.writes.length, writes);
});

for (const change of [
  { imageId: 'other' },
  { inputDigest: 'b'.repeat(64) },
  { checksumSha256: 'b'.repeat(64) },
  { byteSize: 124 },
  { status: 'retry', reason: 'unavailable' },
])
  test(`target commit refuses mismatched proof ${Object.keys(change)[0]}`, async () => {
    const h = await reserved();
    await h.checkpoint();
    const digest = storedCatalogImageInputDigest({ ...h.f.image, ...h.target });
    const health =
      change.status === 'retry'
        ? change
        : {
            status: 'verified',
            kind: 'stored-image-health-v1',
            imageId: 'image',
            inputDigest: digest,
            byteSize: 123,
            checksumSha256: 'a'.repeat(64),
            width: 24,
            height: 16,
            pages: 1,
            ...change,
          };
    const writes = h.f.writes.length;
    assert.deepEqual(
      await h.f.run({
        action: 'commit-image-protection',
        ...h.scope,
        imageId: 'image',
        intentId: h.intent._id,
        health,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.f.writes.length, writes);
  });
for (const change of [
  { storagePath: 'catalog/unowned.png' },
  { storageFileId: 'local-disk:foreign.png' },
  { byteSize: 124 },
])
  test(`checkpoint refuses a foreign target ${Object.keys(change)[0]}`, async () => {
    const h = await reserved();
    const writes = h.f.writes.length;
    assert.deepEqual(
      await h.f.run({
        action: 'checkpoint-image-protection',
        ...h.scope,
        imageId: 'image',
        intentId: h.intent._id,
        target: { ...h.target, ...change },
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.f.writes.length, writes);
  });
test('legacy absence of storage mode/path/refcount is preserved and does not reject protection', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.image, 'storageMode');
  Reflect.deleteProperty(f.image, 'storagePath');
  Reflect.deleteProperty(f.image, 'publishedRefCount');
  const scope = await f.start();
  const b = await f.run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: storedCatalogImageInputDigest(f.image),
  });
  assert.ok(b.ok && 'protection' in b);
  assert.equal(b.protection.sourceStorageMode, null);
  assert.equal(b.protection.sourceStoragePath, null);
  assert.equal(Object.hasOwn(f.rows['images/image'] ?? {}, 'publishedRefCount'), false);
});
test('a valid shared refcount change during preparation is preserved at the target switch', async () => {
  const h = await reserved();
  await h.checkpoint();
  const row = h.f.rows['images/image'];
  assert.ok(row);
  row.publishedRefCount = 3;
  const digest = storedCatalogImageInputDigest({ ...row, ...h.target });
  assert.ok(
    (
      await h.f.run({
        action: 'commit-image-protection',
        ...h.scope,
        imageId: 'image',
        intentId: h.intent._id,
        health: {
          status: 'verified',
          kind: 'stored-image-health-v1',
          imageId: 'image',
          inputDigest: digest,
          byteSize: 123,
          checksumSha256: 'a'.repeat(64),
          width: 24,
          height: 16,
          pages: 1,
        },
      })
    ).ok,
  );
  assert.equal(h.f.rows['images/image']?.publishedRefCount, 3);
});

test('begin on an already protected current image returns its existing committed intent without another attempt', async () => {
  const h = await reserved();
  await h.checkpoint();
  const digest = storedCatalogImageInputDigest({ ...h.f.image, ...h.target });
  const saved = await h.f.run({
    action: 'commit-image-protection',
    ...h.scope,
    imageId: 'image',
    intentId: h.intent._id,
    health: {
      status: 'verified',
      kind: 'stored-image-health-v1',
      imageId: 'image',
      inputDigest: digest,
      byteSize: 123,
      checksumSha256: 'a'.repeat(64),
      width: 24,
      height: 16,
      pages: 1,
    },
  });
  assert.ok(saved.ok && 'protection' in saved);
  const image = h.f.rows['images/image'];
  assert.ok(image);
  const writes = h.f.writes.length;
  const replay = await h.f.run({
    action: 'begin-image-protection',
    ...h.scope,
    imageId: 'image',
    imageInputDigest: storedCatalogImageInputDigest(image),
  });
  assert.deepEqual(replay, saved);
  assert.equal(h.f.writes.length, writes);
  assert.equal(
    Object.values(h.f.rows).filter((r) => r.kind === 'catalog-image-protection-intent-v1').length,
    1,
  );
});

test('source activation ACK replay accepts the same original content after a trusted protection switch', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.rows, 'images/image');
  const store = {
    ...f.tx,
    remove: async (c: string, id: string) => {
      Reflect.deleteProperty(f.rows, `${c}/${id}`);
    },
  };
  const base = {
    sourceUrl: 'https://sc04.alicdn.com/protection.png',
    operationId: 'source-operation',
    imageId: 'image',
    now: new Date(f.now).toISOString(),
  };
  const target = {
    storageProvider: 'local-disk' as const,
    storageMode: 'local-disk' as const,
    storageFileId: 'local-disk:raw.png',
    storagePath: 'raw.png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    mimeType: 'image/png' as const,
    name: 'Source photo',
  };
  assert.equal((await runSourceMediaImport(store, { ...base, action: 'claim' })).status, 'claimed');
  assert.equal(
    (await runSourceMediaImport(store, { ...base, action: 'checkpoint', target })).status,
    'checkpointed',
  );
  const activation = { ...base, action: 'activate' as const, target };
  const first = await runSourceMediaImport(store, activation);
  assert.equal(first.status, 'ready');
  const renamed = f.rows['images/image'];
  assert.ok(renamed);
  renamed.name = 'My photo name';
  assert.deepEqual(await runSourceMediaImport(store, activation), first);
  const scope = await f.start();
  const row = f.rows['images/image'];
  assert.ok(row);
  const begin = await f.run({
    action: 'begin-image-protection',
    ...scope,
    imageId: 'image',
    imageInputDigest: storedCatalogImageInputDigest(row),
  });
  assert.ok(begin.ok && 'protection' in begin);
  const i = begin.protection;
  const path = catalogProtectedStoragePath(
    `${i.imageIdentity}:${i.checksumSha256}:${i.attemptId}`,
    'original.png',
  );
  const protectedTarget = {
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: `local-disk:${path}`,
    storagePath: path,
    byteSize: 123,
  };
  assert.ok(
    (
      await f.run({
        action: 'checkpoint-image-protection',
        ...scope,
        imageId: 'image',
        intentId: i._id,
        target: protectedTarget,
      })
    ).ok,
  );
  const digest = storedCatalogImageInputDigest({ ...row, ...protectedTarget });
  assert.ok(
    (
      await f.run({
        action: 'commit-image-protection',
        ...scope,
        imageId: 'image',
        intentId: i._id,
        health: {
          status: 'verified',
          kind: 'stored-image-health-v1',
          imageId: 'image',
          inputDigest: digest,
          byteSize: 123,
          checksumSha256: 'a'.repeat(64),
          width: 24,
          height: 16,
          pages: 1,
        },
      })
    ).ok,
  );
  const writes = f.writes.length;
  assert.deepEqual(await runSourceMediaImport(store, activation), first);
  assert.equal(f.writes.length, writes);
  assert.equal(f.rows['images/image']?.storageFileId, protectedTarget.storageFileId);
  const current = f.rows['images/image'];
  assert.ok(current);
  current.storageFileId = 'local-disk:foreign.png';
  assert.equal((await runSourceMediaImport(store, activation)).status, 'conflict');
});

test('two products sharing an image serialize protection and reuse the checkpoint after cancellation', async () => {
  const h = await reserved();
  await h.checkpoint();
  h.f.rows['products/second'] = { _id: 'second', name: 'Second clock', imageIds: ['image'] };
  const second = await h.f.start('second-worker', 'second');
  const begin = () =>
    h.f.run({
      action: 'begin-image-protection',
      ...second,
      imageId: 'image',
      imageInputDigest: h.imageInputDigest,
    });
  const writes = h.f.writes.length;
  assert.deepEqual(await begin(), { ok: false, code: 'BUSY' });
  assert.equal(h.f.writes.length, writes);
  assert.ok(
    (
      await h.f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      })
    ).ok,
  );
  const reclaimed = await begin();
  assert.ok(reclaimed.ok && 'protection' in reclaimed);
  assert.equal(reclaimed.protection._id, h.intent._id);
  assert.equal(reclaimed.protection.attemptId, h.intent.attemptId);
  assert.deepEqual(reclaimed.protection.target, h.target);
  assert.equal(reclaimed.protection.state, 'targeted');
  const current = h.f.rows['images/image'];
  assert.ok(current);
  const digest = storedCatalogImageInputDigest({ ...current, ...h.target });
  const committed = await h.f.run({
    action: 'commit-image-protection',
    ...second,
    imageId: 'image',
    intentId: h.intent._id,
    health: {
      status: 'verified',
      kind: 'stored-image-health-v1',
      imageId: 'image',
      inputDigest: digest,
      checksumSha256: 'a'.repeat(64),
      byteSize: 123,
      width: 24,
      height: 16,
      pages: 1,
    },
  });
  assert.ok(committed.ok && 'protection' in committed);
  assert.equal(h.f.rows['products/p']?.published, undefined);
  assert.equal(h.f.rows['products/second']?.published, undefined);
  const count = h.f.writes.length;
  assert.deepEqual(
    await h.f.run({
      action: 'begin-image-protection',
      ...second,
      imageId: 'image',
      imageInputDigest: digest,
    }),
    committed,
  );
  assert.equal(h.f.writes.length, count);
});

for (const corruption of [
  { owner: 'b'.repeat(64) },
  { state: 'committed', targetInputDigest: null },
  { sourceStorageFileId: 'local-disk:unrelated.png' },
  { updatedAt: '2099-01-01T00:00:00.000Z' },
])
  test(`corrupt protection journal refuses writes: ${Object.keys(corruption)[0]}`, async () => {
    const h = await reserved();
    const key = `catalogImageObservations/${h.intent._id}`;
    h.f.rows[key] = { ...h.f.rows[key], ...corruption, _id: h.intent._id };
    const writes = h.f.writes.length;
    assert.deepEqual(await h.checkpoint(), { ok: false, code: 'CORRUPT' });
    assert.equal(h.f.writes.length, writes);
    assert.equal(h.f.rows['images/image']?.storageFileId, 'local-disk:raw.png');
  });

async function withProtectedHealth() {
  const h = await reserved();
  await h.checkpoint();
  const digest = storedCatalogImageInputDigest({ ...h.f.image, ...h.target });
  const health = {
    status: 'verified' as const,
    kind: 'stored-image-health-v1' as const,
    imageId: 'image',
    inputDigest: digest,
    checksumSha256: 'a'.repeat(64),
    byteSize: 123,
    width: 24,
    height: 16,
    pages: 1,
  };
  assert.ok(
    (
      await h.f.run({
        action: 'commit-image-protection',
        ...h.scope,
        imageId: 'image',
        intentId: h.intent._id,
        health,
      })
    ).ok,
  );
  assert.ok(
    (
      await h.f.run({
        action: 'put-image-check',
        ...h.scope,
        imageId: 'image',
        imageInputDigest: digest,
        health,
      })
    ).ok,
  );
  const getHealth = (lease = h.scope.lease) =>
    h.f.run({ action: 'get-protected-image-health', ...h.scope, lease, imageId: 'image' });
  return { ...h, digest, health, getHealth };
}
test('protected verified pixel receipt is shared across current products without extra shared writes', async () => {
  const h = await withProtectedHealth();
  const writes = h.f.writes.length;
  assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: h.health });
  assert.equal(h.f.writes.length, writes);
  h.f.rows['products/second'] = { _id: 'second', name: 'Another clock', imageIds: ['image'] };
  const second = await h.f.start('second-worker', 'second');
  assert.deepEqual(
    await h.f.run({ action: 'get-protected-image-health', ...second, imageId: 'image' }),
    { ok: true, protectedHealth: h.health },
  );
  const observed = () =>
    h.f.run({
      action: 'put-image-check',
      ...second,
      imageId: 'image',
      imageInputDigest: h.digest,
      health: h.health,
    });
  assert.ok((await observed()).ok);
  assert.equal(
    Object.values(h.f.rows).filter((row) => row.kind === 'catalog-protected-image-health-v1')
      .length,
    1,
  );
  const sharedWrites = h.f.writes.filter((c) => c === 'catalogImageObservations').length;
  assert.ok((await observed()).ok);
  assert.equal(h.f.writes.filter((c) => c === 'catalogImageObservations').length, sharedWrites);
});
for (const change of [
  { policyVersion: 'old-pixels' },
  { health: { status: 'retry', reason: 'unavailable' } },
  { imageId: 'other' },
  { inputDigest: 'b'.repeat(64) },
  { attemptId: 'b'.repeat(64) },
  { intentId: 'b'.repeat(64) },
  { checkedAt: '2099-01-01T00:00:00.000Z' },
])
  test(`protected pixel receipt rejects incompatible ${Object.keys(change)[0]}`, async () => {
    const h = await withProtectedHealth();
    const cache = Object.values(h.f.rows).find(
      (row) => row.kind === 'catalog-protected-image-health-v1',
    );
    assert.ok(cache);
    Object.assign(cache, change);
    assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: null });
  });
test('unprotected historical verified observations cannot become global pixel receipts', async () => {
  const f = fixture();
  const scope = await f.start();
  const digest = storedCatalogImageInputDigest(f.image);
  await f.run({
    action: 'put-image-check',
    ...scope,
    imageId: 'image',
    imageInputDigest: digest,
    health: {
      status: 'verified',
      kind: 'stored-image-health-v1',
      imageId: 'image',
      inputDigest: digest,
      checksumSha256: 'a'.repeat(64),
      byteSize: 123,
      width: 24,
      height: 16,
      pages: 1,
    },
  });
  assert.deepEqual(
    await f.run({ action: 'get-protected-image-health', ...scope, imageId: 'image' }),
    { ok: true, protectedHealth: null },
  );
  assert.equal(
    Object.values(f.rows).some((row) => row.kind === 'catalog-protected-image-health-v1'),
    false,
  );
});
test('protected pixel receipt refuses copied grants and changed product inputs are stale', async () => {
  const h = await withProtectedHealth();
  assert.deepEqual(await h.getHealth({}), { ok: false, code: 'CONFLICT' });
  const product = h.f.rows['products/p'];
  assert.ok(product);
  product.name = 'Changed';
  assert.deepEqual(await h.getHealth(), { ok: false, code: 'STALE' });
  assert.deepEqual(await h.getHealth(), { ok: false, code: 'CONFLICT' });
});
for (const change of [
  { storageFileId: 'local-disk:replacement.png' },
  { imageMutationOwner: 'foreign', imageMutationStartedAt: '2026-10-15T16:00:00.000Z' },
  { catalogStorageProtection: null },
])
  test(`current target/lock/marker invalidates pixel receipt: ${Object.keys(change)[0]}`, async () => {
    const h = await withProtectedHealth();
    const image = h.f.rows['images/image'];
    assert.ok(image);
    Object.assign(image, change);
    assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: null });
  });

test('cancelled or expired lease never reads a reusable protected pixel receipt', async () => {
  for (const expired of [false, true]) {
    const h = await withProtectedHealth();
    if (expired) h.f.now += 120000;
    else
      await h.f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      });
    const writes = h.f.writes.length;
    assert.deepEqual(await h.getHealth(), { ok: false, code: 'CONFLICT' });
    assert.equal(h.f.writes.length, writes);
  }
});
test('lease expiry while a reusable receipt is being read prevents returning it', async () => {
  const h = await withProtectedHealth();
  const get = h.f.tx.get;
  h.f.tx.get = async (c, id) => {
    const row = await get(c, id);
    if (row?.kind === 'catalog-protected-image-health-v1') h.f.now += 120000;
    return row;
  };
  const writes = h.f.writes.length;
  assert.deepEqual(await h.getHealth(), { ok: false, code: 'CONFLICT' });
  assert.equal(h.f.writes.length, writes);
});
test('missing or malformed private committed protection proof invalidates the pixel receipt', async () => {
  const h = await withProtectedHealth();
  const key = `catalogImageObservations/${h.intent._id}`;
  const i = h.f.rows[key];
  assert.ok(i);
  i.owner = 'b'.repeat(64);
  assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: null });
  Reflect.deleteProperty(h.f.rows, key);
  assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: null });
});
for (const change of [{ checksumSha256: 'b'.repeat(64) }, { byteSize: 124 }])
  test(`cached health must match current bytes: ${Object.keys(change)[0]}`, async () => {
    const h = await withProtectedHealth();
    const cache = Object.values(h.f.rows).find(
      (r) => r.kind === 'catalog-protected-image-health-v1',
    );
    assert.ok(cache);
    cache.health = { ...h.health, ...change };
    assert.deepEqual(await h.getHealth(), { ok: true, protectedHealth: null });
  });

function sourceMediaFixture() {
  const f = fixture();
  const remove = async (c: string, id: string) => {
    f.writes.push(c);
    Reflect.deleteProperty(f.rows, `${c}/${id}`);
  };
  const run = (cmd: unknown) =>
    runCatalogPreparationJob({ ...f.tx, remove }, f.authority, cmd, f.now);
  const base = {
    sourceUrl: 'https://sc04.alicdn.com/leased-clock.png',
    operationId: 'source-worker-operation',
    imageId: 'remote-image',
    now: new Date(f.now).toISOString(),
  };
  const source = (scope: Awaited<ReturnType<typeof f.start>>, command: unknown) =>
    run({ action: 'manage-source-media', ...scope, command });
  return {
    ...f,
    run,
    base,
    source,
    get now() {
      return f.now;
    },
    set now(value: number) {
      f.now = value;
    },
  };
}
test('current preparation lease runs the existing source claim/checkpoint/activate protocol without touching product', async () => {
  const f = sourceMediaFixture();
  const scope = await f.start();
  const before = structuredClone(f.rows['products/p']);
  assert.deepEqual(await f.source(scope, { ...f.base, action: 'claim' }), {
    ok: true,
    sourceMedia: { status: 'claimed' },
  });
  const target = {
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:remote.png',
    storagePath: 'remote.png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    mimeType: 'image/png',
    name: 'Source clock',
  };
  assert.deepEqual(await f.source(scope, { ...f.base, action: 'checkpoint', target }), {
    ok: true,
    sourceMedia: { status: 'checkpointed' },
  });
  const activated = await f.source(scope, { ...f.base, action: 'activate', target });
  assert.deepEqual(activated, {
    ok: true,
    sourceMedia: { status: 'ready', imageId: f.base.imageId, deduplicated: false },
  });
  assert.deepEqual(await f.source(scope, { ...f.base, action: 'activate', target }), activated);
  assert.equal(f.rows['images/remote-image']?.status, 'active');
  assert.deepEqual(f.rows['products/p'], before);
});
for (const invalid of ['fake', 'cancel', 'expired', 'input'] as const)
  test(`leased source media refuses ${invalid} before source writes`, async () => {
    const f = sourceMediaFixture();
    const scope = await f.start();
    if (invalid === 'cancel')
      await f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: scope.jobId,
        expectedLeaseVersion: 1,
      });
    if (invalid === 'expired') f.now += 120000;
    if (invalid === 'input') {
      const p = f.rows['products/p'];
      assert.ok(p);
      p.name = 'Changed';
    }
    const result = await f.source(
      { ...scope, lease: invalid === 'fake' ? {} : scope.lease },
      { ...f.base, action: 'claim' },
    );
    assert.deepEqual(result, { ok: false, code: invalid === 'input' ? 'STALE' : 'CONFLICT' });
    assert.equal(f.rows['images/remote-image'], undefined);
  });
test('source claim uses server transaction time instead of a future caller timestamp', async () => {
  const f = sourceMediaFixture();
  const scope = await f.start();
  assert.deepEqual(
    await f.source(scope, { ...f.base, action: 'claim', now: '2099-01-01T00:00:00.000Z' }),
    { ok: true, sourceMedia: { status: 'claimed' } },
  );
  const owned = f.rows['images/remote-image']?.sourceMediaImport;
  assert.ok(owned && typeof owned === 'object');
  assert.equal(Reflect.get(owned, 'startedAt'), new Date(f.now).toISOString());
  assert.equal(Reflect.get(owned, 'expiresAt'), new Date(f.now + 120000).toISOString());
});
test('preparation capability cannot retire even an expired source claim eligible for cleanup', async () => {
  const f = sourceMediaFixture();
  const scope = await f.start();
  assert.ok((await f.source(scope, { ...f.base, action: 'claim' })).ok);
  f.now += 60000;
  assert.ok((await f.run({ action: 'renew', ...scope })).ok);
  f.now += 60000;
  const command = {
    action: 'retire' as const,
    imageId: f.base.imageId,
    owner: 'cleanup-worker',
    now: new Date(f.now).toISOString(),
  };
  const image = f.rows[`images/${f.base.imageId}`];
  assert.ok(image);
  const acquired = transitionImageMutationAcquire(image, command.owner, command.now);
  assert.ok(acquired.result === 'acquired');
  Object.assign(image, acquired.patch);
  const copy = structuredClone(f.rows);
  const eligible = await runSourceMediaImport(
    {
      get: async (c, id) => copy[`${c}/${id}`] ?? null,
      set: async (c, row) => {
        copy[`${c}/${row._id}`] = row;
      },
      remove: async (c, id) => {
        Reflect.deleteProperty(copy, `${c}/${id}`);
      },
    },
    command,
  );
  assert.equal(eligible.status, 'retired');
  const writes = f.writes.length;
  assert.deepEqual(await f.source(scope, command), { ok: false, code: 'FORBIDDEN' });
  assert.equal(f.writes.length, writes);
  assert.equal(f.rows[`images/${f.base.imageId}`]?.status, 'pending');
});

test('lease expiry during source reads prevents the first source write', async () => {
  const f = sourceMediaFixture();
  const scope = await f.start();
  const get = f.tx.get;
  f.tx.get = async (c, id) => {
    const row = await get(c, id);
    if (c === 'catalogSourceLinks') f.now += 120000;
    return row;
  };
  await assert.rejects(f.source(scope, { ...f.base, action: 'claim' }), /lease/i);
  assert.equal(f.rows['images/remote-image'], undefined);
});

test('a preparation transaction missing the real remove primitive cannot admit source imports', async () => {
  const f = fixture();
  const scope = await f.start();
  const writes = f.writes.length;
  assert.deepEqual(
    await f.run({
      action: 'manage-source-media',
      ...scope,
      command: {
        action: 'claim',
        sourceUrl: 'https://sc04.alicdn.com/missing-remove.png',
        operationId: 'missing-operation',
        imageId: 'missing-primitive',
        now: new Date(f.now).toISOString(),
      },
    }),
    { ok: false, code: 'CORRUPT' },
  );
  assert.equal(f.writes.length, writes);
});
