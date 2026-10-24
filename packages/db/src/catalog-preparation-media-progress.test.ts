import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'progress-test',
    environmentId: 'test',
    now: () => now,
  });
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock' },
  };
  const writes: string[] = [];
  const tx = {
    get: async (c: string, id: string) => structuredClone(rows[`${c}/${id}`] ?? null),
    set: async (c: string, r: CollectionDoc) => {
      writes.push(c);
      rows[`${c}/${r._id}`] = structuredClone(r);
    },
  };
  const run = (cmd: unknown) => runCatalogPreparationJob(tx, authority, cmd, now);
  async function start() {
    const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
    assert.ok(s.ok && 'progress' in s);
    const jobId = s.progress.jobId;
    const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(d.ok && 'call' in d);
    const c = await run({ action: 'claim', call: d.call, owner: 'worker' });
    assert.ok(c.ok && 'lease' in c);
    return { jobId, lease: c.lease };
  }
  return {
    rows,
    writes,
    run,
    start,
    tx,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
async function bound(total = 3) {
  const f = fixture();
  const scope = await f.start();
  const planDigest = 'b'.repeat(64);
  const bind = () => f.run({ action: 'bind-media-plan', ...scope, planDigest, total });
  const binding = await bind();
  assert.ok(binding.ok && 'media' in binding);
  const step = (index: number, status: 'verified' | 'invalid' | 'retry' = 'invalid') =>
    f.run({
      action: 'advance-media-check',
      ...scope,
      planDigest,
      index,
      imageId: `image-${index}`,
      imageInputDigest: null,
      health: { status, reason: status === 'retry' ? 'unavailable' : 'record' },
    });
  return { f, scope, planDigest, bind, step };
}
test('bind a complete zero-image plan without granting readiness', async () => {
  const h = await bound(0);
  const b = await h.bind();
  assert.ok(b.ok && 'media' in b);
  assert.equal(b.media?.cursor, 0);
  assert.equal(b.media?.total, 0);
  assert.equal(h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`]?.state, 'running');
  assert.equal(h.f.rows['products/p']?.catalogPreparation, undefined);
});
test('advance observations and cursor atomically; exact replay has no duplicate increment or child write', async () => {
  const h = await bound();
  const one = await h.step(0);
  assert.ok(one.ok && 'media' in one);
  assert.equal(one.media?.cursor, 1);
  assert.equal(one.media?.invalid, 1);
  const writes = h.f.writes.length;
  assert.deepEqual(await h.step(0), one);
  assert.equal(h.f.writes.length, writes);
  const two = await h.step(1, 'retry');
  assert.ok(two.ok && 'media' in two);
  assert.equal(two.media?.retry, 1);
  assert.equal(two.media?.cursor, 2);
  assert.deepEqual(await h.step(2), await h.bind());
  assert.equal(h.f.writes.filter((c) => c === 'catalogImageObservations').length, 3);
});
for (const index of [-1, 1, 3])
  test(`refuse out-of-order step ${index}`, async () => {
    const h = await bound();
    const before = h.f.writes.length;
    const r = await h.step(index);
    assert.equal(r.ok, false);
    assert.equal(h.f.writes.length, before);
  });
test('changed plan binding and mismatched replay cannot reset or overwrite progress', async () => {
  const h = await bound();
  await h.step(0);
  for (const cmd of [
    { action: 'bind-media-plan', total: 4 },
    { action: 'bind-media-plan', total: 3, planDigest: 'c'.repeat(64) },
    {
      action: 'advance-media-check',
      index: 0,
      imageId: 'other',
      imageInputDigest: null,
      health: { status: 'invalid', reason: 'record' },
    },
  ]) {
    const r = await h.f.run({ ...h.scope, planDigest: h.planDigest, ...cmd });
    assert.deepEqual(r, { ok: false, code: 'CONFLICT' });
  }
});
for (const fault of ['copied', 'expired', 'cancelled', 'input'] as const)
  test(`progress mutation rejects ${fault}`, async () => {
    const h = await bound();
    let lease: unknown = h.scope.lease;
    if (fault === 'copied') lease = {};
    if (fault === 'expired') h.f.now += 120000;
    if (fault === 'cancelled')
      await h.f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      });
    if (fault === 'input') {
      const p = h.f.rows['products/p'];
      assert.ok(p);
      p.name = 'Edited';
    }
    const r = await h.f.run({
      action: 'advance-media-check',
      ...h.scope,
      lease,
      planDigest: h.planDigest,
      index: 0,
      imageId: 'image-0',
      imageInputDigest: null,
      health: { status: 'invalid', reason: 'record' },
    });
    assert.deepEqual(r, { ok: false, code: fault === 'input' ? 'STALE' : 'CONFLICT' });
    assert.equal(h.f.writes.includes('catalogImageObservations'), false);
  });
test('release/reclaim continues previous cursor; explicit retry after failed scan resets it with a new nonce', async () => {
  const h = await bound(1);
  await h.step(0);
  await h.f.run({ action: 'release', ...h.scope });
  const before = h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  assert.ok(before);
  const retried = await h.f.run({
    action: 'retry',
    actorId: 'admin',
    jobId: h.scope.jobId,
    expectedLeaseVersion: 1,
  });
  assert.ok(retried.ok);
  const after = h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  assert.ok(after);
  assert.notEqual(after.nonce, before.nonce);
  assert.equal(after.media, null);
  assert.equal(after.state, 'queued');
  assert.deepEqual(await h.step(0), { ok: false, code: 'CONFLICT' });
});

test('verified counters require the current target and preserve safe output', async () => {
  const h = await bound(1);
  const image = {
    _id: 'image-0',
    status: 'active',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:a.png',
    storagePath: 'a.png',
    mimeType: 'image/png',
    byteSize: 20,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  };
  h.f.rows['images/image-0'] = image;
  const { storedCatalogImageInputDigest } = await import('./catalog-image-input.ts');
  const imageInputDigest = storedCatalogImageInputDigest(image);
  const health = {
    status: 'verified',
    kind: 'stored-image-health-v1',
    imageId: 'image-0',
    inputDigest: imageInputDigest,
    byteSize: 20,
    checksumSha256: image.checksumSha256,
    width: 24,
    height: 16,
    pages: 1,
  };
  const cmd = {
    action: 'advance-media-check',
    ...h.scope,
    planDigest: h.planDigest,
    index: 0,
    imageId: 'image-0',
    imageInputDigest,
    health,
  };
  const saved = await h.f.run(cmd);
  assert.ok(saved.ok && 'media' in saved);
  assert.equal(saved.media?.verified, 1);
  image.storageFileId = 'local-disk:b.png';
  assert.deepEqual(await h.f.run(cmd), { ok: false, code: 'CONFLICT' });
  const human = await h.f.run({ action: 'get', actorId: 'admin', jobId: h.scope.jobId });
  assert.ok(human.ok && 'progress' in human);
  const json = JSON.stringify(human);
  for (const key of ['signature', 'nonce', 'storageFileId', 'imageInputDigest', 'lastReceipt'])
    assert.equal(json.includes(key), false);
});
test('lease expiry during image read prevents both writes', async () => {
  const h = await bound(1);
  const get = h.f.tx.get;
  h.f.tx.get = async (c, id) => {
    const r = await get(c, id);
    if (c === 'images') h.f.now += 120000;
    return r;
  };
  const before = h.f.writes.length;
  assert.deepEqual(await h.step(0), { ok: false, code: 'CONFLICT' });
  assert.equal(h.f.writes.length, before);
});
for (const change of [
  { cursor: 2 },
  { invalid: 2 },
  { lastReceipt: null },
  { total: -1 },
  { verified: Number.MAX_SAFE_INTEGER },
])
  test(`corrupt durable progress ${JSON.stringify(change)} is never accepted`, async () => {
    const h = await bound(2);
    await h.step(0);
    const job = h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`];
    assert.ok(job?.media && typeof job.media === 'object');
    Object.assign(job.media, change);
    assert.deepEqual(await h.bind(), { ok: false, code: 'CORRUPT' });
  });

test('explicit retry can restart a queued partial scan after media bindings changed; ordinary resume keeps it', async () => {
  const h = await bound(3);
  await h.step(0);
  await h.f.run({ action: 'release', ...h.scope });
  const before = h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  assert.ok(before);
  const ordinary = await h.f.run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(ordinary.ok && 'progress' in ordinary);
  assert.equal(ordinary.progress.media?.checked, 1);
  assert.deepEqual(
    await h.f.run({
      action: 'retry',
      actorId: 'admin',
      jobId: h.scope.jobId,
      expectedLeaseVersion: 0,
    }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.ok(
    (
      await h.f.run({
        action: 'retry',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      })
    ).ok,
  );
  const after = h.f.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  assert.ok(after);
  assert.equal(after.media, null);
  assert.notEqual(after.nonce, before.nonce);
});
