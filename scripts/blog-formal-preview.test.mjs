import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formalPreviewHandler } from './blog/formal-preview.mjs';

test('origin-faithful preview serves only owned static files and never proxies an API or receives cloud credentials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'formal-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries({
    'index.html': 'home',
    '404.html': 'missing',
    'admin/index.html': 'admin',
    '_astro/a.js': 'script',
  })) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  symlinkSync('/etc/passwd', join(root, 'outside.txt'));
  const server = createServer(formalPreviewHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', host = 'supplychainsai.com') =>
    new Promise((done, reject) => {
      const req = httpRequest(origin + path, { method, headers: { host } }, (response) => {
        const chunks = [];
        response.on('data', (b) => chunks.push(b));
        response.on('end', () =>
          done({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
            type: response.headers['content-type'],
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal((await request('/')).body, 'home');
  assert.equal((await request('/admin/')).body, 'admin');
  assert.equal((await request('/_astro/a.js')).type, 'application/javascript');
  assert.equal((await request('/api/admin')).status, 404);
  assert.equal((await request('/outside.txt')).status, 404);
  assert.equal((await request('/', 'GET', 'other.example')).status, 403);
  assert.equal((await request('/api/admin', 'POST')).status, 403);
});
