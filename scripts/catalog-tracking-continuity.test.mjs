import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertCatalogTrackingContinuity } from './release/catalog-runtime-flags.mjs';

test('missing or disabled deployment configuration cannot turn off tracked product pages', () => {
  assert.throws(
    () => assertCatalogTrackingContinuity({ catalogTracked: true }, undefined),
    /normal publication cannot disable change tracking/,
  );
  assert.doesNotThrow(() =>
    assertCatalogTrackingContinuity(
      { catalogTracked: true },
      { siteOrigin: 'https://example.test', detailEnabled: true },
    ),
  );
  for (const active of [null, undefined, { catalogTracked: false }])
    assert.doesNotThrow(() => assertCatalogTrackingContinuity(active, undefined));
});

test('normal snapshot preparation and controlled delivery check continuity before starting workers', () => {
  for (const [file, boundary] of [
    ['./blog/prepare-products.ts', 'await withProductReleaseCoordinator('],
    ['./run-site-delivery.ts', 'let renderer:'],
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const guard = source.indexOf(
      'assertCatalogTrackingContinuity(',
      source.indexOf('const catalogConfig'),
    );
    assert.ok(guard > 0 && guard < source.indexOf(boundary), file);
  }
});

test('normal preparation supplies the actual deployment readiness setting to the existing cloud read', () => {
  const source = readFileSync(new URL('./blog/prepare-products.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /checkCatalogRuntimeFlags\(manager, catalogConfig, policy.envId, \{\s+pageReadiness: env\.CATALOG_SEO_PAGE_READINESS,/,
  );
});
