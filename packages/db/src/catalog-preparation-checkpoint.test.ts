import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
async function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'checkpoint-test',
    environmentId: 'test',
    now: () => now,
  });
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': {
      _id: 'p',
      name: 'Clock',
      published: false,
      productFamily: 'misc',
      subcategoryIds: ['existing'],
      catalogContentGeneration: 3,
      catalogLifecycleVersion: 2,
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
  const command = { action: 'checkpoint-preparation', ...scope, previewReady: true, issues: [] };
  writes.length = 0;
  return {
    rows,
    writes,
    tx,
    run,
    authority,
    scope,
    command,
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
  };
}
test('current technical checkpoint writes only a nonready report and same-job fence', async () => {
  const f = await fixture();
  const before = structuredClone(f.rows['products/p']);
  const r = await f.run(f.command);
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.equal(r.report.state, 'preparing');
  const p = f.rows['products/p'];
  assert.ok(p);
  const report = readCurrentCatalogPreparation(p);
  assert.equal(report?.state, 'preparing');
  assert.deepEqual(p, {
    ...before,
    catalogPreparationState: 'preparing',
    catalogPreparationPolicy: report?.policyVersion,
    catalogPreparationReport: report,
  });
  assert.deepEqual(f.writes, ['products', 'catalogPreparationJobs']);
  assert.equal(f.rows[`catalogPreparationJobs/${f.scope.jobId}`]?.state, 'running');
});
test('a bad preview checkpoint stays readable as blocked with safe diagnostics', async () => {
  const f = await fixture();
  const issue = {
    code: 'INVALID_VALUE',
    stage: 'effective-content',
    path: 'name',
    severity: 'error',
    remedy: 'edit',
  };
  const r = await f.run({ ...f.command, previewReady: false, issues: [issue] });
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.equal(r.report.state, 'blocked');
  assert.equal(r.report.previewReady, false);
  assert.deepEqual(r.report.issues, [issue]);
  assert.equal(f.rows['products/p']?.published, false);
});

test('same current checkpoint at the same service time is readonly', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  f.writes.length = 0;
  const before = structuredClone(f.rows);
  const result = await f.run(f.command);
  assert.ok(result.ok && 'preparation' in result);
  assert.equal(result.preparation, 'unchanged');
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
});
for (const fault of ['lease', 'cancel', 'release', 'expiry', 'edit', 'missing', 'source'] as const)
  test(`checkpoint refuses ${fault} without overwriting a product`, async () => {
    const f = await fixture();
    const command = { ...f.command };
    if (fault === 'lease') command.lease = {};
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
    if (fault === 'release') assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
    if (fault === 'expiry') f.advance(120001);
    if (fault === 'edit') Object.assign(f.rows['products/p'] ?? {}, { name: 'User edit' });
    if (fault === 'missing') Reflect.deleteProperty(f.rows, 'products/p');
    if (fault === 'source')
      Object.assign(f.rows['products/p'] ?? {}, { alibabaPrimarySourceKey: 'new-source' });
    f.writes.length = 0;
    const before = structuredClone(f.rows['products/p']);
    const r = await f.run(command);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(!f.writes.includes('products'));
    assert.deepEqual(f.rows['products/p'], before);
  });
test('checkpoint rechecks lease after the asynchronous product read', async () => {
  const f = await fixture();
  const tx = {
    ...f.tx,
    get: async (c: string, id: string) => {
      const r = await f.tx.get(c, id);
      if (c === 'products') f.advance(120001);
      return r;
    },
  };
  assert.deepEqual(await runCatalogPreparationJob(tx, f.authority, f.command, f.time()), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(f.writes.length, 0);
});
for (const patch of [
  { previewReady: false },
  { state: 'ready' },
  { productId: 'other' },
  { inputDigest: 'f'.repeat(64) },
  { checkedAt: '2026-10-14T00:00:00.000Z' },
  { issues: [{ message: 'PRIVATE_SOURCE_VALUE' }] },
  {
    issues: Array.from({ length: 51 }, () => ({
      code: 'MISSING_CATEGORY',
      stage: 'classification',
      path: 'productFamily',
      severity: 'warning',
      remedy: 'classify',
    })),
  },
])
  test(`checkpoint rejects invalid or caller-owned report fields: ${Object.keys(patch)[0]}`, async () => {
    const f = await fixture();
    assert.deepEqual(await f.run({ ...f.command, ...patch }), {
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    assert.equal(f.writes.length, 0);
  });
test('durable invalid pixels cannot disappear behind fifty warnings or be marked ready', async () => {
  const f = await fixture();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.media = {
    planDigest: 'a'.repeat(64),
    total: 1,
    cursor: 1,
    verified: 0,
    invalid: 1,
    retry: 0,
    lastReceipt: 'b'.repeat(64),
  };
  const warning = {
    code: 'MISSING_CATEGORY',
    stage: 'classification',
    path: 'productFamily',
    severity: 'warning',
    remedy: 'classify',
  };
  const r = await f.run({ ...f.command, issues: Array.from({ length: 50 }, () => warning) });
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.equal(r.report.state, 'blocked');
  assert.equal(r.report.mediaReady, false);
  assert.equal(r.report.issues.length, 50);
  assert.ok(
    r.report.issues.some(
      (i) => i.stage === 'media' && i.severity === 'error' && i.observed?.count === 1,
    ),
  );
});
test('durable transient media failures remain preparing with an actionable retry warning', async () => {
  const f = await fixture();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.media = {
    planDigest: 'a'.repeat(64),
    total: 1,
    cursor: 1,
    verified: 0,
    invalid: 0,
    retry: 1,
    lastReceipt: 'b'.repeat(64),
  };
  const r = await f.run(f.command);
  assert.ok(r.ok && 'report' in r);
  assert.equal(r.report.state, 'preparing');
  assert.ok(
    r.report.issues.some(
      (i) => i.stage === 'media' && i.remedy === 'retry-media' && i.observed?.count === 1,
    ),
  );
});
test('checkpoint preserves later lifecycle, subcategories and a retained approved version without requiring a human account', async () => {
  const f = await fixture();
  Reflect.deleteProperty(f.rows, 'users/admin');
  Object.assign(f.rows['products/p'] ?? {}, {
    published: true,
    archived: false,
    catalogLifecycleVersion: 3,
    subcategoryIds: ['new'],
    catalogDetailPublication: { state: 'approved', revision: 'retained' },
  });
  const before = structuredClone(f.rows['products/p']);
  const r = await f.run(f.command);
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.deepEqual(f.rows['products/p'], {
    ...before,
    catalogPreparationState: r.report.state,
    catalogPreparationPolicy: r.report.policyVersion,
    catalogPreparationReport: r.report,
  });
});

test('fifty existing errors retain media failures and do not drop an error to make room for a retry warning', async () => {
  const f = await fixture();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.media = {
    planDigest: 'a'.repeat(64),
    total: 2,
    cursor: 2,
    verified: 0,
    invalid: 1,
    retry: 1,
    lastReceipt: 'b'.repeat(64),
  };
  const issue = {
    code: 'INVALID_VALUE',
    stage: 'effective-content',
    path: 'name',
    severity: 'error',
    remedy: 'edit',
  };
  const r = await f.run({ ...f.command, issues: Array.from({ length: 50 }, () => issue) });
  assert.ok(r.ok && 'report' in r);
  assert.equal(r.report.state, 'blocked');
  assert.equal(r.report.issues.length, 50);
  assert.ok(r.report.issues.every((i) => i.severity === 'error'));
  assert.ok(r.report.issues.some((i) => i.stage === 'media' && i.observed?.count === 1));
});
test('an already reported durable media issue is not duplicated', async () => {
  const f = await fixture();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.media = {
    planDigest: 'a'.repeat(64),
    total: 1,
    cursor: 1,
    verified: 0,
    invalid: 1,
    retry: 0,
    lastReceipt: 'b'.repeat(64),
  };
  const issue = {
    code: 'MEDIA_NOT_READY',
    stage: 'media',
    path: 'images',
    severity: 'error',
    remedy: 'edit',
    observed: { count: 1 },
  };
  const r = await f.run({ ...f.command, issues: [issue] });
  assert.ok(r.ok && 'report' in r);
  assert.deepEqual(r.report.issues, [issue]);
});

test('human status survives signed admission expiry and returns only current safe diagnostics without writes', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  f.advance(31000);
  const before = structuredClone(f.rows);
  f.writes.length = 0;
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r, JSON.stringify(r));
  assert.equal(r.status.current, true);
  assert.equal(r.status.nextAction, 'continue');
  assert.equal(r.status.report?.state, 'preparing');
  assert.equal(r.status.attestation, null);
  assert.deepEqual(f.rows, before);
  assert.equal(f.writes.length, 0);
  for (const secret of ['nonce', 'leaseOwner', 'signature', 'lease"', 'sourceUrl', 'storageFileId'])
    assert.equal(JSON.stringify(r.status).includes(secret), false, secret);
});

test('human status waits for a fresh lease and offers continuation after expiry', async () => {
  const f = await fixture();
  const read = () => f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  const active = await read();
  assert.ok(active.ok && 'status' in active, JSON.stringify(active));
  assert.equal(active.status.nextAction, 'wait');
  f.advance(120001);
  const expired = await read();
  assert.ok(expired.ok && 'status' in expired);
  assert.equal(expired.status.nextAction, 'continue');
  assert.equal(expired.status.progress.state, 'running');
});

test('status never presents an old input diagnostic as current', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
  const p = f.rows['products/p'];
  assert.ok(p);
  p.name = 'Edited after checkpoint';
  const before = structuredClone(f.rows);
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r, JSON.stringify(r));
  assert.equal(r.status.current, false);
  assert.equal(r.status.report, null);
  assert.equal(r.status.attestation, null);
  assert.equal(r.status.nextAction, 'restart');
  assert.deepEqual(f.rows, before);
});

test('explicit retry atomically invalidates its old blocked diagnostics before the next attempt', async () => {
  const f = await fixture();
  assert.ok(
    (await f.run({ action: 'bind-media-plan', ...f.scope, planDigest: 'a'.repeat(64), total: 1 }))
      .ok,
  );
  assert.ok(
    (
      await f.run({
        ...f.command,
        previewReady: false,
        issues: [
          {
            code: 'REQUIRED',
            stage: 'effective-content',
            path: 'name',
            severity: 'error',
            remedy: 'edit',
          },
        ],
      })
    ).ok,
  );
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  const before = structuredClone(f.rows['products/p']);
  const reset = await f.run({
    action: 'retry',
    actorId: 'admin',
    jobId: f.scope.jobId,
    expectedLeaseVersion: 1,
  });
  assert.ok(reset.ok && 'progress' in reset, JSON.stringify(reset));
  assert.equal(reset.progress.media, null);
  assert.deepEqual(f.rows['products/p'], { ...before, catalogPreparationState: 'stale' });
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r);
  assert.equal(r.status.report, null);
  assert.equal(r.status.nextAction, 'continue');
});

for (const fault of ['missing', 'demoted', 'suspended', 'wrong-id'] as const)
  test(`human status denies a ${fault} admin row`, async () => {
    const f = await fixture();
    if (fault === 'missing') Reflect.deleteProperty(f.rows, 'users/admin');
    else
      f.rows['users/admin'] = {
        _id: fault === 'wrong-id' ? 'other' : 'admin',
        role: fault === 'demoted' ? 'user' : 'admin',
        ...(fault === 'suspended' ? { status: 'suspended' } : {}),
      };
    const before = structuredClone(f.rows);
    assert.deepEqual(await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId }), {
      ok: false,
      code: 'FORBIDDEN',
    });
    assert.deepEqual(f.rows, before);
  });

test('human status is strict and readonly even when a mutation revision cannot be allocated', async () => {
  const f = await fixture();
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.mutationRevision = Number.MAX_SAFE_INTEGER;
  const command = { action: 'status', actorId: 'admin', jobId: f.scope.jobId };
  const before = structuredClone(f.rows);
  const r = await f.run(command);
  assert.ok(r.ok && 'status' in r);
  assert.equal(r.status.nextAction, 'wait');
  for (const extra of [
    { lease: {} },
    { call: {} },
    { productId: 'other' },
    { nonce: 'a'.repeat(64) },
  ])
    assert.deepEqual(await f.run({ ...command, ...extra }), {
      ok: false,
      code: 'VALIDATION_ERROR',
    });
  assert.deepEqual(f.rows, before);
});

for (const change of [
  'generation',
  'source',
  'missing-product',
  'wrong-id',
  'invalid-generation',
] as const)
  test(`human status handles ${change} without exposing an old report`, async () => {
    const f = await fixture();
    assert.ok((await f.run(f.command)).ok);
    const p = f.rows['products/p'];
    assert.ok(p);
    if (change === 'generation') p.catalogContentGeneration = 4;
    if (change === 'source') p.alibabaPrimarySourceKey = 'new-source';
    if (change === 'missing-product') Reflect.deleteProperty(f.rows, 'products/p');
    if (change === 'wrong-id') p._id = 'wrong';
    if (change === 'invalid-generation') p.catalogContentGeneration = -1;
    const before = structuredClone(f.rows);
    const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
    if (change === 'missing-product') assert.deepEqual(r, { ok: false, code: 'NOT_FOUND' });
    else if (change === 'wrong-id' || change === 'invalid-generation')
      assert.deepEqual(r, { ok: false, code: 'CORRUPT' });
    else {
      assert.ok(r.ok && 'status' in r);
      assert.equal(r.status.current, false);
      assert.equal(r.status.report, null);
      assert.equal(r.status.nextAction, 'restart');
    }
    assert.deepEqual(f.rows, before);
  });

for (const condition of [
  'retry',
  'invalid',
  'healthy',
  'obsolete-seal',
  'wrong-seal-plan',
  'seal-before-pixels',
] as const)
  test(`human status projects ${condition} media without exposing private seal fields`, async () => {
    const f = await fixture();
    const planDigest = 'a'.repeat(64);
    assert.ok((await f.run({ action: 'bind-media-plan', ...f.scope, planDigest, total: 1 })).ok);
    const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
    assert.ok(job);
    job.media = {
      planDigest,
      total: 1,
      cursor: 1,
      verified: condition === 'retry' || condition === 'invalid' ? 0 : 1,
      retry: condition === 'retry' ? 1 : 0,
      invalid: condition === 'invalid' ? 1 : 0,
      lastReceipt: 'b'.repeat(64),
    };
    if (!['retry', 'invalid'].includes(condition)) {
      assert.ok((await f.run({ action: 'bind-media-seal', ...f.scope, planDigest })).ok);
      assert.ok(job.mediaSeal === undefined);
      const saved = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
      assert.ok(saved);
      if (condition === 'obsolete-seal') {
        assert.ok(saved.mediaSeal && typeof saved.mediaSeal === 'object');
        Reflect.set(saved.mediaSeal, 'pixelPolicyVersion', 'old-pixels');
      }
      if (condition === 'wrong-seal-plan') {
        assert.ok(saved.mediaSeal && typeof saved.mediaSeal === 'object');
        Reflect.set(saved.mediaSeal, 'planDigest', 'c'.repeat(64));
      }
      if (condition === 'seal-before-pixels')
        saved.media = {
          planDigest,
          total: 1,
          cursor: 0,
          verified: 0,
          retry: 0,
          invalid: 0,
          lastReceipt: null,
        };
    }
    assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
    const before = structuredClone(f.rows);
    const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
    if (condition === 'wrong-seal-plan' || condition === 'seal-before-pixels')
      assert.deepEqual(r, { ok: false, code: 'CORRUPT' });
    else {
      assert.ok(r.ok && 'status' in r, JSON.stringify(r));
      assert.equal(
        r.status.nextAction,
        condition === 'invalid' ? 'edit' : condition === 'healthy' ? 'continue' : 'retry',
      );
      assert.deepEqual(
        r.status.attestation,
        condition === 'healthy' ? { total: 1, checked: 0 } : null,
      );
      assert.equal(JSON.stringify(r).includes('imageIdsDigest'), false);
      assert.equal(JSON.stringify(r).includes('lastReceipt'), false);
    }
    assert.deepEqual(f.rows, before);
  });

for (const state of ['stale', 'blocked'] as const)
  test(`a current ${state} job has an explicit fenced reset without altering user fields`, async () => {
    const f = await fixture();
    assert.ok((await f.run(f.command)).ok);
    assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
    const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
    assert.ok(job);
    job.state = state;
    const before = structuredClone(f.rows['products/p']);
    const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
    assert.ok(r.ok && 'status' in r);
    assert.equal(r.status.nextAction, 'retry');
    assert.deepEqual(
      await f.run({
        action: 'retry',
        actorId: 'admin',
        jobId: f.scope.jobId,
        expectedLeaseVersion: 0,
      }),
      { ok: false, code: 'CONFLICT' },
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
    assert.deepEqual(f.rows['products/p'], { ...before, catalogPreparationState: 'stale' });
  });

test('human status for an expired running scan offers the supported continuation before explicit retry', async () => {
  const f = await fixture();
  const planDigest = 'a'.repeat(64);
  assert.ok((await f.run({ action: 'bind-media-plan', ...f.scope, planDigest, total: 1 })).ok);
  const job = f.rows[`catalogPreparationJobs/${f.scope.jobId}`];
  assert.ok(job);
  job.media = {
    planDigest,
    total: 1,
    cursor: 1,
    verified: 0,
    invalid: 0,
    retry: 1,
    lastReceipt: 'b'.repeat(64),
  };
  f.advance(120001);
  const expired = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(expired.ok && 'status' in expired);
  assert.equal(expired.status.nextAction, 'continue');
  const dispatch = await f.run({ action: 'dispatch', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(dispatch.ok && 'call' in dispatch);
  const claimed = await f.run({ action: 'claim', call: dispatch.call, owner: 'replacement' });
  assert.ok(claimed.ok && 'lease' in claimed);
  assert.ok((await f.run({ action: 'release', jobId: f.scope.jobId, lease: claimed.lease })).ok);
  const queued = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(queued.ok && 'status' in queued);
  assert.equal(queued.status.nextAction, 'retry');
});
test('retry of a changed input cannot clear diagnostics or overwrite user data', async () => {
  const f = await fixture();
  assert.ok(
    (await f.run({ action: 'bind-media-plan', ...f.scope, planDigest: 'a'.repeat(64), total: 1 }))
      .ok,
  );
  assert.ok((await f.run(f.command)).ok);
  assert.ok((await f.run({ action: 'release', ...f.scope })).ok);
  const p = f.rows['products/p'];
  assert.ok(p);
  p.name = 'New user input';
  const before = structuredClone(f.rows);
  assert.deepEqual(
    await f.run({
      action: 'retry',
      actorId: 'admin',
      jobId: f.scope.jobId,
      expectedLeaseVersion: 1,
    }),
    { ok: false, code: 'STALE' },
  );
  assert.deepEqual(f.rows, before);
});

test('cancelled current human status offers a real retry and hides the cancelled checkpoint', async () => {
  const f = await fixture();
  assert.ok((await f.run(f.command)).ok);
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
  const r = await f.run({ action: 'status', actorId: 'admin', jobId: f.scope.jobId });
  assert.ok(r.ok && 'status' in r);
  assert.equal(r.status.current, true);
  assert.equal(r.status.nextAction, 'retry');
  assert.equal(r.status.report, null);
  const retried = await f.run({
    action: 'retry',
    actorId: 'admin',
    jobId: f.scope.jobId,
    expectedLeaseVersion: r.status.progress.leaseVersion,
  });
  assert.ok(retried.ok && 'progress' in retried);
  assert.equal(retried.progress.state, 'queued');
});
