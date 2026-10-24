import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialCatalogTaxonomy } from '../packages/shared/src/catalog-taxonomy.ts';
import { planCatalogTaxonomyMigration } from './catalog-taxonomy-migration.mjs';

test('legacy absent assignments get deterministic proposals without changing the export', () => {
  const products = ['wired', 'office', 'bluetooth'].map((category) => ({
    _id: category,
    category,
    name: 'Private product name not included in the report',
  }));
  const snapshot = { products };
  const before = structuredClone(snapshot);
  const report = planCatalogTaxonomyMigration(snapshot);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.writes, 0);
  assert.equal(report.summary['legacy-absent'], 3);
  assert.deepEqual(
    report.products.map((product) => product.proposedSubcategoryIds),
    [['headphones-wired'], ['headphones-office'], ['headphones-bluetooth']],
  );
  assert.deepEqual(snapshot, before);
  assert.deepEqual(planCatalogTaxonomyMigration(snapshot), report);
  const reversed = planCatalogTaxonomyMigration({ products: [...products].reverse() });
  assert.deepEqual(
    reversed.products.map((product) => product.proposedSubcategoryIds).reverse(),
    report.products.map((product) => product.proposedSubcategoryIds),
  );
  assert.equal(JSON.stringify(report).includes(products[0].name), false);
});

test('manual assignments and explicit empty arrays are preserved even with legacy categories', () => {
  const report = planCatalogTaxonomyMigration({
    products: [
      { _id: 'clear', category: 'wired', subcategoryIds: [] },
      { _id: 'manual', category: 'wired', subcategoryIds: ['headphones-office'] },
      { _id: 'unassigned', productFamily: 'toys' },
    ],
  });
  assert.deepEqual(
    report.products.map((product) => product.status),
    ['preserved-explicit-empty', 'preserved-assigned', 'unassigned'],
  );
  assert.deepEqual(report.products[0].subcategoryIds, []);
  assert.deepEqual(report.products[1].subcategoryIds, ['headphones-office']);
  assert.ok(report.products.every((product) => !Object.hasOwn(product, 'proposedSubcategoryIds')));
});

test('malformed, cross-parent, unknown and duplicate assignments remain unresolved', () => {
  const products = [
    { _id: 'null', category: 'wired', subcategoryIds: null },
    { _id: 'string', category: 'wired', subcategoryIds: 'headphones-wired' },
    { _id: 'repeat', category: 'wired', subcategoryIds: ['headphones-wired', 'headphones-wired'] },
    { _id: 'bad-id', category: 'wired', subcategoryIds: [' HEADPHONES'] },
    { _id: 'missing-child', productFamily: 'headphones', subcategoryIds: ['unknown'] },
    { _id: 'cross-child', productFamily: 'toys', subcategoryIds: ['headphones-wired'] },
    { _id: 'cross-legacy', productFamily: 'toys', category: 'wired' },
    { _id: 'cross-clear', productFamily: 'toys', category: 'wired', subcategoryIds: [] },
    { _id: 'unknown-legacy', category: 'unknown' },
    { _id: 'invalid-parent', productFamily: null, category: 'wired' },
    { _id: 'number-category', productFamily: 'headphones', category: 1 },
    { _id: 'duplicate', category: 'wired' },
    { _id: 'duplicate', category: 'office' },
    { category: 'wired' },
    null,
  ];
  const report = planCatalogTaxonomyMigration({ products });
  assert.equal(report.summary.unresolved, products.length);
  assert.ok(report.products.every((product) => product.status === 'unresolved'));
  assert.ok(report.products.every((product) => !Object.hasOwn(product, 'proposedSubcategoryIds')));
  assert.equal(report.products[7].reason, 'invalid-classification');
});

test('exported registries validate manual IDs and prevent proposals for removed or archived children', () => {
  const headphones = initialCatalogTaxonomy('headphones');
  headphones.children = headphones.children.filter((child) => child.slug !== 'office');
  headphones.children[0].status = 'archived';
  const toys = initialCatalogTaxonomy('toys');
  toys.children.push({
    id: 'toy-blocks',
    name: 'Blocks',
    slug: 'blocks',
    order: 0,
    status: 'active',
  });
  const report = planCatalogTaxonomyMigration({
    catalogTaxonomies: [
      {
        _id: 'headphones',
        assignmentFence: 2,
        updatedAt: '2026-09-18T00:00:00.000Z',
        ...headphones,
      },
      toys,
    ],
    products: [
      { _id: 'removed', category: 'office' },
      { _id: 'archived-legacy', category: 'wired' },
      { _id: 'archived-manual', category: 'wired', subcategoryIds: ['headphones-wired'] },
      { _id: 'manual-toy', productFamily: 'toys', subcategoryIds: ['toy-blocks'] },
    ],
  });
  assert.deepEqual(
    report.products.map((product) => product.status),
    ['unresolved', 'unresolved', 'preserved-assigned', 'preserved-assigned'],
  );
  assert.deepEqual(report.defaultTaxonomyFamilies, ['ai-gadgets', 'misc']);
});

test('invalid export shapes and ambiguous registries fail closed', () => {
  for (const snapshot of [
    null,
    [],
    {},
    { products: {} },
    { products: [], customers: [] },
    { products: [], catalogTaxonomies: null },
    { products: [], catalogTaxonomies: [{ family: 'toys' }] },
    {
      products: [],
      catalogTaxonomies: [initialCatalogTaxonomy('toys'), initialCatalogTaxonomy('toys')],
    },
    { products: [], catalogTaxonomies: [{ _id: 'headphones', ...initialCatalogTaxonomy('toys') }] },
  ])
    assert.throws(() => planCatalogTaxonomyMigration(snapshot));
});

test('CLI reads only a supplied local JSON file, emits a dry run, and rejects all write flags', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'taxonomy-dry-run-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'export.json');
  const contents = JSON.stringify({
    products: [{ _id: 'synthetic', category: 'wired', secret: 'omit-me' }],
  });
  writeFileSync(input, contents);
  const script = fileURLToPath(new URL('./catalog-taxonomy-migration.mjs', import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
      timeout: 10000,
    });
  for (const args of [
    ['--input', input],
    ['--dry-run', '--input', input],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).summary['legacy-absent'], 1);
    assert.equal(result.stdout.includes('omit-me'), false);
  }
  for (const flag of ['--write', '--apply', '--approve', '--output']) {
    const result = run('--input', input, flag);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  assert.equal(run().status, 1);
  assert.equal(run('--input', join(directory, 'absent.json')).status, 1);
  assert.equal(readFileSync(input, 'utf8'), contents);
  assert.deepEqual(readdirSync(directory), ['export.json']);
  writeFileSync(input, '{not-json');
  const malformed = run('--input', input);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr.includes('{not-json'), false);
});
