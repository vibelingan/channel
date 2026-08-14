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

test('posts TOP system params to the SINGLE router URL, method as a parameter', async () => {
  let captured: { url: string; body: string } | undefined;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), body: String(init?.body) };
    return okResponse('{"ok":true}');
  });
  const result = await client.callApi({
    apiPath: 'alibaba.icbu.product.list',
    params: { page_size: '30' },
    accessToken: 'tok-123',
  });
  assert.equal(result.ok, true);
  assert.ok(captured);

  // The method NEVER appears in the URL — one router endpoint, no path.
  assert.equal(captured.url, 'https://eco.taobao.com/router/rest');
  assert.ok(!captured.url.includes('product'), 'the method must not leak into the path');

  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('method'), 'alibaba.icbu.product.list');
  assert.equal(params.get('app_key'), '511630');
  assert.equal(params.get('page_size'), '30');
  assert.equal(params.get('format'), 'json');
  assert.equal(params.get('v'), '2.0');
  // TOP carries the token as `session`; `access_token` is the GOP spelling.
  assert.equal(params.get('session'), 'tok-123');
  assert.equal(params.get('access_token'), null, 'access_token is the OLD protocol');
  assert.equal(params.get('sign_method'), 'hmac');
  // GMT+8 wall-clock, not an epoch and not ISO.
  // Fixture clock is 1722900000000 = 2024-08-05T23:20:00Z, i.e. 07:20 next
  // day in GMT+8. A UTC formatter would emit the 05th and be silently wrong.
  assert.equal(params.get('timestamp'), '2024-08-06 07:20:00');
  // HMAC-MD5 = 32 hex chars. 64 would mean the GOP SHA-256 signer came back.
  assert.match(params.get('sign') ?? '', /^[0-9A-F]{32}$/);
});

test('a legacy slash path is normalised to a dotted TOP method', async () => {
  let body = '';
  const client = makeClient(async (_url, init) => {
    body = String(init?.body);
    return okResponse('{"ok":true}');
  });
  await client.callApi({ apiPath: '/alibaba/icbu/product/get', params: {} });
  assert.equal(new URLSearchParams(body).get('method'), 'alibaba.icbu.product.get');
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
