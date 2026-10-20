import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError } from './api.ts';
import {
  managePreparation,
  readPreparationResponse,
  runPreparation,
} from './catalog-preparation-api.ts';

const jobId = 'a'.repeat(64);
function progress() {
  return {
    jobId,
    productId: 'clock',
    state: 'queued',
    attempt: 0,
    leaseVersion: 0,
    leaseExpiresAt: 0,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    media: { total: 0, checked: 0, verified: 0, invalid: 0, retry: 0 },
  };
}
function status(nextAction = 'continue') {
  return {
    progress: progress(),
    current: true,
    report: null as unknown,
    attestation: null as unknown,
    nextAction,
  };
}
function ready() {
  const value = status('ready');
  value.progress.state = 'completed';
  value.attestation = { total: 0, checked: 0 };
  value.report = {
    schemaVersion: 'catalog-preparation-report-v2',
    productId: 'clock',
    inputDigest: 'b'.repeat(64),
    policyVersion: 'catalog-preparation-v1',
    contentGeneration: 0,
    checkedAt: '2026-10-17T00:00:00.000Z',
    state: 'ready',
    previewReady: true,
    mediaReady: true,
    issues: [],
    seal: {
      kind: 'catalog-preparation-ready-seal-v1',
      jobId,
      receiptId: 'c'.repeat(64),
      planDigest: 'd'.repeat(64),
      imageIdsDigest: 'e'.repeat(64),
      imageCount: 0,
      mediaPolicyVersion: 'catalog-protected-media-seal-v1',
      pixelPolicyVersion: 'catalog-pixels-v1',
    },
  };
  return value;
}
function answer(value = status()) {
  return { ok: true, status: value };
}
function partial() {
  const value = status();
  const report = ready().report;
  assert.ok(report && typeof report === 'object');
  const preparing = { ...report, state: 'preparing', mediaReady: false };
  Reflect.deleteProperty(preparing, 'seal');
  value.report = preparing;
  return { ...answer(value), followUp: 'continue', invocation: 'acknowledged' };
}
function harness(responses: unknown[]) {
  const calls: unknown[] = [];
  const waits: number[] = [];
  let time = 0;
  const request = async (command: unknown) => {
    calls.push(command);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    waits,
    request,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    wait: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}

test('preparation transport uses the existing envelope and never retries a BUSY continuation', async (t) => {
  const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'owned-token' },
  });
  t.after(() => {
    if (stored) Object.defineProperty(globalThis, 'localStorage', stored);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({ ok: false, error: { code: 'BUSY', message: 'Try later' } }),
      { status: 409 },
    );
  });
  await assert.rejects(
    managePreparation({ action: 'continue', jobId }),
    (error: unknown) => error instanceof AdminApiError && error.code === 'BUSY',
  );
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0] && typeof bodies[0] === 'object');
  assert.deepEqual(Reflect.get(bodies[0], 'data'), { action: 'continue', jobId });
  assert.equal(Reflect.get(bodies[0], 'action'), 'catalogPreparation');
});

for (const fault of [
  'job',
  'product',
  'private',
  'sum',
  'ready-without-proof',
  'ready-old',
  'report-product',
  'seal-job',
]) {
  test(`preparation decoder rejects ${fault} instead of granting usable state`, () => {
    const value = fault.includes('ready') || fault === 'seal-job' ? ready() : status();
    if (fault === 'job') value.progress.jobId = 'f'.repeat(64);
    if (fault === 'product') value.progress.productId = 'other';
    if (fault === 'private') Reflect.set(value.progress, 'nonce', 'secret');
    if (fault === 'sum') value.progress.media.checked = 1;
    if (fault === 'ready-without-proof') value.report = null;
    if (fault === 'ready-old') value.current = false;
    if (fault === 'report-product') {
      const report = ready().report;
      assert.ok(report && typeof report === 'object');
      value.report = { ...report, productId: 'other' };
    }
    if (fault === 'seal-job') {
      assert.ok(value.report && typeof value.report === 'object');
      const seal = Reflect.get(value.report, 'seal');
      Reflect.set(seal, 'jobId', 'f'.repeat(64));
    }
    assert.throws(
      () => readPreparationResponse(answer(value), { jobId, productId: 'clock' }),
      /response/,
    );
  });
}

test('browser preparation runs sequential acknowledged steps and keeps the same frozen job', async () => {
  const h = harness([
    { ok: true, progress: progress() },
    partial(),
    partial(),
    { ...answer(ready()), followUp: 'none', invocation: 'acknowledged' },
  ]);
  const observed: string[] = [];
  const result = await runPreparation(
    { productId: 'clock' },
    { ...h, onProgress: (value) => observed.push(value.progress.jobId) },
  );
  assert.equal(result.reason, 'ready');
  assert.equal(result.jobId, jobId);
  assert.deepEqual(h.calls, [
    { action: 'start', productId: 'clock' },
    ...Array.from({ length: 3 }, () => ({ action: 'continue', jobId })),
  ]);
  assert.ok(observed.length >= 3 && observed.every((id) => id === jobId));
});

for (const nextAction of ['edit', 'retry', 'restart']) {
  test(`browser resume stops at ${nextAction} with a usable status`, async () => {
    const value = status(nextAction);
    if (nextAction === 'restart') value.current = false;
    const h = harness([answer(value)]);
    const result = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(result.reason, 'needs-action');
    assert.equal(result.status?.nextAction, nextAction);
    assert.equal(h.calls.length, 1);
  });
}

test('browser resume reads ready without sending any continuation', async () => {
  const h = harness([answer(ready())]);
  assert.equal((await runPreparation({ productId: 'clock', jobId }, h)).reason, 'ready');
  assert.deepEqual(h.calls, [{ action: 'status', jobId }]);
});

test('source retryable result never loops even when its status still recommends continue', async () => {
  const h = harness([answer(), { ...answer(), followUp: 'none', invocation: 'acknowledged' }]);
  const r = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(r.reason, 'needs-action');
  assert.equal(h.calls.length, 2);
});

test('unknown invocation recovers actual ready with one status query and no repeated invocation', async () => {
  const h = harness([answer(), Error('lost invocation ACK'), answer(ready())]);
  const r = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(r.reason, 'ready');
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
    { action: 'status', jobId },
  ]);
});

for (const recovered of [answer(), Error('status unavailable')]) {
  test(`unknown invocation retains same job and ${recovered instanceof Error ? 'unknown outcome' : 'manual continuation'}`, async () => {
    const h = harness([answer(), Error('lost ACK'), recovered]);
    const r = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(r.jobId, jobId);
    assert.equal(r.reason, recovered instanceof Error ? 'unknown' : 'needs-action');
    assert.equal(h.calls.length, 3);
  });
}

for (const code of ['UNAUTHORIZED', 'FORBIDDEN']) {
  test(`browser preparation stops immediately on ${code}`, async () => {
    const h = harness([answer(), new AdminApiError(code, 'Access ended')]);
    const r = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(r.reason, 'needs-action');
    assert.equal(r.errorCode, code);
    assert.equal(h.calls.length, 2);
  });
}

test('polling can observe ready but cannot turn an unknown queued job into a new write', async () => {
  for (const next of [ready(), status()]) {
    const waiting = status('wait');
    waiting.progress.state = 'running';
    const h = harness([
      answer(),
      { ...answer(waiting), followUp: 'poll', invocation: 'unconfirmed', recovery: 'status' },
      answer(next),
    ]);
    const r = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(r.reason, next.nextAction === 'ready' ? 'ready' : 'needs-action');
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.waits, [600]);
    assert.equal(
      h.calls.filter((c) => c && typeof c === 'object' && Reflect.get(c, 'action') === 'continue')
        .length,
      1,
    );
  }
});

test('active lease polling has a fixed cap and backoff', async () => {
  const value = status('wait');
  value.progress.state = 'running';
  const h = harness(Array.from({ length: 10 }, () => answer(value)));
  const r = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(r.reason, 'paused');
  assert.deepEqual(h.waits, [600, 1200, 2400, 2400]);
  assert.equal(h.calls.length, 5);
});

test('automatic source-prefix continuation is bounded by request count with no per-product restart', async () => {
  const h = harness([answer(), ...Array.from({ length: 100 }, partial)]);
  const r = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(r.reason, 'paused');
  assert.equal(r.jobId, jobId);
  assert.equal(h.calls.length, 64);
});

test('elapsed browser budget pauses before starting another request', async () => {
  const h = harness([answer(), partial()]);
  const request = async (command: unknown) => {
    const result = await h.request(command);
    h.advance(120000);
    return result;
  };
  const r = await runPreparation({ productId: 'clock', jobId }, { ...h, request });
  assert.equal(r.reason, 'paused');
  assert.equal(h.calls.length, 1);
});

test('aborted browser wait keeps a recoverable job and does not claim remote cancellation', async () => {
  const controller = new AbortController();
  const h = harness([answer()]);
  const request = async (command: unknown) => {
    const result = await h.request(command);
    controller.abort();
    return result;
  };
  const r = await runPreparation(
    { productId: 'clock', jobId },
    { ...h, request, signal: controller.signal },
  );
  assert.equal(r.reason, 'paused');
  assert.equal(r.jobId, jobId);
  assert.equal(h.calls.length, 1);
  assert.equal(r.status?.progress.state, 'queued');
});

test('malformed continuation never schedules a new write and only a valid recovery status is accepted', async () => {
  const h = harness([answer(), { ...partial(), signature: 'private' }, answer()]);
  const r = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(r.reason, 'needs-action');
  assert.equal(h.calls.length, 3);
});

test('a changed caller selection cannot redirect an in-flight preparation run', async () => {
  const input = { productId: 'clock', jobId };
  const h = harness([
    answer(),
    { ...answer(ready()), followUp: 'none', invocation: 'acknowledged' },
  ]);
  const request = async (command: unknown) => {
    const value = await h.request(command);
    input.productId = 'other';
    input.jobId = 'f'.repeat(64);
    return value;
  };
  const r = await runPreparation(input, { ...h, request });
  assert.equal(r.reason, 'ready');
  assert.equal(r.productId, 'clock');
  assert.equal(r.jobId, jobId);
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
  ]);
});

test('aborting a real transport wait preserves the observed job and sends no cancel or repeated write', async (t) => {
  const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'owned-token' },
  });
  t.after(() => {
    if (stored) Object.defineProperty(globalThis, 'localStorage', stored);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const controller = new AbortController();
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.data.action);
    if (body.data.action === 'status') return Response.json({ ok: true, data: answer() });
    const signal = init.signal;
    assert.ok(signal);
    queueMicrotask(() => controller.abort());
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const r = await runPreparation({ productId: 'clock', jobId }, { signal: controller.signal });
  assert.equal(r.reason, 'paused');
  assert.equal(r.jobId, jobId);
  assert.equal(r.status?.progress.state, 'queued');
  assert.deepEqual(actions, ['status', 'continue']);
});

test('a failed initial start keeps the frozen product available without creating another task', async () => {
  const h = harness([Error('unknown start ACK')]);
  const r = await runPreparation({ productId: 'clock' }, h);
  assert.equal(r.reason, 'unknown');
  assert.equal(r.productId, 'clock');
  assert.equal(r.jobId, undefined);
  assert.deepEqual(h.calls, [{ action: 'start', productId: 'clock' }]);
});

test('stopping during the default poll delay performs no follow-up read or remote cancellation', async () => {
  const active = status('wait');
  active.progress.state = 'running';
  const h = harness([answer(active)]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    const r = await runPreparation(
      { productId: 'clock', jobId },
      { request: h.request, signal: controller.signal },
    );
    assert.equal(r.reason, 'paused');
    assert.equal(r.jobId, jobId);
    assert.deepEqual(h.calls, [{ action: 'status', jobId }]);
  } finally {
    clearTimeout(timer);
  }
});

for (const [action, wrong] of [
  ['status', { ok: true, progress: progress() }],
  ['continue', answer()],
  ['start', answer()],
] as const) {
  test(`a ${action} response must match its action`, () => {
    assert.throws(
      () => readPreparationResponse(wrong, { jobId, productId: 'clock', action }),
      /response/,
    );
  });
}

function rejectedBusy() {
  return { ...answer(), followUp: 'none', invocation: 'rejected', failureCode: 'BUSY' };
}
test('BUSY original preparation retries only after a fresh same-job status read', async () => {
  const h = harness([
    answer(),
    rejectedBusy(),
    answer(),
    { ...answer(ready()), followUp: 'none', invocation: 'acknowledged' },
  ]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'ready');
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
    { action: 'status', jobId },
    { action: 'continue', jobId },
  ]);
  assert.deepEqual(h.waits, [400]);
});
test('BUSY original preparation stops after four bounded retries without creating a new job', async () => {
  const h = harness([
    answer(),
    ...Array.from({ length: 4 }, () => [rejectedBusy(), answer()]).flat(),
    rejectedBusy(),
  ]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'paused');
  assert.equal(result.errorCode, 'BUSY');
  assert.equal(h.calls.length, 10);
  assert.deepEqual(h.waits, [400, 800, 1200, 1200]);
  assert.ok(h.calls.every((c) => c && typeof c === 'object' && Reflect.get(c, 'jobId') === jobId));
});
for (const fault of [
  'stale',
  'older-lease',
  'older-attempt',
  'creation-changed',
  'unconfirmed',
] as const)
  test(`BUSY original preparation does not retry ${fault} evidence`, async () => {
    const fresh = status();
    const busy = rejectedBusy();
    if (fault === 'stale') {
      fresh.current = false;
      fresh.nextAction = 'restart';
    }
    if (fault === 'older-lease') {
      busy.status.progress.leaseVersion = 2;
      fresh.progress.leaseVersion = 1;
    }
    if (fault === 'older-attempt') {
      busy.status.progress.attempt = 2;
      fresh.progress.attempt = 1;
    }
    if (fault === 'creation-changed') fresh.progress.createdAt = '2026-10-16T00:00:00.000Z';
    if (fault === 'unconfirmed') busy.invocation = 'unconfirmed';
    const h = harness([
      answer(),
      busy,
      answer(fresh),
      { ...answer(ready()), followUp: 'none', invocation: 'acknowledged' },
    ]);
    const result = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(result.reason, 'needs-action');
    assert.equal(h.calls.length, fault === 'unconfirmed' ? 2 : 3);
  });
test('BUSY original preparation observes ready without invoking a second worker', async () => {
  const h = harness([answer(), rejectedBusy(), answer(ready())]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'ready');
  assert.equal(h.calls.length, 3);
});
test('BUSY original preparation stops immediately if its recovery wait is aborted', async () => {
  const h = harness([answer(), rejectedBusy(), answer()]);
  const result = await runPreparation(
    { productId: 'clock', jobId },
    {
      ...h,
      wait: async () => {
        throw Error('Stopped');
      },
    },
  );
  assert.equal(result.reason, 'paused');
  assert.equal(h.calls.length, 2);
});

test('BUSY original preparation handles a definite HTTP rejection using fresh status before its bounded retry', async () => {
  const h = harness([
    answer(),
    new AdminApiError('BUSY', 'Nothing saved'),
    answer(),
    answer(),
    { ...answer(ready()), followUp: 'none', invocation: 'acknowledged' },
  ]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'ready');
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
    { action: 'status', jobId },
    { action: 'status', jobId },
    { action: 'continue', jobId },
  ]);
  assert.deepEqual(h.waits, [400]);
});

for (const code of ['UNAUTHORIZED', 'FORBIDDEN'] as const)
  test(`BUSY original preparation loses ${code} during fresh read without invoking again`, async () => {
    const h = harness([answer(), rejectedBusy(), new AdminApiError(code, 'Access ended')]);
    const result = await runPreparation({ productId: 'clock', jobId }, h);
    assert.equal(result.reason, 'needs-action');
    assert.equal(result.errorCode, code);
    assert.equal(h.calls.length, 3);
  });

test('worker rejection preserves a checkable saved job without treating the actor as forbidden or silently retrying', async () => {
  const current = { ...status(), progress: { ...progress(), media: null } };
  const h = harness([
    { ...answer(), status: current },
    {
      ...answer(),
      status: current,
      followUp: 'none',
      invocation: 'rejected',
      failureCode: 'FORBIDDEN',
    },
  ]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'rejected');
  assert.equal(result.errorCode, undefined);
  assert.equal(result.jobId, jobId);
  assert.equal(result.status?.nextAction, 'continue');
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
  ]);
  assert.deepEqual(h.waits, []);
});

test('authoritative ready recovery returned by the server remains ready after an unacknowledged worker call', async () => {
  const h = harness([
    answer(),
    { ...answer(ready()), followUp: 'none', invocation: 'recovered', recovery: 'status' },
  ]);
  const result = await runPreparation({ productId: 'clock', jobId }, h);
  assert.equal(result.reason, 'ready');
  assert.equal(result.errorCode, undefined);
  assert.deepEqual(h.calls, [
    { action: 'status', jobId },
    { action: 'continue', jobId },
  ]);
});
