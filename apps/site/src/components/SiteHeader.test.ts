import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@astrojs/compiler';

const source = readFileSync(fileURLToPath(new URL('./SiteHeader.astro', import.meta.url)), 'utf8');

function occurrences(value: string): number {
  return source.split(value).length - 1;
}

test('SiteHeader compiles with one desktop and one mobile catalog disclosure', async () => {
  const { diagnostics } = await parse(source);
  assert.deepEqual(diagnostics, []);
  assert.equal(occurrences('data-catalog-disclosure="desktop"'), 1);
  assert.equal(occurrences('data-catalog-disclosure="mobile"'), 1);
  assert.equal(occurrences('data-catalog-menu'), 2);
});

test('both disclosures render one hub link plus the same four registry families', () => {
  assert.equal(occurrences('href="/electronics-toys/"'), 2);
  assert.equal(occurrences('catalog.families.map'), 2);
  assert.match(source, /item\.href !== '\/headphones'/);
  assert.match(source, /beforeCatalog/);
  assert.match(source, /afterCatalog/);
  assert.match(source, /getCatalogContent\(\)/);
});

test('catalog menu preserves semantic active state and keyboard-safe close behavior', () => {
  assert.ok(occurrences('aria-current={catalogPath ===') >= 4);
  assert.ok(occurrences('min-h-11') >= 4, 'catalog targets meet the 44px minimum');
  assert.match(source, /header-mobile-toggle inline-flex h-11 w-11/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /disclosure\.addEventListener\('focusout'/);
  assert.match(source, /document\.addEventListener\('pointerdown'/);
  assert.match(source, /querySelector<HTMLElement>\(':scope > summary'\)\?\.focus\(\)/);
  assert.ok(occurrences("'bg-brand-50 ring-1 ring-inset ring-brand-200'") >= 2);
  assert.match(source, /'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'/);
});

test('catalog links remain server-rendered inside native details for no-JS navigation', () => {
  assert.equal(occurrences('<details'), 3, 'outer mobile menu plus two catalog disclosures');
  assert.equal(occurrences('<summary'), 3);
  assert.ok(source.indexOf('href="/electronics-toys/"') < source.indexOf('<script>'));
  assert.ok(source.indexOf('catalog.families.map') < source.indexOf('<script>'));
});
