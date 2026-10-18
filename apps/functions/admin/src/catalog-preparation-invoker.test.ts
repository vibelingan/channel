import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import {
  CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
  createCatalogPreparationInvoker,
  withCatalogPreparationDeadline,
} from './catalog-preparation-invoker.ts';

const require = createRequire(import.meta.url);
const dbRequire = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const sdkRoot = dirname(dbRequire.resolve('@cloudbase/node-sdk/package.json'));
const requester = require(join(sdkRoot, 'dist/utils/tcbapirequester.js'));
initCloudBase('owned-preparation-invoker');
function admission() {
  return createCatalogPreparationAuthority({
    secret: 'owned-invoker-secret',
    environmentId: 'owned-preparation-invoker',
  }).issueCall({ jobId: 'a'.repeat(64), nonce: 'b'.repeat(64) });
}
test('installed SDK invocation encodes only the signed server call with fixed target deadline and no retries', async (t) => {
  const sdk = cloudStorageSdk();
  const call = admission();
  const requests: unknown[] = [];
  t.mock.method(requester, 'request', async (args: unknown) => {
    requests.push(args);
    return {
      data: { response_data: JSON.stringify({ ok: false, code: 'BUSY' }) },
      requestId: 'owned-request',
    };
  });
  const result = await createCatalogPreparationInvoker(sdk)(call);
  assert.deepEqual(result, { result: { ok: false, code: 'BUSY' }, requestId: 'owned-request' });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request && typeof request === 'object');
  assert.equal(Reflect.get(request, 'method'), 'post');
  const params = Reflect.get(request, 'params');
  assert.deepEqual(params, {
    action: 'functions.invokeFunction',
    function_name: 'alibaba-catalog-sync',
    qualifier: '$LATEST',
    request_data: JSON.stringify(call),
  });
  assert.deepEqual(Reflect.get(request, 'opts'), { timeout: 8000, retryOptions: { retries: 0 } });
  assert.equal(CATALOG_PREPARATION_INVOKE_TIMEOUT_MS, 8000);
  const config = Reflect.get(request, 'config');
  assert.ok(config && typeof config === 'object');
  assert.equal(Reflect.get(config, 'envName'), 'owned-preparation-invoker');
});
test('installed SDK may return a provider error object instead of throwing', async (t) => {
  const error = {
    code: 'OWNED_PROVIDER_FAILURE',
    message: 'private fixture detail',
    requestId: 'owned-error',
  };
  t.mock.method(requester, 'request', async () => error);
  assert.deepEqual(await createCatalogPreparationInvoker(cloudStorageSdk())(admission()), error);
});
test('installed SDK keeps non-JSON response_data as a string instead of granting a worker result', async (t) => {
  t.mock.method(requester, 'request', async () => ({
    data: { response_data: 'owned invalid worker response' },
    requestId: 'owned-shape',
  }));
  assert.deepEqual(await createCatalogPreparationInvoker(cloudStorageSdk())(admission()), {
    result: 'owned invalid worker response',
    requestId: 'owned-shape',
  });
});

test('installed SDK uses zero retries even when its configured default permits retries', async (t) => {
  const sdk = cloudStorageSdk();
  const oldConfig: unknown = Reflect.get(sdk, 'config');
  assert.ok(oldConfig && typeof oldConfig === 'object');
  Reflect.set(sdk, 'config', {
    ...oldConfig,
    secretId: 'owned-fake-id',
    secretKey: 'owned-fake-key',
    retries: 3,
    keepalive: false,
  });
  t.after(() => {
    Reflect.set(sdk, 'config', oldConfig);
  });
  const core = require(join(sdkRoot, 'dist/utils/request-core.js'));
  let attempts = 0;
  t.mock.method(core, 'request', (opts: unknown) => {
    attempts++;
    assert.ok(opts && typeof opts === 'object');
    assert.equal(Reflect.get(opts, 'timeout'), 8000);
    throw Object.assign(Error('owned connect failure'), { code: 'ECONNREFUSED' });
  });
  await assert.rejects(createCatalogPreparationInvoker(sdk)(admission()));
  assert.equal(attempts, 1);
});

test(
  'installed SDK startup remains inside the total deadline before any response exists',
  { timeout: 5000 },
  async (t) => {
    let release = () => {};
    let entered = () => {};
    let attempts = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = new Promise<unknown>((resolve) => {
      release = () => resolve({ data: { response_data: '{}' }, requestId: 'owned-late-startup' });
    });
    t.mock.method(requester, 'request', () => {
      attempts++;
      entered();
      return transport;
    });
    try {
      await assert.rejects(
        createCatalogPreparationInvoker(cloudStorageSdk(), { timeoutMs: 5 })(admission()),
        (error) => {
          assert.ok(error && typeof error === 'object');
          return Reflect.get(error, 'code') === 'PREPARATION_RESULT_TIMEOUT';
        },
      );
      await started;
      assert.equal(attempts, 1);
    } finally {
      release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
  },
);

test(
  'an already-streaming installed SDK request cannot extend the total preparation wait',
  { timeout: 5000 },
  async (t) => {
    const sdk = cloudStorageSdk();
    const oldConfig: unknown = Reflect.get(sdk, 'config');
    assert.ok(oldConfig && typeof oldConfig === 'object');
    let received = 0;
    let chunks = 0;
    let completeResponse = () => {};
    let entered = () => {};
    const streaming = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer((request, response) => {
      received++;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(' ');
      const stream = setInterval(() => {
        chunks++;
        response.write(' ');
      }, 10);
      completeResponse = () =>
        response.end(JSON.stringify({ data: { response_data: '{}' }, requestId: 'owned-slow' }));
      response.on('close', () => clearInterval(stream));
      entered();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    Reflect.set(sdk, 'config', {
      ...oldConfig,
      secretId: 'owned-fake-id',
      secretKey: 'owned-fake-key',
      serviceUrl: `http://127.0.0.1:${address.port}`,
      protocol: 'http',
      retries: 3,
      keepalive: false,
    });
    t.after(async () => {
      Reflect.set(sdk, 'config', oldConfig);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const call = admission();
    const inFlight = sdk.callFunction(
      { name: 'alibaba-catalog-sync', qualifier: '$LATEST', data: call },
      { timeout: CATALOG_PREPARATION_INVOKE_TIMEOUT_MS, retryOptions: { retries: 0 } },
    );
    await Promise.race([
      streaming,
      inFlight.then(() => {
        throw Error('SDK completed before the streaming test began');
      }),
    ]);
    // Establish the streaming condition before measuring this part of the deadline.
    const waited = withCatalogPreparationDeadline(() => inFlight, 80)(call);
    let completed = false;
    const finish = setTimeout(() => {
      completed = true;
      completeResponse();
    }, 350);
    t.after(() => clearTimeout(finish));
    await assert.rejects(waited, (error) => {
      assert.ok(error && typeof error === 'object');
      return Reflect.get(error, 'code') === 'PREPARATION_RESULT_TIMEOUT';
    });
    assert.equal(received, 1);
    assert.ok(chunks > 0, 'the server actually streamed bytes before the deadline');
    assert.equal(completed, false, 'the hard deadline must stop waiting before the full response');
  },
);
for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 8001, 1.5])
  test(`preparation invocation rejects unsupported total deadline ${timeoutMs}`, () => {
    assert.throws(() => withCatalogPreparationDeadline(async () => null, timeoutMs), /deadline/);
  });
test('preparation deadline handles a late rejection without repeating the invocation', async () => {
  let rejectLate: (reason: Error) => void = () => {
    throw Error('not initialized');
  };
  let calls = 0;
  const pending = new Promise<unknown>((_resolve, reject) => {
    rejectLate = reject;
  });
  const invoke = withCatalogPreparationDeadline(async () => {
    calls++;
    return pending;
  }, 5);
  await assert.rejects(invoke(admission()), /unconfirmed/);
  rejectLate(Error('owned late transport rejection'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

for (const settlement of ['resolve', 'reject'] as const)
  test(`preparation deadline clears its timer after immediate ${settlement}`, async () => {
    const countTimers = () =>
      process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    const before = countTimers();
    const invoke = withCatalogPreparationDeadline(async () => {
      if (settlement === 'reject') throw Error('owned immediate rejection');
      return { owned: 'completed' };
    });
    if (settlement === 'resolve')
      assert.deepEqual(await invoke(admission()), { owned: 'completed' });
    else await assert.rejects(invoke(admission()), /owned immediate rejection/);
    assert.equal(
      countTimers(),
      before,
      'a completed invocation must not keep an 8s deadline handle alive',
    );
  });
