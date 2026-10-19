import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPublicProductBuild } from './product-seo-release.mjs';

test('release rejects synthetic, wrong-origin and incomplete artifacts before cloud work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-seo-release-'));
  try {
    mkdirSync(join(dir, 'products'));
    const manifest = {
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin: 'https://example.com',
      total: 1,
      products: [{ path: '/products/p-public-id/', revision: 'r1' }],
    };
    writeFileSync(
      join(dir, 'seo-manifest.json'),
      JSON.stringify([{ path: '/products/p-public-id/', kind: 'product' }]),
    );
    const save = (value) =>
      writeFileSync(join(dir, 'products/manifest.json'), JSON.stringify(value));
    save(manifest);
    assert.equal(assertPublicProductBuild(dir, 'https://example.com/'), 1);
    for (const patch of [
      { purpose: 'fixture' },
      { siteOrigin: 'http://localhost:4321' },
      { total: 0 },
      { products: [] },
    ]) {
      save({ ...manifest, ...patch });
      assert.throws(() => assertPublicProductBuild(dir, 'https://example.com'));
    }
    const deploy = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
    assert.ok(
      deploy.indexOf('assertPublicProductBuild(resolve(siteRootPath') <
        deploy.indexOf("callTool('cloudbase.auth'"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
