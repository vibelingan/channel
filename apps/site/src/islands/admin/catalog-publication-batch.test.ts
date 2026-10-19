import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { AdminApiError } from './api.ts';
import {
  type PublicationScope,
  PublicationScopeSchema,
  capturePublicationCommand,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import {
  type PublicationBatchOptions,
  createPublicationBatch,
} from './catalog-publication-batch.ts';

const at = '2026-10-18T00:00:00.000Z';
function scope(input: unknown) {
  if (input && typeof input === 'object' && 'action' in input) {
    const command = capturePublicationCommand(input);
    return {
      productId: command.productId,
      operationId: command.operationId,
      inputDigest: 'a'.repeat(64),
    };
  }
  return { ...PublicationScopeSchema.parse(input), inputDigest: 'a'.repeat(64) };
}
function complete(binding: PublicationScope) {
  return CatalogProductOperationStatusSchema.parse({
    ok: true,
    kind: 'product-operation',
    ...binding,
    inputDigest: binding.inputDigest ?? 'a'.repeat(64),
    intent: 'publish',
    createdAt: at,
    current: true,
    revisionCurrent: true,
    expired: false,
    state: 'complete',
    saved: { at, productUpdatedAt: at },
    approval: {
      revision: 'r',
      configurations: { completed: 0, total: 0 },
      mediaReady: true,
      references: { prepared: true, staged: 0, total: 0 },
    },
    completion: { at, productUpdatedAt: at, revision: 'r', published: true },
  });
}
function fixture() {
  const owner = {
    actorId: 'admin',
    token: 'fixture-token',
    endpoint: 'https://test.example/api/admin',
  };
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (n: number) => [...data.keys()][n] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  const base: PublicationBatchOptions = {
    session: () => owner,
    authorize: async () => ({ id: 'admin', role: 'admin' }),
    storage: () => storage,
    run: async (input, options) => {
      const binding = scope(input);
      const status = complete(binding);
      await options?.onStatus?.(status, { scope: binding });
      return { reason: 'committed', scope: binding, status, requests: 2 };
    },
    check: async (input) => {
      const binding = scope(input);
      const status = complete(binding);
      assert.ok(status.state === 'complete');
      return {
        reason: 'confirmed',
        scope: binding,
        revision: 'r',
        name: binding.productId,
        status,
      };
    },
  };
  return { owner, data, storage, base };
}
function attempts(n: number, prefix = 'p') {
  return Array.from({ length: n }, (_, i) =>
    createPublicationAttempt({
      productId: `${prefix}-${i}`,
      expectedUpdatedAt: at,
      values: { description: `Draft ${i}` },
    }),
  );
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

for (const n of [20, 21, 50, 100])
  test(`${n} publications use sequential groups of20 with at most4 active workflows`, async () => {
    const h = fixture();
    let active = 0;
    let max = 0;
    const ended = new Set<string>();
    const groupStarts: number[] = [];
    const run = h.base.run;
    assert.ok(run);
    const batch = createPublicationBatch({
      ...h.base,
      run: async (input, options) => {
        const binding = scope(input);
        const i = Number(binding.productId.split('-')[1]);
        if (i % 20 === 0) {
          groupStarts.push(i);
          assert.equal(ended.size, i);
        }
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 1));
        assert.equal(h.data.size > 0, true);
        active--;
        ended.add(binding.productId);
        return run(input, options);
      },
    });
    const result = await batch.run(attempts(n));
    assert.equal(result.items.length, n);
    assert.ok(result.items.every((x) => x.state === 'confirmed'));
    assert.equal(result.confirmed, n);
    assert.equal(max, 4);
    assert.deepEqual(
      groupStarts,
      Array.from({ length: Math.ceil(n / 20) }, (_, i) => i * 20),
    );
    assert.equal(h.data.size, 0);
  });

test('two simultaneous controllers share four permits rather than opening eight', async () => {
  const h = fixture();
  let active = 0;
  let max = 0;
  const run = h.base.run;
  assert.ok(run);
  const options = {
    ...h.base,
    run: async (...args: Parameters<typeof run>) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await run(...args);
      } finally {
        active--;
      }
    },
  };
  const [a, b] = await Promise.all([
    createPublicationBatch(options).run(attempts(10, 'a')),
    createPublicationBatch(options).run(attempts(10, 'b')),
  ]);
  assert.equal(a.confirmed, 10);
  assert.equal(b.confirmed, 10);
  assert.equal(max, 4);
  assert.equal(active, 0);
});

for (const invalid of [
  [],
  attempts(101),
  [...attempts(1), ...attempts(1)],
  (() => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    return sparse;
  })(),
])
  test(`invalid or duplicate batch ${JSON.stringify(invalid).slice(0, 65)} is rejected before authorization or writes`, async () => {
    const h = fixture();
    let calls = 0;
    const batch = createPublicationBatch({
      ...h.base,
      authorize: async () => {
        calls++;
        return { id: 'admin', role: 'admin' };
      },
    });
    await assert.rejects(
      batch.run(invalid),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(calls, 0);
    assert.equal(h.data.size, 0);
  });

test('selection and values are captured before asynchronous account verification', async () => {
  const h = fixture();
  const gate = deferred();
  const captured: string[] = [];
  const run = h.base.run;
  assert.ok(run);
  const input = attempts(2).map((x) => ({ ...x, values: { description: 'Before' } }));
  const batch = createPublicationBatch({
    ...h.base,
    authorize: async () => {
      await gate.promise;
      return { id: 'admin', role: 'admin' };
    },
    run: async (command, options) => {
      const parsed = capturePublicationCommand(command);
      assert.ok(parsed.action === 'product-operation-start');
      captured.push(String(parsed.values.description));
      return run(command, options);
    },
  });
  const pending = batch.run(input);
  const second = input[1];
  assert.ok(second);
  second.values.description = 'Changed';
  input.pop();
  gate.release();
  const result = await pending;
  assert.equal(result.confirmed, 2);
  assert.deepEqual(captured, ['Before', 'Before']);
});

for (const actor of [
  { id: 'other', role: 'admin' },
  { id: 'admin', role: 'member' },
])
  test(`backend actor ${JSON.stringify(actor)} cannot authorize local stored owner`, async () => {
    const h = fixture();
    const batch = createPublicationBatch({ ...h.base, authorize: async () => actor });
    await assert.rejects(
      batch.run(attempts(1)),
      (error) => error instanceof AdminApiError && error.code === 'FORBIDDEN',
    );
    assert.equal(h.data.size, 0);
  });

for (const field of ['token', 'actorId', 'endpoint'] as const)
  test(`changing ${field} during account verification prevents all publications`, async () => {
    const h = fixture();
    const gate = deferred();
    const batch = createPublicationBatch({
      ...h.base,
      authorize: async () => {
        await gate.promise;
        return { id: 'admin', role: 'admin' };
      },
    });
    const pending = batch.run(attempts(1));
    h.owner[field] = 'changed';
    gate.release();
    await assert.rejects(
      pending,
      (error) => error instanceof AdminApiError && error.code === 'SESSION_CHANGED',
    );
    assert.equal(h.data.size, 0);
  });

test('changing the original token during a private RPC pauses all later work', async () => {
  const h = fixture();
  let calls = 0;
  const batch = createPublicationBatch({
    ...h.base,
    request: async (command) => {
      calls++;
      h.owner.token = 'changed';
      return complete(scope(command));
    },
    run: async (input, options) => {
      const binding = scope(input);
      await options?.request?.(
        {
          action: 'product-operation-get',
          productId: binding.productId,
          operationId: binding.operationId,
        },
        options.signal,
      );
      return { reason: 'committed', scope: binding, requests: 1 };
    },
  });
  const result = await batch.run(attempts(20));
  assert.equal(calls, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(result.paused, true);
  assert.ok(result.items.some((x) => x.state === 'unknown'));
  assert.ok(batch.journal.read().entries.length > 0);
});

test('backend permission loss stops later queued writes without relying on local role', async () => {
  const h = fixture();
  let calls = 0;
  const batch = createPublicationBatch({
    ...h.base,
    request: async () => {
      calls++;
      throw new AdminApiError('FORBIDDEN', 'Permission revoked');
    },
    run: async (input, options) => {
      const binding = scope(input);
      await options?.request?.(
        {
          action: 'product-operation-get',
          productId: binding.productId,
          operationId: binding.operationId,
        },
        options.signal,
      );
      return { reason: 'unknown', scope: binding, requests: 1 };
    },
  });
  const result = await batch.run(attempts(20));
  assert.ok(calls <= 4);
  assert.equal(result.paused, true);
  assert.equal(result.confirmed, 0);
});

test('storage quota failure prevents first dispatch and retains an exportable original pointer', async () => {
  const h = fixture();
  let calls = 0;
  h.storage.setItem = () => {
    throw new DOMException('Full', 'QuotaExceededError');
  };
  const batch = createPublicationBatch({
    ...h.base,
    run: async (input) => {
      calls++;
      return { reason: 'unknown', scope: scope(input), requests: 0 };
    },
  });
  const selected = attempts(20);
  const result = await batch.run(selected);
  assert.equal(calls, 0);
  assert.equal(result.paused, true);
  assert.equal(result.confirmed, 0);
  assert.ok(result.items.every((x) => x.state === 'not-started'));
  const first = selected[0];
  assert.ok(first);
  const exported = JSON.parse(
    batch.journal.export({ productId: first.productId, operationId: first.operationId }),
  );
  assert.equal(exported.entries[0].scope.operationId, first.operationId);
});

test('an unknown public readback retains the original task and resumes without a replacement start', async () => {
  const h = fixture();
  let checks = 0;
  const inputs: unknown[] = [];
  const run = h.base.run;
  assert.ok(run);
  const batch = createPublicationBatch({
    ...h.base,
    run: async (input, options) => {
      inputs.push(structuredClone(input));
      return run(input, options);
    },
    check: async (input) => {
      const binding = scope(input);
      if (++checks === 1)
        return {
          reason: 'unknown',
          scope: binding,
          error: { code: 'UNAVAILABLE', message: 'Website unavailable', issues: [] },
        };
      const check = h.base.check;
      assert.ok(check);
      return check(input);
    },
  });
  const selected = attempts(1);
  const first = await batch.run(selected);
  assert.equal(first.confirmed, 0);
  assert.equal(first.items[0]?.state, 'unknown');
  const entries = batch.journal.read().entries;
  assert.equal(entries.length, 1);
  const second = await batch.run(entries);
  assert.equal(second.confirmed, 1);
  assert.equal(batch.journal.read().entries.length, 0);
  assert.equal(inputs.length, 2);
  const resumed = inputs[1];
  assert.ok(resumed && typeof resumed === 'object' && !('action' in resumed));
  assert.equal(PublicationScopeSchema.parse(resumed).operationId, selected[0]?.operationId);
});

test('historical completion is never counted or republished', async () => {
  const h = fixture();
  let checks = 0;
  const batch = createPublicationBatch({
    ...h.base,
    run: async (input) => ({ reason: 'historical', scope: scope(input), requests: 1 }),
    check: async (input) => {
      checks++;
      return { reason: 'historical', scope: scope(input) };
    },
  });
  const result = await batch.run(attempts(1));
  assert.equal(result.confirmed, 0);
  assert.equal(result.items[0]?.state, 'historical');
  assert.equal(checks, 0);
  assert.equal(batch.journal.read().entries.length, 0);
});

test('a different original operation in public confirmation never counts as this publication', async () => {
  const h = fixture();
  const check = h.base.check;
  assert.ok(check);
  const batch = createPublicationBatch({
    ...h.base,
    check: async (input) => {
      const result = await check(input);
      return { ...result, scope: { ...result.scope, operationId: crypto.randomUUID() } };
    },
  });
  const result = await batch.run(attempts(1));
  assert.equal(result.confirmed, 0);
  assert.equal(result.items[0]?.state, 'unknown');
  assert.equal(batch.journal.read().entries.length, 1);
});

test('a failing completion observer preserves confirmations, stops later groups and releases permits', async () => {
  const h = fixture();
  const batch = createPublicationBatch({
    ...h.base,
    onItem: async () => {
      throw Error('Observer unavailable');
    },
  });
  const result = await batch.run(attempts(50));
  assert.equal(result.paused, true);
  assert.ok(result.confirmed > 0 && result.confirmed <= 4);
  assert.ok(result.observerError);
  assert.ok(result.items.slice(20).every((x) => x.state === 'not-started'));
  const after = await createPublicationBatch(h.base).run(attempts(4, 'after'));
  assert.equal(after.confirmed, 4);
});

test('a cancelled permit waiter releases no nonexistent permit and cannot block later batches', async () => {
  const h = fixture();
  const gate = deferred();
  const started = deferred();
  let count = 0;
  const run = h.base.run;
  assert.ok(run);
  const first = createPublicationBatch({
    ...h.base,
    run: async (input, options) => {
      if (++count === 4) started.release();
      await gate.promise;
      return run(input, options);
    },
  }).run(attempts(4, 'held'));
  let failed: unknown;
  try {
    await started.promise;
    const controller = new AbortController();
    const second = createPublicationBatch(h.base).run(attempts(1, 'waiting'), controller.signal);
    await new Promise(setImmediate);
    controller.abort();
    const result = await second;
    assert.equal(result.confirmed, 0);
    assert.equal(result.items[0]?.state, 'not-started');
  } catch (error) {
    failed = error;
  } finally {
    gate.release();
    await first;
  }
  if (failed) throw failed;
  const after = await createPublicationBatch(h.base).run(attempts(4, 'after'));
  assert.equal(after.confirmed, 4);
});

for (const corrupt of ['product', 'digest', 'status', 'revision'] as const)
  test(`contradictory ${corrupt} confirmation never increments published count`, async () => {
    const h = fixture();
    const check = h.base.check;
    assert.ok(check);
    const batch = createPublicationBatch({
      ...h.base,
      check: async (input) => {
        const result = await check(input);
        assert.ok(result.reason === 'confirmed');
        if (corrupt === 'product')
          return { ...result, scope: { ...result.scope, productId: 'other' } };
        if (corrupt === 'digest')
          return { ...result, scope: { ...result.scope, inputDigest: 'b'.repeat(64) } };
        if (corrupt === 'status')
          return { ...result, status: { ...result.status, operationId: crypto.randomUUID() } };
        return { ...result, revision: 'another-revision' };
      },
    });
    const result = await batch.run(attempts(1));
    assert.equal(result.confirmed, 0);
    assert.equal(result.items[0]?.state, 'unknown');
    assert.equal(batch.journal.read().entries.length, 1);
  });

test('a failed progress checkpoint stops continuation and keeps the latest exportable digest', async () => {
  const h = fixture();
  const batch = createPublicationBatch({
    ...h.base,
    run: async (input, options) => {
      const binding = scope(input);
      h.storage.setItem = () => {
        throw new DOMException('Full', 'QuotaExceededError');
      };
      await options?.onStatus?.(complete(binding), { scope: binding });
      return { reason: 'committed', scope: binding, requests: 1 };
    },
  });
  const selection = attempts(20);
  const result = await batch.run(selection);
  assert.equal(result.confirmed, 0);
  assert.equal(result.paused, true);
  assert.equal(result.items[0]?.state, 'unknown');
  const first = selection[0];
  assert.ok(first);
  const exported = JSON.parse(
    batch.journal.export({ productId: first.productId, operationId: first.operationId }),
  );
  assert.equal(exported.entries[0].scope.inputDigest, 'a'.repeat(64));
});

test('a saved reference recovery cursor reaches only the original resumed runner', async () => {
  const h = fixture();
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const binding = scope(attempt);
  const cursor = { imageId: 'image', ledgerDigest: 'b'.repeat(64), nextOffset: 3 };
  let calls = 0;
  let observedInput: unknown;
  let observedCursor: unknown;
  const batch = createPublicationBatch({
    ...h.base,
    run: async (input, options) => {
      calls++;
      observedInput = structuredClone(input);
      observedCursor = structuredClone(options?.referenceRecovery);
      return { reason: 'unknown', scope: binding, referenceRecovery: cursor, requests: 1 };
    },
  });
  batch.journal.retain({ scope: binding, referenceRecovery: cursor });
  const result = await batch.run(batch.journal.read().entries);
  assert.equal(result.confirmed, 0);
  assert.equal(calls, 1);
  assert.deepEqual(observedInput, binding);
  assert.deepEqual(observedCursor, cursor);
  assert.deepEqual(batch.journal.read().entries[0]?.referenceRecovery, cursor);
});

test('a second producer for an active product cannot start another operation', async () => {
  const h = fixture();
  const entered = deferred();
  const gate = deferred();
  const run = h.base.run;
  assert.ok(run);
  let calls = 0;
  const first = createPublicationBatch({
    ...h.base,
    run: async (input, options) => {
      calls++;
      entered.release();
      await gate.promise;
      return run(input, options);
    },
  }).run(attempts(1));
  let second: Awaited<ReturnType<ReturnType<typeof createPublicationBatch>['run']>> | undefined;
  try {
    await entered.promise;
    second = await createPublicationBatch({
      ...h.base,
      run: async (input, options) => {
        calls++;
        return run(input, options);
      },
    }).run(attempts(1));
  } finally {
    gate.release();
    await first;
  }
  assert.equal(calls, 1);
  assert.equal(second?.items[0]?.state, 'not-started');
  assert.equal(second?.items[0]?.error?.code, 'BUSY');
});

test('aborting a hung completion observer preserves its confirmed fact and consumes late failure', async () => {
  const h = fixture();
  const entered = deferred();
  let rejectObserver = (error: unknown) => {
    void error;
  };
  const observer = new Promise<void>((_resolve, reject) => {
    rejectObserver = reject;
  });
  const signal = new AbortController();
  const pending = createPublicationBatch({
    ...h.base,
    onItem: () => {
      entered.release();
      return observer;
    },
  }).run(attempts(1), signal.signal);
  await entered.promise;
  signal.abort();
  const result = await pending;
  assert.equal(result.confirmed, 1);
  assert.equal(result.paused, true);
  assert.ok(result.observerError);
  rejectObserver(Error('Late observer failure'));
  await new Promise(setImmediate);
  const after = await createPublicationBatch(h.base).run(attempts(4, 'after-observer'));
  assert.equal(after.confirmed, 4);
});

test('different products may resume the same operation UUID because native identity includes product ID', async () => {
  const h = fixture();
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const binding = scope(attempt);
  const entries = [{ scope: binding }, { scope: { ...binding, productId: 'another-product' } }];
  const result = await createPublicationBatch(h.base).run(entries);
  assert.equal(result.confirmed, 2);
  assert.equal(result.items[0]?.scope.operationId, result.items[1]?.scope.operationId);
});

function reserved(binding: PublicationScope, cancelled = false) {
  return CatalogProductOperationStatusSchema.parse({
    ok: true,
    kind: 'product-operation',
    ...binding,
    inputDigest: binding.inputDigest ?? 'a'.repeat(64),
    intent: 'publish',
    createdAt: at,
    current: true,
    revisionCurrent: true,
    expired: false,
    state: 'reserved',
    ...(cancelled ? { cancelledAt: at } : {}),
  });
}

test('read-only original checks never run or cancel and preserve unfinished recovery', async () => {
  const h = fixture();
  let runs = 0;
  let writes = 0;
  const batch = createPublicationBatch({
    ...h.base,
    run: async () => {
      runs++;
      throw Error('No run during check');
    },
    request: async () => {
      writes++;
      throw Error('No private mutation');
    },
    check: async (input) => {
      const binding = scope(input);
      return { reason: 'not-complete', scope: binding, status: reserved(binding) };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'check');
  assert.equal(result.items[0]?.state, 'paused');
  assert.equal(runs, 0);
  assert.equal(writes, 0);
  assert.equal(batch.journal.read().entries.length, 1);
});
test('read-only original checks still work when browser storage is unavailable', async () => {
  const h = fixture();
  let checks = 0;
  const batch = createPublicationBatch({
    ...h.base,
    storage: () => {
      throw Error('Storage denied');
    },
    check: async (input) => {
      checks++;
      const binding = scope(input);
      return { reason: 'not-complete', scope: binding, status: reserved(binding) };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'check');
  assert.equal(checks, 1);
  assert.equal(result.items[0]?.state, 'paused');
  assert.match(batch.journal.export(), /operationId/);
});
test('stopping reads original input before cancelling and never starts a replacement', async () => {
  const h = fixture();
  let stopped = false;
  const calls: string[] = [];
  const batch = createPublicationBatch({
    ...h.base,
    request: async (command) => {
      calls.push(command.action);
      assert.equal(command.action, 'product-operation-cancel');
      assert.equal('inputDigest' in command ? command.inputDigest : undefined, 'a'.repeat(64));
      stopped = true;
      return reserved(scope(command), true);
    },
    check: async (input) => {
      calls.push('check');
      const binding = scope(input);
      return { reason: 'not-complete', scope: binding, status: reserved(binding, stopped) };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'cancel');
  assert.equal(result.items[0]?.state, 'cancelled');
  assert.deepEqual(calls, ['check', 'product-operation-cancel', 'check']);
  assert.equal(batch.journal.read().entries.length, 0);
});
test('a publication completing during stop is confirmed rather than reported cancelled', async () => {
  const h = fixture();
  let finished = false;
  let cancels = 0;
  const originalCheck = h.base.check;
  assert.ok(originalCheck);
  const batch = createPublicationBatch({
    ...h.base,
    request: async (command) => {
      assert.equal(command.action, 'product-operation-cancel');
      cancels++;
      finished = true;
      return complete(scope(command));
    },
    check: async (input, options) => {
      if (finished) return originalCheck(input, options);
      const binding = scope(input);
      return { reason: 'not-complete', scope: binding, status: reserved(binding) };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'cancel');
  assert.equal(result.confirmed, 1);
  assert.equal(result.items[0]?.state, 'confirmed');
  assert.equal(cancels, 1);
});
test('an unknown original is never cancelled or replaced', async () => {
  const h = fixture();
  let writes = 0;
  const batch = createPublicationBatch({
    ...h.base,
    request: async () => {
      writes++;
      throw Error('No mutation');
    },
    check: async (input) => ({ reason: 'unknown', scope: scope(input) }),
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'cancel');
  assert.equal(result.items[0]?.state, 'unknown');
  assert.equal(writes, 0);
  assert.equal(batch.journal.read().entries.length, 1);
});
test('a different original status cannot authorize cancellation', async () => {
  const h = fixture();
  let writes = 0;
  const batch = createPublicationBatch({
    ...h.base,
    request: async () => {
      writes++;
      throw Error('No mutation');
    },
    check: async (input) => {
      const binding = scope(input);
      return {
        reason: 'not-complete',
        scope: binding,
        status: reserved({ ...binding, productId: 'another' }),
      };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run([{ scope: scope(attempt) }], undefined, 'cancel');
  assert.equal(result.items[0]?.state, 'unknown');
  assert.equal(writes, 0);
});
for (const mode of ['check', 'cancel'] as const)
  test(`${mode} rejects fresh attempts before authorization`, async () => {
    const h = fixture();
    let auth = 0;
    const batch = createPublicationBatch({
      ...h.base,
      authorize: async () => {
        auth++;
        return { id: 'admin', role: 'admin' };
      },
    });
    await assert.rejects(batch.run(attempts(1), undefined, mode));
    assert.equal(auth, 0);
  });

test('a different original digest cannot authorize cancellation when the saved pointer has no digest', async () => {
  const h = fixture();
  let writes = 0;
  const batch = createPublicationBatch({
    ...h.base,
    request: async () => {
      writes++;
      throw Error('No mutation');
    },
    check: async (input) => {
      const binding = scope(input);
      return {
        reason: 'not-complete',
        scope: binding,
        status: reserved({ ...binding, inputDigest: 'b'.repeat(64) }),
      };
    },
  });
  const attempt = attempts(1)[0];
  assert.ok(attempt);
  const result = await batch.run(
    [{ scope: { productId: attempt.productId, operationId: attempt.operationId } }],
    undefined,
    'cancel',
  );
  assert.equal(result.items[0]?.state, 'unknown');
  assert.equal(writes, 0);
});
