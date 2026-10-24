import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_PRODUCT_LIST_MARKER,
  ADMIN_PRODUCT_LIST_VIEW,
  fitsJsonBudget,
  isAdminProductListRow,
  productListCoreIncomplete,
  productListLimited,
} from './admin-product-list.ts';
test('JSON budget matches independent UTF-8 wire bytes for generated JSON and escaped keys', () => {
  let seed = 123456;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const leaves: unknown[] = [
    '',
    '中',
    '😀',
    '\u0000',
    'quote"\n',
    0,
    -0,
    1e-7,
    1e21,
    -25.125,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    false,
    null,
    undefined,
  ];
  const make = (depth: number): unknown => {
    const kind = next() % 4;
    if (!depth || kind < 2) return leaves[next() % leaves.length];
    if (kind === 2) return Array.from({ length: next() % 5 }, () => make(depth - 1));
    return Object.fromEntries(
      Array.from({ length: next() % 5 }, (_, i) => [
        [`key${i}`, '中', '"\n', '__proto__'][next() % 4] ?? '',
        make(depth - 1),
      ]),
    );
  };
  const cases: unknown[] = [
    ...leaves,
    {},
    [],
    new Array(3),
    { omitted: undefined, present: null },
    Object.fromEntries([['__proto__', '中']]),
    Object.assign(Object.create(null), { name: '中' }),
  ];
  for (let i = 0; i < 160; i++) cases.push(make(4));
  for (const value of cases) {
    const json = JSON.stringify(value);
    if (json === undefined) {
      assert.equal(fitsJsonBudget(value, 8192), false);
      continue;
    }
    const bytes = Buffer.byteLength(json);
    for (const budget of [0, Math.max(0, bytes - 1), bytes, bytes + 1, 8192])
      assert.equal(fitsJsonBudget(value, budget), bytes <= budget, json);
  }
});
test('long strings stop before encoding or serializing their full payload', (t) => {
  const original = TextEncoder.prototype.encode;
  let largest = 0;
  t.mock.method(
    TextEncoder.prototype,
    'encode',
    function (this: InstanceType<typeof TextEncoder>, text = '') {
      largest = Math.max(largest, text.length);
      return original.call(this, text);
    },
  );
  assert.equal(fitsJsonBudget({ small: '中' }, 100), true);
  assert.equal(fitsJsonBudget({ oversized: 'a'.repeat(1000000) }, 8192), false);
  assert.ok(largest > 0 && largest < 8192);
});
test('cyclic deep unsupported and invalid budget inputs refuse without recursion or coercion', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [cycle, 1n, Symbol('not-json'), () => 'not-json', new Date(0)])
    assert.equal(fitsJsonBudget(value, 8192), false);
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(fitsJsonBudget(null, size), false);
  assert.equal(fitsJsonBudget(null, 4, 0), true);
  assert.equal(fitsJsonBudget({ x: null }, 100, 0), false);
  assert.equal(fitsJsonBudget({}, 100, -1), false);
  assert.equal(fitsJsonBudget({}, 100, 33), false);
});
test('limited markers require their DTO version and core restriction requires limited true', () => {
  const base = { _id: 'p', [ADMIN_PRODUCT_LIST_MARKER]: ADMIN_PRODUCT_LIST_VIEW };
  assert.equal(isAdminProductListRow(base), true);
  assert.equal(productListLimited({ _adminProductListLimited: true }), false);
  assert.equal(
    productListCoreIncomplete({ ...base, _adminProductListCoreIncomplete: true }),
    false,
  );
  assert.equal(isAdminProductListRow({ ...base, _adminProductListCoreIncomplete: true }), false);
  const core = { ...base, _adminProductListLimited: true, _adminProductListCoreIncomplete: true };
  assert.equal(isAdminProductListRow(core), true);
  assert.equal(productListLimited(core), true);
  assert.equal(productListCoreIncomplete(core), true);
  for (const value of [false, null, 'true', 1])
    assert.equal(isAdminProductListRow({ ...base, _adminProductListLimited: value }), false);
});
