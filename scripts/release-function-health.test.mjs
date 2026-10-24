import assert from 'node:assert/strict';
import test from 'node:test';
import { httpFixture } from './release-hosting-fixtures.mjs';
import { createFunctionHealthProbe } from './release/function-health.mjs';

const target = { envId: 'fixture-env', siteOrigin: 'https://fixture.example' };
const codeSha = 'a'.repeat(40);
for (const [name, method, path] of [
  ['public-api', 'GET', '/api/health'],
  ['admin', 'POST', '/api/admin'],
  ['alibaba-catalog-sync', 'GET', '/api/alibaba-catalog-sync/health'],
])
  test(`uses the existing ${name} health route and release response`, async (t) => {
    let observed;
    const server = await httpFixture(t, (req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        observed = { method: req.method, path: req.url, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: true, data: { status: 'ok', service: name, releaseId: codeSha } }),
        );
      });
    });
    const probe = createFunctionHealthProbe({
      target,
      apiOrigin: 'https://api.fixture.example',
      request: server.request,
    });
    assert.equal((await probe(name, codeSha)).status, 'healthy');
    assert.deepEqual(observed, {
      method,
      path,
      body: name === 'admin' ? '\u007b"action":"health"\u007d' : '',
    });
  });
for (const [label, status, body] of [
  [
    'wrong release',
    200,
    { ok: true, data: { status: 'ok', service: 'public-api', releaseId: 'b'.repeat(40) } },
  ],
  [
    'wrong service',
    200,
    { ok: true, data: { status: 'ok', service: 'admin', releaseId: codeSha } },
  ],
  ['failed health', 200, { ok: false }],
  ['redirect', 302, {}],
  ['server error', 500, {}],
])
  test(`refuses ${label}`, async () => {
    const probe = createFunctionHealthProbe({
      target,
      apiOrigin: 'https://api.fixture.example',
      request: async () => ({ status, body: Buffer.from(JSON.stringify(body)) }),
    });
    await assert.rejects(probe('public-api', codeSha));
  });
test('unknown names and invalid identities do not issue a request', async () => {
  let calls = 0;
  const probe = createFunctionHealthProbe({
    target,
    apiOrigin: 'https://api.fixture.example',
    request: async () => {
      calls++;
    },
  });
  await assert.rejects(probe('constructor', codeSha));
  await assert.rejects(probe('unknown', codeSha));
  await assert.rejects(probe('public-api', 'local'));
  assert.equal(calls, 0);
});
