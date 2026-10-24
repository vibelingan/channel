import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import type {
  CatalogPreparationJobResult,
  CatalogPreparationJobStatus,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { continueHumanCatalogPreparation } from './catalog-preparation-continue.ts';
import { fixture as sourceFixture } from './testing/catalog-source-plan-fixture.ts';

// Controlled status port; real repository/HTTP/pixels are exercised by local-server integration tests.
function fixture() {
  const h = sourceFixture(0);
  const jobId = 'a'.repeat(64);
  let clock = 1792080000000;
  let reads = 0;
  let invocations = 0;
  const authority = createCatalogPreparationAuthority({
    secret: 'continue-test',
    environmentId: 'continue-env',
    now: () => clock,
  });
  let status: CatalogPreparationJobStatus = {
    progress: {
      jobId,
      productId: h.product._id,
      state: 'queued',
      attempt: 1,
      leaseVersion: 1,
      leaseExpiresAt: 0,
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
      media: { total: 1, checked: 0, verified: 0, invalid: 0, retry: 0 },
    },
    current: true,
    attestation: null,
    nextAction: 'continue',
    report: CatalogPreparationReportSchema.parse({
      schemaVersion: 'catalog-preparation-report-v2',
      productId: h.product._id,
      inputDigest: 'c'.repeat(64),
      contentGeneration: 4,
      policyVersion: CATALOG_PREPARATION_POLICY,
      checkedAt: new Date(clock).toISOString(),
      state: 'preparing',
      previewReady: true,
      mediaReady: false,
      issues: [],
    }),
  };
  const commands: string[] = [];
  const controls: {
    read?: (index: number) => Promise<CatalogPreparationJobResult | undefined>;
    dispatch?: () => Promise<CatalogPreparationJobResult>;
    invoke?: (call: unknown) => Promise<unknown>;
  } = {};
  const manager: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async (auth, command) => {
    assert.equal(auth, authority);
    assert.ok('actorId' in command);
    assert.equal(command.actorId, 'admin');
    commands.push(command.action);
    if (command.action === 'status') {
      const special = await controls.read?.(++reads);
      return special ?? { ok: true, status: structuredClone(status) };
    }
    if (command.action === 'dispatch')
      return controls.dispatch
        ? controls.dispatch()
        : { ok: true, call: authority.issueCall({ jobId, nonce: 'b'.repeat(64) }) };
    throw Error('Unexpected write in continuation controller');
  };
  Reflect.set(h.adapter, 'manageCatalogPreparationJob', manager);
  const ack = () => ({
    ok: true,
    kind: 'catalog-preparation-step',
    jobId,
    productId: h.product._id,
    outcome: 'partial',
    media: { total: 1, checked: 0, verified: 0, invalid: 0, retry: 0 },
    issues: [],
  });
  const invoke = async (call: unknown) => {
    invocations++;
    assert.ok(authority.verifyCall(call));
    return controls.invoke ? controls.invoke(call) : { result: ack() };
  };
  const run = () =>
    continueHumanCatalogPreparation(authority, 'admin', jobId, invoke, { now: () => clock });
  const ready = () => {
    status = {
      ...status,
      nextAction: 'ready',
      attestation: { total: 1, checked: 1 },
      progress: {
        ...status.progress,
        state: 'completed',
        media: { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 },
      },
      report: CatalogPreparationReportSchema.parse({
        schemaVersion: 'catalog-preparation-report-v2',
        productId: h.product._id,
        inputDigest: 'c'.repeat(64),
        contentGeneration: 4,
        policyVersion: CATALOG_PREPARATION_POLICY,
        checkedAt: new Date(clock).toISOString(),
        state: 'ready',
        previewReady: true,
        mediaReady: true,
        issues: [],
        seal: {
          kind: 'catalog-preparation-ready-seal-v1',
          jobId,
          receiptId: 'd'.repeat(64),
          planDigest: 'e'.repeat(64),
          imageIdsDigest: 'f'.repeat(64),
          imageCount: 1,
          mediaPolicyVersion: CATALOG_MEDIA_SEAL_POLICY,
          pixelPolicyVersion: CATALOG_PIXEL_POLICY,
        },
      }),
    };
  };
  return {
    h,
    authority,
    jobId,
    commands,
    controls,
    ack,
    run,
    ready,
    patch: (p: Partial<CatalogPreparationJobStatus>) => {
      status = { ...status, ...p };
    },
    advance: (ms: number) => {
      clock += ms;
    },
    time: () => clock,
    get status() {
      return status;
    },
    get invocations() {
      return invocations;
    },
  };
}
test('continuation dispatches one current signed call and only then schedules an acknowledged partial', async () => {
  const f = fixture();
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.followUp, 'continue');
  assert.equal(r.invocation, 'acknowledged');
  assert.deepEqual(f.commands, ['status', 'dispatch', 'status']);
  assert.equal(f.invocations, 1);
  for (const key of ['signature', 'nonce', 'leaseOwner', 'sourceUrl', 'storageFileId'])
    assert.equal(JSON.stringify(r).includes(key), false);
});
for (const nextAction of ['ready', 'edit', 'retry', 'restart', 'wait'] as const)
  test(`continuation never dispatches when the durable next action is ${nextAction}`, async () => {
    const f = fixture();
    if (nextAction === 'ready') f.ready();
    else f.patch({ nextAction, ...(nextAction === 'restart' ? { current: false } : {}) });
    const r = await f.run();
    assert.ok(r.ok);
    assert.equal(r.followUp, nextAction === 'wait' ? 'poll' : 'none');
    assert.equal(r.invocation, 'skipped');
    assert.equal(f.invocations, 0);
    assert.deepEqual(f.commands, ['status']);
  });
test('continuation refuses noncurrent input even if a bad status port recommends continue', async () => {
  const f = fixture();
  f.patch({ current: false });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.invocation, 'skipped');
  assert.equal(f.invocations, 0);
});
for (const fault of [
  'wrong-job',
  'foreign-environment',
  'expired',
  'forged',
  'missing-call',
] as const)
  test(`continuation validates ${fault} admission before any invocation`, async () => {
    const f = fixture();
    f.controls.dispatch = async () => {
      const call = f.authority.issueCall({
        jobId: fault === 'wrong-job' ? 'f'.repeat(64) : f.jobId,
        nonce: 'b'.repeat(64),
      });
      if (fault === 'missing-call') return { ok: true, progress: f.status.progress };
      if (fault === 'expired') f.advance(31001);
      if (fault === 'foreign-environment') {
        const foreign = createCatalogPreparationAuthority({
          secret: 'continue-test',
          environmentId: 'other-env',
          now: f.time,
        });
        return { ok: true, call: foreign.issueCall({ jobId: f.jobId, nonce: 'b'.repeat(64) }) };
      }
      return { ok: true, call: fault === 'forged' ? { ...call, signature: 'e'.repeat(64) } : call };
    };
    assert.deepEqual(await f.run(), { ok: false, code: 'CORRUPT' });
    assert.equal(f.invocations, 0);
  });
for (const stage of ['status', 'dispatch'] as const)
  test(`continuation reserves readback headroom after slow ${stage}`, async () => {
    const f = fixture();
    if (stage === 'status')
      f.controls.read = async (index) => {
        if (index === 1) f.advance(5000);
        return undefined;
      };
    else
      f.controls.dispatch = async () => {
        const call = f.authority.issueCall({ jobId: f.jobId, nonce: 'b'.repeat(64) });
        f.advance(5000);
        return { ok: true, call };
      };
    const r = await f.run();
    assert.ok(r.ok);
    assert.equal(r.followUp, 'poll');
    assert.equal(r.invocation, 'skipped');
    assert.equal(f.invocations, 0);
    assert.deepEqual(f.commands, stage === 'status' ? ['status'] : ['status', 'dispatch']);
  });
for (const code of ['FORBIDDEN', 'NOT_FOUND', 'CORRUPT'] as const)
  test(`continuation returns ${code} admission failure without invoking or leaking a previous snapshot`, async () => {
    const f = fixture();
    f.controls.dispatch = async () => ({ ok: false, code });
    assert.deepEqual(await f.run(), { ok: false, code });
    assert.equal(f.invocations, 0);
  });
test('continuation observes a concurrent cancellation after admission conflict', async () => {
  const f = fixture();
  f.controls.dispatch = async () => {
    f.patch({
      nextAction: 'retry',
      report: null,
      progress: { ...f.status.progress, state: 'cancelled' },
    });
    return { ok: false, code: 'CONFLICT' };
  };
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.status.progress.state, 'cancelled');
  assert.equal(r.followUp, 'none');
  assert.equal(f.invocations, 0);
});
test('continuation can recover a dispatch transport failure without attempting a write again', async () => {
  const f = fixture();
  f.controls.dispatch = async () => {
    throw Error('owned dispatch transport');
  };
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.invocation, 'unconfirmed');
  assert.equal(r.followUp, 'poll');
  assert.deepEqual(f.commands, ['status', 'dispatch', 'status']);
  assert.equal(f.invocations, 0);
});
for (const fault of [
  'empty',
  'string',
  'provider-code',
  'other-job',
  'other-product',
  'negative',
  'overchecked',
  'bad-sum',
  'unsafe',
  'unsealed-ready',
  'error-partial',
  'private-extra',
] as const)
  test(`continuation treats ${fault} worker responses as unconfirmed and reads durable state`, async () => {
    const f = fixture();
    const ack = f.ack();
    let response: unknown = { result: ack };
    if (fault === 'empty') response = {};
    if (fault === 'string') response = { result: 'owned invalid JSON response' };
    if (fault === 'provider-code') response = { code: 'OWNED_PROVIDER_ERROR', result: ack };
    if (fault === 'other-job') ack.jobId = 'f'.repeat(64);
    if (fault === 'other-product') ack.productId = 'other';
    if (fault === 'negative') ack.media.total = -1;
    if (fault === 'overchecked') ack.media.checked = 2;
    if (fault === 'bad-sum') ack.media.verified = 1;
    if (fault === 'unsafe') ack.media.total = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'unsealed-ready')
      response = {
        result: {
          ...ack,
          outcome: 'ready',
          media: { total: 0, checked: 0, verified: 0, invalid: 0, retry: 0 },
        },
      };
    if (fault === 'error-partial')
      response = {
        result: {
          ...ack,
          issues: [
            {
              code: 'REQUIRED',
              stage: 'effective-content',
              path: 'name',
              severity: 'error',
              remedy: 'edit',
            },
          ],
        },
      };
    if (fault === 'private-extra')
      response = { result: { ...ack, rawSource: 'owned private detail' } };
    f.controls.invoke = async () => response;
    const r = await f.run();
    assert.ok(r.ok);
    assert.equal(r.invocation, 'unconfirmed');
    assert.equal(r.followUp, 'poll');
    assert.equal(r.status.report?.state, 'preparing');
    assert.equal(f.invocations, 1);
    assert.deepEqual(f.commands, ['status', 'dispatch', 'status']);
    assert.equal(JSON.stringify(r).includes('owned private detail'), false);
  });
test('a worker ready response cannot fabricate a durable ready preparation', async () => {
  const f = fixture();
  f.controls.invoke = async () => ({
    result: {
      ...f.ack(),
      outcome: 'ready',
      media: { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 },
      attestation: { total: 1, checked: 1 },
    },
  });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.status.nextAction, 'continue');
  assert.equal(r.status.report?.state, 'preparing');
  assert.equal(r.invocation, 'unconfirmed');
  assert.equal(r.followUp, 'poll');
});
test('a committed ready state wins when the invocation acknowledgement is lost', async () => {
  const f = fixture();
  f.controls.invoke = async () => {
    f.ready();
    throw Error('owned ACK lost');
  };
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.status.report?.state, 'ready');
  assert.equal(r.invocation, 'recovered');
  assert.equal(r.recovery, 'status');
  assert.equal(r.followUp, 'none');
  assert.equal(f.invocations, 1);
});
test('source retryable acknowledgement never auto-loops from a queued current job', async () => {
  const f = fixture();
  f.controls.invoke = async () => ({
    result: {
      ...f.ack(),
      outcome: 'retryable',
      issues: [
        {
          code: 'MEDIA_NOT_READY',
          stage: 'media',
          path: 'configurationPhotos',
          severity: 'warning',
          remedy: 'retry-media',
        },
      ],
    },
  });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.status.progress.state, 'queued');
  assert.equal(r.status.nextAction, 'continue');
  assert.equal(r.followUp, 'none');
  assert.equal(r.invocation, 'acknowledged');
  assert.equal(f.invocations, 1);
});
test('worker rejection is bounded and never exposes raw provider detail', async () => {
  const f = fixture();
  f.controls.invoke = async () => ({ result: { ok: false, code: 'UNAVAILABLE' } });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.followUp, 'none');
  assert.equal(r.invocation, 'rejected');
  assert.equal(r.failureCode, 'UNAVAILABLE');
  assert.equal(f.invocations, 1);
});
for (const fault of [
  'edit',
  'cancel',
  'retry',
  'advanced-media',
  'advanced-attestation',
  'revoke',
] as const)
  test(`continuation readback handles concurrent ${fault} after an acknowledged partial`, async () => {
    const f = fixture();
    f.controls.invoke = async () => {
      const response = { result: f.ack() };
      if (fault === 'edit') f.patch({ current: false, report: null, nextAction: 'restart' });
      if (fault === 'cancel')
        f.patch({
          report: null,
          nextAction: 'retry',
          progress: { ...f.status.progress, state: 'cancelled' },
        });
      if (fault === 'retry')
        f.patch({ report: null, progress: { ...f.status.progress, leaseVersion: 2, media: null } });
      if (fault === 'advanced-media')
        f.patch({
          progress: {
            ...f.status.progress,
            media: { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 },
          },
        });
      if (fault === 'advanced-attestation') f.patch({ attestation: { total: 1, checked: 1 } });
      if (fault === 'revoke') f.controls.read = async () => ({ ok: false, code: 'FORBIDDEN' });
      return response;
    };
    const r = await f.run();
    if (fault === 'revoke') assert.deepEqual(r, { ok: false, code: 'FORBIDDEN' });
    else {
      assert.ok(r.ok);
      assert.notEqual(r.followUp, 'continue');
      if (fault === 'edit') assert.equal(r.status.report, null);
      if (fault === 'cancel') assert.equal(r.status.progress.state, 'cancelled');
    }
    assert.equal(f.invocations, 1);
  });
test('continuation rejects a wrong job returned by the status port before admission', async () => {
  const f = fixture();
  f.patch({ progress: { ...f.status.progress, jobId: 'f'.repeat(64) } });
  assert.deepEqual(await f.run(), { ok: false, code: 'CORRUPT' });
  assert.equal(f.invocations, 0);
  assert.deepEqual(f.commands, ['status']);
});

for (const phase of ['before', 'after'] as const)
  test(`continuation confirms one unavailable readonly status ${phase} invocation`, async () => {
    const f = fixture();
    f.controls.read = async (index) => {
      if (index === (phase === 'before' ? 1 : 2)) throw Error('owned read ACK unavailable');
      return undefined;
    };
    const r = await f.run();
    assert.ok(r.ok);
    assert.equal(r.followUp, 'continue');
    assert.equal(f.invocations, 1);
    assert.deepEqual(
      f.commands,
      phase === 'before'
        ? ['status', 'status', 'dispatch', 'status']
        : ['status', 'dispatch', 'status', 'status'],
    );
  });
test('continuation stops after two unavailable readonly status attempts', async () => {
  const f = fixture();
  f.controls.read = async () => {
    throw Error('owned read unavailable');
  };
  await assert.rejects(f.run(), /owned read unavailable/);
  assert.deepEqual(f.commands, ['status', 'status']);
  assert.equal(f.invocations, 0);
});
test('unconfirmed invocation logs a bounded provider code without raw messages or credentials', async (t) => {
  const f = fixture();
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  f.controls.invoke = async () => ({
    code: 'OWNED_PROVIDER_FAILURE',
    message: 'https://private.example/owned-secret',
    result: f.ack(),
  });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.invocation, 'unconfirmed');
  assert.equal(warnings.length, 1);
  assert.ok(JSON.stringify(warnings).includes('OWNED_PROVIDER_FAILURE'));
  assert.equal(JSON.stringify(warnings).includes('private.example'), false);
  assert.equal(JSON.stringify(warnings).includes('owned-secret'), false);
  assert.equal(JSON.stringify(r).includes('OWNED_PROVIDER_FAILURE'), false);
});

test('pending source prefix rejects contradictory pixel counters before automatic continuation', async () => {
  const f = fixture();
  f.patch({ progress: { ...f.status.progress, media: null } });
  f.controls.invoke = async () => ({
    result: { ...f.ack(), media: { total: 1, checked: 0, verified: 1, invalid: 0, retry: 0 } },
  });
  const r = await f.run();
  assert.ok(r.ok);
  assert.equal(r.invocation, 'unconfirmed');
  assert.equal(r.followUp, 'poll');
  assert.equal(f.invocations, 1);
});
