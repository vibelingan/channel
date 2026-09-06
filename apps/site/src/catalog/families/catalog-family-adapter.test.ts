import assert from 'node:assert/strict';
import test from 'node:test';
import { type PublicProduct, PublicProductSchema } from '@vibelingan-channel/shared/catalog';
import { type CatalogFamilyAdapter, assertCatalogFamilyAdapter } from './catalog-family-adapter.ts';

const product: PublicProduct = {
  _id: 'product-1',
  name: 'Product',
  productFamily: 'headphones',
};

function createAdapter(overrides: Partial<CatalogFamilyAdapter> = {}): CatalogFamilyAdapter {
  return {
    family: 'headphones',
    labels: { heading: 'Headphones' },
    filterCapabilities: [{ key: 'category', label: 'Category' }],
    group: (candidate) => candidate.category ?? null,
    facts: (candidate) =>
      candidate.modName ? [{ key: 'model', label: 'Model', value: candidate.modName }] : [],
    emptyCopy: 'No products available.',
    ...overrides,
  };
}

function assertInvalid(value: unknown, field?: keyof CatalogFamilyAdapter): void {
  assert.throws(() => assertCatalogFamilyAdapter(value), {
    name: 'TypeError',
    message: `Invalid CatalogFamilyAdapter${field ? `.${field}` : ''}`,
  });
}

test('complete adapters pass for every canonical family and callbacks stay plain-data', () => {
  for (const family of PublicProductSchema.shape.productFamily.options) {
    const adapter = createAdapter({ family });
    assert.doesNotThrow(() => assertCatalogFamilyAdapter(adapter));
    assert.equal(adapter.group(product), null);
    assert.deepEqual(adapter.facts(product), []);
  }
  assert.doesNotThrow(() =>
    assertCatalogFamilyAdapter(
      createAdapter({ filterCapabilities: [], group: () => null, facts: () => [] }),
    ),
  );
});

test('guard rejects missing and malformed fields by exact contract name', () => {
  const complete = createAdapter();
  for (const field of [
    'family',
    'labels',
    'filterCapabilities',
    'group',
    'facts',
    'emptyCopy',
  ] as const) {
    const { [field]: _removed, ...missing } = complete;
    assertInvalid(missing, field);
  }
  const malformed: Array<[string, unknown]> = [
    ['family', 'unknown'],
    ['labels', []],
    ['labels', { heading: '' }],
    ['filterCapabilities', {}],
    ['filterCapabilities', [{ key: '', label: 'Category' }]],
    ['group', 'group'],
    ['facts', null],
    ['emptyCopy', ''],
  ];
  for (const [field, value] of malformed) {
    assertInvalid({ ...complete, [field]: value }, field as keyof CatalogFamilyAdapter);
  }
});

test('guard rejects non-objects without invoking callbacks and allows additive metadata', () => {
  for (const value of [null, [], 'adapter', () => undefined]) {
    assertInvalid(value);
  }
  let callbackCalls = 0;
  const adapter = {
    ...createAdapter({
      group: () => {
        callbackCalls += 1;
        return null;
      },
      facts: () => {
        callbackCalls += 1;
        return [];
      },
    }),
    extra: true,
    labels: { heading: '耳机', extra: 'Extra' },
    filterCapabilities: [{ key: 'category', label: 'Category', extra: true }],
  };
  assert.doesNotThrow(() => assertCatalogFamilyAdapter(adapter));
  assert.equal(callbackCalls, 0);
});

test('guard rejects sparse, inherited, and accessor-backed contract fields without executing getters', () => {
  const complete = createAdapter();
  const sparseCapabilities = new Array<{ key: string; label: string }>(1);
  let keysCalls = 0;
  Object.defineProperty(sparseCapabilities, 'keys', {
    value() {
      keysCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  assertInvalid({ ...complete, filterCapabilities: sparseCapabilities }, 'filterCapabilities');
  assert.equal(keysCalls, 0);

  const inherited = Object.create(complete) as object;
  assertInvalid(inherited, 'family');

  let getterCalls = 0;
  const accessor = { ...complete };
  Object.defineProperty(accessor, 'family', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'headphones';
    },
  });
  assertInvalid(accessor, 'family');
  assert.equal(getterCalls, 0);

  const labels = { heading: 'Headphones' };
  Object.defineProperty(labels, 'hidden', { value: '', enumerable: false });
  assertInvalid({ ...complete, labels }, 'labels');
});
