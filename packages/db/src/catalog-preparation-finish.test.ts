import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';
async function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'final-test',
    environmentId: 'test',
    now: () => now,
  });
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': {
      _id: 'p',
      name: 'Clock',
      published: false,
      archived: false,
      catalogContentGeneration: 3,
      catalogLifecycleVersion: 2,
      subcategoryIds: ['existing'],
      updatedAt: '2026-10-14T00:00:00.000Z',
    },
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
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const jobId = s.progress.jobId;
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId, lease: c.lease };
  const planDigest = 'a'.repeat(64);
  assert.ok((await run({ action: 'bind-media-plan', ...scope, planDigest, total: 0 })).ok);
  assert.ok((await run({ action: 'bind-media-seal', ...scope, planDigest })).ok);
  const job = rows[`catalogPreparationJobs/${jobId}`];
  assert.ok(job);
  const command = {
    action: 'finish-preparation',
    ...scope,
    inputDigest: job.inputDigest,
    contentGeneration: 3,
    planDigest,
    imageIdsDigest: catalogSealedImageIdsDigest([]),
    imageCount: 0,
    previewReady: true,
    issues: [],
  };
  writes.length = 0;
  return {
    rows,
    writes,
    run,
    tx,
    authority,
    scope,
    command,
    job,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
test('only complete current sealed evidence can atomically finish a private ready report', async () => {
  const f = await fixture();
  const before = structuredClone(f.rows['products/p']);
  const r = await f.run(f.command);
  assert.ok(r.ok && 'preparation' in r, JSON.stringify(r));
  assert.equal(r.preparation, 'ready');
  assert.deepEqual(f.writes, ['products', 'catalogPreparationJobs']);
  const product = f.rows['products/p'];
  assert.ok(product);
  const report = readCurrentCatalogPreparation(product);
  assert.equal(report?.state, 'ready');
  assert.equal(report?.schemaVersion, 'catalog-preparation-report-v2');
  assert.ok(report?.state === 'ready');
  assert.equal(report.seal.jobId, f.scope.jobId);
  assert.equal(report.seal.imageCount, 0);
  assert.deepEqual(product, {
    ...before,
    catalogPreparationState: 'ready',
    catalogPreparationPolicy: report.policyVersion,
    catalogPreparationReport: report,
  });
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.equal(job?.state, 'completed');
  assert.equal(job.leaseOwner, '');
  assert.equal(job.leaseExpiresAt, 0);
  assert.ok(!JSON.stringify(report).includes('leaseOwner'));
  assert.ok(!JSON.stringify(report).includes('nonce'));
});
test('exact lost-ACK replay uses the original opaque grant and makes no further writes', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  const before = structuredClone(f.rows);
  f.writes.length = 0;
  f.now += 180000;
  const replay = await f.run(f.command);
  assert.ok(replay.ok && 'preparation' in replay, JSON.stringify(replay));
  assert.equal(replay.preparation, 'unchanged');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.rows, before);
  assert.equal(
    (await f.run({ ...f.command, lease: JSON.parse(JSON.stringify(f.command.lease)) })).ok,
    false,
  );
  assert.equal(
    (
      await f.run({
        ...f.command,
        issues: [
          {
            code: 'MISSING_CATEGORY',
            stage: 'classification',
            path: 'productFamily',
            severity: 'warning',
            remedy: 'classify',
          },
        ],
      })
    ).ok,
    false,
  );
});
for (const fault of [
  'no-media',
  'incomplete-media',
  'failed-media',
  'no-seal',
  'incomplete-seal',
  'pixel-policy',
  'plan',
  'root',
  'count',
  'input',
  'generation',
  'lease',
  'cancel',
  'edit',
  'delete',
  'expiry',
] as const)
  test(`final ready refuses ${fault} without writing a product`, async () => {
    const f = await fixture();
    const cmd = { ...f.command };
    if (fault === 'no-media') f.job.media = null;
    if (fault === 'incomplete-media') f.job.media = { ...(f.job.media as object), total: 1 };
    if (fault === 'failed-media')
      f.job.media = { ...(f.job.media as object), total: 1, cursor: 1, verified: 0, invalid: 1 };
    if (fault === 'no-seal') f.job.mediaSeal = null;
    if (fault === 'incomplete-seal') {
      cmd.imageCount = 1;
      f.job.media = {
        ...(f.job.media as object),
        total: 1,
        cursor: 1,
        verified: 1,
        lastReceipt: 'b'.repeat(64),
      };
      f.job.mediaSeal = { ...(f.job.mediaSeal as object), total: 1 };
    }
    if (fault === 'pixel-policy')
      f.job.mediaSeal = { ...(f.job.mediaSeal as object), pixelPolicyVersion: 'old' };
    if (fault === 'plan') cmd.planDigest = 'f'.repeat(64);
    if (fault === 'root') cmd.imageIdsDigest = 'f'.repeat(64);
    if (fault === 'count') cmd.imageCount = 1;
    if (fault === 'input') cmd.inputDigest = 'f'.repeat(64);
    if (fault === 'generation') cmd.contentGeneration = 4;
    if (fault === 'lease') cmd.lease = {};
    if (fault === 'cancel')
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
    if (fault === 'edit') Object.assign(f.rows['products/p'] ?? {}, { name: 'New' });
    if (fault === 'delete') Reflect.deleteProperty(f.rows, 'products/p');
    if (fault === 'expiry') f.now += 120001;
    f.writes.length = 0;
    const before = structuredClone(f.rows['products/p']);
    const r = await f.run(cmd);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(!f.writes.includes('products'));
    assert.deepEqual(f.rows['products/p'], before);
  });
test('expiry during input read cannot authorize a late ready write', async () => {
  const f = await fixture();
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      const r = await f.tx.get(c, id);
      if (c === 'products') f.now += 120001;
      return r;
    },
  };
  assert.deepEqual(await runCatalogPreparationJob(tx, f.authority, f.command, f.now), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(f.writes.length, 0);
});
test('concurrent lifecycle and subcategory changes survive readiness without being published', async () => {
  const f = await fixture();
  const p = f.rows['products/p'];
  assert.ok(p);
  Object.assign(p, {
    published: false,
    archived: true,
    catalogLifecycleVersion: 3,
    subcategoryIds: ['changed'],
    catalogClassificationRevision: 2,
  });
  const before = structuredClone(p);
  assert.ok((await f.run(f.command)).ok);
  const current = f.rows['products/p'];
  assert.ok(current);
  const {
    catalogPreparationReport: _r,
    catalogPreparationState: _s,
    catalogPreparationPolicy: _p,
    ...saved
  } = current;
  assert.deepEqual(saved, before);
});
test('completed readback cannot replay after content changed or after the saved report was replaced', async () => {
  for (const fault of ['edit', 'report', 'receipt']) {
    const f = await fixture();
    assert.ok((await f.run(f.command)).ok);
    f.writes.length = 0;
    const p = f.rows['products/p'];
    assert.ok(p);
    if (fault === 'edit') p.name = 'New';
    if (fault === 'report') p.catalogPreparationReport = null;
    if (fault === 'receipt')
      Object.assign(f.rows[`catalogPreparationJobs/${f.scope.jobId}`] ?? {}, { completion: null });
    const before = structuredClone(f.rows);
    assert.equal((await f.run(f.command)).ok, false);
    assert.deepEqual(f.rows, before);
    assert.equal(f.writes.length, 0);
  }
});

test('ready input accepts only safe bounded warnings and a validated preview', async () => {
  const f = await fixture();
  for (const patch of [
    { previewReady: false },
    {
      issues: [
        {
          code: 'INVALID_VALUE',
          stage: 'effective-content',
          path: 'name',
          severity: 'error',
          remedy: 'edit',
        },
      ],
    },
    {
      issues: Array.from({ length: 51 }, () => ({
        code: 'MISSING_CATEGORY',
        stage: 'classification',
        path: 'productFamily',
        severity: 'warning',
        remedy: 'classify',
      })),
    },
    { extra: 'raw-source' },
  ]) {
    assert.deepEqual(await f.run({ ...f.command, ...patch }), {
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    assert.equal(f.writes.length, 0);
  }
});
