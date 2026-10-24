import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import type { DbAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import type { CatalogPreparationJobCommand } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { handleAdminRequest } from './handler.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';

async function apiFixture() {
  const h = fixture(0);
  const commands: CatalogPreparationJobCommand[] = [];
  const authority = createCatalogPreparationAuthority({
    secret: 'preparation-api-test',
    environmentId: 'api-test',
  });
  const config = {
    jwtSecret: 'preparation-api-test',
    enableDetailApproval: true,
    preparationAuthority: authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const progress = {
    jobId: 'a'.repeat(64),
    productId: h.product._id,
    state: 'queued' as const,
    attempt: 0,
    leaseVersion: 0,
    leaseExpiresAt: 0,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    media: null,
  };
  const manage: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async (auth, command) => {
    assert.equal(auth, authority);
    commands.push(command);
    return { ok: true, progress };
  };
  Reflect.set(h.adapter, 'manageCatalogPreparationJob', manage);
  const call = (data: unknown, overrides: Partial<typeof config> = {}) =>
    handleAdminRequest({ action: 'catalogPreparation', token, data }, { ...config, ...overrides });
  return { ...h, commands, config, token, progress, call };
}
test('human preparation API binds the actor from the revalidated session and returns safe progress', async () => {
  const f = await apiFixture();
  const r = await f.call({ action: 'start', productId: f.product._id });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(f.commands, [{ action: 'start', productId: f.product._id, actorId: 'admin' }]);
  assert.deepEqual(r.data, { ok: true, progress: f.progress });
});
test('human preparation API rejects actor injection and technical commands before persistence', async () => {
  const f = await apiFixture();
  for (const data of [
    { action: 'start', productId: f.product._id, actorId: 'other' },
    { action: 'dispatch', jobId: 'a'.repeat(64) },
    { action: 'claim', call: {}, owner: 'browser' },
    {
      action: 'checkpoint-preparation',
      jobId: 'a'.repeat(64),
      lease: {},
      previewReady: true,
      issues: [],
    },
  ]) {
    const r = await f.call(data);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(f.commands.length, 0);
});

for (const state of [
  'anonymous',
  'invalid-token',
  'suspended',
  'deleted',
  'demoted',
  'member',
] as const)
  test(`human preparation API denies ${state} sessions before any job command`, async () => {
    const f = await apiFixture();
    const user = f.adapter.rows.users?.[0];
    assert.ok(user);
    if (state === 'suspended') user.status = 'suspended';
    if (state === 'deleted') f.adapter.rows.users = [];
    if (state === 'demoted' || state === 'member')
      user.role = state === 'member' ? 'member' : 'contributor';
    const token =
      state === 'anonymous'
        ? undefined
        : state === 'invalid-token'
          ? 'invalid'
          : state === 'member'
            ? await signSession(f.config.jwtSecret, {
                sub: 'admin',
                email: 'user@example.test',
                name: 'User',
                role: 'member',
              })
            : f.token;
    const r = await handleAdminRequest(
      {
        action: 'catalogPreparation',
        ...(token ? { token } : {}),
        data: { action: 'start', productId: f.product._id },
      },
      f.config,
    );
    assert.ok(!r.ok);
    assert.equal(
      r.error.code,
      state === 'demoted' || state === 'member' ? 'FORBIDDEN' : 'UNAUTHORIZED',
    );
    assert.equal(f.commands.length, 0);
  });
test('human preparation API requires both rollout and a server authority', async () => {
  const f = await apiFixture();
  for (const config of [
    { ...f.config, enableDetailApproval: false },
    { jwtSecret: f.config.jwtSecret, enableDetailApproval: true },
  ]) {
    const r = await handleAdminRequest(
      {
        action: 'catalogPreparation',
        token: f.token,
        data: { action: 'start', productId: f.product._id },
      },
      config,
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'FORBIDDEN');
  }
  assert.equal(f.commands.length, 0);
});
test('human preparation API reports oversized requests before schema parsing or persistence', async () => {
  const f = await apiFixture();
  const r = await f.call({ action: 'start', productId: 'x'.repeat(5000) });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'VALIDATION_ERROR');
  assert.equal(r.error.message, 'Preparation request is too large.');
  assert.equal(f.commands.length, 0);
});
test('human preparation API validates IDs, versions and all extra fields strictly', async () => {
  const f = await apiFixture();
  for (const data of [
    undefined,
    null,
    [],
    {},
    { action: 'start', productId: '' },
    { action: 'start', productId: ' p ' },
    { action: 'status', jobId: 'bad' },
    { action: 'status', jobId: 'a'.repeat(64), lease: {} },
    { action: 'retry', jobId: 'a'.repeat(64) },
    { action: 'cancel', jobId: 'a'.repeat(64), expectedLeaseVersion: -1 },
    { action: 'retry', jobId: 'a'.repeat(64), expectedLeaseVersion: 0.5 },
    { action: 'retry', jobId: 'a'.repeat(64), expectedLeaseVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const r = await f.call(data);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(f.commands.length, 0);
});
for (const action of ['status', 'cancel', 'retry'] as const)
  test(`human preparation API passes ${action} with the same authenticated actor and version`, async () => {
    const f = await apiFixture();
    const data = {
      action,
      jobId: 'a'.repeat(64),
      ...(action === 'status' ? {} : { expectedLeaseVersion: 2 }),
    };
    const r = await f.call(data);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(f.commands, [{ ...data, actorId: 'admin' }]);
  });
for (const code of [
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CORRUPT',
  'CONFLICT',
  'BUSY',
  'STALE',
] as const)
  test(`human preparation API maps ${code} to safe actionable errors`, async () => {
    const f = await apiFixture();
    const manage: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async () => ({
      ok: false,
      code,
    });
    Reflect.set(f.adapter, 'manageCatalogPreparationJob', manage);
    const r = await f.call({ action: 'status', jobId: 'a'.repeat(64) });
    assert.ok(!r.ok);
    assert.equal(r.error.code, code === 'CORRUPT' || code === 'STALE' ? 'CONFLICT' : code);
    assert.match(r.error.message, /again|request|Refresh|refresh|progress|current/);
  });
test('human preparation API never returns an unexpected signed technical result', async () => {
  const f = await apiFixture();
  const call = f.config.preparationAuthority.issueCall({
    jobId: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
  });
  const manage: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async () => ({
    ok: true,
    call,
  });
  Reflect.set(f.adapter, 'manageCatalogPreparationJob', manage);
  const r = await f.call({ action: 'start', productId: f.product._id });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'CONFLICT');
  for (const value of [call.signature, call.nonce, 'signature', 'nonce', 'leaseOwner'])
    assert.equal(JSON.stringify(r).includes(value), false);
});
test('human preparation API projects only safe progress even if a technical lease is present', async () => {
  const f = await apiFixture();
  const manage: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async () => ({
    ok: true,
    progress: f.progress,
    lease: { privateValue: 'must-not-leak' },
  });
  Reflect.set(f.adapter, 'manageCatalogPreparationJob', manage);
  const r = await f.call({ action: 'start', productId: f.product._id });
  assert.ok(r.ok);
  assert.deepEqual(r.data, { ok: true, progress: f.progress });
});
test('existing capability responses never serialize the preparation authority', async () => {
  const f = await apiFixture();
  const r = await handleAdminRequest(
    { action: 'catalogDetailCapabilities', token: f.token },
    f.config,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.data, { enabled: true });
});

test('human preparation API exposes the safe readonly status response', async () => {
  const f = await apiFixture();
  const status = {
    progress: f.progress,
    current: true,
    report: null,
    attestation: null,
    nextAction: 'continue' as const,
  };
  const manage: NonNullable<DbAdapter['manageCatalogPreparationJob']> = async () => ({
    ok: true,
    status,
  });
  Reflect.set(f.adapter, 'manageCatalogPreparationJob', manage);
  const r = await f.call({ action: 'status', jobId: f.progress.jobId });
  assert.ok(r.ok);
  assert.deepEqual(r.data, { ok: true, status });
});

test('authenticated continue requires a server invoker and never issues a browser admission', async () => {
  const f = await apiFixture();
  const r = await f.call({ action: 'continue', jobId: f.progress.jobId });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'FORBIDDEN');
  assert.match(r.error.message, /execution.*not enabled/);
  assert.equal(f.commands.length, 0);
});

test('authenticated continue rejects browser invocation controls before reading the task', async () => {
  const f = await apiFixture();
  let invokes = 0;
  const config = {
    ...f.config,
    preparationInvoke: async () => {
      invokes++;
      return {};
    },
  };
  for (const extra of [
    { actorId: 'other' },
    { call: {} },
    { nonce: 'b'.repeat(64) },
    { lease: {} },
    { functionName: 'admin' },
    { qualifier: 'other' },
    { timeoutMs: 100000 },
    { budgetMs: 100000 },
  ]) {
    const r = await handleAdminRequest(
      {
        action: 'catalogPreparation',
        token: f.token,
        data: { action: 'continue', jobId: f.progress.jobId, ...extra },
      },
      config,
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(f.commands.length, 0);
  assert.equal(invokes, 0);
});
