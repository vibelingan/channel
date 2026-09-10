import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  hostedAssetManifest,
  publishVerifiedAssets,
  verifyHostedAssets,
} from './hosting-integrity.mjs';

const bytes = Buffer.from('export default 1;');
const asset = {
  path: '_astro/AdminDetailPreview.hash.js',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const response = (status = 200, body = bytes, type = 'application/javascript') => ({
  status,
  body,
  headers: new Headers({ 'content-type': type }),
});

test('manifest includes nested entry pages and lazy chunks, not unrelated media', () => {
  const dist = mkdtempSync(join(tmpdir(), 'channel-hosting-test-'));
  try {
    mkdirSync(join(dist, '_astro'));
    mkdirSync(join(dist, 'admin'));
    writeFileSync(join(dist, asset.path), bytes);
    writeFileSync(join(dist, 'admin/index.html'), '<main>Admin</main>');
    writeFileSync(join(dist, 'unrelated.mp4'), 'not a dependency');
    const manifest = hostedAssetManifest(dist);
    assert.deepEqual(
      manifest.map((item) => item.path),
      [asset.path, 'admin/index.html'],
    );
    assert.deepEqual(manifest[0], asset);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('hosting integrity checks bytes, MIME and status, not just an upload success', async () => {
  assert.deepEqual(
    await verifyHostedAssets([asset], 'https://example.com', async () => response()),
    [],
  );
  for (const bad of [
    response(404),
    response(200, Buffer.from('stale')),
    response(200, bytes, 'text/html'),
  ]) {
    const failures = await verifyHostedAssets([asset], 'https://example.com', async () => bad);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, asset.path);
  }
});

test('hosting integrity records bounded transport failures and checks every asset', async () => {
  const checked = [];
  const failures = await verifyHostedAssets(
    [asset, { ...asset, path: '_astro/other.js' }],
    'https://example.com',
    async (_method, url, options) => {
      checked.push(url);
      assert.equal(options.timeoutMs, 15000);
      assert.ok(options.maxBytes >= bytes.length);
      throw new Error('transport failed');
    },
  );
  assert.equal(checked.length, 2);
  assert.equal(failures.length, 2);
});

test('missing lazy chunk retries the same additive upload and verifies before completion', async () => {
  let uploads = 0;
  const attempts = await publishVerifiedAssets({
    upload: () => {
      uploads += 1;
    },
    verify: async () => (uploads === 1 ? [{ path: asset.path, reason: 'HTTP 404' }] : []),
    log: () => {},
  });
  assert.equal(attempts, 2);
  assert.equal(uploads, 2);
});

test('persistent mismatch fails closed after two uploads; never prunes or silently succeeds', async () => {
  let uploads = 0;
  await assert.rejects(
    publishVerifiedAssets({
      upload: () => {
        uploads += 1;
      },
      verify: async () => [{ path: asset.path, reason: 'HTTP 404' }],
      log: () => {},
    }),
    /AdminDetailPreview.*HTTP 404/,
  );
  assert.equal(uploads, 2);
});

test('an empty asset manifest cannot pass verification', async () => {
  await assert.rejects(verifyHostedAssets([], 'https://example.com'), /empty/i);
});
