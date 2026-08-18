import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createAlibabaClient, fingerprintRequest } from './alibaba-client.ts';
import { DEFAULT_ALIBABA_ENDPOINTS } from './alibaba-endpoints.ts';

const noSleep = () => Promise.resolve();

const makeClient = (fetchImpl: typeof fetch) =>
  createAlibabaClient({
    appKey: '511630',
    appSecret: 'secret',
    endpoints: DEFAULT_ALIBABA_ENDPOINTS,
    fetchImpl,
    sleep: noSleep,
    now: () => 1_722_900_000_000,
  });

const okResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

test('signs and posts form-encoded params to the gateway path', async () => {
  let captured: { url: string; body: string } | undefined;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), body: String(init?.body) };
    return okResponse('{"ok":true}');
  });
  const result = await client.callApi({
    apiPath: '/alibaba/icbu/product/list',
    params: { page_size: '30' },
    accessToken: 'tok-123',
  });
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(captured.url, 'https://open-api.alibaba.com/rest/alibaba/icbu/product/list');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('app_key'), '511630');
  assert.equal(params.get('page_size'), '30');
  assert.equal(params.get('access_token'), 'tok-123');
  assert.equal(params.get('sign_method'), 'sha256');
  assert.equal(params.get('timestamp'), '1722900000000');
  assert.match(params.get('sign') ?? '', /^[0-9A-F]{64}$/);
});

test('retries network failures then succeeds', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed');
    return okResponse('{"ok":true}');
  });
  const result = await client.callApi({ apiPath: '/x', maxAttempts: 3 });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test('retries 429 and 5xx but not 4xx', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return new Response('slow down', { status: 429 });
  });
  const throttled = await client.callApi({ apiPath: '/x', maxAttempts: 2 });
  assert.equal(throttled.ok, false);
  assert.equal(calls, 2);

  calls = 0;
  const client400 = makeClient(async () => {
    calls += 1;
    return new Response('bad', { status: 400 });
  });
  const rejected = await client400.callApi({ apiPath: '/x', maxAttempts: 3 });
  assert.equal(rejected.ok, false);
  assert.equal(calls, 1, '4xx must not retry');
});

test('timeout aborts and reports without leaking params', async () => {
  const client = makeClient(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  );
  const result = await client.callApi({ apiPath: '/slow', timeoutMs: 20, maxAttempts: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'timeout');
    assert.ok(!result.error.includes('secret'));
    assert.ok(!result.error.includes('tok'));
  }
});

test('errors never contain secrets or tokens', async () => {
  const client = makeClient(async () => new Response('boom', { status: 500 }));
  const result = await client.callApi({
    apiPath: '/p',
    accessToken: 'super-secret-token',
    maxAttempts: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!JSON.stringify(result).includes('super-secret-token'));
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('fingerprint excludes secret params and is order-insensitive', () => {
  const a = fingerprintRequest('/p', {
    b: '2',
    a: '1',
    access_token: 'tok',
    sign: 'SIG',
    code: 'c',
  });
  const b = fingerprintRequest('/p', { a: '1', b: '2' });
  assert.equal(a, b);
  const c = fingerprintRequest('/p', { a: '1', b: '3' });
  assert.notEqual(a, c);
});

test('fingerprint has no concatenation collisions', () => {
  const a = fingerprintRequest('/p', { ab: 'c' });
  const b = fingerprintRequest('/p', { a: 'bc' });
  assert.notEqual(a, b);
});
