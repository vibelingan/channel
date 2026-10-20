import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entry,
  errorHtml,
  httpFixture,
  objectResponse,
  target,
} from './release-hosting-fixtures.mjs';
import { verifyHostingObject } from './release/hosting-readback.mjs';

test('ordinary, revalidated and conditional requests verify the same canonical URL and bytes', async (t) => {
  const body = '<h1>Product</h1>';
  const http = await httpFixture(t, (req, res) => objectResponse(req, res, { body }));
  const result = await verifyHostingObject({
    target,
    entry: entry('catalog/index.html', body),
    request: http.request,
  });
  assert.equal(result.sha256, entry('catalog/index.html', body).sha256);
  assert.equal(result.checks.length, 3);
  assert.deepEqual(
    http.requests.map((r) => r.url),
    ['/catalog/', '/catalog/', '/catalog/'],
  );
  assert.equal(http.requests[0].headers['cache-control'], undefined);
  assert.equal(http.requests[1].headers['cache-control'], 'no-cache');
  assert.equal(http.requests[2].headers['if-none-match'], '"v1"');
});
for (const bad of ['stale bytes', 'long cache', 'wrong status', 'wrong mime', 'changed etag'])
  test(`readback rejects ${bad}`, async (t) => {
    let count = 0;
    const http = await httpFixture(t, (req, res) => {
      count++;
      objectResponse(req, res, {
        body: bad === 'stale bytes' && count === 1 ? 'old' : 'new',
        cache: bad === 'long cache' ? 'max-age=600' : 'no-cache',
        status: bad === 'wrong status' ? 500 : 200,
        mime: bad === 'wrong mime' ? 'text/plain' : 'text/html',
        etag: bad === 'changed etag' && count > 1 ? '"v2"' : '"v1"',
      });
    });
    await assert.rejects(
      verifyHostingObject({ target, entry: entry('page.html', 'new'), request: http.request }),
    );
  });
test('removed owned URL must return the expected dedicated 404 body, with mutable caching', async (t) => {
  const http = await httpFixture(t, (req, res) =>
    objectResponse(req, res, { body: errorHtml, status: 404 }),
  );
  const result = await verifyHostingObject({
    target,
    path: 'retired/index.html',
    entry: entry('404.html', errorHtml),
    expectedStatus: 404,
    request: http.request,
  });
  assert.equal(result.status, 404);
});
test('a homepage returned with 404 does not count as the error document', async (t) => {
  const http = await httpFixture(t, (req, res) =>
    objectResponse(req, res, { body: 'home', status: 404 }),
  );
  await assert.rejects(
    verifyHostingObject({
      target,
      path: 'retired/index.html',
      entry: entry('404.html', 'home'),
      expectedStatus: 404,
      request: http.request,
    }),
  );
});
test('redirects fail instead of silently verifying a different URL', async (t) => {
  const http = await httpFixture(t, (_req, res) => {
    res.writeHead(302, { location: '/elsewhere' });
    res.end();
  });
  await assert.rejects(
    verifyHostingObject({ target, entry: entry('page.html', 'body'), request: http.request }),
  );
  assert.equal(http.requests.length, 1);
});
test('deadline covers stalled body and external abort cancels the request', async (t) => {
  const http = await httpFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache', etag: '"v1"' });
    res.write('partial');
  });
  await assert.rejects(
    verifyHostingObject({
      target,
      entry: entry('page.html', 'long enough partial body'),
      request: http.request,
      timeoutMs: 60,
    }),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    verifyHostingObject({
      target,
      entry: entry('page.html', 'long enough partial body'),
      request: http.request,
      signal: controller.signal,
      timeoutMs: 2000,
    }),
  );
});
test('oversized body and encoded or traversing paths are rejected', async (t) => {
  const http = await httpFixture(t, (req, res) => objectResponse(req, res, { body: 'too long' }));
  await assert.rejects(
    verifyHostingObject({ target, entry: entry('page.html', 'a'), request: http.request }),
  );
  for (const path of ['../a', 'a?query=1', 'a%2fb', '/a'])
    await assert.rejects(
      verifyHostingObject({ target, entry: entry(path, 'a'), request: http.request }),
    );
});

test('a 404 artifact served as a normal file must also contain the dedicated error marker', async (t) => {
  const http = await httpFixture(t, (req, res) => objectResponse(req, res, { body: 'homepage' }));
  await assert.rejects(
    verifyHostingObject({ target, entry: entry('404.html', 'homepage'), request: http.request }),
  );
});
