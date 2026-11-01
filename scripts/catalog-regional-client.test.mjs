import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatalogRegionalClient } from './catalog-regional-client.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';

const runId = 'site-41300590230-1';
const codeSha = 'a'.repeat(40);
const guard = { targetId: 'b'.repeat(64), ownerRunId: runId, fence: 7, acquiredVersion: 3 };
const runnerRef = 'github:vibelingan/channel:41300590230:attempt-1';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-region-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const functions = new Map();
  const masks = [];
  const completed = (request) =>
    ({
      'delivery.check': { checked: true },
      'delivery.end': { ended: true },
      'delivery.accept': { accepted: request.input.pages?.length },
    })[request.action] ?? {};
  const f = { calls, functions, masks, directory, invoke: completed, deleted: [] };
  const manager = {
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    functions: {
      async listFunctions(limit, offset) {
        return [...functions.values()].slice(offset, offset + limit);
      },
      async createFunction({ func, force }) {
        calls.push(['create', func.name]);
        assert.equal(force, false);
        assert.equal(func.type, 'Event');
        assert.equal(func.timeout, 45);
        assert.equal(func.installDependency, false);
        functions.set(func.name, {
          FunctionName: func.name,
          Description: func.description,
          Type: func.type,
          Runtime: func.runtime,
          Handler: func.handler,
          Triggers: [],
          Status: 'Active',
          AvailableStatus: 'Available',
          Environment: {
            Variables: Object.entries(func.envVariables).map(([Key, Value]) => ({ Key, Value })),
          },
        });
        if (f.lostCreate) throw Error('transport closed after create');
      },
      async getFunctionDetail(name) {
        return functions.get(name);
      },
      async deleteFunction(name) {
        f.deleted.push(name);
        if (!f.keepAfterDelete) functions.delete(name);
        if (f.lostDelete) throw Error('transport closed after delete');
      },
      async invokeFunction(name, request) {
        calls.push(['invoke', request.action, request]);
        if (request.action === f.unknownAction) throw Error('response lost');
        const result = request.action === 'health' ? { codeSha, runId } : await f.invoke(request);
        return {
          RequestId: 'cloud-request',
          InvokeFinished: 1,
          RetCode: 0,
          RetMsg: JSON.stringify({
            purpose: 'catalog-seo-regional-v1',
            runId,
            codeSha,
            requestId: request.requestId,
            action: request.action,
            ok: true,
            result,
            ...(f.badEnvelope && request.action !== 'health' ? { codeSha: 'c'.repeat(40) } : {}),
          }),
        };
      },
    },
  };
  f.manager = manager;
  f.start = (overrides = {}) =>
    createCatalogRegionalClient({
      manager,
      policy,
      runId,
      codeSha,
      guard,
      runnerRef,
      directory,
      build: async (_dir, sha) => assert.equal(sha, codeSha),
      requestHash: () => 'd'.repeat(64),
      withLease: (operation) => operation(),
      wait: async () => {},
      mask: (value) => masks.push(value),
      onStatus: () => {},
      ...overrides,
    });
  f.receipt = async () => JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  return f;
}

test('readback keeps original task identity but owns a new temporary function and guard', async (t) => {
  const f = await fixture(t);
  const oldName = 'seo-catalog-region-41300590230-1';
  f.functions.set(oldName, { FunctionName: oldName, Description: 'retained original run' });
  const ownerRunId = 'readback-41303614689-2';
  f.invoke = (request) => {
    assert.equal(request.action, 'capture.read');
    assert.equal(request.runId, runId);
    assert.equal(request.guard.ownerRunId, ownerRunId);
    assert.deepEqual(request.input, {});
    return { writes: 0, heads: [] };
  };
  const client = await f.start({
    ownerRunId,
    guard: { ...guard, ownerRunId },
    runnerRef: 'github:vibelingan/channel:41303614689:attempt-2',
  });
  const capture = await client.capture({ detailEnabled: true });
  assert.equal(capture.writes, 0);
  assert.deepEqual(capture.heads, []);
  assert.equal(
    f.calls.some((call) => call[1] === 'prepare.step'),
    false,
  );
  await client.close();
  assert.deepEqual(f.deleted, ['seo-catalog-region-41303614689-2']);
  assert.equal(f.functions.has(oldName), true);
});

test('a guard for another operator cannot be reused by a readback runner', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.start({
      ownerRunId: 'readback-41303614689-2',
      guard,
      runnerRef: 'github:vibelingan/channel:41303614689:attempt-2',
    }),
  );
  await assert.rejects(
    f.start({
      ownerRunId: 'readback-41303614689-1',
      guard: { ...guard, ownerRunId: 'readback-41303614689-1' },
      runnerRef: 'github:vibelingan/channel:41303614689:attempt-2',
    }),
  );
  assert.equal(f.calls.length, 0);
});

test('accepted registration cleanup follows bounded cursors and preserves its sealed identity', async (t) => {
  const f = await fixture(t);
  const artifact = { artifactId: 123, codeSha };
  const acceptedSeal = { sha256: 'e'.repeat(64) };
  const states = ['leased', 'writing', 'needs-readback', 'control'];
  let index = 0;
  f.invoke = (request) => {
    assert.equal(request.action, 'registration.clear');
    assert.deepEqual(request.input, { artifact, acceptedSeal, state: states[index], cursor: null });
    index++;
    return {
      done: index === states.length,
      next: index === states.length ? null : { state: states[index], cursor: null },
      releasedTasks: index === 1 ? 2 : 0,
      controlReleased: index === states.length,
    };
  };
  const client = await f.start();
  let checkpoints = 0;
  assert.deepEqual(
    await client.clearAcceptedRegistration({
      artifact,
      acceptedSeal,
      checkpoint: async () => {
        checkpoints++;
      },
    }),
    { releasedTasks: 2, controlReleased: true },
  );
  assert.equal(index, 4);
  assert.equal(checkpoints, 5);
  await client.close();
});

const renderer = {
  codeSha: 'e'.repeat(40),
  manifestSha256: 'e'.repeat(64),
  archiveSha256: 'f'.repeat(64),
  archiveFileId: `cloud://${policy.envId}.private/renderer`,
  inputSchema: 1,
};
const activation = {
  artifact: { artifactId: '12345' },
  acceptedSeal: { seal: 'exact' },
  renderer,
  executorRef: 'feat/seo-foundation',
  expectedWrites: 9,
};
const active = {
  codeSha: renderer.codeSha,
  manifestSha256: renderer.manifestSha256,
  executorSha: codeSha,
  executorRef: activation.executorRef,
  acceptedRunId: runId,
  catalogTracked: true,
};
test('activation sends the fixed registration proof and validates every returned active field', async (t) => {
  const f = await fixture(t);
  f.invoke = (request) => {
    assert.equal(request.action, 'registration.activate');
    assert.deepEqual(request.input, activation);
    return { registered: true, active };
  };
  const client = await f.start();
  assert.deepEqual(await client.activateAcceptedRegistration(activation), {
    registered: true,
    active,
  });
  await client.close();
});
test('activation lost reply resolves only the original receipt and never submits a second activation', async (t) => {
  const f = await fixture(t);
  let original;
  f.invoke = (request) => {
    if (request.action === 'registration.activate') {
      original = request;
      throw Error('Reply lost after registration');
    }
    assert.equal(request.action, 'operation.get');
    assert.deepEqual(request.input, { requestId: original.requestId, inputHash: 'd'.repeat(64) });
    return {
      state: 'completed',
      receipt: { action: 'registration.activate', result: { registered: true, active } },
    };
  };
  const client = await f.start();
  assert.deepEqual(await client.activateAcceptedRegistration(activation), {
    registered: true,
    active,
  });
  assert.equal(f.calls.filter((call) => call[1] === 'registration.activate').length, 1);
  assert.equal((await f.receipt()).unconfirmed, false);
  await client.close();
});
test('a mismatched activation receipt retains its worker rather than accepting another program', async (t) => {
  const f = await fixture(t);
  f.invoke = (request) =>
    request.action === 'operation.get'
      ? {
          state: 'completed',
          receipt: {
            action: 'registration.activate',
            result: { registered: true, active: { ...active, acceptedRunId: 'site-99999999-1' } },
          },
        }
      : { registered: true, active: { ...active, codeSha: '0'.repeat(40) } };
  const client = await f.start();
  await assert.rejects(client.activateAcceptedRegistration(activation), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.deepEqual(f.deleted, []);
});

test('registration cleanup stops rather than accepting a repeated cursor or skipped state', async (t) => {
  for (const next of [
    { state: 'leased', cursor: null },
    { state: 'control', cursor: null },
  ]) {
    const f = await fixture(t);
    f.invoke = () => ({ done: false, next, releasedTasks: 0, controlReleased: false });
    const client = await f.start();
    await assert.rejects(client.clearAcceptedRegistration({ artifact: {}, acceptedSeal: {} }));
    assert.equal(f.calls.filter((call) => call[1] === 'registration.clear').length, 1);
    await client.close();
  }
});

test('regional lifecycle owns only its exact temporary function and leaves other apps alone', async (t) => {
  const f = await fixture(t);
  f.functions.set('admin', { FunctionName: 'admin', Description: 'business' });
  const client = await f.start();
  assert.equal(f.masks.length, 1);
  assert.match(f.masks[0], /^[a-f0-9]{64}$/);
  assert.equal((await f.receipt()).created, true);
  assert.equal(JSON.stringify(await f.receipt()).includes(f.masks[0]), false);
  await client.close();
  assert.deepEqual(f.deleted, ['seo-catalog-region-41300590230-1']);
  assert.equal(f.functions.has('admin'), true);
  assert.equal((await f.receipt()).cleaned, true);
  await client.close();
  assert.equal(f.deleted.length, 1);
});

test('every invocation and its receipt lookup stay inside the release owner lease boundary', async (t) => {
  const f = await fixture(t);
  const invoke = f.manager.functions.invokeFunction;
  let active = false;
  let boundaries = 0;
  f.manager.functions.invokeFunction = (...args) => {
    assert.equal(active, true);
    return invoke(...args);
  };
  const client = await f.start({
    withLease: async (operation) => {
      assert.equal(active, false);
      active = true;
      boundaries++;
      try {
        return await operation();
      } finally {
        active = false;
      }
    },
  });
  f.unknownAction = 'seed';
  f.invoke = (request) => {
    assert.equal(request.action, 'operation.get');
    return {
      state: 'completed',
      receipt: { action: 'seed', result: { queued: 1, preserved: 0, tracked: 0, upgraded: 0 } },
    };
  };
  await client.seed(['p1'], { detailEnabled: true });
  assert.equal(boundaries, 2);
  assert.equal(active, false);
  await client.close();
});

test('wrong target and occupied function fail before creation without deleting anything', async (t) => {
  const f = await fixture(t);
  f.manager.getManagerConfig = () => ({ envId: 'other', region: policy.region });
  await assert.rejects(f.start());
  assert.equal(f.calls.length, 0);
  f.manager.getManagerConfig = () => ({ envId: policy.envId, region: policy.region });
  f.functions.set('seo-catalog-region-41300590230-1', {
    FunctionName: 'seo-catalog-region-41300590230-1',
  });
  await assert.rejects(f.start(), /occupied/);
  assert.deepEqual(f.deleted, []);
});

test('omitting the lease boundary is rejected before any cloud operation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({ withLease: undefined }));
  assert.equal(f.calls.length, 0);
});

test('lost creation reply is read back once; creation is never repeated', async (t) => {
  const f = await fixture(t);
  f.lostCreate = true;
  const client = await f.start();
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 1);
  await client.close();
});

test('uncertain creation and unavailable inventory preserve its exact function and guard', async (t) => {
  const f = await fixture(t);
  f.lostCreate = true;
  const list = f.manager.functions.listFunctions;
  let lists = 0;
  f.manager.functions.listFunctions = (...args) => {
    if (++lists > 1) throw Error('inventory unavailable after creation');
    return list(...args);
  };
  await assert.rejects(f.start(), { code: 'CATALOG_REGIONAL_UNCONFIRMED' });
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(f.functions.has('seo-catalog-region-41300590230-1'), true);
  assert.deepEqual(f.deleted, []);
  assert.equal((await f.receipt()).unconfirmed, true);
});

test('unconfirmed invocation preserves the function and records the exact request without credentials', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.unknownAction = 'seed';
  await assert.rejects(client.seed(['p1'], { detailEnabled: true }), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.deepEqual(f.deleted, []);
  const receipt = await f.receipt();
  assert.equal(receipt.calls.at(-1).action, 'seed');
  assert.equal(receipt.calls.at(-1).state, 'unconfirmed');
  assert.equal(JSON.stringify(receipt).includes(f.masks[0]), false);
  await assert.rejects(client.seed(['p2'], { detailEnabled: true }), /needs readback/);
});

test('a response from another source is not accepted as a completed operation', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.badEnvelope = true;
  await assert.rejects(client.seed(['p1'], { detailEnabled: true }), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  await client.close();
  assert.deepEqual(f.deleted, []);
});

test('a lost reply uses the atomic result receipt without invoking the mutation twice', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.unknownAction = 'seed';
  f.invoke = (request) => {
    assert.equal(request.action, 'operation.get');
    assert.equal(request.input.inputHash, 'd'.repeat(64));
    return {
      state: 'completed',
      receipt: { action: 'seed', result: { queued: 1, preserved: 0, tracked: 0, upgraded: 0 } },
    };
  };
  const result = await client.seed(['p1'], { detailEnabled: true });
  assert.equal(result.queued, 1);
  assert.equal(f.calls.filter((c) => c[1] === 'seed').length, 1);
  assert.equal(f.calls.filter((c) => c[1] === 'operation.get').length, 1);
  assert.equal(client.unconfirmed, false);
  await client.close();
  assert.equal((await f.receipt()).cleaned, true);
});

test('a partial or mismatched result never confirms a lost invocation', async (t) => {
  for (const observed of [
    { state: 'partial' },
    { state: 'completed', receipt: { action: 'delivery.begin', result: {} } },
  ]) {
    const f = await fixture(t);
    const client = await f.start();
    f.unknownAction = 'seed';
    f.invoke = () => observed;
    await assert.rejects(client.seed(['p1'], { detailEnabled: true }), {
      code: 'CATALOG_REGIONAL_UNCONFIRMED',
    });
    await client.close();
    assert.deepEqual(f.deleted, []);
  }
});

test('lost deletion acknowledgement is confirmed by complete inventory', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.lostDelete = true;
  await client.close();
  assert.equal((await f.receipt()).cleaned, true);
});

test('acknowledged deletion still present is reported rather than called clean', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.keepAfterDelete = true;
  await assert.rejects(client.close(), /not confirmed/);
  assert.equal((await f.receipt()).cleaned, false);
});

test('prepare retains captured versions, verifies ticket ownership and registers two pages per atomic call', async (t) => {
  const f = await fixture(t);
  const heads = Array.from({ length: 5 }, (_, n) => ({
    siteOrigin: policy.siteOrigin,
    productId: `p${n}`,
  }));
  let steps = 0;
  f.invoke = (request) => {
    if (request.action === 'prepare.step')
      return ++steps === 1 ? { ready: false, processed: 4 } : { ready: true, writes: 9, heads };
    if (request.action === 'delivery.begin')
      return {
        expectedHeads: heads,
        ticket: { owner: `${runId}:ticket`, fence: 1, products: request.input.products },
      };
    return (
      {
        'delivery.check': { checked: true },
        'delivery.end': { ended: true },
        'delivery.accept': { accepted: request.input.pages?.length },
      }[request.action] ?? {}
    );
  };
  const client = await f.start();
  const catalog = await client.prepare({ detailEnabled: true });
  assert.equal(steps, 2);
  assert.equal(catalog.writes, 9);
  assert.throws(() =>
    catalog.delivery.primeExpectedHeads([{ ...heads[0], siteOrigin: 'https://wrong.example' }]),
  );
  await assert.rejects(catalog.delivery.end({ owner: 'someone' }, 'verified'), /Unknown/);
  catalog.delivery.primeExpectedHeads(heads);
  const ticket = await catalog.delivery.begin(heads.map((h) => h.productId));
  await catalog.delivery.end(ticket, 'verified');
  await assert.rejects(catalog.delivery.end(ticket, 'verified'), /Unknown/);
  await catalog.delivery.accept(
    heads.map((h) => ({ productId: h.productId, htmlSha256: 'e'.repeat(64) })),
  );
  const accepts = f.calls.filter((c) => c[1] === 'delivery.accept').map((c) => c[2].input);
  assert.deepEqual(
    accepts.map((input) => input.pages.length),
    [2, 2, 1],
  );
  assert.deepEqual(
    accepts.flatMap((input) => input.expectedHeads),
    heads,
  );
  client.setGuard({ ...guard, fence: 8, acquiredVersion: 4 });
  await catalog.delivery.check();
  assert.equal(f.calls.at(-1)[2].guard.fence, 8);
  await client.close();
});

test('bootstrap deduplicates IDs and advances only after each bounded seed finishes', async (t) => {
  const f = await fixture(t);
  f.invoke = (request) => ({
    queued: request.input.productIds.length,
    preserved: 0,
    tracked: 0,
    upgraded: 0,
  });
  const client = await f.start();
  const ids = Array.from({ length: 33 }, (_, n) => `p${n}`);
  assert.equal((await client.seed([...ids, 'p0'], { detailEnabled: true })).queued, 33);
  assert.deepEqual(
    f.calls.filter((c) => c[1] === 'seed').map((c) => c[2].input.productIds.length),
    [16, 16, 1],
  );
  await client.close();
});

test('failed-delivery recovery exposes one checked page and preserves its exact proof', async (t) => {
  const f = await fixture(t);
  const input = {
    stoppedRunId: 'site-41000000000-1',
    stepId: 'old-step',
    beginRequestId: 'old-begin',
    endRequestId: 'old-end',
    originalWrites: 7,
    state: 'writing',
    cursor: null,
  };
  f.invoke = (request) => {
    assert.equal(request.action, 'recovery.clear');
    assert.deepEqual(request.input, input);
    return {
      done: false,
      next: { state: 'writing', cursor: 'f'.repeat(64) },
      releasedTasks: 2,
      controlReleased: false,
    };
  };
  const client = await f.start();
  assert.equal((await client.recoverStoppedDeliveryStep(input)).releasedTasks, 2);
  assert.equal(f.calls.filter((call) => call[1] === 'recovery.clear').length, 1);
  await client.close();
});
test('a recovery page cannot skip stages or claim an early control release', async (t) => {
  const f = await fixture(t);
  f.invoke = (request) =>
    request.action === 'operation.get'
      ? { state: 'not-found' }
      : {
          done: false,
          next: { state: 'control', cursor: null },
          releasedTasks: 2,
          controlReleased: true,
        };
  const client = await f.start();
  await assert.rejects(client.recoverStoppedDeliveryStep({ state: 'leased', cursor: null }), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.equal(f.deleted.length, 0);
});
