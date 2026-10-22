import { createRequire } from 'node:module';
import { fail, id, jsonCopy, tables } from './ledger.mjs';

const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));

/** Resolve the SDK from its direct workspace owner under pnpm's isolated layout. */
export function createCloudbaseReleaseDatabase(config) {
  return dbRequire('@cloudbase/node-sdk').init(config).database();
}

/** Inject app.database() from @cloudbase/node-sdk with an explicit, fixed environment. */
export function createCloudbaseReleaseStore({ db, envId }) {
  id(envId);
  if (db?.config?.env !== envId || typeof db.runTransaction !== 'function')
    fail('STORE_ENV_MISMATCH');
  return Object.freeze({
    envId,
    async transact(callback) {
      if (typeof callback !== 'function') fail('INVALID_TRANSACTION');
      return db.runTransaction(async (transaction) => {
        const reads = new Set();
        const writes = new Map();
        let operations = 0;
        const ref = (table, key) => {
          if (!Object.hasOwn(tables, table) || !/^[a-f0-9]{64}(?:-(?:site|canary))?$/.test(key))
            fail('INVALID_LEDGER_REF');
          return transaction.collection(tables[table]).doc(key);
        };
        const count = () => {
          if (++operations > 24) fail('TRANSACTION_LIMIT');
        };
        const value = await callback(
          Object.freeze({
            async get(table, key) {
              if (writes.size) fail('READ_AFTER_WRITE');
              count();
              const result = await ref(table, key).get();
              if (result?.code) fail('STORE_READ_FAILED', String(result.code));
              if (
                !result ||
                !Object.hasOwn(result, 'data') ||
                (result.data !== null &&
                  (typeof result.data !== 'object' || Array.isArray(result.data)))
              )
                fail('STORE_READ_FAILED');
              reads.add(`${table}/${key}`);
              if (result.data === null) return null;
              const { _id, ...body } = result.data;
              if (_id !== undefined && _id !== key) fail('STORE_READ_FAILED');
              return jsonCopy(body);
            },
            put(table, key, body) {
              ref(table, key);
              if (!reads.has(`${table}/${key}`)) fail('BLIND_WRITE');
              if (
                !body ||
                typeof body !== 'object' ||
                Array.isArray(body) ||
                Object.hasOwn(body, '_id')
              )
                fail('INVALID_LEDGER_DOCUMENT');
              writes.set(`${table}/${key}`, { table, key, body: jsonCopy(body) });
            },
          }),
        );
        for (const { table, key, body } of writes.values()) {
          count();
          const result = await ref(table, key).set(body);
          if (
            result?.code ||
            typeof result?.requestId !== 'string' ||
            !result.requestId ||
            !(result.updated === 1 || result.upserted?.some((item) => item._id === key))
          )
            fail('STORE_WRITE_FAILED', String(result?.code ?? 'Unconfirmed document write'));
        }
        return value;
      });
    },
  });
}
