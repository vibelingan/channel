import { strict as assert } from 'node:assert';
import test from 'node:test';
import { PRODUCT_FAMILY_OPTIONS, type ProductFamily } from './catalog-product.ts';
import {
  type CatalogTaxonomy,
  CatalogTaxonomySchema,
  MAX_PRODUCT_SUBCATEGORIES,
  MAX_TAXONOMY_CHILDREN,
  initialCatalogTaxonomy,
  readProductSubcategories,
  storedCatalogTaxonomy,
  validateProductSubcategories,
} from './catalog-taxonomy.ts';

function taxonomy(
  family: ProductFamily,
  overrides: Partial<CatalogTaxonomy> = {},
): CatalogTaxonomy {
  return {
    family,
    revision: 0,
    name: 'Product family',
    children: [
      { id: `${family}-first`, name: 'First', slug: 'first', order: 0, status: 'active' },
      { id: `${family}-second`, name: 'Second', slug: 'second', order: 1, status: 'active' },
    ],
    ...overrides,
  };
}

for (const family of PRODUCT_FAMILY_OPTIONS) {
  test(`${family} permits multiple children and explicit empty assignments`, () => {
    const registry = taxonomy(family);
    assert.equal(CatalogTaxonomySchema.safeParse(registry).success, true);
    assert.equal(
      validateProductSubcategories(
        family,
        registry.children.map((child) => child.id),
        registry,
      ),
      true,
    );
    assert.equal(validateProductSubcategories(family, [], registry), true);
    assert.equal(validateProductSubcategories(family, [`${family}-unknown`], registry), false);
    assert.equal(
      validateProductSubcategories(family, [`${family}-first`, `${family}-first`], registry),
      false,
    );
    assert.equal(validateProductSubcategories(family, ['another-parent-first'], registry), false);
    assert.equal(
      validateProductSubcategories(family, [], taxonomy(family === 'toys' ? 'misc' : 'toys')),
      false,
    );
  });
}

test('stored registry falls back only when absent and fails closed on corrupt or foreign rows', () => {
  assert.deepEqual(storedCatalogTaxonomy('headphones', null), initialCatalogTaxonomy('headphones'));
  const stored = { _id: 'toys', updatedAt: '2026-09-23T00:00:00.000Z', ...taxonomy('toys') };
  assert.deepEqual(storedCatalogTaxonomy('toys', stored), taxonomy('toys'));
  assert.equal(storedCatalogTaxonomy('misc', stored), null);
  assert.equal(storedCatalogTaxonomy('toys', { ...stored, children: 'corrupt' }), null);
  assert.equal(storedCatalogTaxonomy('toys', { ...stored, revision: -1 }), null);
});

test('initial registries are independent and legacy children have deterministic IDs', () => {
  const headphones = initialCatalogTaxonomy('headphones');
  assert.deepEqual(
    headphones.children.map((child) => child.id),
    ['headphones-wired', 'headphones-office', 'headphones-bluetooth'],
  );
  for (const family of PRODUCT_FAMILY_OPTIONS) {
    const registry = initialCatalogTaxonomy(family);
    assert.equal(CatalogTaxonomySchema.safeParse(registry).success, true);
    if (family !== 'headphones') assert.deepEqual(registry.children, []);
  }
  headphones.children.pop();
  assert.equal(initialCatalogTaxonomy('headphones').children.length, 3);
});

test('absent assignment alone permits legacy fallback without mutating the product', () => {
  const registry = initialCatalogTaxonomy('headphones');
  const product = { category: 'wired', name: 'Historical product' };
  assert.deepEqual(readProductSubcategories(product, registry), {
    status: 'valid',
    source: 'legacy',
    subcategoryIds: ['headphones-wired'],
  });
  assert.deepEqual(product, { category: 'wired', name: 'Historical product' });
  assert.deepEqual(readProductSubcategories({ ...product, subcategoryIds: [] }, registry), {
    status: 'valid',
    source: 'assigned',
    subcategoryIds: [],
  });
  assert.deepEqual(readProductSubcategories({ productFamily: 'headphones' }, registry), {
    status: 'valid',
    source: 'unassigned',
    subcategoryIds: [],
  });
});

test('malformed stored assignments and contradictory parents never fall back', () => {
  const registry = initialCatalogTaxonomy('headphones');
  for (const subcategoryIds of [
    undefined,
    null,
    'headphones-wired',
    ['headphones-wired', 1],
    ['unknown'],
    ['headphones-wired', 'headphones-wired'],
  ]) {
    assert.deepEqual(readProductSubcategories({ category: 'wired', subcategoryIds }, registry), {
      status: 'invalid',
    });
  }
  assert.deepEqual(
    readProductSubcategories({ productFamily: 'toys', category: 'wired' }, registry),
    { status: 'invalid' },
  );
  assert.deepEqual(readProductSubcategories({ productFamily: null, category: 'wired' }, registry), {
    status: 'invalid',
  });
});

test('archived membership can be retained or cleared, never newly introduced', () => {
  const registry = taxonomy('toys');
  const child = registry.children[0];
  assert.ok(child);
  child.status = 'archived';
  assert.equal(validateProductSubcategories('toys', [child.id], registry), false);
  assert.equal(validateProductSubcategories('toys', [child.id], registry, [child.id]), true);
  assert.equal(validateProductSubcategories('toys', [], registry, [child.id]), true);
  assert.deepEqual(
    readProductSubcategories({ productFamily: 'toys', subcategoryIds: [child.id] }, registry),
    {
      status: 'valid',
      source: 'assigned',
      subcategoryIds: [child.id],
    },
  );
});

test('registry rejects duplicate identifiers, display names and slugs', () => {
  for (const field of ['id', 'name', 'slug'] as const) {
    const registry = taxonomy('misc');
    const first = registry.children[0];
    const second = registry.children[1];
    assert.ok(first && second);
    second[field] = first[field];
    assert.equal(CatalogTaxonomySchema.safeParse(registry).success, false);
  }
  const registry = taxonomy('misc');
  const second = registry.children[1];
  assert.ok(second);
  second.name = 'FIRST';
  assert.equal(CatalogTaxonomySchema.safeParse(registry).success, false);
});

test('registry and assignment budgets reject invalid values without truncation', () => {
  const registry = taxonomy('misc');
  registry.children = Array.from({ length: MAX_TAXONOMY_CHILDREN }, (_, index) => ({
    id: `misc-${index}`,
    name: `Child ${index}`,
    slug: `child-${index}`,
    order: index,
    status: 'active',
  }));
  assert.equal(CatalogTaxonomySchema.safeParse(registry).success, true);
  const ids = registry.children.map((child) => child.id);
  assert.equal(
    validateProductSubcategories('misc', ids.slice(0, MAX_PRODUCT_SUBCATEGORIES), registry),
    true,
  );
  assert.equal(
    validateProductSubcategories('misc', ids.slice(0, MAX_PRODUCT_SUBCATEGORIES + 1), registry),
    false,
  );
  registry.children.push({
    id: 'overflow',
    name: 'Overflow',
    slug: 'overflow',
    order: 999,
    status: 'active',
  });
  assert.equal(CatalogTaxonomySchema.safeParse(registry).success, false);
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(CatalogTaxonomySchema.safeParse(taxonomy('misc', { revision })).success, false);
  }
  for (const name of ['', ' Leading', 'Trailing ', 'x'.repeat(81)]) {
    assert.equal(CatalogTaxonomySchema.safeParse(taxonomy('misc', { name })).success, false);
  }
  assert.equal(
    CatalogTaxonomySchema.safeParse({ ...taxonomy('misc'), privateMetadata: 'unexpected' }).success,
    false,
  );
});
