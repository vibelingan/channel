import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogPreparationReportSchema } from '@vibelingan-channel/shared/catalog-preparation';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'image-observation-test',
    environmentId: 'test',
    now: () => now,
  });
  const image: CollectionDoc = {
    _id: 'image',
    status: 'active',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:original.jpg',
    storagePath: 'original.jpg',
    mimeType: 'image/jpeg',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  };
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock', imageIds: ['image'], catalogContentGeneration: 3 },
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
  async function start() {
    const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
    assert.ok(s.ok && 'progress' in s);
    const jobId = s.progress.jobId;
    const call = await run({ action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(call.ok && 'call' in call);
    const claim = await run({ action: 'claim', call: call.call, owner: 'worker' });
    assert.ok(claim.ok && 'lease' in claim);
    return { jobId, lease: claim.lease };
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
async function prepared() {
  const f = fixture();
  const scope = await f.start();
  const imageInputDigest = storedCatalogImageInputDigest(f.image);
  const health = {
    status: 'verified',
    kind: 'stored-image-health-v1',
    imageId: 'image',
    inputDigest: imageInputDigest,
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    width: 800,
    height: 800,
    pages: 1,
  };
  const put = () =>
    f.run({ action: 'put-image-check', ...scope, imageId: 'image', imageInputDigest, health });
  const get = () => f.run({ action: 'get-image-check', ...scope, imageId: 'image' });
  return { ...f, fixture: f, scope, imageInputDigest, health, put, get };
}
test('verified observation persists deterministically, replay and get never grant readiness', async () => {
  const f = await prepared();
  const before = structuredClone(f.rows['products/p']);
  const image = structuredClone(f.image);
  const first = await f.put();
  assert.ok(first.ok && 'observation' in first && first.observation);
  assert.equal(first.observation.kind, 'unsealed-image-observation-v1');
  assert.equal(CatalogPreparationReportSchema.safeParse(first.observation).success, false);
  assert.deepEqual(await f.put(), first);
  assert.deepEqual(await f.get(), first);
  assert.equal(f.writes.filter((c) => c === 'catalogImageObservations').length, 1);
  assert.deepEqual(f.rows['products/p'], before);
  assert.deepEqual(f.rows['images/image'], image);
});
for (const change of [
  { imageId: 'other' },
  { inputDigest: 'b'.repeat(64) },
  { checksumSha256: 'b'.repeat(64) },
  { byteSize: 124 },
])
  test(`mismatched verified health refuses ${Object.keys(change)[0]}`, async () => {
    const f = await prepared();
    const before = f.writes.length;
    assert.deepEqual(
      await f.run({
        action: 'put-image-check',
        ...f.scope,
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health: { ...f.health, ...change },
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(f.writes.length, before);
  });
test('changed physical target refuses old put, then get reports no matching observation', async () => {
  const f = await prepared();
  assert.ok((await f.put()).ok);
  f.image.storageFileId = 'local-disk:new.jpg';
  assert.deepEqual(await f.put(), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(await f.get(), { ok: true, observation: null });
});
test('shared valid refcount increments preserve the observation, corrupt counters fail closed', async () => {
  const f = await prepared();
  const saved = await f.put();
  f.image.publishedRefCount = 2;
  assert.deepEqual(await f.get(), saved);
  f.image.publishedRefCount = 1.5;
  assert.deepEqual(await f.get(), { ok: false, code: 'CORRUPT' });
});
for (const lock of ['fresh', 'corrupt'] as const)
  test(`image ${lock} lock prevents new observation`, async () => {
    const f = await prepared();
    f.image.imageMutationOwner = 'owner';
    if (lock === 'fresh') f.image.imageMutationStartedAt = new Date(f.now).toISOString();
    const before = f.writes.length;
    assert.deepEqual(await f.put(), { ok: false, code: lock === 'fresh' ? 'BUSY' : 'CORRUPT' });
    assert.equal(f.writes.length, before);
  });
for (const reason of ['serialized', 'expired', 'cancelled'] as const)
  test(`${reason} lease cannot store any observation`, async () => {
    const f = await prepared();
    let lease: unknown = f.scope.lease;
    if (reason === 'serialized') lease = JSON.parse(JSON.stringify(lease));
    if (reason === 'expired') f.fixture.now += 120000;
    if (reason === 'cancelled')
      await f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: f.scope.jobId,
        expectedLeaseVersion: 1,
      });
    const before = f.writes.length;
    assert.deepEqual(
      await f.run({
        action: 'put-image-check',
        jobId: f.scope.jobId,
        lease,
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health: f.health,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(f.writes.length, before);
  });
test('product edit invalidates both observation writes and the old job', async () => {
  const f = await prepared();
  const p = f.rows['products/p'];
  assert.ok(p);
  p.name = 'Changed';
  assert.deepEqual(await f.put(), { ok: false, code: 'STALE' });
  assert.equal(f.rows[`catalogPreparationJobs/${f.scope.jobId}`]?.state, 'stale');
  assert.equal(f.writes.includes('catalogImageObservations'), false);
});
test('same-millisecond renewals and observation gets still advance a real write revision', async () => {
  const f = await prepared();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  const before = job.mutationRevision;
  assert.equal(typeof before, 'number');
  await f.run({ action: 'renew', ...f.scope });
  await f.run({ action: 'renew', ...f.scope });
  await f.get();
  const saved = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(saved);
  assert.equal(saved.mutationRevision, Number(before) + 3);
});

test('renewed lease stays valid across private mutation revision increments', async () => {
  const f = await prepared();
  for (let i = 0; i < 5; i++) assert.ok((await f.put()).ok);
  assert.ok((await f.run({ action: 'renew', ...f.scope })).ok);
  assert.ok((await f.get()).ok);
});
test('retry rotates nonce so a replacement worker cannot consume old observations', async () => {
  const f = await prepared();
  assert.ok((await f.put()).ok);
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
  assert.ok(
    (
      await f.run({
        action: 'retry',
        actorId: 'admin',
        jobId: f.scope.jobId,
        expectedLeaseVersion: 1,
      })
    ).ok,
  );
  const call = await f.run({ action: 'dispatch', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(call.ok && 'call' in call);
  const next = await f.run({ action: 'claim', call: call.call, owner: 'new-worker' });
  assert.ok(next.ok && 'lease' in next);
  assert.deepEqual(
    await f.run({
      action: 'get-image-check',
      jobId: f.scope.jobId,
      lease: next.lease,
      imageId: 'image',
    }),
    { ok: true, observation: null },
  );
  assert.deepEqual(await f.get(), { ok: false, code: 'CONFLICT' });
});
for (const health of [
  { status: 'invalid', reason: 'record' },
  { status: 'retry', reason: 'timeout' },
])
  test(`missing-image ${health.status} observation remains diagnostic only`, async () => {
    const f = await prepared();
    const beforeProduct = structuredClone(f.rows['products/p']);
    assert.equal(beforeProduct?.catalogPreparationState, 'checking');
    Reflect.deleteProperty(f.rows, 'images/image');
    const result = await f.run({
      action: 'put-image-check',
      ...f.scope,
      imageId: 'image',
      imageInputDigest: null,
      health,
    });
    assert.ok(result.ok && 'observation' in result && result.observation);
    assert.equal(result.observation.health.status, health.status);
    assert.equal(CatalogPreparationReportSchema.safeParse(result.observation).success, false);
    assert.deepEqual(f.rows['products/p'], beforeProduct);
  });
test('private health fields reject before any database operation', async () => {
  const f = await prepared();
  let reads = 0;
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      reads++;
      return f.tx.get(c, id);
    },
  };
  assert.deepEqual(
    await runCatalogPreparationJob(
      tx,
      f.authority,
      {
        action: 'put-image-check',
        ...f.scope,
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health: { ...f.health, privateBody: 'must never persist' },
      },
      f.now,
    ),
    { ok: false, code: 'VALIDATION_ERROR' },
  );
  assert.equal(reads, 0);
});
test('expired lease during observation reads cannot write job or child record', async () => {
  const f = await prepared();
  const before = f.writes.length;
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      const row = await f.tx.get(c, id);
      if (c === 'images') f.fixture.now += 120001;
      return row;
    },
  };
  assert.deepEqual(
    await runCatalogPreparationJob(
      tx,
      f.authority,
      {
        action: 'put-image-check',
        ...f.scope,
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health: f.health,
      },
      f.now,
    ),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal(f.writes.length, before);
});
test('corrupt observation fields never escape and cannot count as an accepted check', async () => {
  const f = await prepared();
  const stored = await f.put();
  assert.ok(stored.ok && 'observation' in stored && stored.observation);
  const row = f.rows[`catalogImageObservations/${stored.observation._id}`];
  assert.ok(row);
  row.privateToken = 'private';
  assert.deepEqual(await f.get(), { ok: false, code: 'CORRUPT' });
});
test('mutation revision overflow rejects writes while human progress remains readable', async () => {
  const f = await prepared();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.mutationRevision = Number.MAX_SAFE_INTEGER;
  const before = f.writes.length;
  assert.deepEqual(await f.put(), { ok: false, code: 'CORRUPT' });
  assert.equal(f.writes.length, before);
  assert.ok((await f.run({ action: 'get', actorId: 'admin', jobId: f.scope.jobId })).ok);
});

test('forged observation lease rejects before image and product reads', async () => {
  const f = await prepared();
  let expensiveReads = 0;
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      if (c === 'images' || c === 'products') expensiveReads++;
      return f.tx.get(c, id);
    },
  };
  assert.deepEqual(
    await runCatalogPreparationJob(
      tx,
      f.authority,
      {
        action: 'put-image-check',
        jobId: f.scope.jobId,
        lease: {},
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health: f.health,
      },
      f.now,
    ),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal(expensiveReads, 0);
});

for (const health of [
  { status: 'invalid', reason: 'content' },
  { status: 'retry', reason: 'unavailable' },
])
  test(`old ${health.status} result cannot attach to a replacement physical target`, async () => {
    const f = await prepared();
    f.image.storageFileId = 'local-disk:replacement.png';
    const before = f.writes.length;
    assert.deepEqual(
      await f.run({
        action: 'put-image-check',
        ...f.scope,
        imageId: 'image',
        imageInputDigest: f.imageInputDigest,
        health,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(f.writes.length, before);
  });
test('a valid checksum metadata replacement selects a fresh observation rather than a corrupt old one', async () => {
  const f = await prepared();
  assert.ok((await f.put()).ok);
  f.image.checksumSha256 = 'b'.repeat(64);
  assert.deepEqual(await f.get(), { ok: true, observation: null });
});
