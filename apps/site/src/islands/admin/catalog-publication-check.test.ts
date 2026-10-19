import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_DETAIL_PAGE_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-pagination';
import { AdminApiError } from './api.ts';
import type { PublicationCommand } from './catalog-product-operation-api.ts';
import { checkPublication } from './catalog-publication-check.ts';

const at = '2026-10-18T00:00:00.000Z';
const scope = {
  productId: 'p',
  operationId: '12345678-1234-4234-8234-123456789012',
  inputDigest: 'a'.repeat(64),
};
function status(state = 'complete', extra = {}) {
  return {
    ok: true,
    kind: 'product-operation',
    ...scope,
    intent: 'publish',
    createdAt: at,
    current: true,
    revisionCurrent: true,
    expired: false,
    state,
    ...(state === 'reserved' ? {} : { saved: { at, productUpdatedAt: at } }),
    ...(['staging', 'complete'].includes(state)
      ? {
          approval: {
            revision: 'approved',
            configurations: { completed: 0, total: 0 },
            mediaReady: true,
            references: { prepared: true, staged: 1, total: 1 },
          },
        }
      : {}),
    ...(state === 'complete'
      ? { completion: { at, productUpdatedAt: at, revision: 'approved', published: true } }
      : {}),
    ...extra,
  };
}
function detail(extra = {}) {
  return {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Clock',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
    revision: 'approved',
    variants: { items: [], total: 0, page: 1, pageSize: 1, hasMore: false },
    ...extra,
  };
}
function harness(
  responses: unknown[] = [status(), status()],
  publicResponse = Response.json({ ok: true, data: detail() }),
) {
  const calls: PublicationCommand[] = [];
  const publicCalls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (command: PublicationCommand) => {
    calls.push(structuredClone(command));
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    publicCalls.push({ url: String(url), ...(init ? { init } : {}) });
    return publicResponse;
  };
  return { calls, publicCalls, request, fetch };
}

test('confirmation binds the public detail between two reads of the original completed operation', async () => {
  const h = harness();
  const result = await checkPublication(scope, h);
  assert.equal(result.reason, 'confirmed');
  assert.equal(result.revision, 'approved');
  assert.deepEqual(result.scope, scope);
  assert.equal(result.name, 'Clock');
  assert.deepEqual(h.calls, [
    { action: 'product-operation-get', productId: 'p', operationId: scope.operationId },
    { action: 'product-operation-get', productId: 'p', operationId: scope.operationId },
  ]);
  const sent = h.publicCalls[0];
  assert.ok(sent);
  const url = new URL(sent.url, 'https://owned.test');
  assert.equal(url.pathname, '/api/products/p/detail');
  assert.equal(url.searchParams.get('revision'), 'approved');
  assert.equal(url.searchParams.get('pageSize'), '1');
  assert.equal(url.searchParams.get('pagination'), 'byte-budget-v1');
  assert.equal(sent.init?.method, 'GET');
  assert.equal(sent.init?.credentials, 'omit');
  assert.equal(sent.init?.redirect, 'error');
  assert.equal(sent.init?.cache, 'no-store');
  assert.equal(sent.init?.body, undefined);
});

for (const state of ['reserved', 'saved', 'staging'])
  test(`a ${state} task remains incomplete and never triggers a public delivery check`, async () => {
    const h = harness([status(state)]);
    const result = await checkPublication(scope, h);
    assert.equal(result.reason, 'not-complete');
    assert.equal(h.calls.length, 1);
    assert.equal(h.publicCalls.length, 0);
  });

test('an old complete receipt is historical and cannot count as a current publication', async () => {
  const h = harness([status('complete', { current: false, revisionCurrent: false })]);
  const result = await checkPublication(scope, h);
  assert.equal(result.reason, 'historical');
  assert.equal(h.publicCalls.length, 0);
});

for (const extra of [
  { _id: 'other' },
  { revision: 'other' },
  { revision: undefined },
  { variants: { items: [], total: 0, page: 2, pageSize: 1, hasMore: false } },
  { rawSupplierEvidence: 'private' },
])
  test(`wrong or invalid public detail cannot confirm publication ${JSON.stringify(extra)}`, async () => {
    const h = harness(undefined, Response.json({ ok: true, data: detail(extra) }));
    const result = await checkPublication(scope, h);
    assert.equal(result.reason, 'unknown');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every((x) => x.action === 'product-operation-get'));
  });

for (const code of ['NOT_FOUND', 'INTERNAL_ERROR'])
  test(`a public ${code} retains the committed original task for another readback`, async () => {
    const h = harness(
      undefined,
      Response.json(
        { ok: false, error: { code, message: 'Not ready' } },
        { status: code === 'NOT_FOUND' ? 404 : 503 },
      ),
    );
    const result = await checkPublication(scope, h);
    assert.equal(result.reason, 'unknown');
    assert.equal(result.error?.code, code);
    assert.equal(result.status?.state, 'complete');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(result.scope, scope);
  });

test('withdrawal during a failed public check is reported as history, without another publication', async () => {
  const h = harness(
    [status(), status('complete', { current: false, revisionCurrent: false })],
    Response.json(
      { ok: false, error: { code: 'NOT_FOUND', message: 'Withdrawn' } },
      { status: 404 },
    ),
  );
  const result = await checkPublication(scope, h);
  assert.equal(result.reason, 'historical');
  assert.equal(h.calls.length, 2);
});

for (const code of ['UNAUTHORIZED', 'FORBIDDEN'])
  test(`losing ${code} at final confirmation cannot be counted as success`, async () => {
    const h = harness([status(), new AdminApiError(code, 'Sign in')]);
    const result = await checkPublication(scope, h);
    assert.equal(result.reason, 'unknown');
    assert.equal(result.error?.code, code);
    assert.equal(h.calls.length, 2);
  });

test('metadata sync changing row revision does not invalidate the same effective approved publication', async () => {
  const h = harness([status(), status('complete', { revisionCurrent: false })]);
  assert.equal((await checkPublication(scope, h)).reason, 'confirmed');
});

test('an expired complete receipt can still prove the current immutable publication', async () => {
  const h = harness([status('complete', { expired: true }), status('complete', { expired: true })]);
  assert.equal((await checkPublication(scope, h)).reason, 'confirmed');
});

test('an oversized public stream is cancelled and keeps the original confirmation unknown', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CATALOG_DETAIL_PAGE_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const h = harness(undefined, response);
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 1000);
  try {
    const result = await checkPublication(scope, { ...h, signal: controller.signal });
    assert.equal(result.reason, 'unknown');
    assert.equal(cancelled, true);
    assert.equal(h.calls.length, 2);
  } finally {
    clearTimeout(watchdog);
  }
});

test('an already aborted check makes no request and never claims server cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness();
  const result = await checkPublication(scope, { ...h, signal: controller.signal });
  assert.equal(result.reason, 'paused');
  assert.equal(h.calls.length, 0);
  assert.equal(h.publicCalls.length, 0);
  assert.deepEqual(result.scope, scope);
});

for (const input of [
  null,
  [],
  { ...scope, action: 'product-operation-start' },
  { ...scope, actorId: 'other' },
])
  test(`invalid confirmation scope is rejected before any transport ${JSON.stringify(input)}`, async () => {
    const h = harness();
    await assert.rejects(
      checkPublication(input, h),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.publicCalls.length, 0);
  });

test('invalid UTF-8 cancels the remaining public response body', async () => {
  let cancelled = false;
  const h = harness(
    undefined,
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([255]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  assert.equal((await checkPublication(scope, h)).reason, 'unknown');
  assert.equal(cancelled, true);
});

test('abort after the first root answer stops before issuing public fetch', async () => {
  const controller = new AbortController();
  const h = harness();
  const result = await checkPublication(scope, {
    ...h,
    signal: controller.signal,
    request: async (command) => {
      controller.abort();
      return h.request(command);
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(h.calls.length, 1);
  assert.equal(h.publicCalls.length, 0);
});

test('abort releases a waiting public stream without issuing the final root query', async () => {
  const controller = new AbortController();
  const h = harness();
  let cancelled = false;
  const result = await checkPublication(scope, {
    ...h,
    signal: controller.signal,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            setImmediate(() => controller.abort());
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(result.reason, 'paused');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
});

test('confirmation captures its original scope before the caller can alter it', async () => {
  const input = { ...scope };
  const h = harness();
  const result = await checkPublication(input, {
    ...h,
    request: async (command) => {
      input.productId = 'other';
      input.inputDigest = 'b'.repeat(64);
      return h.request(command);
    },
  });
  assert.equal(result.reason, 'confirmed');
  assert.deepEqual(result.scope, scope);
  assert.ok(h.calls.every((command) => command.productId === 'p'));
});

for (const phase of ['first', 'last'])
  test(`a wrong original root at the ${phase} query never confirms publication`, async () => {
    const wrong = status('complete', { productId: 'other' });
    const h = harness(phase === 'first' ? [wrong] : [status(), wrong]);
    assert.equal((await checkPublication(scope, h)).reason, 'unknown');
    assert.equal(h.calls.length, phase === 'first' ? 1 : 2);
    assert.ok(h.calls.every((command) => command.action === 'product-operation-get'));
  });

test('an approval revision changing under the same scope never confirms a mixed publication', async () => {
  const changed = status();
  changed.approval = {
    revision: 'other',
    configurations: { completed: 0, total: 0 },
    mediaReady: true,
    references: { prepared: true, staged: 1, total: 1 },
  };
  changed.completion = { at, productUpdatedAt: at, revision: 'other', published: true };
  const h = harness([status(), changed]);
  assert.equal((await checkPublication(scope, h)).reason, 'unknown');
});

test('the default native and public transports use two scoped POST reads and one anonymous revision-bound GET', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'owned-session-test' },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const calls: Array<{ method: string | undefined; url: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method, url: String(url) });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.action, 'catalogDetailApproval');
      assert.equal(body.token, 'owned-session-test');
      assert.equal(body.data.action, 'product-operation-get');
      assert.equal(body.data.operationId, scope.operationId);
      return Response.json({ ok: true, data: status() });
    }
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.body, undefined);
    assert.equal(init?.headers, undefined);
    return Response.json({ ok: true, data: detail() });
  });
  assert.equal((await checkPublication(scope)).reason, 'confirmed');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['POST', 'GET', 'POST'],
  );
});

test('a pointer without a digest learns it from the original task before confirming public delivery', async () => {
  const h = harness();
  const result = await checkPublication(
    { productId: scope.productId, operationId: scope.operationId },
    h,
  );
  assert.equal(result.reason, 'confirmed');
  assert.deepEqual(result.scope, scope);
});

test('a different input digest at final readback cannot replace the original binding', async () => {
  const h = harness([status(), status('complete', { inputDigest: 'b'.repeat(64) })]);
  const result = await checkPublication(scope, h);
  assert.equal(result.reason, 'unknown');
  assert.deepEqual(result.scope, scope);
});
