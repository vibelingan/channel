import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildWriteSchema, getCollection } from './collections.ts';
import {
  PRODUCT_FAMILY_OPTIONS,
  normalizeProductSlug,
  normalizeSkuCode,
  productFamilyForDoc,
  validateProductPublication,
} from './index.ts';
import { CATALOG_IMAGE_MAX_COUNT, PRODUCT_IMAGE_MAX_COUNT } from './media.ts';
import { FILTER_OPERATORS, isValuelessOperator, matchesFilter } from './query.ts';

function productsDef() {
  const def = getCollection('products');
  assert.ok(def, 'products collection must be registered');
  return def;
}

test('product families are a closed four-value contract', () => {
  assert.deepEqual(PRODUCT_FAMILY_OPTIONS, ['headphones', 'ai-gadgets', 'toys', 'misc']);
  const family = productsDef().fields.find((field) => field.name === 'productFamily');
  assert.deepEqual(family?.options, PRODUCT_FAMILY_OPTIONS);
});

test('slug and SKU normalization produce stable identity keys', () => {
  assert.equal(normalizeProductSlug('  AI Camera Pro  '), 'ai-camera-pro');
  assert.equal(normalizeProductSlug('Already--Clean'), 'already-clean');
  assert.equal(normalizeProductSlug('admin'), null, 'reserved routes are rejected');
  assert.equal(normalizeProductSlug('ai-gadgets'), null);
  assert.equal(normalizeProductSlug('***'), null);
  assert.equal(normalizeSkuCode('  Ab-120  '), 'ab-120');
  assert.equal(normalizeSkuCode('ＣＡＦÉ-１'), normalizeSkuCode('CAFÉ-1'));
  assert.equal(normalizeSkuCode('CAFE\u0301-1'), normalizeSkuCode('CAFÉ-1'));
  assert.equal(normalizeSkuCode(''), null);
});

test('legacy Headphones rows resolve a family without mutating storage', () => {
  const legacy = { category: 'wired', name: 'Legacy' };
  assert.equal(productFamilyForDoc(legacy), 'headphones');
  assert.equal('productFamily' in legacy, false);
  assert.equal(productFamilyForDoc({ category: 'unknown' }), null);
  assert.equal(productFamilyForDoc({ productFamily: 'corrupt', category: 'wired' }), null);
  assert.equal(productFamilyForDoc({ productFamily: 'toys', category: 'wired' }), 'toys');
});

test('draft writes remain backward compatible while product identity fields validate', () => {
  const schema = buildWriteSchema(productsDef());
  assert.equal(schema.safeParse({ name: 'Legacy draft', category: 'wired' }).success, true);
  assert.equal(
    schema.safeParse({
      name: 'AI Camera',
      productFamily: 'ai-gadgets',
      skuCode: 'AI-100',
      slug: 'ai-camera',
      archived: false,
    }).success,
    true,
  );
  assert.equal(schema.safeParse({ name: 'Bad', productFamily: 'garden' }).success, false);
});

test('publication allows missing SKU and slug but still requires content and a primary image', () => {
  const complete = {
    name: 'WorkComm Mono',
    productFamily: 'headphones',
    skuCode: 'WC-15',
    slug: 'workcomm-mono',
    description: 'Office headset.',
    imageIds: ['image-1'],
    published: true,
    archived: false,
  };
  assert.deepEqual(validateProductPublication(complete), []);

  assert.deepEqual(
    validateProductPublication({ ...complete, skuCode: undefined, slug: undefined }),
    [],
  );
  assert.deepEqual(validateProductPublication({ ...complete, skuCode: '', slug: '   ' }), []);

  for (const key of ['name', 'productFamily', 'description', 'imageIds'] as const) {
    const incomplete = { ...complete } as Record<string, unknown>;
    delete incomplete[key];
    assert.ok(validateProductPublication(incomplete).length > 0, `missing ${key} must fail`);
  }
  assert.ok(validateProductPublication({ ...complete, imageIds: ['  '] }).length > 0);
  assert.ok(validateProductPublication({ ...complete, archived: true }).length > 0);
  assert.deepEqual(validateProductPublication({ name: 'Draft', published: false }), []);
});

test('non-Headphones products reject subcategory while legacy Headphones categories remain valid', () => {
  assert.deepEqual(
    validateProductPublication({ name: 'Headset', productFamily: 'headphones', category: 'wired' }),
    [],
  );
  for (const productFamily of ['ai-gadgets', 'toys', 'misc']) {
    assert.deepEqual(
      validateProductPublication({ name: 'Other product', productFamily, category: 'wired' }),
      [{ field: 'category', message: 'Subcategory applies only to Headphones' }],
    );
  }
});

test('manual tier pricing is writable without removing scalar pricing fields', () => {
  const schema = buildWriteSchema(productsDef());
  const parsed = schema.safeParse({
    name: 'Tiered toy',
    productFamily: 'toys',
    moq: 1,
    unitPrice: 134.18,
    wholesalePrice: 118.31,
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [
        { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
        { minQuantity: 13, unitAmountMinor: 11_831 },
      ],
    },
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.unitPrice, 134.18);
  assert.equal(parsed.data.wholesalePrice, 118.31);
  assert.equal((parsed.data.manualCatalogPricing as { tiers: unknown[] }).tiers.length, 2);
});

test('products enforce nine images while Overstock retains eighteen', () => {
  const productImages = Array.from({ length: PRODUCT_IMAGE_MAX_COUNT }, (_, index) => `p-${index}`);
  const overstockImages = Array.from(
    { length: CATALOG_IMAGE_MAX_COUNT },
    (_, index) => `o-${index}`,
  );
  const productSchema = buildWriteSchema(productsDef());
  const overstock = getCollection('overstock');
  assert.ok(overstock);

  assert.equal(productSchema.safeParse({ name: 'Product', imageIds: productImages }).success, true);
  assert.equal(
    productSchema.safeParse({ name: 'Product', imageIds: [...productImages, 'p-over'] }).success,
    false,
  );
  assert.equal(
    buildWriteSchema(overstock).safeParse({
      name: 'Lot',
      category: 'electronics',
      imageIds: overstockImages,
    }).success,
    true,
  );
});

test('identity reservations are server-managed and VIP is deprecated in forms', () => {
  const identities = getCollection('catalogProductIdentities');
  assert.ok(identities);
  assert.equal(identities.adminAccess, 'none');
  assert.equal(identities.hideFromNav, true);
  assert.equal(
    identities.fields.every((field) => field.readOnly === true),
    true,
  );

  const vip = productsDef().fields.find((field) => field.name === 'vipPrice');
  assert.equal(vip?.hideInForm, true);
  assert.equal(vip?.deprecated, true);
});

test('strict active-product filter accepts only archived false or missing', () => {
  const filter = {
    combinator: 'and' as const,
    clauses: [{ field: 'archived', op: 'isFalseOrMissing' as const }],
  };
  assert.equal((FILTER_OPERATORS as readonly string[]).includes('isFalseOrMissing'), false);
  assert.equal(isValuelessOperator('isFalseOrMissing'), true);
  assert.equal(matchesFilter({ _id: 'missing' }, filter), true);
  assert.equal(matchesFilter({ _id: 'false', archived: false }, filter), true);
  for (const archived of [true, 'true', null, 0, '']) {
    assert.equal(matchesFilter({ _id: String(archived), archived }, filter), false);
  }
});

test('internal publication filter accepts only literal true', () => {
  const filter = {
    combinator: 'and' as const,
    clauses: [{ field: 'published', op: 'isLiteralTrue' as const }],
  };
  assert.equal((FILTER_OPERATORS as readonly string[]).includes('isLiteralTrue'), false);
  assert.equal(isValuelessOperator('isLiteralTrue'), true);
  assert.equal(matchesFilter({ _id: 'published', published: true }, filter), true);
  for (const published of [false, 'true', 'false', 1, {}, [], null]) {
    assert.equal(matchesFilter({ _id: String(published), published }, filter), false);
  }
  assert.equal(matchesFilter({ _id: 'missing' }, filter), false);
});

test('internal family filter applies legacy fallback and rejects malformed values', () => {
  const filter = (value: unknown) => ({
    combinator: 'and' as const,
    clauses: [{ field: 'productFamily', op: 'matchesProductFamily' as const, value }],
  });
  assert.equal(matchesFilter({ _id: 'explicit', productFamily: 'toys' }, filter('toys')), true);
  assert.equal(matchesFilter({ _id: 'legacy', category: 'wired' }, filter('headphones')), true);
  assert.equal(matchesFilter({ _id: 'wrong', category: 'unknown' }, filter('headphones')), false);
  assert.equal(matchesFilter({ _id: 'malformed', productFamily: 'toys' }, filter('garden')), false);
});
