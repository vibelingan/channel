import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('records transport stages and leaves signed URLs, credentials and results out of the trace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-blog-http-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, 'trace.jsonl');
  const server = createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      if (request.url.startsWith('/disconnect')) {
        request.socket.destroy();
        return;
      }
      response.writeHead(request.method === 'PUT' ? 201 : 200);
      response.end('private-provider-response');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./blog/cloudrun-http-trace.mjs', import.meta.url)),
      '--input-type=module',
      '--eval',
      MINIMAL_CLIENT,
      String(server.address().port),
    ],
    { env: { ...process.env, CHANNEL_BLOG_TRACE_PATH: trace }, timeout: 5000 },
  );

  const raw = await readFile(trace, 'utf8');
  assert.doesNotMatch(raw, /must-not-leak|127\.0\.0\.1|private-provider-response/);
  const events = raw.trim().split('\n').map(JSON.parse);
  for (const [index, phase, lastEvent, status] of [
    [1, 'request-upload-address', 'response', 200],
    [2, 'transfer-package', 'response', 201],
    [3, 'submit-version', 'response', 200],
    [4, 'transfer-package', 'request-error', undefined],
  ]) {
    const sample = events.filter((event) => event.request === index);
    assert.equal(sample[0].event, 'created');
    assert(sample.some((event) => event.event === 'request-written'));
    assert(sample.every((event) => event.phase === phase));
    assert.equal(sample.at(-1).event, lastEvent);
    assert.equal(sample.at(-1).status, status);
    assert(sample.every((event) => Number.isInteger(event.ms) && event.ms >= 0));
  }
  assert.equal(events.at(-1).request, 4);
});

const MINIMAL_CLIENT = `
import http from 'node:http';
const port = Number(process.argv[1]);
function send(method, action, path) {
  return new Promise((resolve) => {
    const headers = { authorization: 'must-not-leak', ...(action ? { 'X-TC-Action': action } : {}) };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', resolve);
    request.end('must-not-leak');
  });
}
await send('POST', 'DescribeCloudBaseBuildService', '/?signature=must-not-leak');
await send('PUT', undefined, '/?signature=must-not-leak');
await send('POST', 'UpdateCloudRunServer', '/');
await send('PUT', undefined, '/disconnect?signature=must-not-leak');
await send('POST', 'AnotherAction', '/');
`;
