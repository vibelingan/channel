import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@astrojs/compiler';
import type { Node as AstroNode, ComponentNode } from '@astrojs/compiler/types';
import ts from 'typescript';
import { parseDocument } from 'yaml';
import { includeInSitemap, isSitemapPathIncluded } from '../../astro.config.ts';

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const noindexTopLevelPages = new Set([
  'account.astro',
  'admin.astro',
  'login.astro',
  'oem_submit_result.astro',
  'register.astro',
  'reset.astro',
]);

const parseFrontmatter = (relativePath: string) => {
  const source = read(relativePath);
  const frontmatterSource = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatterSource, `${relativePath} has YAML frontmatter`);
  const document = parseDocument(frontmatterSource[1], { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS() as {
    brand?: { name: string };
    meta?: { title: string; description: string };
    hub?: { seoTitle: string; seoDescription: string };
    families?: Array<{ key: string; seoTitle: string; seoDescription: string }>;
  };
};

const evaluateMetadataValue = (
  initializer: ts.Expression,
  brandName: string,
  variableName: string,
) => {
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.text;
  }
  assert.ok(ts.isTemplateExpression(initializer), `${variableName} must be a string literal`);

  let value = initializer.head.text;
  for (const span of initializer.templateSpans) {
    assert.ok(
      ts.isPropertyAccessExpression(span.expression) &&
        ts.isIdentifier(span.expression.expression) &&
        span.expression.expression.text === 'brand' &&
        span.expression.name.text === 'name',
      `${variableName} only supports the brand.name interpolation`,
    );
    value += brandName + span.literal.text;
  }
  return value;
};

const extractPageMetadata = (relativePath: string, brandName: string) => {
  const source = read(relativePath);
  const scriptSource = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  assert.ok(scriptSource, `${relativePath} has an Astro frontmatter script`);
  const script = ts.createSourceFile(relativePath, scriptSource, ts.ScriptTarget.Latest, true);
  const values = new Map<string, string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'seoTitle' || node.name.text === 'seoDescription') &&
      node.initializer
    ) {
      values.set(
        node.name.text,
        evaluateMetadataValue(node.initializer, brandName, node.name.text),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(script);

  const title = values.get('seoTitle');
  const description = values.get('seoDescription');
  assert.ok(title, `${relativePath} defines seoTitle`);
  assert.ok(description, `${relativePath} defines seoDescription`);
  return { title, description };
};

const assertBaseLayoutBindings = async (
  relativePath: string,
  expected: { title: string; description: string },
) => {
  const { ast, diagnostics } = await parse(read(relativePath));
  assert.deepEqual(diagnostics, []);
  const layouts: ComponentNode[] = [];
  const visit = (node: AstroNode) => {
    if (node.type === 'component' && node.name === 'BaseLayout') layouts.push(node);
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(ast);
  assert.equal(layouts.length, 1, `${relativePath} renders one BaseLayout`);
  assert.ok(
    layouts[0].attributes.every((attribute) => attribute.kind !== 'spread'),
    `${relativePath} BaseLayout does not allow attribute spreads`,
  );
  const attributes = new Map(
    layouts[0].attributes.map((attribute) => [
      attribute.name,
      { kind: attribute.kind, value: attribute.value },
    ]),
  );
  assert.deepEqual(attributes.get('title'), { kind: 'expression', value: expected.title });
  assert.deepEqual(attributes.get('description'), {
    kind: 'expression',
    value: expected.description,
  });
};

const routablePageFiles = (relativeDirectory = '../pages', prefix = ''): string[] => {
  const directory = fileURLToPath(new URL(relativeDirectory, import.meta.url));
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) return [];
      return routablePageFiles(`${relativeDirectory}/${entry.name}`, `${relativePath}/`);
    }
    return entry.name.endsWith('.astro') && !entry.name.startsWith('_') ? [relativePath] : [];
  });
};

test('public pages keep dedicated SEO metadata within review limits', async () => {
  const routablePublicPages = routablePageFiles()
    .filter((fileName) => !noindexTopLevelPages.has(fileName))
    .sort();

  const site = parseFrontmatter('../i18n/content/en-US.md');
  const oem = parseFrontmatter('../i18n/content/oem/en-US.md');
  const portfolio = parseFrontmatter('../i18n/content/portfolio/en-US.md');
  const catalog = parseFrontmatter('../i18n/content/catalog/en-US.md');
  assert.ok(site.brand);
  assert.ok(oem.meta);
  assert.ok(portfolio.meta);
  assert.ok(catalog.hub);
  assert.ok(catalog.families);
  assert.ok(oem.meta.title.trim());
  assert.ok(oem.meta.description.trim());
  assert.ok(portfolio.meta.title.trim());
  assert.ok(portfolio.meta.description.trim());
  const brandName = site.brand.name;
  const familyMetadata = new Map(catalog.families.map((family) => [family.key, family]));
  const headphones = familyMetadata.get('headphones');
  const aiGadgets = familyMetadata.get('ai-gadgets');
  const toys = familyMetadata.get('toys');
  const misc = familyMetadata.get('misc');
  assert.ok(headphones);
  assert.ok(aiGadgets);
  assert.ok(toys);
  assert.ok(misc);

  const metadata = [
    {
      name: 'home',
      ...extractPageMetadata('../pages/index.astro', brandName),
    },
    {
      name: 'oem',
      title: `${oem.meta.title} — ${brandName}`,
      description: oem.meta.description,
    },
    {
      name: 'portfolio',
      title: `${portfolio.meta.title} — ${brandName}`,
      description: portfolio.meta.description,
    },
    {
      name: 'headphones',
      title: `${headphones.seoTitle} | ${brandName}`,
      description: headphones.seoDescription,
    },
    {
      name: 'electronics-toys',
      title: `${catalog.hub.seoTitle} | ${brandName}`,
      description: catalog.hub.seoDescription,
    },
    {
      name: 'ai-gadgets',
      title: `${aiGadgets.seoTitle} | ${brandName}`,
      description: aiGadgets.seoDescription,
    },
    {
      name: 'toys',
      title: `${toys.seoTitle} | ${brandName}`,
      description: toys.seoDescription,
    },
    {
      name: 'misc',
      title: `${misc.seoTitle} | ${brandName}`,
      description: misc.seoDescription,
    },
    {
      name: 'products/item',
      ...extractPageMetadata('../pages/products/item.astro', brandName),
    },
  ];

  assert.deepEqual(
    metadata.map(({ name }) => `${name === 'home' ? 'index' : name}.astro`).sort(),
    routablePublicPages,
    'every discovered public route has audited metadata',
  );

  for (const { name, title, description } of metadata) {
    assert.ok(title.length <= 60, `${name} title is ${title.length} characters`);
    assert.ok(description.length <= 160, `${name} description is ${description.length} characters`);
  }

  assert.equal(new Set(metadata.map(({ title }) => title)).size, metadata.length);
  assert.equal(new Set(metadata.map(({ description }) => description)).size, metadata.length);

  await Promise.all([
    assertBaseLayoutBindings('../pages/index.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/headphones.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/electronics-toys.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/ai-gadgets.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/toys.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/misc.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/products/item.astro', {
      title: 'seoTitle',
      description: 'seoDescription',
    }),
    assertBaseLayoutBindings('../pages/oem.astro', {
      title: '`${meta.title} — ${brand.name}`',
      description: 'meta.description',
    }),
    assertBaseLayoutBindings('../pages/portfolio.astro', {
      title: '`${meta.title} — ${brand.name}`',
      description: 'meta.description',
    }),
  ]);
});

test('sitemap follows published catalog content and excludes private routes', () => {
  for (const path of ['/electronics-toys/', '/headphones/', '/ai-gadgets/', '/toys/', '/misc/']) {
    assert.equal(includeInSitemap(`https://example.test${path}`), true, path);
  }
  for (const path of ['/admin/', '/login/', '/register/', '/products/item/', '/success-stories/']) {
    assert.equal(includeInSitemap(`https://example.test${path}`), false, path);
  }
  assert.equal(
    isSitemapPathIncluded('/misc', new Set(['/headphones', '/ai-gadgets', '/toys'])),
    false,
    'known family absent from published catalog content is excluded',
  );
});

test('dynamic SKU shell stays noindex-follow until product metadata is server-rendered', () => {
  const source = read('../pages/products/item.astro');
  assert.match(source, /robots="noindex,follow"/);
  assert.doesNotMatch(source, /schemaNodes|['"]@type['"]\s*:\s*['"](?:Product|Offer)['"]/);
});
