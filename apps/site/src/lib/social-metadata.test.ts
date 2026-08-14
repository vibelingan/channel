import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@astrojs/compiler';
import type {
  Node as AstroNode,
  AttributeNode,
  ComponentNode,
  ElementNode,
  ExpressionNode,
} from '@astrojs/compiler/types';
import sharp from 'sharp';

const layoutPath = new URL('../layouts/BaseLayout.astro', import.meta.url);
const layoutSource = readFileSync(fileURLToPath(layoutPath), 'utf8');

const attribute = (node: ElementNode | ComponentNode, name: string): AttributeNode | undefined =>
  node.attributes.find((candidate) => candidate.name === name);

test('public pages expose a complete default Open Graph and Twitter card contract', async () => {
  const { ast, diagnostics } = await parse(layoutSource);
  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.severity === 1),
    [],
  );
  const metaNodes: Array<{ node: ElementNode; expressions: ExpressionNode[] }> = [];
  const visit = (node: AstroNode, expressions: ExpressionNode[] = []) => {
    const nextExpressions = node.type === 'expression' ? [...expressions, node] : expressions;
    if (node.type === 'element' && node.name === 'meta') {
      metaNodes.push({ node, expressions: nextExpressions });
    }
    if ('children' in node) {
      for (const child of node.children) visit(child, nextExpressions);
    }
  };
  visit(ast);

  const byProperty = new Map(
    metaNodes
      .filter(({ node }) => attribute(node, 'property')?.kind === 'quoted')
      .map(({ node }) => {
        const content = attribute(node, 'content');
        return [
          attribute(node, 'property')?.value,
          content ? { kind: content.kind, value: content.value } : undefined,
        ];
      }),
  );
  const byName = new Map(
    metaNodes
      .filter(({ node }) => attribute(node, 'name')?.kind === 'quoted')
      .map(({ node }) => {
        const content = attribute(node, 'content');
        return [
          attribute(node, 'name')?.value,
          content ? { kind: content.kind, value: content.value } : undefined,
        ];
      }),
  );

  const expectedOpenGraph = {
    'og:type': { kind: 'quoted', value: 'website' },
    'og:site_name': { kind: 'quoted', value: 'Diversity Technology' },
    'og:title': { kind: 'expression', value: 'title' },
    'og:description': { kind: 'expression', value: 'description' },
    'og:url': { kind: 'expression', value: 'canonicalUrl.href' },
    'og:image': { kind: 'expression', value: 'socialImageUrl.href' },
    'og:image:secure_url': { kind: 'expression', value: 'socialImageUrl.href' },
    'og:image:type': { kind: 'expression', value: 'socialImage.mimeType' },
    'og:image:width': { kind: 'expression', value: 'String(socialImage.width)' },
    'og:image:height': { kind: 'expression', value: 'String(socialImage.height)' },
    'og:image:alt': { kind: 'expression', value: 'socialImage.alt' },
    'og:locale': { kind: 'quoted', value: 'en_US' },
  } as const;
  for (const [property, expected] of Object.entries(expectedOpenGraph)) {
    assert.deepEqual(byProperty.get(property), expected, `${property} uses the reviewed value`);
  }

  const expectedTwitter = {
    'twitter:card': { kind: 'quoted', value: 'summary_large_image' },
    'twitter:title': { kind: 'expression', value: 'title' },
    'twitter:description': { kind: 'expression', value: 'description' },
    'twitter:image': { kind: 'expression', value: 'socialImageUrl.href' },
    'twitter:image:alt': { kind: 'expression', value: 'socialImage.alt' },
  } as const;
  for (const [name, expected] of Object.entries(expectedTwitter)) {
    assert.deepEqual(byName.get(name), expected, `${name} uses the reviewed value`);
  }

  const socialMetaNodes = metaNodes.filter(({ node }) => {
    const property = attribute(node, 'property')?.value;
    const name = attribute(node, 'name')?.value;
    return property?.startsWith('og:') || name?.startsWith('twitter:');
  });
  assert.equal(socialMetaNodes.length, 17);
  for (const { node, expressions } of socialMetaNodes) {
    const key = attribute(node, 'property')?.value ?? attribute(node, 'name')?.value;
    assert.ok(
      node.attributes.every((candidate) => candidate.kind !== 'spread'),
      `${key} does not allow duplicate/override spreads`,
    );
    assert.equal(expressions.length, 1, `${key} has one public-only ancestor`);
    const meaningfulText = expressions[0].children
      .filter((child) => child.type === 'text')
      .map((child) => child.value.trim())
      .filter(Boolean);
    assert.deepEqual(meaningfulText, ['!noindex && (', ')'], `${key} stays public-only`);
  }

  assert.match(layoutSource, /socialImage\?: SocialImage/);
  assert.match(layoutSource, /socialImage = defaultSocialImage/);
  assert.match(layoutSource, /const socialImageUrl = new URL\(socialImage\.path, siteOrigin\)/);
  assert.match(layoutSource, /path: '\/media\/social\/oem-manufacturing-og\.png'/);
  assert.match(layoutSource, /width: 1200/);
  assert.match(layoutSource, /height: 630/);
  assert.match(layoutSource, /mimeType: 'image\/png'/);
});

test('private pages keep the noindex input that suppresses social metadata', async () => {
  const privatePages = ['account', 'admin', 'login', 'register', 'reset', 'oem_submit_result'];

  for (const pageName of privatePages) {
    const pagePath = new URL(`../pages/${pageName}.astro`, import.meta.url);
    const { ast, diagnostics } = await parse(readFileSync(fileURLToPath(pagePath), 'utf8'));
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity === 1),
      [],
      `${pageName} parses without errors`,
    );

    const layouts: ComponentNode[] = [];
    const visit = (node: AstroNode) => {
      if (node.type === 'component' && node.name === 'BaseLayout') layouts.push(node);
      if ('children' in node) {
        for (const child of node.children) visit(child);
      }
    };
    visit(ast);

    assert.equal(layouts.length, 1, `${pageName} renders one BaseLayout`);
    const noindex = attribute(layouts[0], 'noindex');
    assert.deepEqual(
      noindex && { name: noindex.name, kind: noindex.kind, value: noindex.value },
      { name: 'noindex', kind: 'empty', value: '' },
      `${pageName} remains noindex`,
    );
  }
});

test('default social image is a reviewed 1200x630 PNG', async () => {
  const imagePath = fileURLToPath(
    new URL('../../public/media/social/oem-manufacturing-og.png', import.meta.url),
  );
  assert.ok(existsSync(imagePath), 'default social image exists');
  const imageBytes = readFileSync(imagePath);
  assert.equal(
    createHash('sha256').update(imageBytes).digest('hex'),
    '06ed099bed2cfb640d115dd8c4b5f10432bee6214e01a16efad8d5c06e5b37c2',
  );
  const metadata = await sharp(imagePath).metadata();
  assert.equal(metadata.format, 'png');
  assert.deepEqual(metadata.autoOrient, { width: 1200, height: 630 });
});
