import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectPage, validateManifest } from './output-gate.ts';
import { createPageDescriptor, serializePageDescriptor } from './page.ts';

const origin = 'https://example.test';
function fixture(path = '/example/', kind: 'marketing' | 'product' | 'article' = 'marketing') {
  const page = createPageDescriptor({
    path,
    kind,
    title: `Title ${path}`,
    description: `Description ${path}`,
    content: { source: kind === 'marketing' ? 'site-content' : `public-${kind}`, revision: '1' },
  });
  const url = `${origin}${path}`;
  const nodes = [
    { '@type': 'WebPage', url },
    ...(kind === 'marketing'
      ? []
      : [
          { '@type': kind === 'product' ? 'Product' : 'Article', url },
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
