import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  type CatalogTaxonomy,
  initialCatalogTaxonomy,
  readProductSubcategories,
} from '../../shared/src/catalog-taxonomy.ts';
import {
  type ProductSubcategoryQueryCommand,
  productSubcategoryWhere,
} from './product-subcategory-query.ts';

type Document = Record<string, unknown>;

const command: ProductSubcategoryQueryCommand = {
  and: (conditions) => ({ $and: conditions }),
  or: (conditions) => ({ $or: conditions }),
  exists: (value) => ({ $exists: value }),
  eq: (value) => ({ $eq: value }),
  in: (values) => ({ $in: values }),
  expr: (expression) => ({ $expr: expression }),
};

function object(value: unknown): Document {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Document;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function evaluate(expression: unknown, document: Document): unknown {
  if (typeof expression === 'string' && expression.startsWith('$')) {
    return document[expression.slice(1)];
  }
  if (Array.isArray(expression)) return expression.map((value) => evaluate(value, document));
  if (expression === null || typeof expression !== 'object') return expression;
  const entries = Object.entries(expression);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  const [operator, operand] = entry;
  if (operator === '$cond') {
    const [condition, positive, negative] = array(operand);
    return evaluate(evaluate(condition, document) ? positive : negative, document);
  }
  if (operator === '$isArray') return Array.isArray(evaluate(operand, document));
  if (operator === '$size') return array(evaluate(operand, document)).length;
  const values = array(operand).map((value) => evaluate(value, document));
  const [left, right] = values;
  switch (operator) {
    case '$and':
      return values.every(Boolean);
    case '$lte':
      assert.equal(typeof left, 'number');
      assert.equal(typeof right, 'number');
      return Number(left) <= Number(right);
    case '$gt':
      assert.equal(typeof left, 'number');
      assert.equal(typeof right, 'number');
      return Number(left) > Number(right);
    case '$eq':
      return left === right;
    case '$setUnion':
      return [...new Set(values.flatMap(array))];
    case '$setIsSubset':
      return array(left).every((value) => array(right).includes(value));
    case '$setIntersection':
      return [...new Set(array(left).filter((value) => array(right).includes(value)))];
    default:
      throw new Error(`Unsupported expression: ${operator}`);
  }
}

function matches(where: unknown, document: Document): boolean {
  return Object.entries(object(where)).every(([field, condition]) => {
    if (field === '$and')
      return array(condition)
        .map((part) => matches(part, document))
        .every(Boolean);
    if (field === '$or')
      return array(condition)
        .map((part) => matches(part, document))
        .some(Boolean);
    if (field === '$expr') return evaluate(condition, document) === true;
    return Object.entries(object(condition)).every(([operator, value]) => {
      const actual = document[field];
      const candidates = Array.isArray(actual) ? actual : [actual];
      if (operator === '$exists') return Object.hasOwn(document, field) === value;
      if (operator === '$eq') return candidates.includes(value);
      if (operator === '$in')
        return candidates.some((candidate) => array(value).includes(candidate));
      throw new Error(`Unsupported query: ${operator}`);
    });
  });
}

const knownIds = ['headphones-wired', 'headphones-office', 'headphones-bluetooth', 'retired'];
const selection = { family: 'headphones', ids: ['headphones-wired'], knownIds };

test('invalid selections fail closed without constructing an expression', () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    'headphones',
    {},
    { ...selection, family: 'Headphones' },
    { ...selection, family: 'headphones\n' },
    { ...selection, family: null },
    { ...selection, ids: [] },
    { ...selection, ids: 'headphones-wired' },
    { ...selection, ids: ['headphones-wired', 'headphones-wired'] },
    { ...selection, ids: ['unknown'] },
    { ...selection, ids: ['headphones-wired', 1] },
    { ...selection, knownIds: undefined },
    { ...selection, knownIds: [] },
    { ...selection, knownIds: ['headphones-wired', 'headphones-wired'] },
    { ...selection, knownIds: [...knownIds, null] },
    { ...selection, knownIds: Array.from({ length: 65 }, (_, index) => `child-${index}`) },
    {
      family: 'toys',
      ids: Array.from({ length: 17 }, (_, index) => `child-${index}`),
      knownIds: Array.from({ length: 17 }, (_, index) => `child-${index}`),
    },
  ];
  for (const id of [
    '',
    'UPPER',
    '_first',
    '-first',
    '$expr',
    'a.b',
    'a b',
    'a\nb',
    'a\n',
    'a\r',
    'a\t',
    ' a',
    'a ',
    'a'.repeat(81),
  ]) {
    invalid.push({ family: 'toys', ids: [id], knownIds: [id] });
    invalid.push({ ...selection, knownIds: [...knownIds, id] });
  }
  const sparse: string[] = [];
  sparse.length = 2;
  sparse[0] = 'headphones-wired';
  invalid.push({ ...selection, ids: sparse }, { ...selection, knownIds: sparse });
  for (const input of invalid) {
    const where = productSubcategoryWhere(command, input);
    assert.deepEqual(where, { _id: { $exists: false } }, JSON.stringify(input));
  }
});

test('array expression is guarded and checks size, uniqueness, known IDs, and overlap', () => {
  const where = object(productSubcategoryWhere(command, selection));
  const branches = array(object(array(where.$and)[1]).$or);
  assert.deepEqual(object(branches[0]).$expr, {
    $cond: [
      { $isArray: '$subcategoryIds' },
      {
        $and: [
          { $lte: [{ $size: '$subcategoryIds' }, 16] },
          {
            $eq: [{ $size: '$subcategoryIds' }, { $size: { $setUnion: ['$subcategoryIds', []] } }],
          },
          { $setIsSubset: ['$subcategoryIds', knownIds] },
          { $gt: [{ $size: { $setIntersection: ['$subcategoryIds', selection.ids] } }, 0] },
        ],
      },
      false,
    ],
  });
  assert.deepEqual(branches[1], {
    $and: [
      { subcategoryIds: { $exists: false } },
      { category: { $in: ['wired'] } },
      { $expr: { $eq: [{ $isArray: '$category' }, false] } },
    ],
  });
});

test('truth table rejects malformed assignments and never falls back for explicit values', () => {
  const where = productSubcategoryWhere(command, selection);
  const invalidValues: unknown[] = [
    [],
    null,
    undefined,
    'headphones-wired',
    1,
    false,
    {},
    ['headphones-wired', 1],
    ['headphones-wired', null],
    ['headphones-wired', ['headphones-office']],
    ['headphones-wired', { id: 'headphones-office' }],
    ['headphones-wired', 'headphones-wired'],
    ['headphones-wired', 'unknown'],
    Array.from({ length: 17 }, (_, index) => (index === 0 ? 'headphones-wired' : `child-${index}`)),
  ];
  for (const subcategoryIds of invalidValues) {
    assert.equal(
      matches(where, {
        _id: 'invalid',
        productFamily: 'headphones',
        category: 'wired',
        subcategoryIds,
      }),
      false,
      JSON.stringify(subcategoryIds),
    );
  }
  assert.equal(matches(where, { _id: 'legacy', category: 'wired' }), true);
  assert.equal(
    matches(where, { _id: 'legacy', productFamily: 'headphones', category: 'wired' }),
    true,
  );
  assert.equal(matches(where, { _id: 'other', productFamily: 'toys', category: 'wired' }), false);
  assert.equal(matches(where, { _id: 'other', productFamily: null, category: 'wired' }), false);
  assert.equal(matches(where, { _id: 'other', productFamily: '', category: 'wired' }), false);
  assert.equal(
    matches(where, {
      _id: 'assigned',
      productFamily: 'headphones',
      category: null,
      subcategoryIds: ['headphones-wired', 'retired'],
    }),
    true,
  );
});

test('all four families match the shared local-read truth table including archived retention', () => {
  for (const family of ['headphones', 'ai-gadgets', 'toys', 'misc'] as const) {
    const registry: CatalogTaxonomy = {
      ...initialCatalogTaxonomy(family),
      children: [
        ...initialCatalogTaxonomy(family).children,
        { id: 'selected', name: 'Selected', slug: 'selected', order: 4, status: 'active' },
        { id: 'retired', name: 'Retired', slug: 'retired', order: 5, status: 'archived' },
      ],
    };
    const ids = family === 'headphones' ? ['selected', 'headphones-wired'] : ['selected'];
    const where = productSubcategoryWhere(command, {
      family,
      ids,
      knownIds: registry.children.map((child) => child.id),
    });
    const familyFields: Document[] = [
      {},
      ...[
        'headphones',
        'ai-gadgets',
        'toys',
        'misc',
        '',
        null,
        'unknown',
        [family],
        ['headphones', 'toys'],
        {},
        1,
      ].map((productFamily) => ({ productFamily })),
    ];
    const categoryFields: Document[] = [
      {},
      ...['', null, 'wired', 'office', 'bluetooth', 'unknown', ['wired'], [''], {}, 1].map(
        (category) => ({ category }),
      ),
    ];
    const assignmentFields: Document[] = [
      {},
      ...[
        [],
        ['selected'],
        ['selected', 'retired'],
        ['retired'],
        ['headphones-wired'],
        ['headphones-office'],
        ['selected', 'unknown'],
        ['selected', 'selected'],
        ['selected', null],
        'selected',
        null,
      ].map((subcategoryIds) => ({ subcategoryIds })),
    ];
    for (const familyField of familyFields) {
      for (const categoryField of categoryFields) {
        for (const assignmentField of assignmentFields) {
          const document: Document = {
            _id: 'product',
            ...familyField,
            ...categoryField,
            ...assignmentField,
          };
          const local = readProductSubcategories(document, registry);
          const expected =
            local.status === 'valid' && local.subcategoryIds.some((id) => ids.includes(id));
          assert.equal(matches(where, document), expected, JSON.stringify({ family, document }));
        }
      }
    }
  }
});

test('selection and registry boundaries are inclusive and inputs are not mutated', () => {
  const knownIds = Array.from({ length: 64 }, (_, index) => `child-${index}`);
  knownIds[0] = 'a'.repeat(80);
  const ids = knownIds.slice(0, 16);
  const input = Object.freeze({
    family: 'toys',
    ids: Object.freeze(ids),
    knownIds: Object.freeze(knownIds),
  });
  const before = JSON.stringify(input);
  const where = productSubcategoryWhere(command, input);
  assert.equal(matches(where, { _id: 'full', productFamily: 'toys', subcategoryIds: ids }), true);
  assert.equal(
    matches(where, {
      _id: 'too-long',
      productFamily: 'toys',
      subcategoryIds: knownIds.slice(0, 17),
    }),
    false,
  );
  assert.equal(
    matches(where, {
      _id: 'null-category',
      productFamily: 'toys',
      category: null,
      subcategoryIds: ids,
    }),
    false,
  );
  assert.equal(JSON.stringify(input), before);
});

test('installed node and wx SDK serializers preserve the complete predicate', () => {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
  const { QuerySerializer } = sdkRequire(
    join(dirname(sdkRequire.resolve('@cloudbase/database')), 'serializer/query.js'),
  ) as {
    QuerySerializer: { encodeEJSON(value: unknown): string };
  };
  const nodeSdk = require('@cloudbase/node-sdk') as {
    init(options: { env: string }): { database(): { command: ProductSubcategoryQueryCommand } };
  };
  const wxSdk = require('wx-server-sdk') as {
    init(options: { env: string }): void;
    database(): { command: ProductSubcategoryQueryCommand };
  };
  wxSdk.init({ env: 'offline-subcategory-test' });
  for (const sdkCommand of [
    nodeSdk.init({ env: 'offline-subcategory-test' }).database().command,
    wxSdk.database().command,
  ]) {
    const where = productSubcategoryWhere(sdkCommand, selection);
    const expected = JSON.parse(
      JSON.stringify(productSubcategoryWhere(command, selection), (_key, value) =>
        typeof value === 'number' ? { $numberInt: String(value) } : value,
      ),
    );
    assert.deepEqual(JSON.parse(QuerySerializer.encodeEJSON(where)), expected);
  }
});
