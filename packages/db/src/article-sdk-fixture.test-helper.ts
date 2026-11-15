/** Offline transport for the REAL installed SDK. This is not a CloudBase emulator. */
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import cloudbase from '@cloudbase/node-sdk';
import type { ArticleDatabase } from './article-repository.ts';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
const { Db } = sdkRequire('@cloudbase/database');
const databaseRequire = createRequire(sdkRequire.resolve('@cloudbase/database/package.json'));
const { EJSON } = databaseRequire('bson');
type Row = Record<string, unknown>;
type Call = { api: string; params: Record<string, unknown> };
type Snapshot = {
  rows: Map<string, Row>;
  versions: Map<string, number>;
  reads: Map<string, number>;
  writes: Map<string, Row>;
};

function nested(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined,
      row,
    );
}

function project(row: Row, fields?: Record<string, number>): Row {
  if (!fields) return structuredClone(row);
  const output: Row = {};
  for (const [path, enabled] of Object.entries(fields)) {
    if (!enabled) continue;
    const value = nested(row, path);
    if (value === undefined) continue;
    const parts = path.split('.');
    let target = output;
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Row;
    }
    const last = parts.at(-1);
    if (last) target[last] = structuredClone(value);
  }
  return output;
}

function matches(row: Row, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([path, expected]) => {
    const value = nested(row, path);
    if (typeof expected !== 'object' || expected === null) return value === expected;
    if ('$in' in expected) {
      if (!Array.isArray(expected.$in)) throw Error('Invalid offline in query');
      return expected.$in.includes(value);
    }
    if ('$gt' in expected) return typeof value === 'string' && value > String(expected.$gt);
    if ('$regex' in expected)
      return typeof value === 'string' && new RegExp(String(expected.$regex)).test(value);
    if ('$regularExpression' in expected) {
      const expression = expected.$regularExpression as { pattern: string; options: string };
      return (
        typeof value === 'string' && new RegExp(expression.pattern, expression.options).test(value)
      );
    }
    throw new Error(`Unimplemented offline query: ${JSON.stringify(expected)}`);
  });
}

export function articleSdkFixture(t: TestContext) {
  const rows = new Map<string, Row>();
  const versions = new Map<string, number>();
  const transactions = new Map<string, Snapshot>();
  const calls: Call[] = [];
  let sequence = 0;
  const control: {
    failNextCommit: boolean;
    zeroNextWrite: boolean;
    zeroWriteCollection?: string;
    returnedReadError: boolean;
    beforeCommit?: (() => void) | undefined;
    afterQuery?: () => void;
  } = { failNextCommit: false, zeroNextWrite: false, returnedReadError: false };

  function put(collection: string, id: string, row: Row) {
    const key = `${collection}/${id}`;
    rows.set(key, structuredClone({ ...row, _id: id }));
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }

  class Request {
    async send(api: string, params: Record<string, unknown> = {}) {
      calls.push({ api, params: structuredClone(params) });
      if (api === 'database.startTransaction') {
        const transactionId = `article-tx-${++sequence}`;
        transactions.set(transactionId, {
          rows: structuredClone(rows),
          versions: new Map(versions),
          reads: new Map(),
          writes: new Map(),
        });
        return { transactionId };
      }
      const transaction = transactions.get(String(params.transactionId));
      if (api === 'database.commitTransaction') {
        if (!transaction) throw new Error('Missing offline transaction');
        control.beforeCommit?.();
        if (control.failNextCommit) {
          control.failNextCommit = false;
          throw new Error('Synthetic commit failure; PRIVATE_DATABASE_DETAIL');
        }
        for (const [key, version] of transaction.reads)
          if ((versions.get(key) ?? 0) !== version) throw { code: 'DATABASE_TRANSACTION_CONFLICT' };
        for (const [key, row] of transaction.writes) {
          rows.set(key, structuredClone(row));
          versions.set(key, (versions.get(key) ?? 0) + 1);
        }
        transactions.delete(String(params.transactionId));
        return {};
      }
      if (api === 'database.abortTransaction') {
        transactions.delete(String(params.transactionId));
        return {};
      }
      const collection = String(params.collectionName);
      const query: Record<string, unknown> = JSON.parse(String(params.query ?? '{}'));
      if (api === 'database.getDocument') {
        if (control.returnedReadError)
          return { code: 'DATABASE_PERMISSION_DENIED', message: 'PRIVATE_DATABASE_DETAIL' };
        if (transaction && typeof query._id === 'string') {
          const key = `${collection}/${query._id}`;
          if (!transaction.reads.has(key))
            transaction.reads.set(key, transaction.versions.get(key) ?? 0);
          const found = transaction.writes.get(key) ?? transaction.rows.get(key);
          return { data: { list: found ? [JSON.stringify(found)] : [] }, requestId: 'offline' };
        }
        const projection = params.projection ? JSON.parse(String(params.projection)) : undefined;
        const selected = [...rows.entries()]
          .filter(([key, row]) => key.startsWith(`${collection}/`) && matches(row, query))
          .map(([, row]) => row)
          .sort((a, b) => String(a._id).localeCompare(String(b._id)))
          .slice(0, Number(params.limit ?? 100));
        control.afterQuery?.();
        return {
          data: {
            list: selected.map((row) => JSON.stringify(project(row, projection))),
            total: selected.length,
          },
          requestId: 'offline',
        };
      }
      if (api === 'database.modifyDocument') {
        if (!transaction) throw new Error('Article writes must carry a transaction');
        if (control.zeroNextWrite || control.zeroWriteCollection === collection) {
          control.zeroNextWrite = false;
          return { data: { updated: 0 } };
        }
        const key = `${collection}/${query._id}`;
        const existed = transaction.rows.has(key);
        if (params.merge !== false || params.upsert !== true)
          throw new Error('Expected full-replacement set');
        const body = EJSON.parse(String(params.data));
        transaction.writes.set(key, { ...body, _id: query._id });
        return {
          data: { updated: existed ? 1 : 0, ...(existed ? {} : { upsert_id: query._id }) },
          requestId: 'offline',
        };
      }
      throw new Error(`Unexpected SDK API: ${api}`);
    }
  }
  // database() installs the SDK's default transport; replace it AFTER construction.
  const db: ArticleDatabase = cloudbase.init({ env: 'offline-article-contract' }).database();
  const original = Db.reqClass;
  Db.reqClass = Request;
  t.after(() => {
    Db.reqClass = original;
  });
  put('users', 'admin', { role: 'admin', status: 'active' });
  return { db, rows, calls, control, put };
}
