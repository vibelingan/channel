import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import ts from 'typescript';
import { type ViteDevServer, createServer } from 'vite';
import { parseDocument } from 'yaml';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import { createPublicProduct } from '../../test/factories/catalog.ts';
import { assertCatalogFamilyAdapter } from './catalog-family-adapter.ts';

let server: ViteDevServer | undefined;
let createToysAdapter: typeof import('./toys.ts')['createToysAdapter'];
let selectToysAdapter: typeof import('./toys.ts')['selectToysAdapter'];
let defaultAdapter: unknown;

before(async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = await getViteConfig(
    {
      root,
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true },
    },
    { root },
  )({ mode: 'test', command: 'serve' });
  server = await createServer({ ...config, configFile: false });
  assert.equal(server.config.server.ws, false);
  const loaded: Record<string, unknown> = await server.ssrLoadModule(
    '/src/catalog/families/toys.ts',
  );
  assert.ok(typeof loaded.createToysAdapter === 'function');
  assert.ok(typeof loaded.selectToysAdapter === 'function');
  createToysAdapter = loaded.createToysAdapter as typeof createToysAdapter;
  selectToysAdapter = loaded.selectToysAdapter as typeof selectToysAdapter;
  defaultAdapter = loaded.toysAdapter;
});

after(async () => {
  await server?.close();
});

const markdown = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter);
const document = parseDocument(frontmatter[1], { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const content = document.toJS() as CatalogContent;
const family = content.families.find((candidate) => candidate.key === 'toys');
assert.ok(family);
const toysFamily: CatalogFamilyContent = family;
const routeKeys = [
  'label',
  'href',
  'eyebrow',
  'heading',
  'description',
  'seoTitle',
  'seoDescription',
] as const;

test('Toys exposes exact Markdown route and list/detail labels without media', () => {
  const adapter = createToysAdapter(content, toysFamily);
  assertCatalogFamilyAdapter(adapter);
  assert.equal(adapter.family, 'toys');
  const expectedKeys: string[] = [];
  for (const [key, value] of Object.entries(content.list)) {
    expectedKeys.push(key);
    assert.equal(adapter.labels[key], value);
  }
  for (const key of routeKeys) {
    expectedKeys.push(key);
    assert.equal(adapter.labels[key], toysFamily[key]);
  }
  for (const [key, value] of Object.entries(content.detail)) {
    expectedKeys.push(`detail.${key}`);
    assert.equal(adapter.labels[`detail.${key}`], value);
  }
  if (!Object.hasOwn(content.detail, 'productCodeLabel')) {
    expectedKeys.push('detail.productCodeLabel');
    assert.equal(adapter.labels['detail.productCodeLabel'], 'Product Code');
  }
  assert.deepEqual(Object.keys(adapter.labels).sort(), expectedKeys.sort());
  assert.equal(adapter.labels.href, '/toys/');
  assert.equal(adapter.emptyCopy, content.list.emptyLabel);
});

test('unsupported filters and legacy categories never group or exclude minimal Toys records', () => {
  const adapter = createToysAdapter(content, {
    ...toysFamily,
    categories: [{ key: 'wired', label: 'Wired' }],
  });
  assert.deepEqual(adapter.filterCapabilities, []);
  for (const category of ['wired', 'office', 'bluetooth', 'unknown', '', undefined]) {
    const product = Object.freeze(createPublicProduct({ productFamily: 'toys', category }));
    assert.equal(adapter.group(product), null);
    assert.deepEqual(adapter.facts(product), []);
    assert.equal(product.slug, undefined);
  }
});

test('Toys facts project ordered identity fields only and do not mutate products', () => {
  const adapter = createToysAdapter(content, toysFamily);
  const product = Object.freeze(
    createPublicProduct({
      productFamily: 'toys',
      category: undefined,
      series: 'Learn',
      modName: 'R1',
      modType: 'Robot',
      productCode: 'R1-OEM',
    }),
  );
  const expected = [
    { key: 'series', label: content.detail.seriesLabel, value: 'Learn' },
    { key: 'model', label: content.detail.modelLabel, value: 'R1' },
    { key: 'type', label: content.detail.typeLabel, value: 'Robot' },
    { key: 'product-code', label: 'Product Code', value: 'R1-OEM' },
  ];
  assert.deepEqual(adapter.facts(product), expected);
  assert.deepEqual(
    adapter.facts({
      ...product,
      moq: 50,
      unitPrice: 99,
      wholesalePrice: 88,
      images: ['image'],
      alibabaPrimarySourceKey: 'linked',
    }),
    expected,
  );
  assert.notEqual(adapter.facts(product), adapter.facts(product));
  assert.notEqual(adapter.facts(product)[0], adapter.facts(product)[0]);
  assert.deepEqual(
    adapter.facts(
      createPublicProduct({
        productFamily: 'toys',
        series: '',
        modName: '',
        modType: '',
        productCode: '',
      }),
    ),
    [],
  );
});

test('approved pathname aliases select the real default canonical Toys instance', () => {
  assertCatalogFamilyAdapter(defaultAdapter);
  const adapter = createToysAdapter(content, toysFamily);
  assert.equal(defaultAdapter.family, 'toys');
  assert.deepEqual(defaultAdapter.labels, adapter.labels);
  assert.deepEqual(defaultAdapter.filterCapabilities, []);
  assert.equal(defaultAdapter.emptyCopy, content.list.emptyLabel);
  for (const pathname of ['/toys', '/toys/', '/electronics-toys', '/electronics-toys/']) {
    const selected = selectToysAdapter(pathname);
    assert.equal(selected, defaultAdapter);
    assert.ok(selected);
    assert.equal(selected.family, 'toys');
    assert.equal(selected.labels.href, '/toys/');
    for (const product of [
      createPublicProduct({ productFamily: 'toys', category: undefined }),
      createPublicProduct({
        productFamily: 'toys',
        category: 'wired',
        series: 'Learn',
        modName: 'R1',
        modType: 'Robot',
        productCode: 'R1',
      }),
    ]) {
      assert.equal(selected.group(product), null);
      assert.deepEqual(selected.facts(product), adapter.facts(product));
    }
  }
});

test('route selection does not normalize unrelated paths or accept complete URLs', () => {
  for (const pathname of [
    '',
    'toys',
    '/TOYS',
    '/toys//',
    '/toys/item',
    '/toys?category=wired',
    '/toys#detail',
    '/electronics-toys-extra',
    '/ai-gadgets/',
    '/misc/',
    '/headphones/',
    'https://example.test/toys/',
  ]) {
    assert.equal(selectToysAdapter(pathname), null, pathname);
  }
});

test('localized and long copy stays plain data and snapshots fact labels', () => {
  const longCopy = '<plain-copy>'.repeat(120);
  const localized = {
    list: { ...content.list, emptyLabel: longCopy },
    detail: { ...content.detail, productCodeLabel: longCopy },
  };
  const translatedFamily: CatalogFamilyContent = { ...toysFamily, heading: longCopy };
  const adapter = createToysAdapter(localized, translatedFamily);
  assert.deepEqual(
    Object.keys(adapter).sort(),
    ['family', 'labels', 'filterCapabilities', 'group', 'facts', 'emptyCopy'].sort(),
  );
  localized.list.emptyLabel = 'Changed';
  localized.detail.productCodeLabel = 'Changed';
  translatedFamily.heading = 'Changed';
  assert.equal(adapter.emptyCopy, longCopy);
  assert.equal(adapter.labels.heading, longCopy);
  assert.equal(adapter.labels['detail.productCodeLabel'], longCopy);
  assert.deepEqual(
    adapter.facts(createPublicProduct({ productFamily: 'toys', productCode: longCopy })),
    [{ key: 'product-code', label: longCopy, value: longCopy }],
  );
  assert.ok(Object.values(adapter.labels).every((value) => typeof value === 'string'));
});

test('another family cannot silently supply Toys identity or route copy', () => {
  assert.throws(() => createToysAdapter(content, { ...toysFamily, key: 'ai-gadgets' }), {
    name: 'TypeError',
    message: 'Expected toys content',
  });
});

function dependencies(source: string): string[] {
  const parsed = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)) imports.push('import-equals');
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      imports.push('dynamic');
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return imports.sort();
}

test('Toys imports only content and its contract, with negative dependency controls', () => {
  const source = readFileSync(new URL('./toys.ts', import.meta.url), 'utf8');
  const allowed = ['../../i18n/catalog.ts', './catalog-family-adapter.ts'].sort();
  assert.deepEqual(dependencies(source), allowed);
  for (const forbidden of [
    "import React from 'react';",
    "export { state } from '../application/state.ts';",
    "import('../presentation/CatalogCard.tsx');",
    "require('../pricing.ts');",
    "import sibling = require('./ai-gadgets.ts');",
  ]) {
    assert.notDeepEqual(dependencies(`${source}\n${forbidden}`), allowed);
  }
});
