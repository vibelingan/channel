import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  PRODUCT_FAMILY_OPTIONS,
  normalizeProductSlug,
  normalizeSkuCode,
  productFamilyForDoc,
  validateProductPublication,
} from './catalog-product.ts';
import { buildWriteSchema, getCollection } from './collections.ts';
import { CATALOG_IMAGE_MAX_COUNT, PRODUCT_IMAGE_MAX_COUNT } from './media.ts';

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

test('publication requires complete identity, description, and a primary image', () => {
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

  for (const key of [
    'name',
    'productFamily',
    'skuCode',
    'slug',
    'description',
    'imageIds',
  ] as const) {
    const incomplete = { ...complete } as Record<string, unknown>;
    delete incomplete[key];
    assert.ok(validateProductPublication(incomplete).length > 0, `missing ${key} must fail`);
  }
  assert.ok(validateProductPublication({ ...complete, imageIds: ['  '] }).length > 0);
  assert.ok(validateProductPublication({ ...complete, archived: true }).length > 0);
  assert.deepEqual(validateProductPublication({ name: 'Draft', published: false }), []);
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
