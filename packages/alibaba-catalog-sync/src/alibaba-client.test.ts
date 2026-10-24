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

test('uses documented TOP transport for ICBU business methods', async () => {
  let captured: { url: string; body: string } | undefined;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), body: String(init?.body) };
    return okResponse('{"ok":true}');
  });
  const result = await client.callApi({
    apiPath: 'alibaba.icbu.product.list',
    protocol: 'top',
    params: { page_size: '30' },
    accessToken: 'tok-123',
  });
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(captured.url, 'https://open-api.alibaba.com/sync?method=alibaba.icbu.product.list');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('method'), 'alibaba.icbu.product.list');
  assert.equal(params.get('app_key'), '511630');
  assert.equal(params.get('page_size'), '30');
  assert.equal(params.get('session'), 'tok-123');
  assert.equal(params.get('access_token'), null);
  assert.equal(params.get('format'), 'json');
  assert.equal(params.get('v'), '2.0');
  assert.equal(params.get('sign_method'), 'sha256');
  assert.equal(params.get('timestamp'), '1722900000000');
  assert.match(params.get('sign') ?? '', /^[0-9A-F]{64}$/);
});

test('keeps OAuth system methods on documented GOP REST transport', async () => {
  let captured: { url: string; body: string } | undefined;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), body: String(init?.body) };
    return okResponse('{"ok":true}');
  });
  await client.callApi({ apiPath: '/auth/token/refresh', params: { refresh_token: 'refresh' } });
  assert.ok(captured);
  assert.equal(captured.url, 'https://open-api.alibaba.com/rest/auth/token/refresh');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('method'), null);
  assert.equal(params.get('session'), null);
  assert.equal(params.get('sign_method'), 'sha256');
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

test('response cap is measured in UTF-8 bytes, not JavaScript characters', async () => {
  // Each character is three UTF-8 bytes. The character count is below 8 MiB,
  // but the response bytes exceed it and must be rejected before parsing.
  const body = '界'.repeat(2_796_203);
  const client = makeClient(async () => okResponse(body));
  const result = await client.callApi({ apiPath: '/large', maxAttempts: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'body-too-large');
});

test('response cap cancels the stream as soon as the byte budget is crossed', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 20) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = makeClient(async () => new Response(body, { status: 200 }));
  const result = await client.callApi({ apiPath: '/stream-too-large', maxAttempts: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'body-too-large');
  assert.equal(cancelled, true, 'oversized stream is cancelled instead of fully buffered');
  assert.ok(pulls < 20, 'not every provider byte is pulled after the cap is known');
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
