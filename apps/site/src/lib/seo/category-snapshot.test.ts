import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryManifest, categoryPage, categoryPages } from './category-snapshot.ts';
import type { ProductSnapshot } from './product-snapshot.ts';

function snapshot(total: number): ProductSnapshot {
  return {
    schemaVersion: 1,
    purpose: 'fixture',
    siteOrigin: 'http://localhost:4321',
    apiOrigin: 'https://fixture.invalid',
    total,
    products: Array.from({ length: total }, (_, index) => ({
      product: {
        _id: `item-${String(index).padStart(3, '0')}`,
        name: `Item ${index}`,
        productFamily: 'headphones',
      },
      revision: `revision-${index}`,
    })),
  };
}

test('category pages have exact 0, 1, 12, 13 and 25 item boundaries and finite next links', () => {
  for (const total of [0, 1, 12, 13, 25]) {
    const input = snapshot(total);
    const pages = categoryPages(input).filter(({ family }) => family === 'headphones');
    assert.equal(pages.length, Math.max(1, Math.ceil(total / 12)));
    assert.deepEqual(
      pages.flatMap(({ items }) => items.map(({ _id }) => _id)),
      input.products.map(({ product }) => product._id),
    );
    for (const [index, page] of pages.entries()) {
      assert.equal(page.items.length, Math.max(0, Math.min(12, total - index * 12)));
      assert.equal(page.total, total);
      assert.equal(page.path, index ? `/headphones/page/${index + 1}/` : '/headphones/');
      assert.equal(page.nextPath, pages[index + 1]?.path ?? null);
      assert.equal(page.previousPath, pages[index - 1]?.path ?? null);
    }
    assert.throws(() => categoryPage(input, 'headphones', pages.length + 1));
  }
});

test('snapshot order does not change category contents, revision or public manifest', () => {
  const input = snapshot(25);
  const shuffled = { ...input, products: [...input.products].reverse() };
  assert.deepEqual(categoryManifest(shuffled), categoryManifest(input));
  assert.equal(categoryPages(input).length, 6);
  assert.equal(categoryPage(input, 'toys').total, 0);
  assert.equal(categoryPage(input, 'headphones', 2).items[0]?._id, 'item-012');
});

test('editing one card changes only its page revision and retains a shared manifest revision', () => {
  const before = snapshot(25);
  const after: ProductSnapshot = {
    ...before,
    products: before.products.map((entry, index) =>
      index === 12 ? { ...entry, product: { ...entry.product, name: 'Updated card' } } : entry,
    ),
  };

  const pages = (input: ProductSnapshot) =>
    categoryPages(input).filter(({ family }) => family === 'headphones');
  const previousPages = pages(before);
  const changed = pages(after).filter(
    (page, index) => page.revision !== previousPages[index]?.revision,
  );
  assert.deepEqual(
    changed.map(({ path }) => path),
    ['/headphones/page/2/'],
  );

  const groupRevisions = (input: ProductSnapshot) =>
    categoryManifest(input)
      .pages.filter(({ family }) => family === 'headphones')
      .map(({ revision }) => revision);
  assert.equal(new Set(groupRevisions(after)).size, 1);
  assert.notDeepEqual(groupRevisions(after), groupRevisions(before));
});

test('move and withdrawal update both families and remove a no-longer-existing last page', () => {
  const before = snapshot(13);
  const moved: ProductSnapshot = {
    ...before,
    products: before.products.map((entry, index) =>
      index === 0 ? { ...entry, product: { ...entry.product, productFamily: 'toys' } } : entry,
    ),
  };
  assert.equal(categoryPage(moved, 'headphones').total, 12);
  assert.equal(categoryPage(moved, 'toys').items[0]?._id, 'item-000');
  assert.throws(() => categoryPage(moved, 'headphones', 2));
  assert.notEqual(
    categoryPage(before, 'headphones').revision,
    categoryPage(moved, 'headphones').revision,
  );
  const withdrawn = { ...before, total: 12, products: before.products.slice(1) };
  assert.equal(
    categoryManifest(withdrawn).pages.some(({ path }) => path === '/headphones/page/2/'),
    false,
  );
  assert.equal(
    categoryPage(withdrawn, 'headphones').items.some(({ _id }) => _id === 'item-000'),
    false,
  );
});

test('manifest contains only public page identity, revisions and IDs', () => {
  const manifest = categoryManifest(snapshot(1));
  assert.deepEqual(Object.keys(manifest.pages[0] ?? {}).sort(), [
    'family',
    'page',
    'path',
    'productIds',
    'revision',
    'total',
  ]);
  assert.equal(JSON.stringify(manifest).includes('Item 0'), false);
});

test('historical headphones category uses the same family rule as the public API', () => {
  const input = snapshot(0);
  input.products = [
    { product: { _id: 'legacy-wired', name: 'Legacy wired', category: 'wired' }, revision: 'old' },
  ];
  input.total = 1;
  assert.equal(categoryPage(input, 'headphones').items[0]?._id, 'legacy-wired');
  assert.equal(categoryPage(input, 'misc').items.length, 0);
});
