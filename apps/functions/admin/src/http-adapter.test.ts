import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type ApiResult, ok } from '@vibelingan-channel/shared';
import type { AdminConfig, AdminRequest } from './handler.ts';
import {
  type HttpResponse,
  handleAdminFunctionEvent,
  parseAllowedOrigins,
} from './http-adapter.ts';

function isHttpResponse(value: ApiResult<unknown> | HttpResponse): value is HttpResponse {
  return 'statusCode' in value;
}

function parseBody(response: HttpResponse): ApiResult<unknown> {
  return JSON.parse(response.body) as ApiResult<unknown>;
}

const config = {
  jwtSecret: 'test-secret',
  corsAllowedOrigins: ['https://site.example'],
} satisfies AdminConfig & { corsAllowedOrigins: string[] };

test('wraps a plain JSON POST envelope as an HTTP response', async () => {
  let captured: AdminRequest | null = null;
  const response = await handleAdminFunctionEvent(
    {
      httpMethod: 'POST',
      headers: { origin: 'https://site.example' },
      body: JSON.stringify({ action: 'login', data: { email: 'a@example.com' }, token: 't' }),
    },
    config,
    async (req) => {
      captured = req;
      return ok({ action: req.action });
    },
  );

  assert.ok(isHttpResponse(response));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://site.example');
  assert.deepEqual(captured, {
    action: 'login',
    data: { email: 'a@example.com' },
    token: 't',
  });
  assert.deepEqual(parseBody(response), ok({ action: 'login' }));
});

test('decodes a base64 JSON POST body', async () => {
  const body = Buffer.from(JSON.stringify({ action: 'collections' }), 'utf8').toString('base64');
  const response = await handleAdminFunctionEvent(
    { method: 'POST', body, isBase64Encoded: true },
    config,
    async (req) => ok({ action: req.action }),
  );

  assert.ok(isHttpResponse(response));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parseBody(response), ok({ action: 'collections' }));
});

test('returns BAD_REQUEST for invalid JSON without calling the handler', async () => {
  let calls = 0;
  const response = await handleAdminFunctionEvent(
    { httpMethod: 'POST', body: '{"action":' },
    config,
    async () => {
      calls += 1;
      return ok({});
    },
  );

  assert.ok(isHttpResponse(response));
  assert.equal(response.statusCode, 400);
  assert.equal(calls, 0);
  assert.deepEqual(parseBody(response), {
    ok: false,
    error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' },
  });
});

test('returns an empty 204 response for OPTIONS preflight', async () => {
  const response = await handleAdminFunctionEvent(
    { httpMethod: 'OPTIONS', headers: { origin: 'https://site.example' } },
    config,
    async () => ok({ unreachable: true }),
  );

  assert.ok(isHttpResponse(response));
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('preserves direct invocation fallback for tests and local callers', async () => {
  const response = await handleAdminFunctionEvent(
    { action: 'me', token: 'session' },
    config,
    async (req) => ok({ direct: true, token: req.token }),
  );

  assert.ok(!isHttpResponse(response));
  assert.deepEqual(response, ok({ direct: true, token: 'session' }));
});

test('parses comma-separated CORS origins', () => {
  assert.deepEqual(parseAllowedOrigins(' https://a.example,https://b.example ,, '), [
    'https://a.example',
    'https://b.example',
  ]);
});
