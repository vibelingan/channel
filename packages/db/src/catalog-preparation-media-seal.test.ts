import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import {
  CatalogPreparationMediaSealSchema,
  advanceCatalogMediaSeal,
  catalogSealedImageIdsDigest,
  initialCatalogMediaSeal,
} from './catalog-preparation-media-seal.ts';
async function fixture(total = 0) {
  const now = 1792080000000;
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock' },
  };
  const authority = createCatalogPreparationAuthority({
    secret: 'seal-test-secret',
    environmentId: 'test',
    now: () => now,
  });
  const writes: string[] = [];
  const run = (command: unknown) =>
    runCatalogPreparationJob(
      {
        get: async (c, id) => structuredClone(rows[`${c}/${id}`] ?? null),
        set: async (c, r) => {
          writes.push(c);
          rows[`${c}/${r._id}`] = structuredClone(r);
        },
      },
      authority,
      command,
      now,
    );
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const jobId = s.progress.jobId;
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId, lease: c.lease };
  const planDigest = 'a'.repeat(64);
  assert.ok((await run({ action: 'bind-media-plan', ...scope, planDigest, total })).ok);
  return { rows, writes, run, scope, planDigest };
}
test('a current complete empty plan can start a bounded media seal without marking the product ready', async () => {
  const h = await fixture();
  const before = structuredClone(h.rows['products/p']);
  const r = await h.run({ action: 'bind-media-seal', ...h.scope, planDigest: h.planDigest });
  assert.ok(r.ok && 'mediaSeal' in r, JSON.stringify(r));
  assert.equal(r.mediaSeal.cursor, 0);
  assert.equal(r.mediaSeal.total, 0);
  assert.deepEqual(h.rows['products/p'], before);
});
test('an incomplete media cursor cannot be used to start final attestation', async () => {
  const h = await fixture(2);
  h.writes.length = 0;
  assert.deepEqual(
    await h.run({ action: 'bind-media-seal', ...h.scope, planDigest: h.planDigest }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal(h.writes.length, 0);
});
function verified(id: string) {
  return {
    status: 'verified' as const,
    kind: 'stored-image-health-v1' as const,
    imageId: id,
    inputDigest: 'b'.repeat(64),
    byteSize: 123,
    checksumSha256: 'c'.repeat(64),
    width: 24,
    height: 16,
    pages: 1,
  };
}
for (const count of [0, 1, 105, 90000])
  test(`ordered ${count} image attestation has a constant-size durable proof`, () => {
    const ids = Array.from({ length: count }, (_, i) => `image-${String(i).padStart(6, '0')}`);
    let seal = initialCatalogMediaSeal('a'.repeat(64), count);
    for (const [index, imageId] of ids.entries()) {
      const next = advanceCatalogMediaSeal(seal, {
        index,
        imageId,
        imageInputDigest: 'b'.repeat(64),
        health: verified(imageId),
      });
      assert.ok(next);
      seal = next;
    }
    assert.equal(seal.cursor, count);
    assert.equal(seal.imageIdsDigest, catalogSealedImageIdsDigest(ids));
    assert.ok(Buffer.byteLength(JSON.stringify(seal)) < 1024);
    // Independent digest route, without the production fold helper.
    let expected = createHash('sha256')
      .update(JSON.stringify(['catalog-protected-media-seal-v1', 'image-ids']))
      .digest('hex');
    for (const id of ids)
      expected = createHash('sha256')
        .update(JSON.stringify([expected, id]))
        .digest('hex');
    assert.equal(seal.imageIdsDigest, expected);
  });
test('only exact immediate ACK replay is idempotent; repeats, skips, reverse order and changed evidence refuse', () => {
  const zero = initialCatalogMediaSeal('a'.repeat(64), 3);
  const a = { index: 0, imageId: 'a', imageInputDigest: 'b'.repeat(64), health: verified('a') };
  const one = advanceCatalogMediaSeal(zero, a);
  assert.ok(one);
  assert.equal(advanceCatalogMediaSeal(one, a), one);
  for (const input of [
    { ...a, index: 2, imageId: 'b' },
    { ...a, index: 1 },
    { ...a, index: 1, imageId: '0' },
    { ...a, health: { ...a.health, width: 99 } },
  ])
    assert.equal(advanceCatalogMediaSeal(one, input), null);
  const two = advanceCatalogMediaSeal(one, { ...a, index: 1, imageId: 'b', health: verified('b') });
  assert.ok(two);
  assert.equal(advanceCatalogMediaSeal(two, a), null);
});
for (const change of [
  { cursor: 2 },
  { imageIdsDigest: 'wrong' },
  { lastImageId: 'a' },
  { lastReceipt: 'b'.repeat(64) },
  { extra: true },
])
  test(`malformed seal ${Object.keys(change)[0]} is refused`, () => {
    assert.equal(
      CatalogPreparationMediaSealSchema.safeParse({
        ...initialCatalogMediaSeal('a'.repeat(64), 1),
        ...change,
      }).success,
      false,
    );
  });
test('legacy jobs without mediaSeal still start, while retry clears a previous attestation', async () => {
  const h = await fixture();
  assert.equal(h.rows[`catalogPreparationJobs/${h.scope.jobId}`]?.mediaSeal, undefined);
  assert.ok((await h.run({ action: 'bind-media-seal', ...h.scope, planDigest: h.planDigest })).ok);
  assert.ok((await h.run({ action: 'release', ...h.scope })).ok);
  assert.ok(
    (
      await h.run({
        action: 'retry',
        actorId: 'admin',
        jobId: h.scope.jobId,
        expectedLeaseVersion: 1,
      })
    ).ok,
  );
  assert.equal(h.rows[`catalogPreparationJobs/${h.scope.jobId}`]?.mediaSeal, null);
});
