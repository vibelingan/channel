import assert from 'node:assert/strict';
import test from 'node:test';
import { functionManagerFixture, functionZip } from './release-function-manager-fixture.mjs';
import { checkFunctionArchive, functionZipLimit } from './release/function-archive.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { sha256 } from './release/input.mjs';
const target = { envId: 'fixture-env', siteOrigin: 'https://fixture.example' };
const setup = () => {
  const f = functionManagerFixture();
  return {
    ...f,
    provider: createCloudbaseFunctionProvider({
      ...f,
      target,
      region: 'ap-shanghai',
      names: ['public-api'],
    }),
  };
};

test('actual SDK receives the exact archived ZIP, handler, environment and disabled dependency installation', async () => {
  const f = setup();
  const before = await f.provider.read('public-api');
  const bytes = functionZip('exports.main = async () => 42;');
  const result = await f.provider.updateCode({
    name: 'public-api',
    runtime: 'Nodejs20.19',
    handler: 'index.main',
    bytes,
    sha256: sha256(bytes),
    expectedSnapshot: before,
  });
  assert.equal(result.providerOperationId, 'update-code');
  assert.equal(f.state.updates, 1);
  const call = f.state.calls.find((x) => x.action === 'UpdateFunctionCode');
  assert.equal(call.payload.EnvId, 'fixture-env');
  assert.equal(call.payload.Handler, 'index.main');
  assert.equal(call.payload.InstallDependency, 'FALSE');
  assert.deepEqual(Buffer.from(call.payload.Code.ZipFile, 'base64'), bytes);
  assert.equal(Object.hasOwn(call.payload, 'Environment'), false);
  const after = await f.provider.read('public-api');
  assert.equal(after.packageSha256, sha256(bytes));
  assert.equal(after.configurationToken, before.configurationToken);
  assert.equal(after.installDependency, 'FALSE');
  assert(!JSON.stringify(after).includes('sdk-fixture-secret'));
  assert(!JSON.stringify(after).includes('fixture-private-signature'));
});

for (const [name, change] of [
  [
    'other environment',
    (f) => {
      f.state.envId = 'other-env';
    },
  ],
  [
    'other namespace',
    (f) => {
      f.state.namespace = 'other-env';
    },
  ],
  [
    'unsupported backend',
    (f) => {
      f.state.backend = 'cbf';
    },
  ],
  [
    'wrong function',
    (f) => {
      f.state.detail.FunctionName = 'admin';
    },
  ],
  [
    'protected code',
    (f) => {
      f.state.detail.CodeSecret = 'protected';
    },
  ],
  [
    'masked variables',
    (f) => {
      f.state.detail.Environment.Variables[0].Value = '***';
    },
  ],
  [
    'existing trigger',
    (f) => {
      f.state.detail.Triggers = [{ Name: 'timer' }];
    },
  ],
  [
    'unreviewed VPC',
    (f) => {
      f.state.detail.VpcConfig = { VpcId: 'vpc-1', SubnetId: 'subnet-1' };
    },
  ],
])
  test(`SDK port refuses ${name}`, async () => {
    const f = setup();
    change(f);
    await assert.rejects(f.provider.read('public-api'));
    assert.equal(f.state.updates, 0);
  });

test('foreign region and function names fail before a mutation', async () => {
  const f = setup();
  assert.throws(() =>
    createCloudbaseFunctionProvider({ ...f, target, region: 'ap-shanghai', names: [] }),
  );
  await assert.rejects(f.provider.read('admin'));
  const p = createCloudbaseFunctionProvider({
    ...f,
    target,
    region: 'ap-singapore',
    names: ['public-api'],
  });
  await assert.rejects(p.read('public-api'));
  assert.equal(f.state.updates, 0);
});

test('configuration or code drift before submission is not overwritten', async () => {
  const f = setup();
  const before = await f.provider.read('public-api');
  const bytes = functionZip();
  f.state.detail.Environment.Variables[0].Value = 'hotfix';
  await assert.rejects(
    f.provider.updateCode({
      name: 'public-api',
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      bytes,
      sha256: sha256(bytes),
      expectedSnapshot: before,
    }),
    /changed/,
  );
  assert.equal(f.state.updates, 0);
});

test('a lost receipt is sanitized and never retried by this provider', async () => {
  const f = setup();
  const before = await f.provider.read('public-api');
  const bytes = functionZip();
  f.state.fail = 'lost-ack';
  await assert.rejects(
    f.provider.updateCode({
      name: 'public-api',
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      bytes,
      sha256: sha256(bytes),
      expectedSnapshot: before,
    }),
    (e) => !e.message.includes('sdk-fixture-secret'),
  );
  assert.equal(f.state.updates, 1);
});

test('invalid, oversized, dependency-bearing and unsafe ZIPs never reach SDK mutation', async () => {
  const f = setup();
  for (const bytes of [
    Buffer.from('not a zip'),
    Buffer.alloc(functionZipLimit + 1),
    functionZip('exports.main=()=>0;', { '../escape': 'x' }),
    functionZip('exports.main=()=>0;', {
      'package.json': '{"main":"index.js","dependencies":{"unsafe":"*"}}',
    }),
  ])
    await assert.rejects(
      f.provider.updateCode({
        name: 'public-api',
        runtime: 'Nodejs20.19',
        handler: 'index.main',
        bytes,
        sha256: sha256(bytes),
        expectedSnapshot: {},
      }),
    );
  assert.equal(f.state.calls.length, 0);
});

test('cold-start validation uses an isolated directory and requires a bundled main export', () => {
  assert.equal(
    checkFunctionArchive(functionZip(), { smoke: true }).format,
    'channel-bundled-zip-v1',
  );
  assert.throws(
    () => checkFunctionArchive(functionZip('exports.other = 1;'), { smoke: true }),
    /cold-start/,
  );
});

test('aborted input does not start an update', async () => {
  const f = setup();
  const bytes = functionZip();
  await assert.rejects(
    f.provider.updateCode(
      {
        name: 'public-api',
        runtime: 'Nodejs20.19',
        handler: 'index.main',
        bytes,
        sha256: sha256(bytes),
        expectedSnapshot: {},
      },
      { signal: AbortSignal.abort() },
    ),
  );
  assert.equal(f.state.updates, 0);
});

test('read-only inspection observes a larger existing package and timer without widening code recovery', async () => {
  const f = setup();
  f.state.detail.Triggers = [{ Name: 'existing-timer' }];
  f.state.bytes = Buffer.alloc(2 * 1024 * 1024, 1);
  f.state.detail.CodeSize = f.state.bytes.length;
  const inspected = await f.provider.inspect('public-api');
  assert.equal(inspected.triggerCount, 1);
  assert.equal(inspected.packageBytes, f.state.bytes.length);
  assert.equal(inspected.recoveryEligibility.status, 'manual-required');
  assert(inspected.recoveryEligibility.reasons.includes('EXISTING_TRIGGER_OUTSIDE_RECOVERY_SCOPE'));
  await assert.rejects(f.provider.read('public-api'));
  const bytes = functionZip();
  await assert.rejects(
    f.provider.updateCode({
      name: 'public-api',
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      bytes,
      sha256: sha256(bytes),
      expectedSnapshot: inspected,
    }),
  );
  assert.equal(f.state.updates, 0);
  assert.equal(f.state.detail.Triggers.length, 1);
});

test('capture returns the exact online ZIP with a secret-free stable snapshot', async () => {
  const f = setup();
  const captured = await f.provider.capture('public-api');
  assert.equal(sha256(captured.bytes), captured.snapshot.packageSha256);
  assert.equal(captured.bytes.length, captured.snapshot.packageBytes);
  assert(!JSON.stringify(captured.snapshot).includes('sdk-fixture-secret'));
  const read = await f.provider.inspect('public-api');
  assert.equal(read.configurationToken, captured.snapshot.configurationToken);
  assert.equal(read.packageSha256, captured.snapshot.packageSha256);
});

test('package GET retries a transient read but never retries code submission or leaks signed targets', async () => {
  const f = functionManagerFixture();
  let calls = 0;
  const provider = createCloudbaseFunctionProvider({
    ...f,
    target,
    region: 'ap-shanghai',
    names: ['public-api'],
    request: async (...args) => {
      if (++calls === 1)
        throw Object.assign(new Error('fixture request failed'), { code: 'ETIMEDOUT' });
      return f.request(...args);
    },
  });
  const actual = await provider.read('public-api');
  assert.equal(calls, 2);
  assert.equal(actual.packageSha256, sha256(f.state.bytes));
  assert.equal(f.state.updates, 0);
});
test('permanent package errors keep a safe stage and do not retry or expose a signature', async () => {
  const f = functionManagerFixture();
  let calls = 0;
  const provider = createCloudbaseFunctionProvider({
    ...f,
    target,
    region: 'ap-shanghai',
    names: ['public-api'],
    request: async () => {
      calls++;
      throw Object.assign(new Error('do not expose https://private.example/?signature=secret'), {
        code: 'EACCES',
      });
    },
  });
  await assert.rejects(
    provider.read('public-api'),
    (e) =>
      e.stage === 'download-package' &&
      e.causeCode === 'EACCES' &&
      !e.message.includes('signature'),
  );
  assert.equal(calls, 1);
  assert.equal(f.state.updates, 0);
});
