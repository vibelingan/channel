import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createRedirectServer } = require('../apps/functions/seo-canonical-redirect/index.js');
async function probe(path, method = 'GET') {
  const server = createRedirectServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path,
          method,
          headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
for (const path of [
  '/',
  '/blog/',
  '/headphones/?page=2&name=one%20two',
  '/%E4%B8%AD%E6%96%87/?x=%23value',
  '//other.example/path',
  '/__missing__/',
]) {
  test(`fixed host and exact path/query ${path}`, async () => {
    const r = await probe(path);
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, `https://supplychainsai.com${path}`);
    assert.equal(new URL(r.headers.location).origin, 'https://supplychainsai.com');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body, '');
  });
}
test('HEAD has the same permanent target and no body', async () => {
  const r = await probe('/blog/?x=1', 'HEAD');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://supplychainsai.com/blog/?x=1');
  assert.equal(r.body, '');
});
for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
  test(`does not forward ${method} or execute business actions`, async () => {
    const r = await probe('/', method);
    assert.equal(r.status, 405);
    assert.equal(r.headers.location, undefined);
  });
for (const path of ['/bad#fragment', '/bad\\path'])
  test(`reject ambiguous path ${path}`, async () => {
    assert.equal((await probe(path)).status, 400);
  });
