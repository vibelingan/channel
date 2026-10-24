import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  type CatalogReadiness,
  CatalogReadinessSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { catalogReadinessWhere, matchesCatalogReadiness } from './catalog-readiness-query.ts';
import { listDocumentsInCloudBase } from './cloudbase-adapter.ts';
import { expected, prepared, rows } from './testing/catalog-readiness-fixtures.ts';

const require = createRequire(import.meta.url);
const wxSdk = require('wx-server-sdk');
const nodeSdk = require('@cloudbase/node-sdk');
const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
const { QuerySerializer } = sdkRequire(
  join(dirname(sdkRequire.resolve('@cloudbase/database')), 'serializer/query.js'),
);
wxSdk.init({ env: 'offline-readiness-query' });
const command = wxSdk.database().command;
const scopes = CatalogReadinessSchema.options;
type Row = Record<string, unknown>;
const list = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};
function field(document: Row, path: string): unknown {
  let value: unknown = document;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
function expr(value: unknown, document: Row): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return field(document, value.slice(1));
  if (Array.isArray(value)) return value.map((x) => expr(x, document));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  const [op, arg] = entry;
  if (op === '$cond') {
    const [condition, yes, no] = list(arg);
    return expr(expr(condition, document) ? yes : no, document);
  }
  if (op === '$type') {
    const v = expr(arg, document);
    return v === undefined
      ? 'missing'
      : v === null
        ? 'null'
        : Array.isArray(v)
          ? 'array'
          : typeof v === 'number'
            ? 'double'
            : typeof v === 'object'
              ? 'object'
              : typeof v;
  }
  const values = list(arg).map((x) => expr(x, document));
  const [left, right] = values;
  switch (op) {
    case '$eq':
      return typeof left === typeof right && JSON.stringify(left) === JSON.stringify(right);
    case '$and':
      return values.every(Boolean);
    case '$or':
      return values.some(Boolean);
    case '$not':
      return !left;
    case '$ifNull':
      return left ?? right;
    case '$in':
      return list(right).includes(left);
    case '$gte':
      assert.equal(typeof left, 'number');
      return Number(left) >= Number(right);
    case '$lte':
      assert.equal(typeof left, 'number');
      return Number(left) <= Number(right);
    case '$mod':
      assert.equal(typeof left, 'number');
      return Number(left) % Number(right);
    default:
      throw Error(`Unsupported ${op}`);
  }
}
function matches(where: Row, doc: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === '$expr') return expr(value, doc) === true;
    if (key === '$and') return list(value).every((x) => matches(x as Row, doc));
    if (key === '$or') return list(value).some((x) => matches(x as Row, doc));
    const actual = field(doc, key);
    const candidates = Array.isArray(actual) ? actual : [actual];
    return Object.entries(value as Row).every(([op, operand]) => {
      if (op === '$eq') return candidates.includes(operand);
      if (op === '$in') return candidates.some((x) => list(operand).includes(x));
      if (op === '$exists') return (actual !== undefined) === operand;
      if (op === '$nin') return !candidates.some((x) => list(operand).includes(x));
      throw Error(`Unsupported ${op}`);
    });
  });
}
for (const scope of scopes)
  test(`installed SDK ${scope} predicate matches independently derived exact IDs`, () => {
    const query = QuerySerializer.encode(catalogReadinessWhere(command, scope));
    const nodeQuery = QuerySerializer.encode(
      catalogReadinessWhere(
        nodeSdk.init({ env: 'offline-readiness-query' }).database().command,
        scope,
      ),
    );
    assert.deepEqual(query, nodeQuery);
    assert.deepEqual(
      rows()
        .filter((row) => matches(query, row))
        .map((row) => row._id)
        .sort(),
      expected[scope],
    );
    for (const row of rows())
      assert.equal(matches(query, row), matchesCatalogReadiness(row, scope), `${scope}:${row._id}`);
  });
test('generation corruption never throws numeric operators or grants normal admission', () => {
  for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', true, {}, [], [2]]) {
    const p = prepared('bad-generation');
    p.catalogContentGeneration = generation as number;
    p.catalogPreparationReport.contentGeneration = generation as number;
    const query = QuerySerializer.encode(catalogReadinessWhere(command, 'normal'));
    assert.equal(matches(query, p), false, JSON.stringify(generation));
    assert.equal(matchesCatalogReadiness(p, 'normal'), false);
    assert.equal(
      matches(QuerySerializer.encode(catalogReadinessWhere(command, 'unchecked')), p),
      true,
    );
  }
});
test('unknown runtime scopes reject before constructing a widened native query', () => {
  for (const scope of ['invalid', null, [], {}]) {
    assert.throws(() => catalogReadinessWhere(command, scope as CatalogReadiness));
    assert.throws(() => matchesCatalogReadiness(prepared('p'), scope as CatalogReadiness));
  }
});
for (const scope of scopes)
  test(`actual cloud adapter uses one ${scope} predicate for count and page with no source reads`, async () => {
    const events: string[] = [];
    let saved: Row | undefined;
    let countWhere: Row | undefined;
    let pageWhere: Row | undefined;
    let offset = 0;
    let limit = 0;
    const data = rows();
    const query = {
      field: (_fields: Readonly<Record<string, boolean>>): never => {
        throw Error('Unexpected projection in legacy query');
      },
      where: (where: Row) => {
        assert.equal(saved, undefined);
        saved = where;
        events.push('where');
        return query;
      },
      count: async () => {
        countWhere = saved;
        events.push('count');
        return {
          total: data.filter((row) => matches(saved ? QuerySerializer.encode(saved) : {}, row))
            .length,
        };
      },
      orderBy: (_key: string, _direction: string) => {
        events.push('sort');
        return query;
      },
      skip: (n: number) => {
        offset = n;
        events.push('skip');
        return query;
      },
      limit: (n: number) => {
        limit = n;
        events.push('limit');
        return query;
      },
      get: async () => {
        pageWhere = saved;
        events.push('get');
        return {
          data: data
            .filter((row) => matches(saved ? QuerySerializer.encode(saved) : {}, row))
            .sort((a, b) => String(a._id).localeCompare(String(b._id)))
            .slice(offset, offset + limit),
        };
      },
    };
    const database = {
      command,
      RegExp: () => {
        throw Error('Unexpected regexp');
      },
      collection: (name: string) => {
        assert.equal(name, 'products');
        events.push('collection');
        return {
          ...query,
          doc: () => {
            throw Error('Unexpected per-row read');
          },
          add: async () => {
            throw Error('Unexpected write');
          },
        };
      },
    };
    const result = await listDocumentsInCloudBase(database, {
      collection: 'products',
      catalogReadiness: scope,
      page: 2,
      pageSize: 1,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
    });
    assert.equal(result.total, expected[scope].length);
    assert.deepEqual(
      result.items.map((row) => row._id),
      expected[scope].slice(1, 2),
    );
    assert.equal(countWhere, pageWhere);
    assert.deepEqual(events, ['collection', 'where', 'count', 'sort', 'skip', 'limit', 'get']);
  });

for (const answer of [
  {},
  { total: '2' },
  { total: -1 },
  { total: 1.5 },
  { total: Number.POSITIVE_INFINITY },
  { total: 2, code: 'READ_UNAVAILABLE' },
])
  test(`uncertain native count cannot become a successful empty or partial list: ${JSON.stringify(answer)}`, async () => {
    let gets = 0;
    const query = {
      field: (_fields: Readonly<Record<string, boolean>>): never => {
        throw Error('Unexpected projection in legacy query');
      },
      where: () => query,
      orderBy: () => query,
      skip: () => query,
      limit: () => query,
      count: async () => answer,
      get: async () => {
        gets++;
        return { data: [] };
      },
    };
    const database = {
      command,
      RegExp: () => null,
      collection: () => ({
        ...query,
        doc: () => {
          throw Error('Unexpected doc');
        },
        add: async () => {
          throw Error('Unexpected write');
        },
      }),
    };
    await assert.rejects(
      listDocumentsInCloudBase(database as never, {
        collection: 'products',
        catalogReadiness: 'normal',
        page: 1,
        pageSize: 20,
        search: '',
      }),
    );
    assert.equal(gets, 0);
  });
for (const answer of [
  {},
  { data: null },
  { data: {} },
  { data: [null] },
  { data: [{ name: 'missing-id' }] },
  { data: [], code: 'READ_UNAVAILABLE' },
])
  test(`uncertain native rows cannot masquerade as a valid result: ${JSON.stringify(answer)}`, async () => {
    const query = {
      field: (_fields: Readonly<Record<string, boolean>>): never => {
        throw Error('Unexpected projection in legacy query');
      },
      where: () => query,
      orderBy: () => query,
      skip: () => query,
      limit: () => query,
      count: async () => ({ total: 2 }),
      get: async () => answer,
    };
    const database = {
      command,
      RegExp: () => null,
      collection: () => ({
        ...query,
        doc: () => {
          throw Error('Unexpected doc');
        },
        add: async () => {
          throw Error('Unexpected write');
        },
      }),
    };
    await assert.rejects(
      listDocumentsInCloudBase(database as never, {
        collection: 'products',
        catalogReadiness: 'normal',
        page: 1,
        pageSize: 20,
        search: '',
      }),
    );
  });

for (const input of [
  {
    sort: undefined,
    expected: [
      ['createdAt', 'desc'],
      ['_id', 'asc'],
    ],
  },
  {
    sort: [{ field: 'name', dir: 'desc' as const }],
    expected: [
      ['name', 'desc'],
      ['_id', 'asc'],
    ],
  },
  { sort: [{ field: '_id', dir: 'desc' as const }], expected: [['_id', 'desc']] },
])
  test(`native scoped sort has one identity tie break: ${JSON.stringify(input.sort)}`, async () => {
    const sorts: unknown[] = [];
    const query = {
      field: (_fields: Readonly<Record<string, boolean>>): never => {
        throw Error('Unexpected projection in legacy query');
      },
      where: () => query,
      count: async () => ({ total: 0 }),
      orderBy: (key: string, direction: string) => {
        sorts.push([key, direction]);
        return query;
      },
      skip: () => query,
      limit: () => query,
      get: async () => ({ data: [] }),
    };
    const db = {
      command,
      RegExp: () => null,
      collection: () => ({
        ...query,
        doc: () => {
          throw Error('No row read');
        },
        add: async () => {
          throw Error('No write');
        },
      }),
    };
    const result = await listDocumentsInCloudBase(db, {
      collection: 'products',
      catalogReadiness: 'normal',
      page: 1,
      pageSize: 20,
      search: '',
      ...(input.sort ? { sort: input.sort } : {}),
    });
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.deepEqual(sorts, input.expected);
  });
