import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalPath,
  canonicalUrl,
  createPageDescriptor,
  indexPolicy,
  serializePageDescriptor,
} from './page.ts';

test('canonical identity drops UI parameters and uses one trailing slash', () => {
  assert.equal(canonicalPath('/headphones?category=wired#details'), '/headphones/');
  assert.equal(
    canonicalUrl('/headphones/', 'https://example.test/'),
    'https://example.test/headphones/',
  );
  for (const path of [
    '//evil.test/path',
    'https://evil.test/',
    '/a/../admin',
    '/a\\b',
    '/%2e%2e/admin',
  ]) {
    assert.throws(() => canonicalPath(path), Error, path);
  }
  assert.throws(() => canonicalUrl('/', 'https://example.test/subpath'));
});

test('private descendants and the existing product shell cannot opt into indexing', () => {
  for (const path of [
    '/admin/settings/',
    '/%61dmin/settings/',
    '/account/',
    '/login/',
    '/products/item/',
  ]) {
    assert.match(indexPolicy(path), /noindex/, path);
    assert.throws(() =>
      createPageDescriptor({
        path,
        title: 'Example',
        description: 'Example description',
        robots: 'index,follow',
      }),
    );
  }
  assert.equal(indexPolicy('/headphones/'), 'index,follow');
  assert.equal(indexPolicy('/products/item/'), 'noindex,follow');
});

test('product and article descriptors require explicit public provenance', () => {
  assert.throws(() =>
    createPageDescriptor({
      path: '/products/example/',
      title: 'Example',
      description: 'Description',
    }),
  );
  const page = createPageDescriptor({
    path: '/products/example/',
    kind: 'product',
    title: 'Example product',
    description: 'Public description',
    content: {
      source: 'public-catalog',
      revision: 'public-revision-1',
      updatedAt: '2026-10-18T10:00:00Z',
    },
    schemaNodes: [{ '@type': 'Product', name: 'Example product' }],
  });
  assert.equal(page.canonicalPath, '/products/example/');
  assert.equal(page.content.revision, 'public-revision-1');
  assert.throws(() =>
    createPageDescriptor({
      ...page,
      path: '/products/example/',
      content: { source: 'public-catalog', updatedAt: 'yesterday' },
    }),
  );
});

test('embedded descriptor projects provenance fields and cannot close its JSON script', () => {
  const content = { source: 'site-content', revision: '1', privateNotes: 'internal-only' };
  const page = createPageDescriptor({
    path: '/example/',
    title: 'An example',
    description: '</script><script>unexpected()</script>',
    content,
  });
  const serialized = serializePageDescriptor(page);
  assert.ok(!serialized.includes('</script>'));
  assert.ok(!serialized.includes('privateNotes'));
  assert.ok(!serialized.includes('internal-only'));
  assert.equal(JSON.parse(serialized).description, page.description);
});
