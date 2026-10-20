import { createRequire } from 'node:module';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';

const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const cloudbase = dbRequire('@cloudbase/node-sdk');
const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));
const { Db } = sdkRequire('@cloudbase/database');

/** Replace only the network transport. Transaction, get, set and retry are the installed SDK. */
export function cloudbaseFixture(t) {
  const rows = new Map();
  const versions = new Map();
  const transactions = new Map();
  const calls = [];
  let next = 0;
  let getFault;
  let setFault;
  let commitFault;
  const app = cloudbase.init({ env: 'fixture-env' });
  const db = app.database();
  const original = Db.reqClass;
  Db.reqClass = class {
    async send(action, params = {}) {
      calls.push({ action, params: structuredClone(params) });
      if (action === 'database.startTransaction') {
        const transactionId = `tx-${++next}`;
        transactions.set(transactionId, {
          rows: structuredClone(rows),
          versions: new Map(versions),
          reads: new Set(),
          writes: new Map(),
        });
        return { transactionId, requestId: `request-${next}` };
      }
      const tx = transactions.get(params.transactionId);
      if (!tx) throw new Error('Missing wire transaction');
      if (action === 'database.abortTransaction') {
        transactions.delete(params.transactionId);
        return { requestId: 'abort' };
      }
      if (action === 'database.commitTransaction') {
        if (commitFault === 'conflict') {
          commitFault = null;
          transactions.delete(params.transactionId);
          return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'fixture conflict' };
        }
        for (const key of tx.reads)
          if ((versions.get(key) ?? 0) !== (tx.versions.get(key) ?? 0)) {
            transactions.delete(params.transactionId);
            return { code: 'DATABASE_TRANSACTION_CONFLICT' };
          }
        for (const [key, value] of tx.writes) {
          rows.set(key, value);
          versions.set(key, (versions.get(key) ?? 0) + 1);
        }
        transactions.delete(params.transactionId);
        if (commitFault === 'lost-ack') {
          commitFault = null;
          throw new Error('Commit response lost');
        }
        return { requestId: 'commit' };
      }
      const { _id } = JSON.parse(params.query);
      const key = `${params.collectionName}/${_id}`;
      if (action === 'database.getDocument') {
        if (tx.writes.size) throw new Error('Wire read after write');
        if (getFault) {
          const result = getFault;
          getFault = null;
          return result;
        }
        tx.reads.add(key);
        const row = tx.rows.get(key);
        return { data: { list: row ? [JSON.stringify({ ...row, _id })] : [] }, requestId: 'get' };
      }
      if (action === 'database.modifyDocument') {
        if (!tx.reads.has(key) || params.merge !== false || params.upsert !== true)
          throw new Error('Unexpected SDK write shape');
        if (setFault) {
          const result = setFault;
          setFault = null;
          return result;
        }
        const value = JSON.parse(params.data);
        if (Object.hasOwn(value, 'data') || Object.hasOwn(value, '_id'))
          throw new Error('Wrong Node SDK set wrapper');
        tx.writes.set(key, value);
        return {
          data: {
            updated: tx.rows.has(key) ? 1 : 0,
            upsert_id: tx.rows.has(key) ? undefined : _id,
          },
          requestId: 'set',
        };
      }
      throw new Error(`Unexpected SDK network action: ${action}`);
    }
  };
  t.after(() => {
    Db.reqClass = original;
  });
  return {
    db,
    calls,
    rows,
    store: createCloudbaseReleaseStore({ db, envId: 'fixture-env' }),
    fault: {
      get(result) {
        getFault = result;
      },
      set(result) {
        setFault = result;
      },
      commit(value) {
        commitFault = value;
      },
    },
  };
}
