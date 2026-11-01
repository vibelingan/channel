import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { createReleaseRegionalClient } from './release-regional-client.mjs';
import { createReleaseRegionalHandler } from './release/regional-coordinator.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';

const ownerRunId = 'site-41313740695-1';
const runnerRef = 'github:vibelingan/channel:41313740695:attempt-1';
const codeSha = 'b'.repeat(40);
async function fixture(t) {
  const wire = cloudbaseFixture(t);
  wire.db.config.env = policy.envId;
  const directory = await mkdtemp(join(tmpdir(), 'release-region-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const functions = new Map();
  const calls = [];
  const f = { ...wire, directory, functions, calls, deleted: [] };
  const manager = {
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    functions: {
      listFunctions: async (limit, offset) => [...functions.values()].slice(offset, offset + limit),
      async createFunction({ func, force }) {
        assert.equal(force, false);
        assert.equal(func.type, 'Event');
        const vars = func.envVariables;
        f.handler = createReleaseRegionalHandler(
          {
            envId: vars.TCB_ENV,
            targetId: vars.RELEASE_REGIONAL_TARGET_ID,
            ownerRunId,
            runnerRef,
            codeSha,
            tokenDigest: vars.RELEASE_REGIONAL_TOKEN_DIGEST,
          },
          {
            createDatabase: () => wire.db,
            onStatus: () => {},
          },
        );
        functions.set(func.name, {
          FunctionName: func.name,
          Description: func.description,
          Type: func.type,
          Runtime: func.runtime,
          Handler: func.handler,
          Triggers: [],
          Status: 'Active',
          AvailableStatus: 'Available',
          Environment: { Variables: Object.entries(vars).map(([Key, Value]) => ({ Key, Value })) },
        });
        if (f.lostCreate) throw Error('secret create response');
      },
      getFunctionDetail: async (name) => functions.get(name),
      async deleteFunction(name) {
        f.deleted.push(name);
        if (!f.keepFunction) functions.delete(name);
        if (f.lostDelete) throw Error('secret delete response');
      },
      async invokeFunction(name, request) {
        calls.push(request.method);
        if (f.failBeforeInvoke === request.method)
          throw Object.assign(Error('secret timeout'), { code: 'ETIMEDOUT' });
        const result = await f.handler(request);
        if (f.loseReply === request.method) {
          f.loseReply = null;
          throw Error('secret transport error');
        }
        if (f.loseReadback && request.method === 'operation.get')
          throw Error('secret readback error');
        if (f.badReadbackResult && request.method === 'operation.get' && result.ok)
          result.result.result = { ...result.result.result, ownerRunId: 'other-owner' };
        return {
          RequestId: 'cloud-request',
          RetCode: 0,
          InvokeFinished: 1,
          RetMsg: JSON.stringify(
            f.badEnvelope && request.method !== 'health'
              ? { ...result, codeSha: 'c'.repeat(40) }
              : result,
          ),
        };
      },
    },
  };
  f.start = (overrides = {}) =>
    createReleaseRegionalClient({
      manager,
      policy,
      ownerRunId,
      runnerRef,
      codeSha,
      directory,
      build: async () => {},
      wait: async () => {},
      mask: () => {},
      onStatus: () => {},
      ...overrides,
    });
  return f;
}

test('lost reply is resolved from the atomic receipt without resubmitting the lease write', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  const guard = await client.coordinator.acquire({ ownerRunId, runnerRef });
  assert.equal(guard.fence, 1);
  assert.equal(f.calls.filter((method) => method === 'acquire').length, 1);
  assert.equal(f.calls.filter((method) => method === 'operation.get').length, 1);
  await client.coordinator.release(guard);
  await client.close();
  assert.deepEqual(f.deleted, ['seo-release-region-41313740695-1']);
  assert.equal(client.unconfirmed, false);
});

test('unconfirmed mutation retains the function and rejects every following coordinator command', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  f.loseReadback = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  const count = f.calls.length;
  await assert.rejects(client.coordinator.status());
  assert.equal(f.calls.length, count);
  assert.deepEqual(await client.close(), { cleaned: false, unconfirmed: true });
  assert.equal(f.deleted.length, 0);
  const evidence = await readFile(join(f.directory, 'result.json'), 'utf8');
  assert.doesNotMatch(evidence, /secret|tokenDigest|"token"/);
  assert.equal(JSON.parse(evidence).unconfirmed, true);
});

test('an absent receipt after transport failure does not authorize replaying the write', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.failBeforeInvoke = 'acquire';
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), (cause) => {
    assert.equal(cause.code, 'RELEASE_REGIONAL_UNCONFIRMED');
    assert.equal(cause.sdkCode, 'ETIMEDOUT');
    assert.doesNotMatch(cause.message, /secret/);
    return true;
  });
  assert.equal(f.calls.filter((method) => method === 'acquire').length, 1);
  assert.equal(f.rows.size, 0);
  assert.equal((await client.close()).cleaned, false);
});

test('safe status can be read again after a lost reply without creating mutation receipts', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'status';
  assert.equal((await client.coordinator.status({})).state, 'uninitialized');
  assert.equal(f.calls.filter((method) => method === 'status').length, 2);
  assert.equal(f.rows.size, 0);
  await client.close();
});

test('an invocation with the wrong runtime source identity is never accepted', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.badEnvelope = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.equal((await client.close()).cleaned, false);
});

test('lost create and delete replies are resolved only by exact owned inventory readback', async (t) => {
  const f = await fixture(t);
  f.lostCreate = true;
  f.lostDelete = true;
  const client = await f.start();
  assert.deepEqual(await client.close(), { cleaned: true, unconfirmed: false });
  assert.equal(f.functions.size, 0);
});

test('an occupied or foreign function is never replaced or deleted', async (t) => {
  const f = await fixture(t);
  const name = 'seo-release-region-41313740695-1';
  f.functions.set(name, { FunctionName: name, Description: 'another app' });
  await assert.rejects(f.start(), { code: 'RELEASE_REGIONAL_PREPARATION_FAILED' });
  assert.equal(f.functions.get(name).Description, 'another app');
  assert.deepEqual(f.deleted, []);
});

test('cleanup uncertainty is explicit and retains the original function', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.keepFunction = true;
  await assert.rejects(client.close(), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal(client.unconfirmed, true);
  assert.equal(f.functions.size, 1);
});

test('another owner or cloud environment is rejected before function creation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({ ownerRunId: 'site-41313740696-1' }));
  await assert.rejects(f.start({ policy: { ...policy, envId: 'other-env' } }));
  assert.equal(f.functions.size, 0);
});

test('a receipt result must pass the same guard checks as a normal response', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  f.loseReply = 'acquire';
  f.badReadbackResult = true;
  await assert.rejects(client.coordinator.acquire({ ownerRunId, runnerRef }), {
    code: 'RELEASE_REGIONAL_UNCONFIRMED',
  });
  assert.equal(client.unconfirmed, true);
  assert.equal((await client.close()).cleaned, false);
});
