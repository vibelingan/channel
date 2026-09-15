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
let createAiGadgetsAdapter: typeof import('./ai-gadgets.ts')['createAiGadgetsAdapter'];
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
    '/src/catalog/families/ai-gadgets.ts',
  );
  assert.ok(typeof loaded.createAiGadgetsAdapter === 'function');
  createAiGadgetsAdapter = loaded.createAiGadgetsAdapter as typeof createAiGadgetsAdapter;
  defaultAdapter = loaded.aiGadgetsAdapter;
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
const family = content.families.find((candidate) => candidate.key === 'ai-gadgets');
assert.ok(family);
const aiFamily: CatalogFamilyContent = family;
const routeKeys = [
  'label',
  'href',
  'eyebrow',
  'heading',
  'description',
  'seoTitle',
  'seoDescription',
] as const;

test('AI gadgets exposes the exact existing route and list/detail copy without media', () => {
  const adapter = createAiGadgetsAdapter(content, aiFamily);
  assertCatalogFamilyAdapter(adapter);
  assert.equal(adapter.family, 'ai-gadgets');
  const expectedKeys: string[] = [];
  for (const [key, value] of Object.entries(content.list)) {
    expectedKeys.push(key);
    assert.equal(adapter.labels[key], value);
  }
  for (const key of routeKeys) {
    expectedKeys.push(key);
    assert.equal(adapter.labels[key], aiFamily[key]);
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
  assert.equal(adapter.emptyCopy, content.list.emptyLabel);
});

test('AI gadgets never inherits legacy filters or groups from content or stale product category', () => {
  const adapter = createAiGadgetsAdapter(content, {
    ...aiFamily,
    categories: [{ key: 'wired', label: 'Wired' }],
  });
  assert.deepEqual(adapter.filterCapabilities, []);
  for (const category of ['wired', 'office', 'bluetooth', 'unknown', '', undefined]) {
    const product = Object.freeze(createPublicProduct({ productFamily: 'ai-gadgets', category }));
    assert.equal(adapter.group(product), null);
    assert.deepEqual(adapter.facts(product), []);
  }
});

test('facts expose ordered identity metadata only, including on slugless old products', () => {
  const adapter = createAiGadgetsAdapter(content, aiFamily);
  const product = createPublicProduct({
    productFamily: 'ai-gadgets',
    category: undefined,
    series: 'Smart',
    modName: 'A1',
    modType: 'Translator',
    productCode: 'A1-OEM',
  });
  const expected = [
    { key: 'series', label: content.detail.seriesLabel, value: 'Smart' },
    { key: 'model', label: content.detail.modelLabel, value: 'A1' },
    { key: 'type', label: content.detail.typeLabel, value: 'Translator' },
    { key: 'product-code', label: 'Product Code', value: 'A1-OEM' },
  ];
  Object.freeze(product);
  assert.deepEqual(adapter.facts(product), expected);
  assert.deepEqual(
    adapter.facts({
      ...product,
      moq: 100,
      unitPrice: 42,
      wholesalePrice: 21,
      images: ['image'],
      alibabaPrimarySourceKey: 'linked',
    }),
    expected,
  );
  assert.equal(product.slug, undefined);
  assert.notEqual(adapter.facts(product), adapter.facts(product));
  assert.deepEqual(
    adapter.facts(
      createPublicProduct({
        productFamily: 'ai-gadgets',
        series: '',
        modName: '',
        modType: '',
        productCode: '',
      }),
    ),
    [],
  );
});

test('default export uses production Markdown and agrees with factory behavior', () => {
  assertCatalogFamilyAdapter(defaultAdapter);
  const adapter = createAiGadgetsAdapter(content, aiFamily);
  assert.equal(defaultAdapter.family, 'ai-gadgets');
  assert.deepEqual(defaultAdapter.labels, adapter.labels);
  assert.deepEqual(defaultAdapter.filterCapabilities, []);
  assert.equal(defaultAdapter.emptyCopy, content.list.emptyLabel);
  for (const product of [
    createPublicProduct({ productFamily: 'ai-gadgets', category: undefined }),
    createPublicProduct({
      productFamily: 'ai-gadgets',
      category: 'wired',
      series: 'Smart',
      modName: 'A1',
      modType: 'Translator',
      productCode: 'A1',
    }),
  ]) {
    assert.equal(defaultAdapter.group(product), null);
    assert.deepEqual(defaultAdapter.facts(product), adapter.facts(product));
  }
});

test('long localized copy stays plain data and does not alias mutable source content', () => {
  const longCopy = '<plain-copy>'.repeat(120);
  const localized = {
    list: { ...content.list, emptyLabel: longCopy },
    detail: { ...content.detail, productCodeLabel: longCopy },
  };
  const translatedFamily: CatalogFamilyContent = { ...aiFamily, heading: longCopy };
  const adapter = createAiGadgetsAdapter(localized, translatedFamily);
  assert.deepEqual(
    Object.keys(adapter).sort(),
    ['family', 'labels', 'filterCapabilities', 'group', 'facts', 'emptyCopy'].sort(),
  );
  assert.equal(adapter.emptyCopy, longCopy);
  assert.equal(adapter.labels.heading, longCopy);
  assert.deepEqual(
    adapter.facts(createPublicProduct({ productFamily: 'ai-gadgets', productCode: longCopy })),
    [{ key: 'product-code', label: longCopy, value: longCopy }],
  );
  localized.detail.productCodeLabel = 'Changed';
  translatedFamily.heading = 'Changed';
  assert.equal(adapter.labels.heading, longCopy);
  assert.equal(adapter.labels['detail.productCodeLabel'], longCopy);
  assert.deepEqual(
    adapter.facts(createPublicProduct({ productFamily: 'ai-gadgets', productCode: longCopy })),
    [{ key: 'product-code', label: longCopy, value: longCopy }],
  );
  assert.ok(Object.values(adapter.labels).every((value) => typeof value === 'string'));
});

test('a different family cannot silently give AI gadgets another route or identity', () => {
  assert.throws(() => createAiGadgetsAdapter(content, { ...aiFamily, key: 'toys' }), {
    name: 'TypeError',
    message: 'Expected ai-gadgets content',
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

test('family dependency boundary excludes UI, state and pricing with negative controls', () => {
  const source = readFileSync(new URL('./ai-gadgets.ts', import.meta.url), 'utf8');
  const allowed = ['../../i18n/catalog.ts', './catalog-family-adapter.ts'].sort();
  assert.deepEqual(dependencies(source), allowed);
  for (const forbidden of [
    "import React from 'react';",
    "export { state } from '../application/state.ts';",
    "import('../presentation/CatalogCard.tsx');",
    "require('../pricing.ts');",
  ]) {
    assert.notDeepEqual(dependencies(`${source}\n${forbidden}`), allowed);
  }
});
