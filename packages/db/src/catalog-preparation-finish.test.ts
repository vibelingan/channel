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
    advance(ms: number) {
      now += ms;
    },
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
  const expected = Object.fromEntries(
    Object.entries(before).filter(
      ([key]) =>
        ![
          'catalogPreparationReport',
          'catalogPreparationState',
          'catalogPreparationPolicy',
        ].includes(key),
    ),
  );
  assert.deepEqual(saved, expected);
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
    if (fault === 'report-timestamp') {
      assert.ok(p.catalogPreparationReport && typeof p.catalogPreparationReport === 'object');
      Reflect.set(p.catalogPreparationReport, 'checkedAt', '2026-10-14T00:00:01.000Z');
    }
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

async function completed() {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  assert.equal(typeof job.nonce, 'string');
  const call = f.authority.issueCall({ jobId: f.scope.jobId, nonce: String(job.nonce) });
  const claim = { action: 'claim', call, owner: 'replacement' };
  f.writes.length = 0;
  return { ...f, job, claim };
}
test('signed completed claim is readonly even when no further mutation revision can be allocated', async () => {
  const f = await completed();
  f.job.mutationRevision = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(f.rows);
  const result = await f.run(f.claim);
  assert.ok(result.ok && 'preparation' in result);
  assert.equal(result.preparation, 'unchanged');
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});
for (const fault of [
  'edited-product',
  'missing-product',
  'report',
  'receipt',
  'receipt-owner',
  'report-timestamp',
  'seal-policy',
  'seal-root',
  'media',
  'nonce',
] as const)
  test(`completed claim refuses ${fault} without changing any saved row`, async () => {
    const f = await completed();
    const p = f.rows['products/p'];
    assert.ok(p);
    if (fault === 'edited-product') p.name = 'User edit';
    if (fault === 'missing-product') Reflect.deleteProperty(f.rows, 'products/p');
    if (fault === 'report') p.catalogPreparationReport = null;
    if (fault === 'report-timestamp') {
      assert.ok(p.catalogPreparationReport && typeof p.catalogPreparationReport === 'object');
      Reflect.set(p.catalogPreparationReport, 'checkedAt', '2026-10-14T00:00:01.000Z');
    }
    if (fault === 'receipt') f.job.completion = null;
    if (fault === 'receipt-owner') {
      assert.ok(f.job.completion && typeof f.job.completion === 'object');
      Reflect.set(f.job.completion, 'leaseOwner', 'other-owner');
    }
    if (fault === 'seal-policy') {
      assert.ok(f.job.mediaSeal && typeof f.job.mediaSeal === 'object');
      Reflect.set(f.job.mediaSeal, 'pixelPolicyVersion', 'old-pixels');
    }
    if (fault === 'seal-root') {
      assert.ok(p.catalogPreparationReport && typeof p.catalogPreparationReport === 'object');
      const seal = Reflect.get(p.catalogPreparationReport, 'seal');
      assert.ok(seal && typeof seal === 'object');
      Reflect.set(seal, 'imageIdsDigest', 'f'.repeat(64));
    }
    if (fault === 'media') f.job.media = null;
    if (fault === 'nonce') f.job.nonce = 'f'.repeat(64);
    const before = structuredClone(f.rows);
    const result = await f.run(f.claim);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(f.rows, before);
    assert.equal(f.writes.length, 0);
  });
test('a signed wrong-attempt nonce refuses before reading the completed product', async () => {
  const f = await completed();
  let productReads = 0;
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      if (c === 'products') productReads++;
      return f.tx.get(c, id);
    },
  };
  const call = f.authority.issueCall({ jobId: f.scope.jobId, nonce: 'f'.repeat(64) });
  assert.deepEqual(await runCatalogPreparationJob(tx, f.authority, { ...f.claim, call }, f.now), {
    ok: false,
    code: 'FORBIDDEN',
  });
  assert.equal(productReads, 0);
  assert.equal(f.writes.length, 0);
});
test('completed readonly claim preserves current lifecycle and subcategories', async () => {
  const f = await completed();
  Object.assign(f.rows['products/p'] ?? {}, {
    archived: true,
    published: false,
    catalogLifecycleVersion: 3,
    subcategoryIds: ['latest'],
  });
  const before = structuredClone(f.rows);
  assert.ok((await f.run(f.claim)).ok);
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});
test('expiry during completed input reads cannot return ready data', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  f.writes.length = 0;
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  const call = f.authority.issueCall({ jobId: f.scope.jobId, nonce: String(job.nonce) });
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      const r = await f.tx.get(c, id);
      if (c === 'products') f.now += 30001;
      return r;
    },
  };
  const before = structuredClone(f.rows);
  assert.deepEqual(
    await runCatalogPreparationJob(
      tx,
      f.authority,
      { action: 'claim', call, owner: 'replacement' },
      f.now,
    ),
    { ok: false, code: 'FORBIDDEN' },
  );
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});

test('completed claim never binds a new opaque lease', async () => {
  const f = await completed();
  const authority = {
    ...f.authority,
    bindLease: () => {
      throw Error('completed readonly must not bind');
    },
  };
  const before = structuredClone(f.rows);
  const result = await runCatalogPreparationJob(f.tx, authority, f.claim, f.now);
  assert.ok(result.ok && 'preparation' in result);
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});

test('human completed status confirms ready after admission expiry with no lease or writes', async () => {
  const f = await completed();
  f.advance(120001);
  assert.equal(f.authority.verifyCall(f.claim.call), null);
  f.job.mutationRevision = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(f.rows);
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r, JSON.stringify(r));
  assert.equal(r.status.nextAction, 'ready');
  assert.equal(r.status.current, true);
  assert.equal(r.status.report?.state, 'ready');
  assert.deepEqual(r.status.attestation, { total: 0, checked: 0 });
  assert.equal(JSON.stringify(r).includes('nonce'), false);
  assert.equal(JSON.stringify(r).includes('leaseOwner'), false);
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});

for (const fault of ['receipt', 'source', 'product'] as const)
  test(`human completed status cannot confirm ${fault} with an old ready report`, async () => {
    const f = await completed();
    if (fault === 'receipt') f.job.completion = null;
    else if (fault === 'product') {
      const p = f.rows['products/p'];
      assert.ok(p);
      p.name = 'New input';
    } else {
      const p = f.rows['products/p'];
      assert.ok(p);
      p.alibabaPrimarySourceKey = 'new-source';
    }
    const before = structuredClone(f.rows);
    const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
    if (fault === 'receipt') assert.deepEqual(r, { ok: false, code: 'CONFLICT' });
    else {
      assert.ok(r.ok && 'status' in r);
      assert.equal(r.status.current, false);
      assert.equal(r.status.report, null);
      assert.equal(r.status.attestation, null);
      assert.equal(r.status.nextAction, 'restart');
    }
    assert.deepEqual(f.rows, before);
    assert.equal(f.writes.length, 0);
  });

test('retry never invalidates a current ready report even when a job state was changed', async () => {
  const f = await completed();
  f.job.state = 'queued';
  const before = structuredClone(f.rows);
  assert.deepEqual(
    await f.run({
      action: 'retry',
      actorId: 'admin',
      jobId: f.scope.jobId,
      expectedLeaseVersion: 1,
    }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});
