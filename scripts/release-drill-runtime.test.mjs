import assert from 'node:assert/strict';
import test from 'node:test';
import { createDummyInvoker, readDummyInvocation } from './release-drill/runtime.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'vibelingan/channel',
  GITHUB_REF: 'refs/heads/feat/seo-foundation',
  GITHUB_JOB: 'drill',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  TCB_ENV_ID: 'diversity-123-d9grnqfux221323bb',
  CLOUDBASE_REGION: 'ap-shanghai',
  SITE_URL: 'https://supplychainsai.com',
  DUMMY_RECOVERY_CONFIRM: 'ISOLATED_RECOVERY_ONLY',
};
test('the real drill has a fixed repository, branch, environment, job and confirmation', () => {
  assert.equal(readDummyInvocation(env).runId, '123');
  for (const key of Object.keys(env))
    assert.throws(() => readDummyInvocation({ ...env, [key]: 'wrong' }), key);
});
test('dummy RPC never accepts a platform acknowledgement as business success or leaks its token', async () => {
  let request;
  let response = {
    RequestId: 'platform-request',
    RetMsg: JSON.stringify({
      purpose: 'channel-recovery-dummy-v1',
      version: 'A',
      codeSha: env.GITHUB_SHA,
      runId: '123',
    }),
  };
  const manager = {
    getManagerConfig: () => ({ envId: env.TCB_ENV_ID, region: 'ap-shanghai' }),
    functions: {
      async invokeFunction(name, input) {
        request = { name, input };
        return response;
      },
    },
  };
  const invoke = createDummyInvoker({ manager, token: 'f'.repeat(64) });
  assert.equal((await invoke({ action: 'health' })).version, 'A');
  assert.equal(request.name, 'seo-release-dummy');
  assert.equal(request.input.token, 'f'.repeat(64));
  for (const bad of [
    { RequestId: 'ack' },
    { ...response, RetCode: 1 },
    { ...response, InvokeFinished: 0 },
    { ...response, ErrMsg: 'runtime failed' },
    { ...response, RetMsg: 'not json' },
  ]) {
    response = bad;
    await assert.rejects(invoke({ action: 'health' }));
  }
  await assert.rejects(invoke({ action: 'health', token: 'override' }));
});
