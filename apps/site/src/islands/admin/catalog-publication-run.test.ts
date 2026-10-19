import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError } from './api.ts';
import {
  type PublicationCommand,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import { runPublication } from './catalog-publication-run.ts';

const at = '2026-10-18T00:00:00.000Z';
const operationId = '12345678-1234-4234-8234-123456789012';
const scope = { productId: 'p', operationId, inputDigest: 'a'.repeat(64) };
function status(state = 'saved', extra = {}) {
  const value = {
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
    ...extra,
  };
  return state === 'complete'
    ? {
        ...value,
        approval: {
          revision: 'approved',
          configurations: { completed: 0, total: 0 },
          mediaReady: true,
          references: { prepared: true, staged: 0, total: 0 },
        },
        completion: { at, productUpdatedAt: at, revision: 'approved', published: true },
      }
    : value;
}

test('a warm publication advances its original start and returns a committed receipt', async () => {
  const attempt = createPublicationAttempt({
    productId: 'p',
    expectedUpdatedAt: at,
    values: { description: 'Reviewed' },
  });
  const calls: PublicationCommand[] = [];
  const result = await runPublication(attempt, {
    request: async (command) => {
      calls.push(structuredClone(command));
      return status(command.action === 'product-operation-start' ? 'reserved' : 'complete', {
        operationId: attempt.operationId,
      });
    },
  });
  assert.equal(result.reason, 'committed');
  assert.deepEqual(
    calls.map((command) => command.action),
    ['product-operation-start', 'product-operation-continue'],
  );
  assert.ok(calls.every((command) => command.operationId === attempt.operationId));
});

test('resuming a private scope queries it before continuing and never starts a replacement', async () => {
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    request: async (command) => {
      calls.push(structuredClone(command));
      return status(command.action === 'product-operation-get' ? 'saved' : 'complete');
    },
  });
  assert.equal(result.reason, 'committed');
  assert.deepEqual(
    calls.map((command) => command.action),
    ['product-operation-get', 'product-operation-continue'],
  );
  assert.ok(calls.every((command) => command.operationId === operationId));
});

const cursor = { imageId: 'shared', ledgerDigest: 'b'.repeat(64), nextOffset: 3 };
const approval = {
  revision: 'approved',
  configurations: { completed: 0, total: 0 },
  mediaReady: true,
  references: { prepared: true, staged: 0, total: 1 },
};
const staging = (extra = {}) => status('staging', { approval, ...extra });
function human(ready = false) {
  const progress = {
    jobId: 'c'.repeat(64),
    productId: 'p',
    state: ready ? 'completed' : 'queued',
    attempt: 0,
    leaseVersion: 0,
    leaseExpiresAt: 0,
    createdAt: at,
    updatedAt: at,
    media: { total: 1, checked: ready ? 1 : 0, verified: ready ? 1 : 0, invalid: 0, retry: 0 },
  };
  const report = ready
    ? {
        schemaVersion: 'catalog-preparation-report-v2',
        productId: 'p',
        inputDigest: 'd'.repeat(64),
        policyVersion: 'catalog-preparation-v1',
        contentGeneration: 0,
        checkedAt: at,
        state: 'ready',
        previewReady: true,
        mediaReady: true,
        issues: [],
        seal: {
          kind: 'catalog-preparation-ready-seal-v1',
          jobId: progress.jobId,
          receiptId: 'e'.repeat(64),
          planDigest: 'f'.repeat(64),
          imageIdsDigest: 'a'.repeat(64),
          imageCount: 1,
          mediaPolicyVersion: 'catalog-protected-media-seal-v1',
          pixelPolicyVersion: 'catalog-pixels-v1',
        },
      }
    : null;
  return {
    progress,
    current: true,
    report,
    attestation: ready ? { total: 1, checked: 1 } : null,
    nextAction: ready ? 'ready' : 'continue',
  };
}

for (const shape of ['complete', 'historical', 'cancelled', 'expired', 'changed'])
  test(`resuming ${shape} work never dispatches a new publication`, async () => {
    const value =
      shape === 'complete'
        ? status('complete')
        : shape === 'historical'
          ? status('complete', { current: false })
          : shape === 'cancelled'
            ? status('saved', { current: false, cancelledAt: at })
            : shape === 'expired'
              ? status('saved', { expired: true })
              : status('saved', { current: false });
    const calls: PublicationCommand[] = [];
    const result = await runPublication(scope, {
      request: async (command) => {
        calls.push(command);
        return value;
      },
    });
    assert.equal(
      result.reason,
      shape === 'complete'
        ? 'committed'
        : shape === 'historical'
          ? 'historical'
          : shape === 'cancelled'
            ? 'cancelled'
            : 'needs-action',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'product-operation-get');
  });

test('media waiting uses the standalone Human budget then resumes the same publication', async () => {
  let prepared = false;
  const commands: string[] = [];
  const result = await runPublication(scope, {
    now: () => 0,
    wait: async () => {},
    request: async (command) => {
      commands.push(command.action);
      assert.equal(command.operationId, operationId);
      if (command.action === 'product-operation-get')
        return commands.length === 1
          ? status('saved', { preparation: { nextAction: 'wait', job: null, progress: null } })
          : status();
      return prepared
        ? status('complete')
        : status('saved', { preparation: { nextAction: 'wait', job: null, progress: null } });
    },
    preparationRequest: async (command) => {
      commands.push(`human-${command.action}`);
      if (command.action === 'start') return { ok: true, progress: human().progress };
      assert.equal(command.action, 'continue');
      prepared = true;
      return { ok: true, status: human(true), followUp: 'none', invocation: 'acknowledged' };
    },
  });
  assert.equal(result.reason, 'committed');
  assert.equal(prepared, true);
  assert.equal(commands.filter((command) => command === 'product-operation-start').length, 0);
  assert.equal(commands.filter((command) => command === 'human-start').length, 1);
  assert.equal(commands.filter((command) => command === 'human-continue').length, 1);
  assert.equal(commands.at(-1), 'product-operation-continue');
});

for (const change of ['cancelled', 'edited', 'already-complete'])
  test(`a ${change} original scope stops standalone media dispatch`, async () => {
    let reads = 0;
    let humanWrites = 0;
    const result = await runPublication(scope, {
      request: async () => {
        reads++;
        return reads === 1
          ? status('saved', { preparation: { nextAction: 'wait', job: null, progress: null } })
          : change === 'cancelled'
            ? status('saved', { cancelledAt: at, current: false })
            : change === 'edited'
              ? status('saved', { current: false })
              : status('complete');
      },
      preparationRequest: async () => {
        humanWrites++;
        throw Error('must not prepare');
      },
    });
    assert.equal(humanWrites, 0);
    assert.equal(
      result.reason,
      change === 'cancelled' ? 'cancelled' : change === 'edited' ? 'needs-action' : 'committed',
    );
  });

for (const nextAction of ['retry', 'edit', 'repair'])
  test(`a ${nextAction} photo issue requires an explicit user action without a new job`, async () => {
    let humanWrites = 0;
    const result = await runPublication(scope, {
      request: async () =>
        status('saved', {
          preparation: {
            nextAction,
            job: nextAction === 'retry' ? { id: 'c'.repeat(64), leaseVersion: 1 } : null,
            progress: null,
          },
        }),
      preparationRequest: async () => {
        humanWrites++;
        throw Error('must not prepare');
      },
    });
    assert.equal(result.reason, 'needs-action');
    assert.equal(humanWrites, 0);
    assert.equal(result.scope.operationId, operationId);
  });

test('the server reference cursor is carried back to the same original continuation', async () => {
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    request: async (command) => {
      calls.push(structuredClone(command));
      return command.action === 'product-operation-get'
        ? staging({ referenceRecovery: { nextAction: 'wait', cursor } })
        : status('complete');
    },
  });
  assert.equal(result.reason, 'committed');
  assert.deepEqual(calls[1], {
    action: 'product-operation-continue',
    ...scope,
    referenceRecovery: cursor,
  });
});

test('a preserved reference checkpoint survives the initial resume query', async () => {
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    referenceRecovery: cursor,
    request: async (command) => {
      calls.push(structuredClone(command));
      return command.action === 'product-operation-get' ? staging() : status('complete');
    },
  });
  assert.equal(result.reason, 'committed');
  assert.deepEqual(calls[1], {
    action: 'product-operation-continue',
    ...scope,
    referenceRecovery: cursor,
  });
});

for (const code of ['CONFLICT', 'VALIDATION_ERROR', 'BUSY'])
  test(`a ${code} answer followed by a complete original receipt is committed, not guessed rejected`, async () => {
    const calls: PublicationCommand[] = [];
    const result = await runPublication(scope, {
      request: async (command) => {
        calls.push(command);
        if (command.action === 'product-operation-continue')
          throw new AdminApiError(code, 'response ambiguous');
        return calls.length === 1 ? status() : status('complete');
      },
    });
    assert.equal(result.reason, 'committed');
    assert.deepEqual(
      calls.map((command) => command.action),
      ['product-operation-get', 'product-operation-continue', 'product-operation-get'],
    );
  });

test('an explicit review issue retains private progress and original issues without replaying writes', async () => {
  const issue = {
    code: 'INVALID_VALUE' as const,
    stage: 'source' as const,
    path: 'description',
    severity: 'error' as const,
    remedy: 'review-change' as const,
  };
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    request: async (command) => {
      calls.push(command);
      if (command.action === 'product-operation-continue')
        throw new AdminApiError('VALIDATION_ERROR', 'Review changes', [issue]);
      return staging();
    },
  });
  assert.equal(result.reason, 'needs-action');
  assert.deepEqual(result.error?.issues, [issue]);
  assert.equal(result.status?.state, 'staging');
  assert.equal(calls.length, 3);
});

test('BUSY is queried before a bounded retry of the same scope', async () => {
  const calls: PublicationCommand[] = [];
  const waits: number[] = [];
  let writes = 0;
  const result = await runPublication(scope, {
    now: () => 0,
    wait: async (ms) => {
      waits.push(ms);
    },
    request: async (command) => {
      calls.push(structuredClone(command));
      if (command.action === 'product-operation-continue') {
        if (++writes === 1) throw new AdminApiError('BUSY', 'Retry');
        return status('complete');
      }
      return status();
    },
  });
  assert.equal(result.reason, 'committed');
  assert.deepEqual(
    calls.map((command) => command.action),
    [
      'product-operation-get',
      'product-operation-continue',
      'product-operation-get',
      'product-operation-continue',
    ],
  );
  assert.deepEqual(waits, [400]);
});

for (const code of ['UNAUTHORIZED', 'FORBIDDEN'])
  test(`losing ${code} after an issued continuation retains an unknown original outcome`, async () => {
    let calls = 0;
    const result = await runPublication(scope, {
      request: async (command) => {
        calls++;
        if (command.action === 'product-operation-continue')
          throw new AdminApiError(code, 'Sign in');
        return status();
      },
    });
    assert.equal(result.reason, 'unknown');
    assert.equal(result.error?.code, code);
    assert.equal(calls, 2);
    assert.equal(result.scope.operationId, operationId);
  });

test('unknown writes and failed confirmation keep the original scope without an extra mutation', async () => {
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    request: async (command) => {
      calls.push(command);
      if (calls.length === 1) return status();
      throw Error('unavailable');
    },
  });
  assert.equal(result.reason, 'unknown');
  assert.equal(calls.length, 3);
  assert.equal(
    calls.filter((command) => command.action === 'product-operation-continue').length,
    1,
  );
  assert.deepEqual(result.scope, scope);
});

test('four unchanged idle rounds pause with backoff and no replacement start', async () => {
  const calls: PublicationCommand[] = [];
  const waits: number[] = [];
  const result = await runPublication(scope, {
    now: () => 0,
    wait: async (ms) => {
      waits.push(ms);
    },
    request: async (command) => {
      calls.push(command);
      return status();
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(calls.length, 6);
  assert.deepEqual(waits, [200, 400, 800]);
  assert.ok(calls.every((command) => command.action !== 'product-operation-start'));
});

test('a moving private cursor still stops at the total request budget', async () => {
  let calls = 0;
  const result = await runPublication(scope, {
    now: () => 0,
    request: async () => {
      calls++;
      return staging({
        approval: {
          ...approval,
          configurations: { completed: calls, total: 500 },
          mediaReady: false,
          references: { prepared: false, staged: 0, total: 0 },
        },
      });
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(calls, 64);
  assert.equal(result.requests, 64);
});

test('time spent in requests consumes the original overall budget', async () => {
  let time = 0;
  let calls = 0;
  const result = await runPublication(scope, {
    now: () => time,
    request: async () => {
      time += 40000;
      calls++;
      return staging({
        approval: {
          ...approval,
          configurations: { completed: calls, total: 500 },
          mediaReady: false,
          references: { prepared: false, staged: 0, total: 0 },
        },
      });
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(calls, 3);
});

test('a presentation callback only receives a copy and cannot redirect the real scope', async () => {
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    onStatus: (value) => {
      Reflect.set(value, 'productId', 'other');
      Reflect.set(value, 'inputDigest', 'f'.repeat(64));
    },
    request: async (command) => {
      calls.push(command);
      return command.action === 'product-operation-get' ? status() : status('complete');
    },
  });
  assert.equal(result.reason, 'committed');
  assert.equal(result.scope.productId, 'p');
  assert.deepEqual(calls[1], { action: 'product-operation-continue', ...scope });
});

for (const mode of ['sync', 'undefined', 'async'])
  test(`a ${mode} presentation failure pauses before another backend write`, async () => {
    let calls = 0;
    const result = await runPublication(scope, {
      onStatus: () => {
        if (mode === 'async') return Promise.reject(Error('view failed'));
        if (mode === 'undefined') throw undefined;
        throw Error('view failed');
      },
      request: async () => {
        calls++;
        return status();
      },
    });
    assert.equal(result.reason, 'paused');
    assert.equal(calls, 1);
    assert.equal(result.observerFailed, true);
    assert.equal(result.status?.state, 'saved');
  });

test('abort releases an awaited presentation callback without starting a continuation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runPublication(scope, {
    signal: controller.signal,
    onStatus: () => {
      setImmediate(() => controller.abort(Error('stopped')));
      return new Promise<void>(() => {});
    },
    request: async () => {
      calls++;
      return status();
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(calls, 1);
});

for (const input of [null, [], { ...scope, actorId: 'other' }, { ...scope, operationId: 'bad' }])
  test(`invalid coordinator input ${JSON.stringify(input)} is refused before transport`, async () => {
    let calls = 0;
    await assert.rejects(
      runPublication(input, {
        request: async () => {
          calls++;
          return status();
        },
      }),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(calls, 0);
  });

test('an already aborted run makes no request and keeps the original scope', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runPublication(scope, {
    signal: controller.signal,
    request: async () => {
      calls++;
      return status();
    },
  });
  assert.equal(result.reason, 'paused');
  assert.equal(calls, 0);
  assert.deepEqual(result.scope, scope);
});

for (const field of ['productId', 'operationId', 'inputDigest'])
  test(`a mismatched ${field} cannot continue or count as committed`, async () => {
    let calls = 0;
    const result = await runPublication(scope, {
      request: async () => {
        calls++;
        return status('complete', {
          [field]:
            field === 'inputDigest'
              ? 'b'.repeat(64)
              : field === 'operationId'
                ? '22345678-1234-4234-8234-123456789012'
                : 'other',
        });
      },
    });
    assert.equal(result.reason, 'unknown');
    assert.equal(calls, 1);
    assert.deepEqual(result.scope, scope);
    assert.equal(result.status, undefined);
  });

test('a lost start followed by NOT_FOUND never starts a replacement', async () => {
  const attempt = createPublicationAttempt({
    productId: 'p',
    expectedUpdatedAt: at,
    values: { description: 'Draft' },
  });
  const calls: PublicationCommand[] = [];
  const result = await runPublication(attempt, {
    request: async (command) => {
      calls.push(command);
      if (command.action === 'product-operation-get')
        throw new AdminApiError('NOT_FOUND', 'Not found');
      throw Error('lost');
    },
  });
  assert.equal(result.reason, 'unknown');
  assert.equal(result.scope.operationId, attempt.operationId);
  assert.deepEqual(
    calls.map((x) => x.action),
    ['product-operation-start', 'product-operation-get'],
  );
});

test('a committed receipt survives a presentation failure and remains available for readback', async () => {
  const result = await runPublication(scope, {
    request: async () => status('complete'),
    onStatus: async () => {
      throw Error('storage full');
    },
  });
  assert.equal(result.reason, 'committed');
  assert.equal(result.observerFailed, true);
  assert.equal(result.status?.state, 'complete');
  assert.equal(result.requests, 1);
});

test('the next publication write waits until the status has been persisted', async () => {
  let release = () => {};
  let calls = 0;
  const persisted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = runPublication(scope, {
    request: async () => {
      calls++;
      return calls === 1 ? status() : status('complete');
    },
    onStatus: async (value) => {
      if (value.state === 'saved') await persisted;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.equal((await running).reason, 'committed');
  assert.equal(calls, 2);
});

test('a rejected callback after abort is consumed without an unhandled rejection', async () => {
  const controller = new AbortController();
  let rejectLate = (_reason: unknown) => {};
  const notification = new Promise<void>((_resolve, reject) => {
    rejectLate = reject;
  });
  const running = runPublication(scope, {
    signal: controller.signal,
    request: async () => status(),
    onStatus: () => notification,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await running).reason, 'paused');
  rejectLate(Error('late storage failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const initial of [
  status(),
  status('reserved'),
  staging({
    approval: {
      ...approval,
      mediaReady: false,
      references: { prepared: false, staged: 0, total: 0 },
    },
  }),
  staging({ approval: { ...approval, references: { prepared: true, staged: 1, total: 1 } } }),
])
  test(`a persisted reference cursor is dropped outside an unfinished reference page ${JSON.stringify(initial)}`, async () => {
    const calls: PublicationCommand[] = [];
    const result = await runPublication(scope, {
      referenceRecovery: cursor,
      request: async (command) => {
        calls.push(command);
        return calls.length === 1 ? initial : status('complete');
      },
    });
    assert.equal(result.reason, 'committed');
    assert.equal(Reflect.get(calls[1] ?? {}, 'referenceRecovery'), undefined);
    assert.equal(result.referenceRecovery, undefined);
  });

test('an unknown continuation discards the old reference cursor before reading back', async () => {
  const calls: PublicationCommand[] = [];
  let writes = 0;
  const result = await runPublication(scope, {
    referenceRecovery: cursor,
    request: async (command) => {
      calls.push(command);
      if (command.action === 'product-operation-continue') {
        if (++writes === 1) throw Error('lost');
        return status('complete');
      }
      return staging();
    },
  });
  assert.equal(result.reason, 'committed');
  const continuations = calls.filter((x) => x.action === 'product-operation-continue');
  assert.deepEqual(Reflect.get(continuations[0] ?? {}, 'referenceRecovery'), cursor);
  assert.equal(Reflect.get(continuations[1] ?? {}, 'referenceRecovery'), undefined);
});

test('a paused observer returns the last authoritative cursor as a recovery checkpoint', async () => {
  const result = await runPublication(scope, {
    request: async () => staging({ referenceRecovery: { nextAction: 'wait', cursor } }),
    onStatus: () => {
      throw Error('paused');
    },
  });
  assert.equal(result.reason, 'paused');
  assert.deepEqual(result.referenceRecovery, cursor);
});

for (const referenceRecovery of [
  { ...cursor, nextOffset: 80 },
  { ...cursor, ledgerDigest: 'bad' },
  { ...cursor, writeDelta: 1 },
])
  test(`an invalid reference checkpoint is rejected before transport ${JSON.stringify(referenceRecovery)}`, async () => {
    let calls = 0;
    await assert.rejects(
      runPublication(scope, {
        referenceRecovery,
        request: async () => {
          calls++;
          return status();
        },
      }),
      (error) => error instanceof AdminApiError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(calls, 0);
  });

test('a definite continuation failure discards the persisted reference cursor before its confirmation', async () => {
  let writes = 0;
  const calls: PublicationCommand[] = [];
  const result = await runPublication(scope, {
    referenceRecovery: cursor,
    now: () => 0,
    wait: async () => {},
    request: async (command) => {
      calls.push(structuredClone(command));
      if (command.action === 'product-operation-continue') {
        if (++writes === 1) throw new AdminApiError('BUSY', 'Prior progress uncertain');
        return status('complete');
      }
      return staging();
    },
  });
  assert.equal(result.reason, 'committed');
  const continuations = calls.filter((command) => command.action === 'product-operation-continue');
  assert.deepEqual(Reflect.get(continuations[0] ?? {}, 'referenceRecovery'), cursor);
  assert.equal(Reflect.get(continuations[1] ?? {}, 'referenceRecovery'), undefined);
});

test('an observer receives the effective recovery checkpoint even when a plain get omits its hint', async () => {
  let observed: unknown;
  const result = await runPublication(scope, {
    referenceRecovery: cursor,
    request: async () => staging(),
    onStatus: (_status, checkpoint) => {
      observed = structuredClone(checkpoint);
      throw Error('pause after persistence');
    },
  });
  assert.equal(result.reason, 'paused');
  assert.deepEqual(observed, { scope, referenceRecovery: cursor });
});
