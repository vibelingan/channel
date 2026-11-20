import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { parseDocument } from 'yaml';
import type { CatalogContent, SharedDetailContent } from '../../i18n/catalog.ts';
import { categoryPageIdentity } from '../../lib/seo/category-page-metadata.ts';
import { CatalogFamilyPage } from './CatalogFamilyPage.tsx';
import { CatalogPagination } from './CatalogPagination.tsx';
import {
  CATALOG_PAGE_SIZE,
  beginNumberedPage,
  catalogDeliveredPageCount,
  catalogDocumentTarget,
  catalogFilteredPathRedirect,
  catalogPagePath,
  catalogPathPage,
  catalogUrl,
  initialNumberedCatalogState,
} from './numbered-catalog-state.ts';

const raw = readFileSync(new URL('../../i18n/content/catalog/en-US.md', import.meta.url), 'utf8');
const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter);
const content: CatalogContent & { sharedDetail: SharedDetailContent } = parseDocument(
  frontmatter[1],
).toJS();
const family = content.families.find(({ key }) => key === 'headphones');
assert.ok(family);
const bootstrap = {
  page: 2,
  pageSize: 12,
  total: 25,
  items: [
    {
      _id: 'initial-product',
      name: 'Initial public product',
      description: 'Initial public description',
    },
  ],
};

test('family island renders public body and product and pagination links before browser effects', () => {
  const html = renderToString(
    createElement(CatalogFamilyPage, {
      content,
      family,
      previewContent: content.sharedDetail,
      bootstrap,
    }),
  );
  assert.match(html, /href="\/products\/p-initial-product\/"/);
  assert.match(html, /Initial public product/);
  assert.match(html, /Initial public description/);
  assert.match(html, /href="\/headphones\/page\/3\/"/);
  assert.equal((html.match(/data-product-card="/g) ?? []).length, 1);
  assert.doesNotMatch(html, /animate-pulse/);
});

test('refresh keeps the initial body while a complete current page is requested', () => {
  const initial = initialNumberedCatalogState(bootstrap);
  assert.equal(initial.committed?.page, 2);
  const pending = beginNumberedPage(initial, initial.requested);
  assert.deepEqual(pending.products, bootstrap.items);
  assert.equal(pending.pending, true);
  assert.equal(pending.committed?.page, 2);
});

test('unfiltered page URLs use finite paths; filters use the existing root query and keep metadata state', () => {
  assert.equal(catalogPagePath('headphones', 1), '/headphones/');
  assert.equal(catalogPathPage('/headphones/page/2/'), 2);
  assert.equal(catalogPathPage('/headphones/page/2'), 2);
  for (const pathname of [
    '/headphones/page/0/',
    '/headphones/page/-1/',
    '/headphones/page/1.5/',
    '/unknown/page/2/',
  ])
    assert.equal(catalogPathPage(pathname), null);
  assert.throws(() => catalogPagePath('toys', 0));
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/?page=2&utm_source=mail#models',
      { page: 2, search: '', categories: null },
      true,
    ),
    '/headphones/page/2/?utm_source=mail#models',
  );
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/page/2/?page=99',
      { page: 2, search: '', categories: null },
      true,
    ),
    '/headphones/page/2/',
  );
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/page/2/',
      { page: 2, search: 'usb', categories: ['wired'] },
      true,
    ),
    '/headphones/?page=2&search=usb&category=wired',
  );
});

test('an API-created page beyond the delivered snapshot stays on a working query URL', () => {
  const deliveredPages = catalogDeliveredPageCount({ total: 24 });
  assert.equal(deliveredPages, 2);
  assert.equal(catalogDeliveredPageCount({ total: 0 }), 1);
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/',
      { page: 2, search: '', categories: null },
      true,
      deliveredPages,
    ),
    '/headphones/page/2/',
  );
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/page/2/',
      { page: 3, search: '', categories: null },
      true,
      deliveredPages,
    ),
    '/headphones/?page=3',
  );
  assert.equal(
    catalogDocumentTarget(
      'https://example.test/headphones/page/2/',
      { page: 3, search: '', categories: null },
      deliveredPages,
    ),
    null,
  );
  assert.equal(
    catalogDocumentTarget(
      'https://example.test/headphones/?page=3',
      { page: 3, search: '', categories: null },
      deliveredPages,
    ),
    null,
  );
  assert.equal(
    catalogUrl(
      'https://example.test/headphones/?page=3',
      { page: 3, search: '', categories: null },
      true,
      catalogDeliveredPageCount({ total: 25 }),
    ),
    '/headphones/page/3/',
  );
});

test('equivalent no-slash documents keep page identity and do not fetch a different page', () => {
  assert.equal(
    catalogDocumentTarget(
      'https://example.test/headphones/page/2',
      { page: 2, search: '', categories: null },
      2,
    ),
    null,
  );
  assert.equal(
    catalogFilteredPathRedirect('https://example.test/headphones/page/2?category=wired'),
    '/headphones/?category=wired&page=2',
  );
  assert.equal(
    catalogDocumentTarget(
      'https://example.test/headphones/page/2',
      { page: 2, search: '', categories: null },
      2,
      2,
    ),
    null,
  );
  assert.equal(
    catalogDocumentTarget(
      'https://example.test/headphones/page/2/',
      { page: 2, search: '', categories: null },
      2,
      1,
    ),
    '/headphones/page/2/',
  );
});

test('root category metadata preserves each existing SEO title and full description', () => {
  for (const source of content.families) {
    const identity = categoryPageIdentity(
      source,
      { page: 1, pageCount: 2, path: source.href, revision: 'current' },
      'Existing Brand',
      'https://example.test',
    );
    assert.equal(identity.page.title, `${source.seoTitle} | Existing Brand`);
    assert.equal(identity.page.description, source.seoDescription);
    assert.equal(identity.page.canonicalPath, source.href);
  }
  assert.equal(family.seoTitle, 'OEM Headphone Manufacturer');
  assert.match(
    family.seoDescription,
    /MOQ from 500 units, OEM\/ODM customization, and global delivery/,
  );
});

test('pagination supplies real next/previous links and does not link outside the page set', () => {
  const html = renderToString(
    createElement(CatalogPagination, {
      page: 2,
      total: 25,
      pending: false,
      onPageChange: () => {},
      pageHref: (page) => catalogPagePath('headphones', page),
      nativeNavigation: true,
    }),
  );
  assert.match(html, /<a[^>]+href="\/headphones\/"[^>]+aria-label="Previous page"/);
  assert.match(html, /<a[^>]+href="\/headphones\/page\/3\/"[^>]+aria-label="Next page"/);
  assert.doesNotMatch(html, /page\/0|page\/4/);
});

test('large categories expose the middle pages through a bounded set of real links', () => {
  const lastPage = 39;
  const distance = new Map([[1, 0]]);
  const queue = [1];
  for (const page of queue) {
    const currentDistance = distance.get(page);
    assert.ok(currentDistance !== undefined);
    const html = renderToString(
      createElement(CatalogPagination, {
        page,
        total: lastPage * CATALOG_PAGE_SIZE,
        pending: false,
        onPageChange: () => {},
        pageHref: (target) => catalogPagePath('headphones', target),
        nativeNavigation: true,
      }),
    );
    const links = [...html.matchAll(/<a href="\/headphones\/(?:page\/(\d+)\/)?"/g)].map(
      ([, target]) => Number(target ?? 1),
    );
    assert.ok(links.length <= 8, `Pagination on page ${page} should stay compact`);
    for (const link of links) {
      assert.ok(link >= 1 && link <= lastPage, `Invalid page ${link} from page ${page}`);
      if (distance.has(link)) continue;
      distance.set(link, currentDistance + 1);
      queue.push(link);
    }
  }
  assert.equal(distance.size, lastPage);
  assert.ok(
    Math.max(...distance.values()) <= 5,
    `Furthest page is ${Math.max(...distance.values())} links from the category start`,
  );
});

test('mixed filtered paths and API shrinking-page recovery fetch the right document', () => {
  assert.equal(
    catalogFilteredPathRedirect('https://example.test/headphones/page/2/?category=wired#model'),
    '/headphones/?category=wired&page=2#model',
  );
  assert.equal(
    catalogFilteredPathRedirect('https://example.test/headphones/page/2/?search=usb&page=3'),
    '/headphones/?search=usb&page=3',
  );
  assert.equal(
    catalogFilteredPathRedirect('https://example.test/headphones/page/2/?utm_source=mail'),
    null,
  );
  assert.equal(
    catalogDocumentTarget('https://example.test/headphones/page/3/', {
      page: 2,
      search: '',
      categories: null,
    }),
    '/headphones/page/2/',
  );
  assert.equal(
    catalogDocumentTarget('https://example.test/headphones/page/2/', {
      page: 2,
      search: '',
      categories: null,
    }),
    null,
  );
});
