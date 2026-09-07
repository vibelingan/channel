import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import ts from 'typescript';
import { type ViteDevServer, createServer } from 'vite';
import { parseDocument } from 'yaml';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import {
  createOldestHeadphonesPublicProduct,
  createPublicProduct,
} from '../../test/factories/catalog.ts';
import { assertCatalogFamilyAdapter } from './catalog-family-adapter.ts';
let server: ViteDevServer | undefined;
let createHeadphonesAdapter: typeof import('./headphones.ts')['createHeadphonesAdapter'];
let defaultAdapter: unknown;

before(async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = await getViteConfig(
    {
      root,
      server: { middlewareMode: true, watch: null, hmr: false },
      optimizeDeps: { noDiscovery: true },
    },
    { root },
  )({ mode: 'test', command: 'serve' });
  server = await createServer({ ...config, configFile: false });
  const loaded: Record<string, unknown> = await server.ssrLoadModule(
    '/src/catalog/families/headphones.ts',
  );
  assert.ok(typeof loaded.createHeadphonesAdapter === 'function');
  createHeadphonesAdapter = loaded.createHeadphonesAdapter as typeof createHeadphonesAdapter;
  defaultAdapter = loaded.headphonesAdapter;
});

after(async () => {
  await server?.close();
});

const markdown = readFileSync(
  new URL('../../i18n/content/headphones/en-US.md', import.meta.url),
  'utf8',
);
const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter);
const document = parseDocument(frontmatter[1], { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const content = document.toJS() as HeadphonesContent;

test('Headphones adapter uses real copy and legacy category order', () => {
  const adapter = createHeadphonesAdapter(content);
  assertCatalogFamilyAdapter(adapter);
  assert.equal(adapter.family, 'headphones');
  assert.deepEqual(adapter.filterCapabilities, content.list.categories);
  assert.equal(adapter.labels.heading, content.list.heading);
  assert.equal(adapter.emptyCopy, content.list.emptyStateLabel);
  const expectedLabelKeys: string[] = [];
  for (const [key, value] of Object.entries(content.list)) {
    if (key === 'categories') continue;
    expectedLabelKeys.push(key);
    assert.equal(adapter.labels[key], value);
  }
  for (const [key, value] of Object.entries(content.detail)) {
    expectedLabelKeys.push(`detail.${key}`);
    assert.equal(adapter.labels[`detail.${key}`], value);
  }
  if (content.detail.productCodeLabel === undefined) {
    expectedLabelKeys.push('detail.productCodeLabel');
    assert.equal(adapter.labels['detail.productCodeLabel'], 'Product Code');
  }
  assert.deepEqual(Object.keys(adapter.labels).sort(), expectedLabelKeys.sort());
  for (const category of content.list.categories) {
    assert.equal(adapter.group(createPublicProduct({ category: category.key })), category.key);
  }
});

test('default adapter loads real Markdown through the production content loader', () => {
  assertCatalogFamilyAdapter(defaultAdapter);
  assert.equal(defaultAdapter.family, 'headphones');
  assert.deepEqual(defaultAdapter.filterCapabilities, content.list.categories);
  assert.equal(defaultAdapter.emptyCopy, content.list.emptyStateLabel);
  assert.equal(defaultAdapter.labels.heading, content.list.heading);
  const factoryAdapter = createHeadphonesAdapter(content);
  assert.deepEqual(defaultAdapter.labels, factoryAdapter.labels);
  for (const category of ['wired', 'office', 'bluetooth', 'historic-category', '', undefined]) {
    const product = createPublicProduct({
      category,
      series: 'SY',
      modName: 'T8',
      modType: 'TWS',
      productCode: 'SY-T8',
    });
    assert.equal(defaultAdapter.group(product), category || 'uncategorized');
    assert.deepEqual(defaultAdapter.facts(product), factoryAdapter.facts(product));
  }
  assert.deepEqual(defaultAdapter.facts(createOldestHeadphonesPublicProduct()), []);
});

test('localized labels never merge distinct category groups', () => {
  const localized: HeadphonesContent = {
    ...content,
    list: {
      ...content.list,
      categories: content.list.categories.map(({ key }) => ({ key, label: 'Same translation' })),
    },
  };
  const adapter = createHeadphonesAdapter(localized);
  assert.deepEqual(
    localized.list.categories.map(({ key }) =>
      adapter.group(createPublicProduct({ category: key })),
    ),
    ['wired', 'office', 'bluetooth'],
  );
});

test('oldest, unknown, and uncategorized products retain grouping without mutation', () => {
  const adapter = createHeadphonesAdapter(content);
  const oldest = createOldestHeadphonesPublicProduct();
  Object.freeze(oldest);
  assert.equal(adapter.group(oldest), 'wired');
  assert.deepEqual(adapter.facts(oldest), []);
  assert.equal(oldest.slug, undefined);
  assert.equal(
    adapter.group(createPublicProduct({ category: 'historic-category' })),
    'historic-category',
  );
  assert.equal(adapter.group(createPublicProduct({ category: undefined })), 'uncategorized');
  assert.equal(adapter.group(createPublicProduct({ category: '' })), 'uncategorized');
});

test('facts project ordered identity fields only and ignore price and media changes', () => {
  const adapter = createHeadphonesAdapter(content);
  const product = createPublicProduct({
    series: 'SY',
    modName: 'T8',
    modType: 'TWS',
    productCode: 'SY-T8',
  });
  const expected = [
    { key: 'series', label: content.detail.seriesLabel, value: 'SY' },
    { key: 'model', label: content.detail.modelLabel, value: 'T8' },
    { key: 'type', label: content.detail.typeLabel, value: 'TWS' },
    { key: 'product-code', label: 'Product Code', value: 'SY-T8' },
  ];
  assert.deepEqual(adapter.facts(product), expected);
  assert.deepEqual(
    adapter.facts({
      ...product,
      moq: 100,
      unitPrice: 99,
      wholesalePrice: 88,
      alibabaPrimarySourceKey: 'linked',
      images: ['image'],
    }),
    expected,
  );
  assert.equal(adapter.group(product), adapter.group({ ...product, slug: undefined }));
});

test('localized fact labels and copy are isolated from the source content', () => {
  const localized = {
    list: { ...content.list, heading: 'Local heading', emptyStateLabel: 'Local empty' },
    detail: { ...content.detail, productCodeLabel: 'Local code' },
  };
  const adapter = createHeadphonesAdapter(localized);
  assert.equal(adapter.labels.heading, 'Local heading');
  assert.equal(adapter.emptyCopy, 'Local empty');
  assert.deepEqual(adapter.facts(createPublicProduct({ productCode: 'SKU' })), [
    { key: 'product-code', label: 'Local code', value: 'SKU' },
  ]);
  assert.notEqual(adapter.filterCapabilities, content.list.categories);
  assert.notEqual(adapter.filterCapabilities[0], content.list.categories[0]);
  const result = adapter.facts(createPublicProduct({ series: 'Series' }));
  assert.notEqual(result, adapter.facts(createPublicProduct({ series: 'Series' })));
  assert.deepEqual(
    adapter.facts(createPublicProduct({ series: '', modName: '', modType: '', productCode: '' })),
    [],
  );
});

function adapterDependencies(source: string): string[] {
  const parsed = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      dependencies.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      dependencies.push('dynamic-dependency');
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return dependencies.sort();
}

test('adapter imports only its family contract and content, including dynamic dependencies', () => {
  const source = readFileSync(new URL('./headphones.ts', import.meta.url), 'utf8');
  const allowed = ['../../i18n/headphones.ts', './catalog-family-adapter.ts'].sort();
  assert.deepEqual(adapterDependencies(source), allowed);
  for (const forbidden of [
    "import React from 'react';",
    "export { state } from '../application/state.ts';",
    "import('../presentation/CatalogCard.tsx');",
    "require('../pricing.ts');",
  ]) {
    assert.notDeepEqual(adapterDependencies(`${source}\n${forbidden}`), allowed);
  }
});
