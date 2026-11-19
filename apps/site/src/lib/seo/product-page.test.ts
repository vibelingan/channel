import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { ProductLanding } from '../../islands/shop/ProductLanding.tsx';
import { LegacySkuDetailPage, SkuDetailView } from '../../islands/shop/SkuDetailPage.tsx';
import { isPlainProductClick, productPath } from './product-identity.ts';
import { duplicateProductTitleIds, productPageDescriptor } from './product-page.ts';
import {
  type ProductSnapshotEntry,
  collectProductSnapshotWithImages,
  decodeProductSnapshot,
  readProductSnapshot,
} from './product-snapshot.ts';

const source = readFileSync(
  new URL('../../i18n/content/catalog/en-US.md', import.meta.url),
  'utf8',
);
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(match);
const content: CatalogContent & { sharedDetail: SharedDetailContent } = parseDocument(
  match[1],
).toJS();
const product = { _id: 'canonical-product', name: 'Headset', description: 'Legacy public body.' };
test('initial HTML uses the existing detail view for both canonical and no-slug legacy products', () => {
  for (const bootstrap of [
    undefined,
    { ...detailFixture(), revision: 'approved-r1', descriptionText: 'Approved public body.' },
  ]) {
    const canonicalPath = productPath(product._id);
    const view = bootstrap
      ? createElement(ProductLanding, { bootstrap, copy: content.sharedDetail, canonicalPath })
      : createElement(LegacySkuDetailPage, {
          initialProduct: product,
          productId: product._id,
          content,
          canonicalPath,
        });
    const html = renderToStaticMarkup(view);
    assert.match(html, /<h1[^>]*>Headset<\/h1>/);
    assert.match(html, bootstrap ? /Approved public body\./ : /Legacy public body\./);
    assert.doesNotMatch(html, /Loading product|data-catalog-schema/);
  }
});

test('capture, save and initial HTML retain configuration-photo sizes separately from the strict legacy content snapshot', async (t) => {
  const general = '/api/images/general-photo';
  const source = '/api/images/configuration-photo';
  const candidates = [{ url: `${source}?w=640`, width: 640, height: 400 }];
  const fixture = detailFixture(1);
  const publicProduct = {
    ...product,
    images: [general],
    imagePresentation: { [general]: [{ url: `${general}?w=160`, width: 160, height: 100 }] },
  };
  const detail = {
    ...fixture,
    images: [source],
    imagePresentation: { [source]: candidates },
    variants: {
      ...fixture.variants,
      items: fixture.variants.items.map((variant) => ({ ...variant, images: [source] })),
    },
  };
  const requests: URL[] = [];
  const capture = await collectProductSnapshotWithImages(
    'https://example.com',
    'https://example.com',
    async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json({
        ok: true,
        data: url.pathname.endsWith('/detail')
          ? detail
          : { items: [publicProduct], page: 1, pageSize: 48, total: 1 },
      });
    },
  );
  assert.equal(requests.length, 4, 'no extra image acquisition requests');
  assert.equal(
    requests.filter(
      (url) =>
        url.pathname.endsWith('/detail') && url.searchParams.get('media') === 'responsive-v1',
    ).length,
    1,
  );
  assert.equal(capture.snapshot.products[0]?.detail?.imagePresentation, undefined);
  assert.deepEqual(
    decodeProductSnapshot(capture.snapshot, 'https://example.com'),
    capture.snapshot,
  );
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-images-'));
  const previous = process.env.SEO_CATALOG_SNAPSHOT;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) Reflect.deleteProperty(process.env, 'SEO_CATALOG_SNAPSHOT');
    else process.env.SEO_CATALOG_SNAPSHOT = previous;
  });
  const file = join(directory, 'products.json');
  writeFileSync(file, JSON.stringify(capture.snapshot));
  writeFileSync(`${file}.images.json`, JSON.stringify(capture.images));
  process.env.SEO_CATALOG_SNAPSHOT = file;
  const rendered = (await readProductSnapshot('https://example.com')).products[0];
  assert.ok(rendered?.detail);
  const html = renderToStaticMarkup(
    createElement(ProductLanding, {
      bootstrap: rendered.detail,
      imagePresentation: rendered.product.imagePresentation,
      copy: content.sharedDetail,
      canonicalPath: productPath(product._id),
    }),
  );
  assert.match(html, /srcSet="[^"]*configuration-photo\?w=640 640w/);
  assert.doesNotMatch(html, /general-photo\?w=160/);
});
test('one stable identity drives metadata schema and breadcrumbs without inferring variant-wide offers', () => {
  const detail = {
    ...detailFixture(51),
    revision: 'approved-r1',
    descriptionText: 'Public summary.',
  };
  const page = productPageDescriptor(
    { product, detail, revision: detail.revision ?? '' },
    'https://example.com',
    'Brand',
  );
  assert.equal(page.canonicalPath, '/products/p-canonical-product/');
  assert.match(page.description, /Public summary/);
  assert.doesNotMatch(JSON.stringify(page.schemaNodes), /localhost|products\/item|Offer/);
  assert.equal(page.robots, 'index,follow');
  assert.equal(page.content.revision, detail.revision);
  assert.ok(page.schemaNodes.every((node) => node['@type'] !== 'Product'));
  const breadcrumb = page.schemaNodes.find((node) => node['@type'] === 'BreadcrumbList');
  const items = breadcrumb?.itemListElement;
  assert.ok(Array.isArray(items));
  assert.equal(items.at(-1)?.item, 'https://example.com/products/p-canonical-product/');
});
test('plain clicks expand in place and modifier clicks retain native link navigation', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(isPlainProductClick(click), true);
  for (const field of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])
    assert.equal(isPlainProductClick({ ...click, [field]: true }), false);
  assert.equal(isPlainProductClick({ ...click, button: 1 }), false);
  assert.throws(() => productPath('../admin'));
});

test('legacy refresh errors retain public body and expose a retry instead of failing silently', () => {
  const html = renderToStaticMarkup(
    createElement(SkuDetailView, {
      content,
      canonicalPath: productPath(product._id),
      state: { status: 'ready', product, related: [], refreshError: true },
      onRetry: () => {},
    }),
  );
  assert.match(html, /Legacy public body/);
  assert.match(html, /role="alert"/);
  assert.ok(html.includes(content.list.retryLabel));
});

test('first delivery uses the existing dynamic route and later acceptance restores its stable URL', async () => {
  const { productBrowserPath } = await import('./product-identity.ts');
  assert.equal(
    productBrowserPath({ ...product, publicPageReady: false }),
    '/products/item/?id=canonical-product',
  );
  assert.equal(productBrowserPath({ ...product, publicPageReady: true }), productPath(product._id));
  assert.equal(productBrowserPath(product), productPath(product._id));
  const page = productPageDescriptor(
    {
      product,
      revision: 'legacy',
      publicVersion: { sequence: 1, semanticHash: 'a'.repeat(64), changedAt: null },
    },
    'https://example.com',
    'Brand',
  );
  assert.equal(page.content.updatedAt, undefined);
  const updated = productPageDescriptor(
    {
      product,
      revision: 'legacy',
      publicVersion: {
        sequence: 2,
        semanticHash: 'b'.repeat(64),
        changedAt: '2026-10-30T00:00:00.000Z',
      },
    },
    'https://example.com',
    'Brand',
  );
  assert.equal(updated.content.updatedAt, '2026-10-30T00:00:00.000Z');
});

function metadataEntry(id: string, name: string, description = ''): ProductSnapshotEntry {
  return { product: { ...product, _id: id, name, description }, revision: 'metadata-r1' };
}
const metadata = (
  entry: ProductSnapshotEntry,
  brand = 'Diversity Innovations Limited',
  duplicate = false,
) => productPageDescriptor(entry, 'https://example.com', brand, duplicate);
const characters = (text: string) => Array.from(text).length;

test('short titles keep the brand only when the complete name and brand fit', () => {
  assert.equal(
    metadata(metadataEntry('short', 'Headset')).title,
    'Headset | Diversity Innovations Limited',
  );
  const name = 'Wireless over-ear headphones for everyday listening';
  assert.equal(metadata(metadataEntry('full-name', name)).title, name);
  assert.equal(
    metadata(metadataEntry('long-brand', 'Headset'), 'Brand'.repeat(30)).title,
    'Headset',
  );
});

test('the real long imported name and summary fit display budgets without changing public content', () => {
  const name =
    'High Quality Foldable Headband Headphones Wireless Headset Wireless Headphones With Noise Cancellations';
  const summary =
    'Experienced Headphones Manufacturer Channel Technology Ltd is engaged in the research, development, production, and sale of wired and wireless headsets. Established in 2004, we export headphones.';
  const entry = metadataEntry('01121e8b-9503-4095-a889-0742a14c7f4c', name, summary);
  const page = metadata(entry);
  assert.ok(characters(page.title) <= 65);
  assert.ok(characters(page.description) <= 160);
  assert.equal(page.title, 'High Quality Foldable Headband Headphones Wireless Headset…');
  assert.match(page.description, /…$/u);
  assert.doesNotMatch(page.description, /we exp(?:…|$)/u);
  assert.ok(summary.includes(page.description.slice(name.length + 2, -1)));
  const html = renderToStaticMarkup(
    createElement(LegacySkuDetailPage, {
      initialProduct: entry.product,
      productId: entry.product._id,
      content,
      canonicalPath: productPath(entry.product._id),
    }),
  );
  assert.deepEqual(
    [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => match[1]),
    [name],
  );
  assert.equal(entry.product.name, name);
  assert.equal(entry.product.description, summary);
  const breadcrumbs = page.schemaNodes.find((node) => node['@type'] === 'BreadcrumbList');
  assert.ok(Array.isArray(breadcrumbs?.itemListElement));
  assert.equal(breadcrumbs.itemListElement.at(-1)?.name, name);
});

test('identical names retain each complete UUID within the title budget', () => {
  const entries = [
    metadataEntry('01121e8b-9503-4095-a889-0742a14c7f4c', 'Wireless headphones for everyday use'),
    metadataEntry('804ee5b9-209c-41b7-ae91-9c854fc8d1b4', 'Wireless headphones for everyday use'),
  ];
  const duplicates = duplicateProductTitleIds(entries, 'Diversity Innovations Limited');
  assert.deepEqual(duplicates, new Set(entries.map((entry) => entry.product._id)));
  const titles = entries.map(
    (entry) =>
      metadata(entry, 'Diversity Innovations Limited', duplicates.has(entry.product._id)).title,
  );
  const descriptions = entries.map(
    (entry) =>
      metadata(entry, 'Diversity Innovations Limited', duplicates.has(entry.product._id))
        .description,
  );
  assert.equal(new Set(titles).size, 2);
  assert.equal(new Set(descriptions).size, 2);
  for (const [index, title] of titles.entries()) {
    assert.ok(title.includes(`(${entries[index].product._id})`));
    assert.ok(characters(title) <= 65);
    assert.ok(descriptions[index].endsWith(`(${entries[index].product._id})`));
    assert.ok(characters(descriptions[index]) <= 160);
  }
});

test('different long names with the same shortened prefix receive identities too', () => {
  const prefix =
    'Wireless over-ear headphones for comfortable listening at home and while travelling';
  const entries = [
    metadataEntry('prefix-one', `${prefix} with a blue finish`),
    metadataEntry('prefix-two', `${prefix} with a purple finish`),
  ];
  assert.equal(metadata(entries[0]).title, metadata(entries[1]).title);
  const duplicates = duplicateProductTitleIds(entries, 'Diversity Innovations Limited');
  const titles = entries.map(
    (entry) =>
      metadata(entry, 'Diversity Innovations Limited', duplicates.has(entry.product._id)).title,
  );
  assert.equal(duplicates.size, 2);
  assert.equal(new Set(titles).size, 2);
  assert.ok(titles.every((title) => characters(title) <= 65));
});

test('adding an identity cannot collide with another existing product title', () => {
  const entries = [
    metadataEntry('one', 'Headset'),
    metadataEntry('two', 'Headset'),
    metadataEntry('three', 'Headset (one)'),
  ];
  const duplicates = duplicateProductTitleIds(entries, 'Brand');
  assert.deepEqual(duplicates, new Set(['one', 'two', 'three']));
  const titles = entries.map(
    (entry) => metadata(entry, 'Brand', duplicates.has(entry.product._id)).title,
  );
  assert.equal(new Set(titles).size, 3);
});

test('Unicode and unspaced names stay readable without splitting surrogate pairs', () => {
  for (const name of ['🎧'.repeat(80), '无线头戴式耳机'.repeat(20), 'Headphones'.repeat(20)]) {
    const page = metadata(metadataEntry('unicode', name, name));
    assert.equal(characters(page.title), 65);
    assert.ok(characters(page.description) <= 160);
    assert.ok(page.title.startsWith(Array.from(name)[0]));
    assert.match(page.title, /…$/u);
    assert.doesNotMatch(page.title, /[\uD800-\uDFFF]/u);
  }
});

test('an exceptionally long historical identity takes priority over the soft title budget', () => {
  const id = `historical-${'a'.repeat(150)}`;
  const entry = metadataEntry(id, 'Headset');
  const page = metadata(entry, 'Brand', true);
  assert.equal(page.title, `Headset (${id})`);
  assert.ok(characters(page.title) > 65);
  assert.ok(page.description.endsWith(`(${id})`));
  assert.equal(page.canonicalPath, productPath(id));
});

test('the complete description is shortened on a word boundary and normalizes whitespace', () => {
  const page = metadata(
    metadataEntry(
      'description',
      '  Headset\n for travel ',
      `${'clear information '.repeat(20)}we export products`,
    ),
  );
  assert.ok(characters(page.description) <= 160);
  assert.match(page.description, /^Headset for travel\. clear information/);
  assert.match(page.description, /(?:clear|information)…$/u);
  assert.doesNotMatch(page.description, /\s{2}|\n/);
  assert.equal(
    metadata(metadataEntry('empty-summary', 'Headset')).description,
    'Headset. View product specifications, photos and quotation options.',
  );
});
