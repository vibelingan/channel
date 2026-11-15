import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectPage, validateManifest, validateSitemapIndex } from './output-gate.ts';
import { createPageDescriptor, serializePageDescriptor } from './page.ts';

const origin = 'https://example.test';
function fixture(
  path = '/example/',
  kind: 'marketing' | 'product' | 'article' = 'marketing',
  productSchema?: Record<string, unknown> | null,
) {
  const page = createPageDescriptor({
    path,
    kind,
    title: `Title ${path}`,
    description: `Description ${path}`,
    content: { source: kind === 'marketing' ? 'site-content' : `public-${kind}`, revision: '1' },
  });
  const url = `${origin}${path}`;
  const product =
    productSchema === undefined
      ? {
          '@type': 'Product',
          name: 'Example',
          url,
          offers: { '@type': 'Offer', price: '3.10', priceCurrency: 'USD' },
        }
      : productSchema;
  const nodes = [
    { '@type': 'WebPage', url },
    ...(kind === 'marketing'
      ? []
      : [
          ...(kind === 'product' ? (product ? [product] : []) : [{ '@type': 'Article', url }]),
          {
            '@type': 'BreadcrumbList',
            itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Example', item: url }],
          },
        ]),
  ];
  return `<!doctype html><html><head><title>${page.title}</title><meta name="description" content="${page.description}"><link rel="canonical" href="${url}"><meta property="og:url" content="${url}"><meta property="og:title" content="${page.title}"><meta property="og:description" content="${page.description}"><script type="application/json" id="channel-page-descriptor">${serializePageDescriptor(page)}</script><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes })}</script></head><body><main><h1>Example</h1><p>Public body content rendered before JavaScript.</p></main></body></html>`;
}

test('rendered product/article fixtures and manifest share their canonical identity', async () => {
  const entries = await Promise.all(
    ['product', 'article'].map((kind) => {
      const path = kind === 'product' ? '/products/example/' : '/blog/example/';
      return inspectPage(fixture(path, kind as 'product' | 'article'), path, origin);
    }),
  );
  assert.doesNotThrow(() =>
    validateManifest(
      entries,
      entries.map((entry) => entry.canonicalUrl),
    ),
  );
});

test('product pages can use ordinary WebPage and Breadcrumb markup without a Product rich result', async () => {
  const path = '/products/example/';
  const page = await inspectPage(fixture(path, 'product', null), path, origin);
  assert.equal(page.kind, 'product');
  assert.equal(page.robots, 'index,follow');
  assert.equal(page.canonicalUrl, `${origin}${path}`);
});

test('gate rejects incomplete Product markup rather than treating a field name as a valid rich result', async () => {
  const path = '/products/example/';
  const product = { '@type': 'Product', name: 'Example', url: `${origin}${path}` };
  for (const invalid of [
    product,
    { ...product, offers: {} },
    { ...product, offers: [] },
    { ...product, offers: { '@type': 'Offer', price: 'NaN', priceCurrency: 'USD' } },
    { ...product, offers: { '@type': 'Offer', price: -1, priceCurrency: 'USD' } },
    { ...product, offers: { '@type': 'Offer', price: '3.10', priceCurrency: 'dollars' } },
    { ...product, offers: { '@type': 'Offer', price: '3.10', priceCurrency: ['USD'] } },
    { ...product, aggregateRating: {} },
    {
      ...product,
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 99, ratingCount: 1 },
    },
    { ...product, review: {} },
    { ...product, '@type': ['Thing', 'Product'], offers: {} },
  ])
    await assert.rejects(inspectPage(fixture(path, 'product', invalid), path, origin), /Product/);
});

test('gate preserves a real rating or review alternative and a typed price specification', async () => {
  const path = '/products/example/';
  const product = { '@type': 'Product', name: 'Example', url: `${origin}${path}` };
  for (const fields of [
    { aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5, ratingCount: 2 } },
    {
      review: {
        '@type': 'Review',
        reviewRating: { '@type': 'Rating', ratingValue: 4 },
        author: { '@type': 'Person', name: 'Reviewer' },
      },
    },
    {
      offers: {
        '@type': 'Offer',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '3.10',
          priceCurrency: 'USD',
        },
      },
    },
  ])
    await inspectPage(fixture(path, 'product', { ...product, ...fields }), path, origin);
});

test('valid Product offers preserve zero prices and reject a different canonical identity', async () => {
  const path = '/products/example/';
  const product = { '@type': 'Product', name: 'Example', url: `${origin}${path}` };
  await inspectPage(
    fixture(path, 'product', {
      ...product,
      offers: { '@type': 'Offer', price: '0.00', priceCurrency: 'USD' },
    }),
    path,
    origin,
  );
  await inspectPage(
    fixture(path, 'product', {
      ...product,
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '1.20',
        highPrice: '3.10',
        priceCurrency: 'USD',
      },
    }),
    path,
    origin,
  );
  await assert.rejects(
    inspectPage(
      fixture(path, 'product', {
        ...product,
        url: 'https://other.test/item',
        offers: { '@type': 'Offer', price: 1, priceCurrency: 'USD' },
      }),
      path,
      origin,
    ),
    /Product/,
  );
  await assert.rejects(
    inspectPage(
      fixture(path, 'product', {
        ...product,
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '3.10',
          highPrice: '1.20',
          priceCurrency: 'USD',
        },
      }),
      path,
      origin,
    ),
    /Product/,
  );
});

test('gate rejects missing canonical, noindex, mismatched identity, and script-only body', async () => {
  const html = fixture();
  for (const broken of [
    html.replace(/<link rel="canonical"[^>]+>/, ''),
    html.replace('</head>', '<meta name="robots" content="noindex,follow"></head>'),
    html.replace('href="https://example.test/example/"', 'href="https://wrong.test/example/"'),
    html.replace(
      /<main>[\s\S]*?<\/main>/,
      '<main><h1>Example</h1><script>Public body content</script><astro-island props="Public body content"></astro-island></main>',
    ),
    html.replace('</head>', '<link rel="canonical" href="https://example.test/example/"></head>'),
    html.replace(
      /<script type="application\/json" id="channel-page-descriptor">[\s\S]*?<\/script>/,
      '',
    ),
  ])
    await assert.rejects(inspectPage(broken, '/example/', origin));
});

test('sitemap cannot leak private pages or silently omit/add public pages', async () => {
  const page = await inspectPage(fixture(), '/example/', origin);
  assert.throws(() => validateManifest([page], []));
  assert.throws(() => validateManifest([page], [page.canonicalUrl, `${origin}/admin/`]));
  assert.throws(() => validateManifest([page], [page.canonicalUrl, page.canonicalUrl]));
  assert.throws(() => validateManifest([page, { ...page, path: '/other/' }], [page.canonicalUrl]));
});

test('server Blog adds exactly its own dynamic sitemap without loosening static sitemap checks', () => {
  const staticMap = `${origin}/sitemap-0.xml`;
  const dynamicMap = `${origin}/blog/sitemap.xml`;
  assert.doesNotThrow(() => validateSitemapIndex([staticMap], ['sitemap-0.xml'], origin));
  assert.doesNotThrow(() =>
    validateSitemapIndex([staticMap, dynamicMap], ['sitemap-0.xml'], origin, true),
  );
  assert.throws(() => validateSitemapIndex([staticMap], ['sitemap-0.xml'], origin, true));
  assert.throws(() => validateSitemapIndex([staticMap, dynamicMap], ['sitemap-0.xml'], origin));
  assert.throws(() =>
    validateSitemapIndex(
      [staticMap, 'https://other.example/blog/sitemap.xml'],
      ['sitemap-0.xml'],
      origin,
      true,
    ),
  );
  assert.throws(() =>
    validateSitemapIndex([staticMap, staticMap, dynamicMap], ['sitemap-0.xml'], origin, true),
  );
});
