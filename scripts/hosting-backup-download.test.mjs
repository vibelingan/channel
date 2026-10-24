import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadHostingBackupFiles } from './hosting-backup-download.mjs';
const digest = (bytes) => createHash('md5').update(bytes).digest('hex');
const entry = (path, bytes, etag = digest(bytes)) => ({
  path,
  bytes: Buffer.byteLength(bytes),
  etag: `"${etag}"`,
  lastModified: '2026-10-24T00:00:00Z',
});
async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), 'hosting-http-backup-'));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, origin: `http://127.0.0.1:${server.address().port}` };
}
test('real HTTP backup handles escaped object keys and a reserved 404 only when exact stored bytes match', async (t) => {
  const files = { 'media/中.png': 'image bytes', '404.html': 'actual error bytes' };
  const f = await fixture(t, (req, res) => {
    const path = decodeURIComponent(req.url.slice(1));
    const body = files[path];
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.writeHead(path === '404.html' ? 404 : 200, { ETag: `"${digest(body)}"` });
    res.end(body);
  });
  const result = await downloadHostingBackupFiles({
    ...f,
    entries: Object.entries(files).map(([path, bytes]) => entry(path, bytes)),
  });
  assert.equal(result.files, 2);
  for (const [path, bytes] of Object.entries(files))
    assert.equal(readFileSync(join(f.directory, path), 'utf8'), bytes);
});
test('homepage fallback never becomes a backup of a different listed object', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.end('home');
  });
  await assert.rejects(
    downloadHostingBackupFiles({ ...f, entries: [entry('missing.html', 'real!')] }),
    /bytes|digest/,
  );
  assert.equal(existsSync(join(f.directory, 'missing.html')), false);
});
test('a real interrupted response is bounded and retried without accepting partial bytes', async (t) => {
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++;
    if (calls === 1) {
      req.socket.destroy();
      return;
    }
    res.end('complete');
  });
  const result = await downloadHostingBackupFiles({
    ...f,
    entries: [entry('index.html', 'complete')],
  });
  assert.equal(result.files, 1);
  assert.equal(calls, 2);
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), 'complete');
});
test('persistent network failure stops after three attempts', async (t) => {
  let calls = 0;
  const f = await fixture(t, (req) => {
    calls++;
    req.socket.destroy();
  });
  await assert.rejects(downloadHostingBackupFiles({ ...f, entries: [entry('index.html', 'x')] }));
  assert.equal(calls, 3);
});
test('actual downloads use at most three concurrent requests', async (t) => {
  let active = 0;
  let peak = 0;
  const f = await fixture(t, (_req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end('x');
    }, 20);
  });
  const result = await downloadHostingBackupFiles({
    ...f,
    entries: Array.from({ length: 8 }, (_, i) => entry(`file-${i}.txt`, 'x')),
  });
  assert.equal(result.files, 8);
  assert.equal(peak, 3);
});
test('multipart metadata requires matching response ETag and records SHA-256 proof', async (t) => {
  let etag = 'abc-2';
  const f = await fixture(t, (_req, res) => {
    res.setHeader('ETag', `"${etag}"`);
    res.end('large');
  });
  const entries = [entry('media.bin', 'large', 'abc-2')];
  const result = await downloadHostingBackupFiles({ ...f, entries });
  assert.equal(result.contentProofs.length, 1);
  assert.equal(result.contentProofs[0].sha256, createHash('sha256').update('large').digest('hex'));
  etag = 'changed-2';
  await assert.rejects(
    downloadHostingBackupFiles({ ...f, entries, directory: join(f.directory, 'another') }),
    /ETag/,
  );
});
test('unsafe paths and arbitrary cleartext origins fail before network requests', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.end('x');
  });
  for (const path of ['../escape', '//outside.example/x', 'a/../escape'])
    await assert.rejects(downloadHostingBackupFiles({ ...f, entries: [entry(path, 'x')] }));
  await assert.rejects(
    downloadHostingBackupFiles({
      ...f,
      origin: 'http://outside.example',
      entries: [entry('x', 'x')],
    }),
  );
  assert.equal(calls, 0);
});

test('flat backup preserves object-store keys that are both files and directory prefixes', async (t) => {
  const bodies = { same: 'root object', 'same/index.html': 'nested object' };
  const f = await fixture(t, (req, res) => res.end(bodies[req.url.slice(1)]));
  const entries = Object.entries(bodies).map(([path, body]) => entry(path, body));
  const result = await downloadHostingBackupFiles({
    ...f,
    entries,
    storageLayout: 'sha256-path-v1',
  });
  assert.equal(result.files, 2);
  for (const [path, body] of Object.entries(bodies)) {
    const key = createHash('sha256').update(path).digest('hex');
    assert.equal(readFileSync(join(f.directory, '.recovery-objects', `${key}.bin`), 'utf8'), body);
  }
});

test('a reset after headers and partial bytes retries the whole file and records transfer counts', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200, { 'content-length': 8 });
    if (calls === 1) {
      res.write('part');
      setTimeout(() => res.destroy(), 10);
    } else res.end('complete');
  });
  const result = await downloadHostingBackupFiles({
    ...f,
    entries: [entry('index.html', 'complete')],
  });
  assert.equal(calls, 2);
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), 'complete');
  assert.equal(result.transfer.files, 1);
  assert.equal(result.transfer.attempts, 2);
  assert.equal(result.transfer.retries, 1);
  assert.equal(result.transfer.verifiedBytes, 8);
  assert(
    result.transfer.elapsedMs >= 250,
    'retry must give the interrupted connection time to recover',
  );
});

test('temporary server failures wait between bounded attempts and never save an error body', async (t) => {
  const times = [];
  const f = await fixture(t, (_req, res) => {
    times.push(performance.now());
    res.writeHead(times.length < 3 ? 503 : 200);
    res.end(times.length < 3 ? 'unavailable' : 'complete');
  });
  const result = await downloadHostingBackupFiles({
    ...f,
    entries: [entry('index.html', 'complete')],
  });
  assert.equal(result.transfer.attempts, 3);
  assert.equal(result.transfer.retries, 2);
  assert(times[1] - times[0] >= 200);
  assert(times[2] - times[1] >= 450);
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), 'complete');
});

test('an unauthorized response is not retried or written', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(403);
    res.end('denied');
  });
  await assert.rejects(
    downloadHostingBackupFiles({ ...f, entries: [entry('index.html', 'complete')] }),
    /403/,
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(join(f.directory, 'index.html')), false);
});

test('wrong bytes of the correct length fail without a retry or a saved file', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.end('corrupte');
  });
  await assert.rejects(
    downloadHostingBackupFiles({ ...f, entries: [entry('index.html', 'complete')] }),
    /digest/,
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(join(f.directory, 'index.html')), false);
});

test('a stalled response is timed out, retried at most three times, and leaves no partial file', async (t) => {
  const { fetchFully } = await import('./smoke-http.mjs');
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200);
    res.write('part');
  });
  await assert.rejects(
    downloadHostingBackupFiles({
      ...f,
      entries: [entry('index.html', 'complete')],
      request: (method, url, options) => fetchFully(method, url, { ...options, timeoutMs: 40 }),
    }),
    /timed out/,
  );
  assert.equal(calls, 3);
  assert.equal(existsSync(join(f.directory, 'index.html')), false);
});
