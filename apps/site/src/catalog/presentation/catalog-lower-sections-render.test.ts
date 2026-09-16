import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import { CatalogDescriptionImages } from './CatalogDescriptionImages.tsx';
import { CatalogSpecifications } from './CatalogSpecifications.tsx';

const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter);
const copy: SharedDetailContent = parseDocument(frontmatter[1]).toJS().sharedDetail;

function renderSpecifications(
  overrides: Partial<ComponentProps<typeof CatalogSpecifications>> = {},
) {
  return renderToStaticMarkup(
    createElement(CatalogSpecifications, { facts: [], copy, ...overrides }),
  );
}

function visibleSection(html: string, attribute: string) {
  const section = html.match(
    new RegExp(`<section\\b[^>]*${attribute}[^>]*>[\\s\\S]*?<\\/section>`),
  );
  assert.ok(section, `${attribute} must render as a section`);
  assert.match(section[0], /<h2\b[^>]*>[^<]+<\/h2>/);
  assert.doesNotMatch(section[0], /<details\b|<summary\b|\bhidden(?:[\s=>"]|$)|aria-hidden="true"/);
  return section[0];
}

test('supplier notes are an always-visible section with escaped paragraph text', () => {
  const html = renderSpecifications({
    content: {
      schemaVersion: 'catalog-content-v1',
      specifications: [],
      packaging: [],
      notes: ['Supplier statement <script>unsafe()</script>', 'Additional information'],
    },
  });
  const notes = visibleSection(html, 'data-catalog-notes');
  assert.match(notes, /Supplier notes/);
  assert.match(notes, /<p[^>]*>Supplier statement &lt;script&gt;unsafe\(\)&lt;\/script&gt;<\/p>/);
  assert.match(notes, /<p[^>]*>Additional information<\/p>/);
  assert.match(notes, /max-w-\[70ch\]/);
  assert.doesNotMatch(notes, /<script\b/);
});

test('product specifications retain their open disclosure and existing fact layout', () => {
  const html = renderSpecifications({
    facts: [{ name: 'Material', value: 'ABS' }],
    description: 'Supplier information',
  });
  assert.match(html, /<details open="" class="border-b border-slate-200 py-6">/);
  assert.match(html, /<summary class="cursor-pointer [^"]*">[^<]+<\/summary>/);
  assert.match(html, /<dl class="mt-5 grid gap-x-10 md:grid-cols-2">/);
  assert.match(html, /<dt[^>]*>Material<\/dt>/);
  assert.match(html, /<dd[^>]*>ABS<\/dd>/);
  assert.equal((html.match(/<details\b/g) ?? []).length, 1);
  visibleSection(html, 'data-catalog-notes');
});

test('legacy descriptions remain visible trimmed paragraphs instead of inferred facts or HTML', () => {
  const notes = visibleSection(
    renderSpecifications({ description: '  Material\r\n\r\n ABS \n <b>Supplier text</b>  ' }),
    'data-catalog-notes',
  );
  assert.match(notes, /<p[^>]*>Material<\/p>/);
  assert.match(notes, /<p[^>]*>ABS<\/p>/);
  assert.match(notes, /<p[^>]*>&lt;b&gt;Supplier text&lt;\/b&gt;<\/p>/);
  assert.equal((notes.match(/<p\b/g) ?? []).length, 3);
  assert.doesNotMatch(notes, /<dt\b|<b>/);
});

test('visible note blocks retain headings paragraphs escaping and conflicting fact notes', () => {
  const notes = visibleSection(
    renderSpecifications({
      facts: [
        { name: 'Material', value: 'ABS' },
        { name: 'material', value: 'Metal' },
      ],
      content: {
        schemaVersion: 'catalog-content-v1',
        specifications: [],
        packaging: [],
        notes: ['Fallback text replaced by note blocks'],
      },
      noteBlocks: [
        { kind: 'heading', text: 'Supplier <b>heading</b>' },
        { kind: 'paragraph', text: 'Approved <script>note</script>' },
      ],
    }),
    'data-catalog-notes',
  );
  assert.match(notes, /<h3[^>]*>Supplier &lt;b&gt;heading&lt;\/b&gt;<\/h3>/);
  assert.match(notes, /<p[^>]*>Approved &lt;script&gt;note&lt;\/script&gt;<\/p>/);
  assert.ok(notes.includes('Material \u2014 ABS'));
  assert.ok(notes.includes('material \u2014 Metal'));
  assert.equal((notes.match(/<p\b/g) ?? []).length, 3);
  assert.doesNotMatch(notes, /Fallback text|<script\b|<b>/);
});

test('empty structured notes omit the notes section while specifications keep their empty state', () => {
  const html = renderSpecifications({
    content: {
      schemaVersion: 'catalog-content-v1',
      specifications: [],
      packaging: [],
      notes: [],
    },
  });
  assert.doesNotMatch(html, /data-catalog-notes|data-catalog-packaging/);
  assert.match(html, /<details open=""/);
  assert.ok(html.includes(copy.noFacts));
});

test('description images suppress the empty legacy text placeholder without hiding real notes', () => {
  assert.doesNotMatch(renderSpecifications({ hasDescriptionImages: true }), /data-catalog-notes/);
  const fallback = visibleSection(renderSpecifications(), 'data-catalog-notes');
  assert.ok(fallback.includes(copy.noDescription));
  const notes = visibleSection(
    renderSpecifications({ hasDescriptionImages: true, description: 'Text beside images' }),
    'data-catalog-notes',
  );
  assert.match(notes, /<p[^>]*>Text beside images<\/p>/);
});

test('empty description images render no section or placeholder', () => {
  assert.equal(renderToStaticMarkup(createElement(CatalogDescriptionImages, { images: [] })), '');
});

test('description images are visible without a disclosure and preserve authorized URL mapping', () => {
  const html = renderToStaticMarkup(
    createElement(CatalogDescriptionImages, {
      images: [
        '/api/catalog/images/public-photo',
        'api/catalog/images/relative-photo',
        'https://media.example.test/approved.jpg',
        'blob:https://admin.example.test/approved-preview',
      ],
    }),
  );
  const section = visibleSection(html, 'data-description-images');
  assert.match(section, /<h2[^>]*>Product description images \(4\)<\/h2>/);
  assert.match(section, /class="mx-auto mt-5 max-w-3xl space-y-4"/);
  const images = section.match(/<img\b[^>]*>/g) ?? [];
  const expectedUrls = [
    '/api/catalog/images/public-photo',
    '/api/catalog/images/relative-photo',
    'https://media.example.test/approved.jpg',
    'blob:https://admin.example.test/approved-preview',
  ];
  assert.equal(images.length, expectedUrls.length);
  for (const [index, image] of images.entries()) {
    assert.ok(image.includes(`src="${expectedUrls[index]}"`));
    assert.ok(image.includes(`alt="Product description ${index + 1}"`));
    assert.match(image, /loading="lazy"/);
    assert.match(image, /decoding="async"/);
    assert.match(image, /referrerPolicy="no-referrer"/i);
    assert.match(image, /class="h-auto w-full rounded-lg border border-slate-100 object-contain"/);
  }
  assert.doesNotMatch(html, /<link\b[^>]*rel="preload"/);
});

test('description image rendering retains the shared count cap and lazy loading', () => {
  const images = Array.from(
    { length: PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT + 2 },
    (_, index) => `/api/catalog/images/photo-${index + 1}`,
  );
  const html = renderToStaticMarkup(createElement(CatalogDescriptionImages, { images }));
  assert.equal((html.match(/<img\b/g) ?? []).length, PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT);
  assert.equal((html.match(/loading="lazy"/g) ?? []).length, PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT);
  assert.ok(
    html.includes(`src="/api/catalog/images/photo-${PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT}"`),
  );
  assert.ok(
    !html.includes(`src="/api/catalog/images/photo-${PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT + 1}"`),
  );
});
