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
  f.start = () =>
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
      wait: async () => {},
      mask: (value) => masks.push(value),
      onStatus: () => {},
    });
  f.receipt = async () => JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  return f;
}

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

test('lost creation reply is read back once; creation is never repeated', async (t) => {
  const f = await fixture(t);
  f.lostCreate = true;
  const client = await f.start();
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 1);
  await client.close();
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
