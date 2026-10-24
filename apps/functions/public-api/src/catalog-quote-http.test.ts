import assert from 'node:assert/strict';
import test from 'node:test';
import { handleQuoteEvent } from './catalog-quote-http.ts';
import { handlePublicApiEvent } from './http-adapter.ts';

const config = { enableInquiries: true, corsAllowedOrigins: ['https://site.example'] };
const event = {
  path: '/api/catalog-quote-requests',
  httpMethod: 'POST',
  headers: { origin: 'https://site.example', 'content-type': 'application/json' },
  body: '{}',
};

test('quote HTTP boundary rejects disabled, foreign origin, method, type, size and invalid JSON before save', async () => {
  let calls = 0;
  const save = async () => {
    calls++;
    return { ok: false as const, code: 'validation' };
  };
  assert.equal((await handleQuoteEvent(event, {}, save)).statusCode, 404);
  assert.equal(
    (
      await handleQuoteEvent(
        { ...event, headers: { ...event.headers, origin: 'https://evil.example' } },
        config,
        save,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await handleQuoteEvent({ ...event, httpMethod: 'GET' }, config, save)).statusCode,
    405,
  );
  assert.equal(
    (
      await handleQuoteEvent(
        { ...event, headers: { ...event.headers, 'content-type': 'text/plain' } },
        config,
        save,
      )
    ).statusCode,
    415,
  );
  assert.equal(
    (await handleQuoteEvent({ ...event, body: 'x'.repeat(16385) }, config, save)).statusCode,
    413,
  );
  assert.equal((await handleQuoteEvent({ ...event, body: '{' }, config, save)).statusCode, 400);
  assert.equal(calls, 0);
});

test('quote transport returns a receipt only after save; errors are private, stable and retryable', async () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const saved = await handleQuoteEvent(
    { ...event, body: Buffer.from('{}').toString('base64'), isBase64Encoded: true },
    config,
    async (input) => {
      assert.deepEqual(input, {});
      return { ok: true, requestId };
    },
  );
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(JSON.parse(saved.body), { ok: true, requestId });
  assert.equal(saved.headers['Cache-Control'], 'no-store');
  const failed = await handleQuoteEvent(event, config, async () => {
    throw new Error('private details');
  });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.includes('private'), false);
  const limited = await handleQuoteEvent(event, config, async () => ({
    ok: false,
    code: 'rate-limit',
  }));
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  const stale = await handleQuoteEvent(event, config, async () => ({
    ok: false,
    code: 'revision-changed',
  }));
  assert.equal(stale.statusCode, 409);
});

test('production router keeps RFQ disabled by default and routes explicit preflight with POST only', async () => {
  assert.equal((await handlePublicApiEvent(event, {})).statusCode, 404);
  const result = await handlePublicApiEvent({ ...event, httpMethod: 'OPTIONS' }, config);
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://site.example');
});
