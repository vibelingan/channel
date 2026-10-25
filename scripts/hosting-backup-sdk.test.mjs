import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function probe(t, scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'hosting-sdk-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'download');
  const env = { ...process.env };
  for (const name of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])
    delete env[name];
  const result = spawnSync(
    process.execPath,
    ['scripts/diagnostics/hosting-sdk-download.mjs', scenario, file],
    {
      encoding: 'utf8',
      timeout: 10000,
      env,
    },
  );
  assert.equal(result.error, undefined);
  return { ...result, file };
}

test('installed Manager download succeeds on the actual loopback HTTP happy path', (t) => {
  const result = probe(t, 'complete');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SDK_COMPLETED/);
  assert.equal(readFileSync(result.file, 'utf8'), 'complete');
});

test('installed Manager 5.9.1 neither resolves nor rejects after a real mid-body reset', (t) => {
  const result = probe(t, 'reset');
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /SDK_STALLED/);
  assert.match(result.stdout, /SDK_PARTIAL_BYTES_CONFIRMED/);
  assert.doesNotMatch(result.stdout, /SDK_COMPLETED|SDK_REJECTED/);
  assert.equal(readFileSync(result.file, 'utf8'), 'part');
});

test('an injected stream error escapes the installed Manager promise and terminates its process', (t) => {
  const result = probe(t, 'stream-error');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unhandled 'error' event/);
  assert.match(result.stderr, /injected stream failure/);
  assert.match(result.stdout, /SDK_PARTIAL_BYTES_CONFIRMED/);
  assert.doesNotMatch(result.stdout, /SDK_COMPLETED|SDK_REJECTED/);
  assert.equal(readFileSync(result.file, 'utf8'), 'part');
});

test('installed Manager accepts an actual 503 error page, so backup must validate independently', (t) => {
  const result = probe(t, 'error-page');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SDK_COMPLETED/);
  assert.equal(readFileSync(result.file, 'utf8'), 'unavailable');
});

test('file and directory-prefix object keys terminate the installed bulk downloader without any network fault', (t) => {
  const result = probe(t, 'prefix-conflict');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unhandled 'error' event/);
  assert.match(result.stderr, /EISDIR/);
  assert.doesNotMatch(result.stdout, /SDK_COMPLETED|SDK_REJECTED/);
});
