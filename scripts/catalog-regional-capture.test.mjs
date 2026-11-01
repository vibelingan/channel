import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { captureCatalogRegionalInput } from './catalog-regional-capture.mjs';
import { createCatalogRegionalClient } from './catalog-regional-client.mjs';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { clock, composition, plan, policy, receipt, stepInput } from './release-state-fixtures.mjs';
import { SITE_DELIVERY_POLICY as livePolicy } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { sealCatalogBuildInput } = tsxRequire('./catalog-build-input.ts', import.meta.url);

const runId = 'site-41300590230-1';
const owner = { ownerRunId: runId, runnerRef: 'github:vibelingan/channel:41300590230:attempt-1' };
const config = { siteOrigin: policy.siteOrigin, detailEnabled: true };

async function fixture(t) {
  const database = cloudbaseFixture(t);
  const time = clock();
  const actual = createReleaseCoordinator({ store: database.store, policy, clock: time.now });
  const guard = await actual.acquire({ ownerRunId: 'accepted', runnerRef: 'previous-runner' });
  await actual.startRun({
    guard,
    runId: 'accepted',
    scopeKey: 'site',
    kind: 'adopt',
    plan: plan(1),
    composition: composition(),
  });
  const step = await actual.beginStep({ guard, runId: 'accepted', ...stepInput('accept') });
  await actual.confirmStep({
    guard,
    runId: 'accepted',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  await actual.commitRun({ guard, runId: 'accepted', changeSetRef: 'accepted fixture' });
  const baseline = (await actual.status()).scope.baseline;
  const events = [];
  const capture = { writes: 4, heads: [] };
  const f = {
    actual,
    database,
    time,
    events,
    baseline,
    capture,
    failRenewal: false,
    changed: false,
  };
  const coordinator = {
    acquire: async (value) => {
      events.push('acquire');
      return actual.acquire(value);
    },
    renew: async (value) => {
      events.push('renew');
      if (f.failRenewal) throw Error('PRIVATE_LEASE_ERROR');
      return actual.renew(value);
    },
    release: async (value) => {
      events.push('release');
      return actual.release(value);
    },
    status: async () => {
      const status = await actual.status();
      return f.changed
        ? {
            ...status,
            scope: {
              ...status.scope,
              baseline: { ...status.scope.baseline, sourceRunId: 'changed' },
            },
          }
        : status;
    },
  };
  const client = {
    unconfirmed: false,
    prepare: async (value) => {
      assert.deepEqual(value, config);
      events.push('prepare');
      return structuredClone(capture);
    },
    close: async () => {
      events.push('close-confirmed');
      return { cleaned: true, unconfirmed: false };
    },
  };
  f.coordinator = coordinator;
  f.client = client;
  f.run = (collect, overrides = {}) =>
    captureCatalogRegionalInput({
      coordinator,
      owner,
      config,
      collect,
      createClient: async (value) => {
        assert.equal(value.ownerRunId, runId);
        events.push('create');
        return client;
      },
      schedule: (callback, ms) => {
        assert.equal(ms, 30000);
        f.tick = callback;
        return 'timer';
      },
      cancel: (timer) => {
        assert.equal(timer, 'timer');
        events.push('timer-stopped');
      },
      ...overrides,
    });
  return f;
}

test('normal capture uses the installed SDK lease, prepares both sides and confirms cleanup before release', async (t) => {
  const f = await fixture(t);
  const result = await f.run(async ({ baseline, checkpoint }) => {
    assert.deepEqual(baseline, f.baseline);
    f.events.push('public-api');
    await f.tick();
    await checkpoint();
    return { source: 'fresh', bytes: 'unchanged snapshot' };
  });
  assert.deepEqual(result.before, f.capture);
  assert.deepEqual(result.after, f.capture);
  assert.deepEqual(result.value, { source: 'fresh', bytes: 'unchanged snapshot' });
  assert.equal(f.events.filter((event) => event === 'prepare').length, 2);
  assert.ok(f.events.indexOf('close-confirmed') < f.events.indexOf('release'));
  const status = await f.actual.status();
  assert.equal(status.state, 'idle');
  assert.deepEqual(status.scope.baseline, f.baseline);
  assert.ok(f.database.calls.some((call) => call.action === 'database.modifyDocument'));
  assert.ok(
    f.database.calls.every(
      (call) =>
        !call.params.collectionName ||
        /^siteRelease(?:Targets|Scopes|Runs|Steps)$/.test(call.params.collectionName),
    ),
  );
});

test('a public API failure still confirms its own cleanup and releases its lease', async (t) => {
  const f = await fixture(t);
  const apiFailure = Error('Public API capture failed');
  await assert.rejects(
    f.run(async () => {
      throw apiFailure;
    }),
    (error) => error === apiFailure,
  );
  assert.equal(f.events.filter((event) => event === 'prepare').length, 1);
  assert.ok(f.events.indexOf('close-confirmed') < f.events.indexOf('release'));
  assert.equal((await f.actual.status()).state, 'idle');
});

test('a product change during API capture still fails the original build seal after safe cleanup', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.client.prepare = async () => ({ writes: ++calls === 1 ? 4 : 5, heads: [] });
  const captured = await f.run(async () => 'snapshot');
  assert.equal((await f.actual.status()).state, 'idle');
  assert.throws(
    () =>
      sealCatalogBuildInput({
        config,
        source: 'fresh',
        before: captured.before,
        after: captured.after,
        snapshot: Buffer.from('snapshot'),
      }),
    /Products changed while collecting/,
  );
});

test('an unknown regional operation preserves both its function and this lease', async (t) => {
  const f = await fixture(t);
  f.client.prepare = async () => {
    f.client.unconfirmed = true;
    throw Object.assign(Error('Readback required'), { code: 'CATALOG_REGIONAL_UNCONFIRMED' });
  };
  await assert.rejects(
    f.run(async () => {
      assert.fail('No API capture after an unknown operation');
    }),
    { code: 'CATALOG_REGIONAL_UNCONFIRMED' },
  );
  assert.equal(f.events.includes('close-confirmed'), false);
  assert.equal(f.events.includes('release'), false);
  assert.equal((await f.actual.status()).target.lease.ownerRunId, runId);
});

test('renewal failure prevents after-capture and sealing even if the public API succeeds', async (t) => {
  const f = await fixture(t);
  let sealed = false;
  await assert.rejects(
    f
      .run(async () => {
        f.failRenewal = true;
        await f.tick();
        return 'API succeeded';
      })
      .then(() => {
        sealed = true;
      }),
    { code: 'CATALOG_CAPTURE_LEASE_LOST' },
  );
  assert.equal(sealed, false);
  assert.equal(f.events.filter((event) => event === 'prepare').length, 1);
  assert.equal(f.events.includes('release'), false);
});

test('unconfirmed cleanup never releases the publishing lease or exposes its SDK error', async (t) => {
  const f = await fixture(t);
  f.client.close = async () => {
    throw Error('PRIVATE_MANAGER_TOKEN');
  };
  const error = await f.run(async () => 'snapshot').catch((value) => value);
  assert.equal(error.code, 'CATALOG_CAPTURE_CLEANUP_UNCONFIRMED');
  assert.equal(String(error).includes('PRIVATE_MANAGER_TOKEN'), false);
  assert.equal(f.events.includes('release'), false);
  assert.equal((await f.actual.status()).target.lease.ownerRunId, runId);
});

test('unconfirmed creation does not repeat creation, clean an unproven function or release its lease', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const error = await f
    .run(async () => assert.fail('No capture after unknown creation'), {
      createClient: async () => {
        attempts++;
        throw Error('PRIVATE_CREATION_TOKEN');
      },
    })
    .catch((value) => value);
  assert.equal(attempts, 1);
  assert.equal(error.code, 'CATALOG_REGIONAL_UNCONFIRMED');
  assert.equal(String(error).includes('PRIVATE_CREATION_TOKEN'), false);
  assert.equal(f.events.includes('close-confirmed'), false);
  assert.equal(f.events.includes('release'), false);
});

test('cleanup waits for an already running renewal before releasing the lease', async (t) => {
  const f = await fixture(t);
  let releaseRenewal = () => {};
  const hold = new Promise((resolve) => {
    releaseRenewal = resolve;
  });
  const renew = f.coordinator.renew;
  let blocked = false;
  f.coordinator.renew = async (guard) => {
    if (blocked) await hold;
    return renew(guard);
  };
  const apiFailure = Error('API interrupted');
  let tick;
  const outcome = f
    .run(async () => {
      blocked = true;
      tick = f.tick();
      throw apiFailure;
    })
    .catch((error) => error);
  try {
    await nextTurn();
    assert.equal(f.events.includes('close-confirmed'), true);
    assert.equal(f.events.includes('release'), false);
  } finally {
    releaseRenewal();
  }
  assert.equal(await outcome, apiFailure);
  await tick;
  assert.equal((await f.actual.status()).state, 'idle');
});

test('real regional client confirms deletion through management readback before a same-name later session', async (t) => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'catalog-capture-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const other = { FunctionName: 'existing-other-app', Description: 'unrelated' };
  const functions = new Map([[other.FunctionName, other]]);
  let deleting;
  let readbacks = 0;
  let creates = 0;
  const manager = {
    getManagerConfig: () => ({ envId: livePolicy.envId, region: livePolicy.region }),
    functions: {
      listFunctions: async (limit, offset) => {
        if (deleting && ++readbacks === 2) {
          functions.delete(deleting);
          f.events.push('function-deletion-readback');
          deleting = undefined;
        }
        return [...functions.values()].slice(offset, offset + limit);
      },
      createFunction: async ({ func, force }) => {
        assert.equal(force, false);
        assert.equal(functions.has(func.name), false);
        creates++;
        functions.set(func.name, {
          FunctionName: func.name,
          Description: func.description,
          Runtime: func.runtime,
          Type: func.type,
          Handler: func.handler,
          Triggers: [],
          Status: 'Active',
          AvailableStatus: 'Available',
          Environment: {
            Variables: Object.entries(func.envVariables).map(([Key, Value]) => ({ Key, Value })),
          },
        });
      },
      getFunctionDetail: async (name) => functions.get(name),
      deleteFunction: async (name) => {
        assert.equal(name, `seo-catalog-region-${runId.slice(5)}`);
        deleting = name;
        readbacks = 0;
      },
      invokeFunction: async (_name, request) => {
        const result =
          request.action === 'health'
            ? { codeSha: 'a'.repeat(40), runId }
            : { ready: true, writes: 4, heads: [] };
        return {
          RequestId: 'offline-manager',
          InvokeFinished: 1,
          RetCode: 0,
          RetMsg: JSON.stringify({
            purpose: 'catalog-seo-regional-v1',
            codeSha: 'a'.repeat(40),
            runId,
            requestId: request.requestId,
            action: request.action,
            ok: true,
            result,
          }),
        };
      },
    },
  };
  const start = (guard) =>
    createCatalogRegionalClient({
      manager,
      policy: livePolicy,
      runId,
      codeSha: 'a'.repeat(40),
      runnerRef: owner.runnerRef,
      guard,
      directory,
      requestHash: () => 'b'.repeat(64),
      build: async () => {},
      wait: async () => {},
      mask: () => {},
      onStatus: () => {},
    });
  await f.run(async () => ({ source: 'accepted' }), { createClient: start });
  assert.ok(f.events.indexOf('function-deletion-readback') < f.events.indexOf('release'));
  assert.equal(functions.size, 1);
  assert.deepEqual(functions.get(other.FunctionName), other);
  const nextGuard = await f.actual.acquire(owner);
  const next = await start(nextGuard);
  await next.close();
  await f.actual.release(nextGuard);
  assert.equal(creates, 2);
  assert.deepEqual(functions.get(other.FunctionName), other);
});

test('a changed accepted baseline stops the capture and is never released as this session', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run(async () => {
      f.changed = true;
      return 'snapshot';
    }),
    { code: 'CATALOG_CAPTURE_BASELINE_CHANGED' },
  );
  assert.equal(f.events.includes('release'), false);
});
