import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { assertServerBlogReady } from './blog/server-route-health.mjs';
import { fetchFully } from './smoke-http.mjs';
const origin = 'https://reviewed.example';
const sha = 'a'.repeat(40);
function fixture(fault = '') {
  const calls = [];
  const request = async (method, url, options) => {
    calls.push({ method, url, options });
    if (url.endsWith('health.json'))
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            service: 'blog-pages',
            status: 'ok',
            siteOrigin: origin,
            releaseId: fault === 'version' ? 'local' : sha,
            previewOnly: true,
          }),
        ),
      };
    const xml = url.endsWith('.xml');
    return {
      status: fault === 'status' ? 503 : 200,
      body: Buffer.from(xml ? '<urlset/>' : '<h1>Insights</h1>'),
      headers: new Headers({
        'content-type': xml ? 'application/xml; charset=utf-8' : 'text/html; charset=utf-8',
        'x-channel-blog-version':
          fault === 'static' ? '' : fault === 'drift' ? 'b'.repeat(40) : sha,
      }),
    };
  };
  return { request, calls };
}
test('server delivery requires actual healthy index and sitemap responses from the same running version', async () => {
  const f = fixture();
  assert.deepEqual(await assertServerBlogReady(origin, f.request), {
    releaseId: sha,
    previewOnly: true,
  });
  assert.equal(f.calls.length, 3);
  assert(f.calls.every((c) => c.method === 'GET' && c.options.redirect === 'error'));
});
test('health alone, an old static page, mixed versions, unavailable API or an unreviewed origin cannot pass', async () => {
  for (const fault of ['version', 'static', 'drift', 'status'])
    await assert.rejects(assertServerBlogReady(origin, fixture(fault).request));
  await assert.rejects(assertServerBlogReady('http://reviewed.example', fixture().request));
});

test('the route guard consumes real HTTP Headers from the existing fetchFully transport', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/blog/health.json')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          service: 'blog-pages',
          status: 'ok',
          siteOrigin: origin,
          releaseId: sha,
          previewOnly: true,
        }),
      );
    else
      res
        .writeHead(200, {
          'content-type': req.url.endsWith('.xml') ? 'application/xml' : 'text/html',
          'x-channel-blog-version': sha,
        })
        .end(req.url.endsWith('.xml') ? '<urlset/>' : '<h1>Insights</h1>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address === 'object');
  const transport = (method, url, options) =>
    fetchFully(method, url.replace(origin, `http://127.0.0.1:${address.port}`), options);
  assert.equal((await assertServerBlogReady(origin, transport)).releaseId, sha);
});
