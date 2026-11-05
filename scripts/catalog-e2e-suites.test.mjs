import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { catalogE2eSuites } from './catalog-e2e-suites.mjs';
test('independent browser groups cover the complete original suites exactly once in both catalog modes', () => {
  for (const formal of [true, false]) {
    const all = catalogE2eSuites({ formal }).flat();
    const original = [
      'public',
      'header-navigation',
      'catalog-hub',
      'catalog-family-routes',
      'catalog-category',
      'sku-detail',
      ...(formal
        ? ['catalog-formal-journey']
        : [
            'font-loading',
            'catalog-local-seed',
            'catalog-admin',
            'admin-product-form',
            'admin-product-family-tabs',
          ]),
      'admin-subcategory-visibility',
      'admin-readiness-default',
      'catalog-taxonomy',
    ].map((name) => `tests/e2e/${name}.spec.ts`);
    assert.deepEqual(all, original);
    const groups = [
      'storefront',
      ...(formal ? ['admin-workflows'] : []),
      'admin',
      'taxonomy',
    ].flatMap((group) => catalogE2eSuites({ formal, group }).flat());
    assert.deepEqual([...groups].sort(), [...all].sort());
    assert.equal(new Set(groups).size, groups.length);
    assert(groups.every(existsSync));
    assert(all.includes('tests/e2e/public.spec.ts'));
    assert(all.includes('tests/e2e/catalog-taxonomy.spec.ts'));
    assert.equal(all.includes('tests/e2e/catalog-formal-journey.spec.ts'), formal);
    assert.equal(all.includes('tests/e2e/catalog-admin.spec.ts'), !formal);
  }
  assert.throws(() => catalogE2eSuites({ formal: true, group: 'skip' }));
  assert.throws(() => catalogE2eSuites({ formal: false, group: 'admin-workflows' }));
  assert.deepEqual(catalogE2eSuites({ formal: true, group: 'admin' }), [
    ['tests/e2e/admin-subcategory-visibility.spec.ts'],
  ]);
  assert.deepEqual(catalogE2eSuites({ formal: true, group: 'admin-workflows' }), [
    ['tests/e2e/catalog-formal-journey.spec.ts'],
    ['tests/e2e/admin-readiness-default.spec.ts'],
  ]);
});
test('parallel browser jobs retain the old required check names and no failing group can become green', () => {
  const workflow = parse(readFileSync('.github/workflows/browser-regression.yml', 'utf8'));
  const browser = workflow.jobs.browser;
  assert.deepEqual(browser.strategy.matrix.group, ['storefront', 'admin', 'taxonomy']);
  assert.deepEqual(browser.strategy.matrix.include, [{ formal: '1', group: 'admin-workflows' }]);
  assert.equal(browser.env.E2E_CATALOG_GROUP, '${{ matrix.group }}');
  assert.equal(browser.strategy['fail-fast'], false);
  const gate = workflow.jobs.catalog_gate;
  assert.equal(gate.name, 'Catalog regression (formal=${{ matrix.formal }})');
  assert.equal(gate.needs, 'browser');
  assert.equal(gate.if, 'always()');
  assert.match(gate.steps[0].run, /test.*RESULT.*success/);
  assert.deepEqual(gate.strategy.matrix.formal, ['0', '1']);
  assert(!JSON.stringify(workflow.jobs).includes('continue-on-error'));
  assert(!JSON.stringify(workflow.jobs).includes('secrets.'));
});
