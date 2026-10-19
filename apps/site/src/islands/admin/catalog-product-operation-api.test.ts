import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError, catalogProductOperationCall } from './api.ts';
import {
  type PublicationCommand,
  PublicationStatusUnknownError,
  createPublicationAttempt,
  managePublication,
  readPublicationStatus,
} from './catalog-product-operation-api.ts';

test('a publication continuation uses one transport request even when BUSY is returned', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(
      { ok: false, error: { code: 'BUSY', message: 'Try the same operation again.' } },
      { status: 409 },
    );
  });
  await assert.rejects(
    catalogProductOperationCall({
      action: 'product-operation-continue',
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      inputDigest: 'a'.repeat(64),
    }),
    (error) => error instanceof AdminApiError && error.code === 'BUSY',
  );
  assert.equal(calls, 1);
});

const operationId = '12345678-1234-4234-8234-123456789012';
const at = '2026-10-18T00:00:00.000Z';
const binding = { productId: 'p', operationId, inputDigest: 'a'.repeat(64) };
const query = { action: 'product-operation-get', productId: 'p', operationId };
const advance = { action: 'product-operation-continue', ...binding };
function saved(extra = {}) {
  return {
    ok: true,
    kind: 'product-operation',
    ...binding,
    intent: 'publish',
    createdAt: at,
    current: true,
    revisionCurrent: true,
    expired: false,
    state: 'saved',
    saved: { at, productUpdatedAt: at },
    ...extra,
  };
}
function complete(current = true) {
  return {
    ...saved({ current, revisionCurrent: current }),
    state: 'complete',
    approval: {
      revision: 'approved-r1',
      configurations: { completed: 0, total: 0 },
      mediaReady: true,
      references: { prepared: true, staged: 0, total: 0 },
    },
    completion: { at, productUpdatedAt: at, revision: 'approved-r1', published: true },
  };
}
function harness(responses: unknown[]) {
  const calls: PublicationCommand[] = [];
  const request = async (command: PublicationCommand) => {
    calls.push(structuredClone(command));
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, request };
}

test('a new publication attempt has its own UUID and captures nested input before callers edit it', () => {
  const input = {
    productId: 'p',
    expectedUpdatedAt: at,
    values: { imageIds: ['a'], description: 'Reviewed text' },
  };
  const first = createPublicationAttempt(input);
  const second = createPublicationAttempt(input);
  assert.notEqual(first.operationId, second.operationId);
  assert.equal(first.intent, 'publish');
  input.values.imageIds.push('later');
  input.values.description = 'Later edit';
  assert.deepEqual(first.values, { imageIds: ['a'], description: 'Reviewed text' });
});

for (const action of [
  'product-operation-start',
  'product-operation-continue',
  'product-operation-cancel',
])
  for (const outcome of ['saved', 'complete', 'historical', 'cancelled'])
    test(`an unknown ${action} response queries only its original ${outcome} operation`, async () => {
      const response =
        outcome === 'complete'
          ? complete()
          : outcome === 'historical'
            ? complete(false)
            : outcome === 'cancelled'
              ? saved({ cancelledAt: at, current: false })
              : saved();
      const command =
        action === 'product-operation-start'
          ? {
              action,
              productId: 'p',
              operationId,
              intent: 'publish',
              expectedUpdatedAt: at,
              values: { description: 'My original input' },
            }
          : { action, ...binding };
      const h = harness([Error('response lost'), response]);
      const result = await managePublication(command, h);
      assert.equal(result.recovery, 'status');
      assert.deepEqual(result.status, response);
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.calls[1], query);
      assert.deepEqual(h.calls[0], command);
      if (outcome === 'historical') assert.equal(result.status.current, false);
      if (outcome === 'saved') assert.equal(result.status.state, 'saved');
    });

for (const code of [
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'CONFLICT',
  'BUSY',
  'NOT_FOUND',
  'MEDIA_BUSY',
])
  test(`an explicit ${code} keeps the original error and does not retry or query`, async () => {
    const error = new AdminApiError(code, 'Original reason', [
      {
        code: 'INVALID_VALUE',
        stage: 'source',
        path: 'description',
        severity: 'error',
        remedy: 'review-change',
      },
    ]);
    const h = harness([error]);
    await assert.rejects(managePublication(advance, h), (caught) => caught === error);
    assert.equal(h.calls.length, 1);
  });

for (const confirmation of [
  Error('confirmation unavailable'),
  new AdminApiError('NOT_FOUND', 'Not found'),
  new AdminApiError('UNAUTHORIZED', 'Sign in'),
  new AdminApiError('FORBIDDEN', 'No permission'),
])
  test(`failed confirmation ${confirmation.message} preserves the original unknown scope and both errors`, async () => {
    const original = Error('original response lost');
    const h = harness([original, confirmation]);
    await assert.rejects(managePublication(advance, h), (error) => {
      assert.ok(error instanceof PublicationStatusUnknownError);
      assert.deepEqual(error.scope, binding);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [original, confirmation]);
      assert.equal('values' in error.scope, false);
      if (
        confirmation instanceof AdminApiError &&
        ['UNAUTHORIZED', 'FORBIDDEN'].includes(confirmation.code)
      )
        assert.equal(error.code, confirmation.code);
      return true;
    });
    assert.deepEqual(h.calls, [advance, query]);
  });

test('a lost start and NOT_FOUND lookup never creates a second attempt', async () => {
  const attempt = createPublicationAttempt({ productId: 'p', expectedUpdatedAt: at, values: {} });
  const h = harness([Error('start response lost'), new AdminApiError('NOT_FOUND', 'Not found')]);
  await assert.rejects(managePublication(attempt, h), PublicationStatusUnknownError);
  assert.deepEqual(
    h.calls.map((call) => call.action),
    ['product-operation-start', 'product-operation-get'],
  );
  assert.ok(h.calls.every((call) => call.operationId === attempt.operationId));
});

for (const fault of [
  'productId',
  'operationId',
  'inputDigest',
  'intent',
  'private-root',
  'bad-completion',
  'too-large',
])
  test(`a ${fault} status cannot confirm another publication`, async () => {
    const response: Record<string, unknown> = complete();
    if (fault === 'productId') response.productId = 'other';
    if (fault === 'operationId') response.operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    if (fault === 'inputDigest') response.inputDigest = 'f'.repeat(64);
    if (fault === 'intent') response.intent = 'save-draft';
    if (fault === 'private-root') response.record = { values: { description: 'private text' } };
    if (fault === 'bad-completion')
      response.completion = { at, productUpdatedAt: at, revision: 'wrong', published: true };
    if (fault === 'too-large') response.productId = 'x'.repeat(5000);
    assert.throws(
      () => readPublicationStatus(response, binding),
      (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
    );
    const h = harness([Error('response lost'), response]);
    await assert.rejects(managePublication(advance, h), PublicationStatusUnknownError);
    assert.equal(h.calls.length, 2);
  });

test('a malformed command response is recovered only by the original matching receipt', async () => {
  const h = harness([{ ...complete(), productId: 'other' }, complete()]);
  const result = await managePublication(advance, h);
  assert.equal(result.recovery, 'status');
  assert.equal(result.status.productId, 'p');
  assert.equal(h.calls.length, 2);
});

test('a normal command answer needs no extra status request', async () => {
  const h = harness([complete()]);
  const result = await managePublication(advance, h);
  assert.equal(result.recovery, 'none');
  assert.equal(h.calls.length, 1);
});

test('a read with an expected digest checks that same digest and never recursively retries', async () => {
  const h = harness([saved({ inputDigest: 'b'.repeat(64) })]);
  await assert.rejects(
    managePublication(query, { ...h, expectedInputDigest: binding.inputDigest }),
    (error) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
  );
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], query);
});

test('a failed read is returned once without any mutation or second read', async () => {
  const error = Error('read unavailable');
  const h = harness([error]);
  await assert.rejects(managePublication(query, h), (caught) => caught === error);
  assert.deepEqual(h.calls, [query]);
});

for (const bad of [
  { ...advance, action: 'operation-publish' },
  { ...advance, action: 'operation-get' },
  { ...advance, actorId: 'other' },
  { ...advance, values: {} },
  { ...advance, inputDigest: 'bad' },
  { ...advance, productId: ' p' },
  { ...advance, operationId: 'bad' },
  { ...query, inputDigest: binding.inputDigest },
  { ...advance, referenceRecovery: { imageId: 'i', ledgerDigest: 'b'.repeat(64), nextOffset: 80 } },
  {
    ...advance,
    referenceRecovery: {
      imageId: 'i',
      ledgerDigest: 'b'.repeat(64),
      nextOffset: 0,
      privateRoot: 'secret',
    },
  },
  {
    action: 'product-operation-start',
    productId: 'p',
    operationId,
    intent: 'refresh-live',
    expectedUpdatedAt: at,
    values: {},
  },
  {
    action: 'product-operation-start',
    productId: 'p',
    operationId,
    intent: 'publish',
    expectedUpdatedAt: at,
    values: { description: 'x'.repeat(256 * 1024) },
  },
])
  test(`an invalid public request ${JSON.stringify(bad).slice(0, 90)} is refused before dispatch`, async () => {
    const h = harness([]);
    await assert.rejects(
      managePublication(bad, h),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(h.calls.length, 0);
  });

test('a cyclic publication value is rejected before transport', async () => {
  const values: Record<string, unknown> = {};
  values.self = values;
  const h = harness([]);
  await assert.rejects(
    managePublication(
      {
        action: 'product-operation-start',
        productId: 'p',
        operationId,
        intent: 'publish',
        expectedUpdatedAt: at,
        values,
      },
      h,
    ),
    (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
  );
  assert.equal(h.calls.length, 0);
});

test('scope and reference cursor are captured before the first request yields', async () => {
  const input = {
    ...advance,
    referenceRecovery: { imageId: 'i', ledgerDigest: 'b'.repeat(64), nextOffset: 3 },
  };
  const calls: PublicationCommand[] = [];
  const result = await managePublication(input, {
    request: async (command) => {
      calls.push(structuredClone(command));
      if (command.action !== 'product-operation-get') {
        input.productId = 'other';
        input.operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        input.inputDigest = 'f'.repeat(64);
        input.referenceRecovery.nextOffset = 7;
        throw Error('lost');
      }
      return saved();
    },
  });
  assert.deepEqual(calls[0], {
    ...advance,
    referenceRecovery: { imageId: 'i', ledgerDigest: 'b'.repeat(64), nextOffset: 3 },
  });
  assert.deepEqual(calls[1], query);
  assert.equal(result.status.productId, 'p');
});

test('aborting before dispatch makes no request', async () => {
  const controller = new AbortController();
  controller.abort(Error('stopped'));
  const h = harness([]);
  await assert.rejects(managePublication(advance, { ...h, signal: controller.signal }), /stopped/);
  assert.equal(h.calls.length, 0);
});

test('an interrupted unknown write is not called cancelled and does not issue a hidden confirmation', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    managePublication(advance, {
      signal: controller.signal,
      request: async () => {
        calls++;
        controller.abort(Error('stopped'));
        throw Error('answer unknown');
      },
    }),
    (error) =>
      error instanceof PublicationStatusUnknownError && error.scope.operationId === operationId,
  );
  assert.equal(calls, 1);
});

for (const expectedInputDigest of ['bad', 'b'.repeat(64)])
  test(`an invalid expected digest ${expectedInputDigest.slice(0, 5)} is rejected before a write`, async () => {
    const h = harness([]);
    await assert.rejects(
      managePublication(advance, { ...h, expectedInputDigest }),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(h.calls.length, 0);
  });

for (const shape of ['expired-completion', 'newer-row-same-publication'])
  test(`a valid ${shape} is preserved for current public readback without a new publication`, async () => {
    const value = {
      ...complete(),
      ...(shape === 'expired-completion' ? { expired: true } : { revisionCurrent: false }),
    };
    const h = harness([value]);
    const result = await managePublication(query, {
      ...h,
      expectedInputDigest: binding.inputDigest,
    });
    assert.deepEqual(result.status, value);
    assert.equal(result.status.current, true);
    assert.deepEqual(h.calls, [query]);
  });

test('transport mutation of its dispatched copy cannot change the original recovery action', async () => {
  const calls: PublicationCommand[] = [];
  const result = await managePublication(advance, {
    request: async (command) => {
      calls.push(structuredClone(command));
      if (calls.length === 1) {
        Reflect.set(command, 'action', 'product-operation-get');
        Reflect.set(command, 'productId', 'other');
        throw Error('transport lost response');
      }
      return saved();
    },
  });
  assert.equal(result.recovery, 'status');
  assert.deepEqual(calls, [advance, query]);
});

test('an undefined confirmation rejection still retains both failed attempts', async () => {
  const original = Error('original response lost');
  let calls = 0;
  await assert.rejects(
    managePublication(advance, {
      request: async () => {
        calls++;
        if (calls === 1) throw original;
        throw undefined;
      },
    }),
    (error) => {
      assert.ok(error instanceof PublicationStatusUnknownError);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [original, undefined]);
      return true;
    },
  );
});

test('reusing an exposed publication attempt cannot change its original UUID or submitted values', async () => {
  const attempt = createPublicationAttempt({
    productId: 'p',
    expectedUpdatedAt: at,
    values: { description: 'Original input', imageIds: ['original'] },
  });
  const original = JSON.stringify(attempt);
  const h = harness([
    saved({ operationId: attempt.operationId }),
    saved({ operationId: attempt.operationId }),
  ]);
  await managePublication(attempt, h);
  assert.equal(Reflect.set(attempt, 'operationId', 'ffffffff-ffff-4fff-8fff-ffffffffffff'), false);
  assert.equal(Reflect.set(attempt.values, 'description', 'A later edit'), false);
  const images = Reflect.get(attempt.values, 'imageIds');
  assert.ok(Array.isArray(images));
  assert.throws(() => images.push('later'), TypeError);
  await managePublication(attempt, h);
  assert.equal(JSON.stringify(h.calls[0]), original);
  assert.equal(JSON.stringify(h.calls[1]), original);
});

test('an unknown outcome exposes an immutable recovery scope', async () => {
  const h = harness([Error('lost'), Error('lookup lost')]);
  await assert.rejects(managePublication(advance, h), (error) => {
    assert.ok(error instanceof PublicationStatusUnknownError);
    assert.equal(
      Reflect.set(error.scope, 'operationId', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
      false,
    );
    assert.deepEqual(error.scope, binding);
    return true;
  });
});

test('the default publication client sends the real authenticated public command exactly once', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key === 'channel.token' ? 'publication-only-test-token' : null),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const requests: { action: string; token: string; data: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, data: complete() });
  });
  const result = await managePublication(advance);
  assert.equal(result.status.state, 'complete');
  assert.equal(result.recovery, 'none');
  assert.deepEqual(requests, [
    { action: 'catalogDetailApproval', data: advance, token: 'publication-only-test-token' },
  ]);
});

test('the default publication client preserves BUSY with one actual fetch and no hidden write retry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(
      { ok: false, error: { code: 'BUSY', message: 'Try the original operation again.' } },
      { status: 409 },
    );
  });
  await assert.rejects(
    managePublication(advance),
    (error) => error instanceof AdminApiError && error.code === 'BUSY',
  );
  assert.equal(calls, 1);
});
