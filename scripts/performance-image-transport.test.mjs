import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { measureTransfer, transportTargets } from './performance/image-transport.mjs';

test('curl reads complete public bytes and fixed timing headers without copying cookies or object addresses', async (t) => {
  const body = Buffer.from('public file');
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, {
      'content-type': 'image/webp',
      'x-cloudbase-upstream-timecost': '12',
      'set-cookie': 'private=value',
      'x-storage-url': 'secret.invalid',
    });
    res.end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  t.after(() => server.close());
  const result = await measureTransfer({
    url: `http://127.0.0.1:${server.address().port}/image`,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    mime: 'image/webp',
  });
  assert.equal(result.upstreamMs, 12);
  assert(result.times.total >= result.times.starttransfer);
  assert.equal(JSON.stringify(result).includes('private=value'), false);
  assert.equal(JSON.stringify(result).includes('secret.invalid'), false);
  assert.equal(requests, 1);
});

for (const failure of ['truncated', '503', 'redirect', 'changed'])
  test(`curl refuses ${failure} instead of accepting HTTP headers as a complete image`, async (t) => {
    let requests = 0;
    const body = Buffer.from('expected');
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(failure === '503' ? 503 : failure === 'redirect' ? 302 : 200, {
        'content-type': 'image/webp',
        location: '/other',
        'content-length': failure === 'truncated' ? '100' : String(body.length),
      });
      res.end(failure === 'changed' ? Buffer.from('modified') : body);
    }).listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    t.after(() => server.close());
    await assert.rejects(
      measureTransfer(
        {
          url: `http://127.0.0.1:${server.address().port}/image`,
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          mime: 'image/webp',
        },
        0.3,
      ),
      (error) =>
        failure === 'truncated'
          ? [18, 28].includes(error.code)
          : error.code === 'ERR_ASSERTION' &&
            error.message.includes(
              failure === 'changed' ? 'File changed' : 'Public file did not return 200',
            ),
    );
    assert.equal(requests, 1, 'No automatic follow or retry');
  });

test('transport measurements use fixed reviewed resources and a manual workflow with no secrets', async () => {
  assert.equal(transportTargets.length * 3 + 5, 20);
  assert(
    transportTargets.every((x) =>
      /^https:\/\/(?:supplychainsai\.com|diversity-123-d9grnqfux221323bb\.service\.tcloudbase\.com)\//.test(
        x.url,
      ),
    ),
  );
  const { parse } = createRequire(import.meta.url)('yaml');
  const workflow = parse(await readFile('.github/workflows/seo-performance-baseline.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(
    workflow.jobs.baseline.if,
    "${{ inputs.scope != 'image-transport' && inputs.scope != 'document-transport' }}",
  );
  const job = workflow.jobs.transport;
  assert.equal(job.if, "${{ inputs.scope == 'image-transport' }}");
  assert.equal(job.permissions, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert(!JSON.stringify(job).includes('secrets.'));
  assert(!JSON.stringify(job).includes('lighthouse'));
  assert.equal(job.steps.at(-1).if, 'always()');
});
