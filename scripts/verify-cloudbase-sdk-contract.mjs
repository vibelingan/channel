import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const localServerRequire = createRequire(
  new URL('../apps/local-server/package.json', import.meta.url),
);

const results = [];

function record(ok, label, detail = '') {
  results.push({ ok, label, detail });
}

function requireCheck(condition, label, detail = '') {
  record(Boolean(condition), label, detail);
}

function resolvePackage(pkg) {
  const packagePath = dbRequire.resolve(`${pkg}/package.json`);
  const meta = dbRequire(packagePath);
  return { packagePath, root: dirname(packagePath), meta };
}

function readPackageFile(pkgInfo, relPath) {
  const file = join(pkgInfo.root, relPath);
  if (!existsSync(file)) {
    throw new Error(`Missing ${relPath} in ${pkgInfo.packagePath}`);
  }
  return readFileSync(file, 'utf8');
}

function containsAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

const nodeSdk = resolvePackage('@cloudbase/node-sdk');
const wxSdk = resolvePackage('wx-server-sdk');
const nodeSdkRequire = createRequire(nodeSdk.packagePath);
const databasePackagePath = nodeSdkRequire.resolve('@cloudbase/database/package.json');
const databasePackage = nodeSdkRequire(databasePackagePath);

requireCheck(
  nodeSdk.meta.version === '3.17.2',
  'resolved @cloudbase/node-sdk 3.17.2',
  nodeSdk.packagePath,
);
requireCheck(wxSdk.meta.version === '4.0.2', 'resolved wx-server-sdk 4.0.2', wxSdk.packagePath);
requireCheck(
  databasePackage.version === '1.4.3',
  'resolved @cloudbase/database 1.4.3',
  databasePackagePath,
);

const cloudbase = dbRequire('@cloudbase/node-sdk');
const storageApp = cloudbase.init({ env: 'contract-check' });
const nodeDatabase = storageApp.database();
requireCheck(
  typeof nodeDatabase.runTransaction === 'function',
  '@cloudbase/node-sdk database exposes runTransaction',
);
requireCheck(
  typeof storageApp.getUploadMetadata === 'function',
  '@cloudbase/node-sdk app exposes getUploadMetadata',
);
requireCheck(
  typeof storageApp.uploadFile === 'function',
  '@cloudbase/node-sdk app exposes uploadFile',
);
requireCheck(
  typeof storageApp.getTempFileURL === 'function',
  '@cloudbase/node-sdk app exposes getTempFileURL',
);
requireCheck(
  typeof storageApp.deleteFile === 'function',
  '@cloudbase/node-sdk app exposes deleteFile',
);

const wx = dbRequire('wx-server-sdk');
wx.init({ env: 'contract-check' });
requireCheck(typeof wx.database === 'function', 'wx-server-sdk exposes database');
requireCheck(typeof wx.uploadFile === 'function', 'wx-server-sdk exposes uploadFile');
requireCheck(typeof wx.getTempFileURL === 'function', 'wx-server-sdk exposes getTempFileURL');
requireCheck(typeof wx.deleteFile === 'function', 'wx-server-sdk exposes deleteFile');
requireCheck(
  typeof wx.getUploadMetadata === 'undefined',
  'wx-server-sdk does not expose getUploadMetadata',
  'If this changes in a future SDK, update the design and integration intentionally.',
);
const wxDatabase = wx.database();

const listFieldProbe = `
  import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  import { ADMIN_PRODUCT_LIST_PROJECTION } from './packages/db/src/catalog-product-list-view.ts';
  const require = createRequire(new URL('./packages/db/package.json', import.meta.url));
  const wx = require('wx-server-sdk'); wx.init({ env: 'offline-admin-list-field' });
  const node = require('@cloudbase/node-sdk');
  for (const [name, db] of [['wx', wx.database()], ['node', node.init({ env: 'offline-admin-list-field' }).database()]]) {
    const base = db.collection('products').where({ _id: 'owned-projection' });
    const projected = base.field(ADMIN_PRODUCT_LIST_PROJECTION);
    const options = query => (query._query ?? query)._apiOptions;
    assert.notEqual(projected, base);
    assert.equal(options(base).projection, undefined);
    assert.deepEqual(options(projected).projection,
      Object.fromEntries(Object.keys(ADMIN_PRODUCT_LIST_PROJECTION).map(field => [field, 1])));
    assert.equal(options(projected).projection['alibabaAutoPhotos.gallery'], 1);
    assert.equal(Object.hasOwn(options(projected).projection, 'description'), false);
    const query = projected._query ?? projected;
    let sent = 0;
    query._request.send = async (api, params) => {
      assert.equal(api, 'database.getDocument');
      assert.deepEqual(JSON.parse(params.projection),
        Object.fromEntries(Object.keys(ADMIN_PRODUCT_LIST_PROJECTION).map(field => [field, { $numberInt: '1' }])));
      sent++;
      return { data: { list: [] }, requestId: 'owned-field-send' };
    };
    await projected.get();
    assert.equal(sent, 1);
    console.log(name + ':fixed-product-list-field-ok');
  }
`;
const listFieldEvidence = execFileSync(
  process.execPath,
  ['--experimental-strip-types', '--input-type=module', '--eval', listFieldProbe],
  { cwd: root, encoding: 'utf8' },
);
requireCheck(
  listFieldEvidence.includes('wx:fixed-product-list-field-ok') &&
    listFieldEvidence.includes('node:fixed-product-list-field-ok'),
  'both installed SDKs encode the actual fixed admin list projection without mutating the base query',
);
requireCheck(
  typeof wxDatabase.command.exists === 'function' && wxDatabase.command.exists(false) !== undefined,
  'wx-server-sdk command exposes exists(false) for strict missing-field queries',
);

for (const [name, command] of [
  ['@cloudbase/node-sdk', nodeDatabase.command],
  ['wx-server-sdk', wxDatabase.command],
]) {
  requireCheck(
    ['and', 'or', 'eq', 'in', 'exists', 'expr', 'elemMatch'].every(
      (method) => typeof command[method] === 'function',
    ),
    `${name} exposes the subcategory query command surface`,
  );
  requireCheck(
    [
      'cond',
      'isArray',
      'size',
      'setUnion',
      'setIsSubset',
      'setIntersection',
      'and',
      'eq',
      'lte',
      'gt',
    ].every((method) => typeof command.aggregate[method] === 'function'),
    `${name} exposes the subcategory aggregation expression operators`,
  );
}

const subcategoryProbe = `
  import { createRequire } from 'node:module';
  import { dirname, join } from 'node:path';
  import { productSubcategoryWhere } from './packages/db/src/product-subcategory-query.ts';
  const require = createRequire(new URL('./packages/db/package.json', import.meta.url));
  const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
  const { QuerySerializer } = sdkRequire(join(dirname(sdkRequire.resolve('@cloudbase/database')), 'serializer/query.js'));
  const nodeSdk = require('@cloudbase/node-sdk');
  const wxSdk = require('wx-server-sdk');
  wxSdk.init({ env: 'offline-subcategory-contract' });
  const commands = [nodeSdk.init({ env: 'offline-subcategory-contract' }).database().command, wxSdk.database().command];
  console.log(JSON.stringify(commands.map((command) => ({
    invalid: JSON.parse(QuerySerializer.encodeEJSON(productSubcategoryWhere(command, null))),
    queries: ['headphones', 'ai-gadgets', 'toys', 'misc'].map((family) => {
      const ids = [family === 'headphones' ? 'headphones-wired' : 'selected'];
      return JSON.parse(QuerySerializer.encodeEJSON(productSubcategoryWhere(command, { family, ids, knownIds: [...ids, 'retired'] })));
    }),
  }))));
`;
const subcategoryProbes = JSON.parse(
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', subcategoryProbe],
    { cwd: root, encoding: 'utf8' },
  ).trim(),
);
requireCheck(
  isDeepStrictEqual(subcategoryProbes[0], subcategoryProbes[1]) &&
    subcategoryProbes.every((probe) =>
      isDeepStrictEqual(probe.invalid, { _id: { $exists: false } }),
    ),
  'node and wx SDKs serialize the import-free subcategory helper identically and fail closed',
);
for (const [position, family] of ['headphones', 'ai-gadgets', 'toys', 'misc'].entries()) {
  const ids = [family === 'headphones' ? 'headphones-wired' : 'selected'];
  const expected = {
    $cond: [
      { $isArray: '$subcategoryIds' },
      {
        $and: [
          { $lte: [{ $size: '$subcategoryIds' }, { $numberInt: '16' }] },
          {
            $eq: [{ $size: '$subcategoryIds' }, { $size: { $setUnion: ['$subcategoryIds', []] } }],
          },
          { $setIsSubset: ['$subcategoryIds', [...ids, 'retired']] },
          { $gt: [{ $size: { $setIntersection: ['$subcategoryIds', ids] } }, { $numberInt: '0' }] },
        ],
      },
      false,
    ],
  };
  requireCheck(
    subcategoryProbes.every(({ queries }) => {
      const assignment = queries[position].$and[1];
      return isDeepStrictEqual(
        family === 'headphones' ? assignment.$or[0].$expr : assignment.$expr,
        expected,
      );
    }),
    `installed SDK query serializer preserves the guarded ${family} subcategory expression`,
  );
}

const readinessProbe = `
  import { createRequire } from 'node:module';
  import { dirname, join } from 'node:path';
  import assert from 'node:assert/strict';
  import { catalogReadinessWhere } from './packages/db/src/catalog-readiness-query.ts';
  const require = createRequire(new URL('./packages/db/package.json', import.meta.url));
  const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
  const { QuerySerializer } = sdkRequire(join(dirname(sdkRequire.resolve('@cloudbase/database')), 'serializer/query.js'));
  const nodeSdk = require('@cloudbase/node-sdk');
  const wxSdk = require('wx-server-sdk');
  wxSdk.init({ env: 'offline-readiness-contract' });
  const commands = [nodeSdk.init({ env: 'offline-readiness-contract' }).database().command, wxSdk.database().command];
  const plain = { and: c => ({$and:c}), or: c => ({$or:c}), eq: v => ({$eq:v}), in: v => ({$in:v}), expr: v => ({$expr:v}) };
  for (const scope of ['all','normal','issues','preparing','unchecked']) {
    const expected = catalogReadinessWhere(plain,scope);
    for (const command of commands) assert.deepEqual(QuerySerializer.encode(catalogReadinessWhere(command,scope)),expected);
  }
  console.log('five native readiness scopes preserved by both installed SDK serializers');
`;
requireCheck(
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', readinessProbe],
    { cwd: root, encoding: 'utf8' },
  ).includes('five native readiness scopes preserved'),
  'node and wx serializers preserve readiness identity, scalar, guarded numeric and before-page expressions',
);

const nodeTypes = readPackageFile(
  nodeSdk,
  nodeSdk.meta.types ?? nodeSdk.meta.typings ?? 'types/index.d.ts',
);
// node-sdk 3.x splits the database typings into types/db.d.ts.
const nodeDbTypes = readPackageFile(nodeSdk, 'types/db.d.ts');
const transactionTypeStart = nodeDbTypes.indexOf('export class Transaction');
const transactionTypeEnd = nodeDbTypes.indexOf(
  'export interface CommitResult',
  transactionTypeStart,
);
const transactionTypes =
  transactionTypeStart >= 0 && transactionTypeEnd > transactionTypeStart
    ? nodeDbTypes.slice(transactionTypeStart, transactionTypeEnd)
    : '';
requireCheck(
  nodeDbTypes.includes('runTransaction: (') &&
    transactionTypes.includes('collection(collName: string)'),
  '@cloudbase/node-sdk types expose runTransaction transaction collections',
);
const databaseEntry = nodeSdkRequire.resolve('@cloudbase/database');
const transactionRuntime = readFileSync(
  join(dirname(databaseEntry), 'transaction/index.js'),
  'utf8',
);
requireCheck(
  containsAll(transactionRuntime, [
    'const callbackRes = await callback(transaction);',
    'await transaction.commit();',
    'return callbackRes;',
    'await transaction.rollback();',
    'ERRORS.DATABASE_TRANSACTION_CONFLICT.code',
    'return await runTransaction.bind(this)(callback, --times);',
    // docs/agents/cloudbase.md: "retries 3 times with no pause".
    'async function runTransaction(callback, times = 3)',
  ]),
  '@cloudbase/database runTransaction commits, returns callback results, rolls back, and retries conflicts',
);
const databaseModule = nodeSdkRequire('@cloudbase/database');
const originalRequestClass = databaseModule.Db.reqClass;
const transactionCalls = [];
let transactionSequence = 0;
class FakeTransactionRequest {
  async send(api) {
    transactionCalls.push(api);
    if (api === 'database.startTransaction') {
      transactionSequence += 1;
      return { transactionId: `transaction-${transactionSequence}` };
    }
    return { requestId: `request-${transactionCalls.length}` };
  }
}
try {
  databaseModule.Db.reqClass = FakeTransactionRequest;
  const fakeDatabase = new databaseModule.Db({});
  transactionCalls.length = 0;
  const successResult = await fakeDatabase.runTransaction(async (transaction) =>
    transaction.getTransactionId(),
  );
  const successCalls = [...transactionCalls];

  transactionCalls.length = 0;
  let rollbackCaught = false;
  try {
    await fakeDatabase.runTransaction(async () => {
      throw new Error('rollback-probe');
    }, 0);
  } catch (error) {
    rollbackCaught = error instanceof Error && error.message === 'rollback-probe';
  }
  const rollbackCalls = [...transactionCalls];

  transactionCalls.length = 0;
  let conflictAttempts = 0;
  const conflictResult = await fakeDatabase.runTransaction(async () => {
    conflictAttempts += 1;
    if (conflictAttempts === 1) throw { code: 'DATABASE_TRANSACTION_CONFLICT' };
    return 'retried';
  }, 1);
  const conflictCalls = [...transactionCalls];

  requireCheck(
    successResult === 'transaction-1' &&
      JSON.stringify(successCalls) ===
        JSON.stringify(['database.startTransaction', 'database.commitTransaction']) &&
      rollbackCaught &&
      JSON.stringify(rollbackCalls) ===
        JSON.stringify(['database.startTransaction', 'database.abortTransaction']) &&
      conflictResult === 'retried' &&
      conflictAttempts === 2 &&
      JSON.stringify(conflictCalls) ===
        JSON.stringify([
          'database.startTransaction',
          'database.startTransaction',
          'database.commitTransaction',
        ]),
    '@cloudbase/database runTransaction behavior passes commit, rollback, result, and retry probes',
  );
  // DEC-21: the admin function answers BUSY by this code once the SDK's own
  // retries run out, so the same error must come back, code intact.
  transactionCalls.length = 0;
  let exhaustedCode = null;
  try {
    await fakeDatabase.runTransaction(async () => {
      throw { code: 'DATABASE_TRANSACTION_CONFLICT' };
    }, 1);
  } catch (error) {
    exhaustedCode = error?.code ?? null;
  }
  requireCheck(
    exhaustedCode === 'DATABASE_TRANSACTION_CONFLICT' &&
      transactionCalls.filter((api) => api === 'database.startTransaction').length === 2 &&
      transactionCalls.includes('database.abortTransaction'),
    '@cloudbase/database rethrows DATABASE_TRANSACTION_CONFLICT after its retries (admin answers BUSY, DEC-21)',
  );
  // DEC-21: production goes through @cloudbase/node-sdk, whose request layer
  // THROWS a coded database answer (throwOnCode defaults to true), so
  // runTransaction sees the conflict code and retries.
  const nodeSdkRoot = dirname(nodeSdk.packagePath);
  const nodeSdkUtils = readFileSync(join(nodeSdkRoot, 'dist/utils/utils.js'), 'utf8');
  const nodeSdkRequester = readFileSync(join(nodeSdkRoot, 'dist/utils/tcbapirequester.js'), 'utf8');
  requireCheck(
    containsAll(nodeSdkUtils, ['let throwOnCode = true;', 'throw E(Object.assign({}, result));']) &&
      containsAll(nodeSdkRequester, ['return processReturn(result);']),
    '@cloudbase/node-sdk throws a coded database answer by default (throwOnCode true)',
  );
  // Ownerless legacy intent fields must stay absent, never become null on wire.
  const ownerlessWrites = [];
  class OwnerlessTransactionRequest {
    async send(api, params) {
      if (api === 'database.startTransaction') return { transactionId: 'ownerless-probe' };
      if (api === 'database.modifyDocument') {
        ownerlessWrites.push(params);
        return { data: { updated: 1, upsert_id: 'ownerless' }, requestId: 'ownerless-set' };
      }
      return { requestId: 'ownerless-request' };
    }
  }
  databaseModule.Db.reqClass = OwnerlessTransactionRequest;
  const ownerlessDb = new databaseModule.Db({});
  const ownerlessTransaction = await ownerlessDb.startTransaction();
  await ownerlessTransaction
    .collection('probe')
    .doc('ownerless')
    .set({
      uploadedByUserId: undefined,
      imageDeletion: {
        schemaVersion: 'image-deletion-ownerless-v1',
        uploadedByUserId: undefined,
        storageFileIds: ['cloud://Env.Bucket/Case%20Key '],
      },
    });
  const ownerlessWire = JSON.parse(ownerlessWrites[0].data);
  requireCheck(
    !Object.hasOwn(ownerlessWire, 'uploadedByUserId') &&
      !Object.hasOwn(ownerlessWire.imageDeletion, 'uploadedByUserId') &&
      ownerlessWire.imageDeletion.schemaVersion === 'image-deletion-ownerless-v1' &&
      ownerlessWire.imageDeletion.storageFileIds[0] === 'cloud://Env.Bucket/Case%20Key ',
    '@cloudbase/database native set preserves absent ownerless fields and exact permanent identifiers',
  );
  // The bare @cloudbase/database API instead ANSWERS a failed read or write with
  // { code }, not thrown; the approval wrappers rethrow it (sdkAnswer).
  class CodedTransactionRequest {
    async send(api) {
      if (api === 'database.startTransaction') return { transactionId: 'transaction-coded' };
      if (api === 'database.modifyDocument' || api === 'database.getDocument')
        return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'probe' };
      return { requestId: 'request-coded' };
    }
  }
  databaseModule.Db.reqClass = CodedTransactionRequest;
  const codedDatabase = new databaseModule.Db({});
  const codedTransaction = await codedDatabase.startTransaction();
  const codedSet = await codedTransaction.collection('probe').doc('probe').set({ value: 1 });
  const codedGet = await codedTransaction.collection('probe').doc('probe').get();
  requireCheck(
    codedSet?.code === 'DATABASE_TRANSACTION_CONFLICT' &&
      codedGet?.code === 'DATABASE_TRANSACTION_CONFLICT',
    '@cloudbase/database answers a failed in-transaction set/get with { code } instead of throwing (sdkAnswer rethrows it, DEC-21)',
  );
} finally {
  databaseModule.Db.reqClass = originalRequestClass;
}

// ---------------------------------------------------------------------------
// Alibaba sync lease surfaces (docs/alibaba-linked-catalog-sync, MIU 4):
// the fenced lease and createDocWithId/upsertDocWithId rely on in-transaction
// doc.get() (missing -> {data: null}) and doc.set() acting as a full-replace
// upsert routed through database.modifyDocument with the transactionId.
// Static probe: the installed @cloudbase/database source must implement set()
// with exactly that contract.
// ---------------------------------------------------------------------------
const documentRuntime = readFileSync(join(dirname(databaseEntry), 'document.js'), 'utf8');
requireCheck(
  containsAll(documentRuntime, [
    "await this.request.send('database.modifyDocument'",
    'upsert: true',
    'merge: false',
    'transactionId: this._transactionId',
  ]),
  '@cloudbase/database doc.set is a transaction-aware full-replace upsert via database.modifyDocument',
);
requireCheck(
  containsAll(documentRuntime, [
    "await this.request.send('database.getDocument'",
    'data: documents[0] || null',
  ]),
  '@cloudbase/database in-transaction doc.get resolves {data: doc|null} for missing documents',
);
requireCheck(
  containsAll(documentRuntime, [
    "await this.request.send('database.removeDocument'",
    'transactionId: this._transactionId',
    'deleted: res.data.deleted',
  ]),
  '@cloudbase/database doc.remove is transaction-aware and returns the deleted count',
);
// wx-server-sdk wraps @cloudbase/database's delete count as
// `{ stats: { removed } }`; the adapter's plain `remove()` reads it there
// (`wxRemovedCount`). Reading `deleted` made every delete report failure.
const wxRuntime = readFileSync(join(dirname(wxSdk.packagePath), 'index.js'), 'utf8');
requireCheck(
  containsAll(wxRuntime, ['stats: {', 'removed: removeResult.deleted || 0']),
  'wx-server-sdk doc.remove resolves { stats: { removed } }',
);
requireCheck(
  containsAll(readFileSync(join(root, 'packages/db/src/cloudbase-adapter.ts'), 'utf8'), [
    'return wxRemovedCount(res) > 0;',
  ]),
  'cloudbase-adapter remove() reads the wx-server-sdk removed count',
);
// Runtime probe: drive a transaction through get(miss) -> set -> update ->
// remove and pin the API sequence + transaction params actually sent.
{
  const txCalls = [];
  class FakeLeaseProbeRequest {
    async send(api, params) {
      txCalls.push({ api, params });
      if (api === 'database.startTransaction') return { transactionId: 'lease-probe-tx' };
      if (api === 'database.getDocument') return { requestId: 'r', data: { list: [] } };
      if (api === 'database.modifyDocument') {
        if (params?.query?.includes('update-not-found'))
          return { requestId: 'r', data: { updated: 0 } };
        if (params?.query?.includes('approval-new'))
          return { requestId: 'r', data: { updated: 0, upsert_id: 'approval-new' } };
        return { requestId: 'r', data: { updated: 1, upsert_id: 'conn-1' } };
      }
      if (api === 'database.removeDocument') {
        return { requestId: 'r', data: { deleted: 1 } };
      }
      return { requestId: 'r' };
    }
  }
  const originalReqClass = databaseModule.Db.reqClass;
  try {
    databaseModule.Db.reqClass = FakeLeaseProbeRequest;
    const probeDb = new databaseModule.Db({});
    const probeResult = await probeDb.runTransaction(async (transaction) => {
      const ref = transaction.collection('alibabaSyncLeases').doc('conn-1');
      const missing = await ref.get();
      const setResult = await ref.set({ holder: 'h', fence: 1 });
      const updateResult = await ref.update({ heartbeatAt: 'x' });
      const removeResult = await ref.remove();
      return {
        missing: missing.data,
        updated: setResult.updated,
        updateCount: updateResult.updated,
        deleted: removeResult.deleted,
      };
    });
    const apiSequence = txCalls.map((call) => call.api);
    const setCall = txCalls.find(
      (call) => call.api === 'database.modifyDocument' && call.params?.upsert === true,
    );
    const updateCall = txCalls.find(
      (call) => call.api === 'database.modifyDocument' && call.params?.upsert === false,
    );
    const removeCall = txCalls.find((call) => call.api === 'database.removeDocument');
    requireCheck(
      probeResult.missing === null &&
        probeResult.updated === 1 &&
        probeResult.deleted === 1 &&
        JSON.stringify(apiSequence) ===
          JSON.stringify([
            'database.startTransaction',
            'database.getDocument',
            'database.modifyDocument',
            'database.modifyDocument',
            'database.removeDocument',
            'database.commitTransaction',
          ]) &&
        setCall?.params?.merge === false &&
        setCall?.params?.transactionId === 'lease-probe-tx' &&
        setCall?.params?.query?.includes('conn-1') &&
        updateCall?.params?.merge === true &&
        updateCall?.params?.transactionId === 'lease-probe-tx' &&
        removeCall?.params?.transactionId === 'lease-probe-tx' &&
        removeCall?.params?.query?.includes('conn-1'),
      '@cloudbase/database transaction get/set/update/remove probe matches deterministic write contracts',
    );

    requireCheck(
      probeResult.updateCount === 1,
      '@cloudbase/database update exposes the exact affected-document count',
    );
    const notUpdated = await probeDb.runTransaction((transaction) =>
      transaction.collection('probe').doc('update-not-found').update({ value: 'changed' }),
    );
    requireCheck(
      notUpdated.updated === 0,
      '@cloudbase/database update preserves a zero-write ACK for caller rejection',
    );

    txCalls.length = 0;
    let postWriteRollbackCaught = false;
    try {
      await probeDb.runTransaction(async (transaction) => {
        await transaction.collection('catalogProductIdentities').doc('slug:failed').set({
          kind: 'slug',
          normalizedValue: 'failed',
          productId: 'product-failed',
        });
        throw new Error('catalog-save-rollback-probe');
      }, 0);
    } catch (error) {
      postWriteRollbackCaught =
        error instanceof Error && error.message === 'catalog-save-rollback-probe';
    }
    const postWriteRollbackCalls = txCalls.map((call) => call.api);
    requireCheck(
      postWriteRollbackCaught &&
        JSON.stringify(postWriteRollbackCalls) ===
          JSON.stringify([
            'database.startTransaction',
            'database.modifyDocument',
            'database.abortTransaction',
          ]),
      '@cloudbase/database aborts a catalog transaction when the callback fails after a write',
    );

    txCalls.length = 0;
    let catalogConflictAttempts = 0;
    const catalogRetryResult = await probeDb.runTransaction(async (transaction) => {
      catalogConflictAttempts += 1;
      await transaction.collection('catalogProductIdentities').doc('slug:retry').set({
        kind: 'slug',
        normalizedValue: 'retry',
        productId: 'product-retry',
      });
      if (catalogConflictAttempts === 1) throw { code: 'DATABASE_TRANSACTION_CONFLICT' };
      return 'saved';
    }, 1);
    const catalogRetryCalls = txCalls.map((call) => call.api);
    requireCheck(
      catalogRetryResult === 'saved' &&
        catalogConflictAttempts === 2 &&
        JSON.stringify(catalogRetryCalls) ===
          JSON.stringify([
            'database.startTransaction',
            'database.modifyDocument',
            'database.startTransaction',
            'database.modifyDocument',
            'database.commitTransaction',
          ]),
      '@cloudbase/database retries the complete catalog callback and commits only the winning attempt',
    );
    const inserted = await probeDb.runTransaction((transaction) =>
      transaction
        .collection('catalogDetailApprovals')
        .doc('approval-new')
        .set({ state: 'staging' }),
    );
    requireCheck(
      inserted.updated === 0 &&
        Array.isArray(inserted.upserted) &&
        inserted.upserted.length === 1 &&
        inserted.upserted[0]?._id === 'approval-new',
      '@cloudbase/database acknowledges a new staged approval with upserted identity, not updated=1',
    );
  } finally {
    databaseModule.Db.reqClass = originalReqClass;
  }
}
// Nested-object update semantics (blessing-gate P1). CloudBase's `update`
// FLATTENS a nested plain object into dot-paths, so a patch MERGES into the
// previous value instead of replacing it — and cannot land at all over a field
// currently holding null. The local JSON adapter shallow-spreads, so this
// diverges ONLY in production. Prove both the raw driver behaviour and that
// the adapter wraps object values in the `set` command.
{
  const flattenCalls = [];
  class FakeFlattenProbeRequest {
    async send(api, params) {
      flattenCalls.push({ api, params });
      if (api === 'database.startTransaction') return { transactionId: 'flatten-probe-tx' };
      if (api === 'database.getDocument') {
        return { requestId: 'r', data: { list: [JSON.stringify({ _id: 'p-1', pricing: null })] } };
      }
      if (api === 'database.modifyDocument') return { requestId: 'r', data: { updated: 1 } };
      return { requestId: 'r' };
    }
  }
  const originalReqClass = databaseModule.Db.reqClass;
  try {
    databaseModule.Db.reqClass = FakeFlattenProbeRequest;
    const probeDb = new databaseModule.Db({});

    // (a) RAW: a bare nested object flattens to a dot-path key.
    await probeDb.runTransaction(async (transaction) => {
      await transaction
        .collection('products')
        .doc('p-1')
        .update({ pricing: { mode: 'fixed', amountMinor: 250 } });
    });
    const rawUpdate = flattenCalls.find(
      (call) => call.api === 'database.modifyDocument' && call.params?.merge === true,
    );
    // `params.data` is a JSON STRING wrapping the operators: {"$set": {...}}.
    const rawSet = JSON.parse(rawUpdate?.params?.data ?? '{}').$set ?? {};
    requireCheck(
      Object.hasOwn(rawSet, 'pricing.mode') && !Object.hasOwn(rawSet, 'pricing'),
      '@cloudbase/database update FLATTENS a nested object to dot-paths (merge, not replace)',
    );

    // (b) WRAPPED: the `set` command the adapter applies keeps the field whole.
    flattenCalls.length = 0;
    await probeDb.runTransaction(async (transaction) => {
      await transaction
        .collection('products')
        .doc('p-1')
        .update({ pricing: probeDb.command.set({ mode: 'fixed', amountMinor: 250 }) });
    });
    const wrappedUpdate = flattenCalls.find(
      (call) => call.api === 'database.modifyDocument' && call.params?.merge === true,
    );
    const wrappedSet = JSON.parse(wrappedUpdate?.params?.data ?? '{}').$set ?? {};
    requireCheck(
      Object.hasOwn(wrappedSet, 'pricing') &&
        !Object.keys(wrappedSet).some((key) => key.startsWith('pricing.')) &&
        wrappedSet.pricing?.mode === 'fixed',
      '@cloudbase/database command.set REPLACES a nested field wholesale (no dot-paths)',
    );
  } finally {
    databaseModule.Db.reqClass = originalReqClass;
  }
}

// The adapter must route EVERY object-valued patch field through command.set —
// otherwise a mode transition leaves the previous mode's keys behind.
{
  const adapterSource = readFileSync(
    new URL('../packages/db/src/cloudbase-adapter.ts', import.meta.url),
    'utf8',
  );
  const writeSites = [
    /\.update\(\{ data: replaceNestedObjects\(patch, db\.command\) \}\)/,
    /await ref\.update\(replaceNestedObjects\(merged, db\.command\)\)/,
    /await targetRef\.update\(\s*replaceNestedObjects\(/,
  ];
  requireCheck(
    writeSites.every((pattern) => pattern.test(adapterSource)),
    'cloudbase-adapter routes all three update paths through replaceNestedObjects',
  );
  requireCheck(
    /proto === Object\.prototype \|\| proto === null/.test(adapterSource),
    'replaceNestedObjects wraps PLAIN objects only, so update commands pass through intact',
  );
}

requireCheck(
  containsAll(nodeTypes, [
    'IGetUploadMetadataResult',
    'url: string',
    'token: string',
    'authorization: string',
    'fileId: string',
    'cosFileId: string',
    'getUploadMetadata',
  ]),
  '@cloudbase/node-sdk types define getUploadMetadata data.url/token/authorization/fileId/cosFileId',
);

const nodeStorage = readPackageFile(nodeSdk, 'dist/storage/index.js');
requireCheck(
  containsAll(nodeStorage, [
    'getUploadMetadata',
    'storage.getUploadMetadata',
    'Signature',
    'x-cos-security-token',
    'x-cos-meta-fileid',
    'fileId',
    'cosFileId',
  ]),
  '@cloudbase/node-sdk storage implementation mints upload metadata with the expected fields',
);

/*
 * THE UPLOAD VERB IS THE WHOLE CONTRACT — and it must be read from the
 * uploadFile BODY, never from a whole-file grep. The previous probe scanned the
 * entire module for /method: 'post'/ and matched the CONTROL-PLANE metadata
 * request (which is legitimately a POST), so it reported "multipart POST upload"
 * while the installed SDK actually PUT the bytes. The browser kept POSTing a
 * multipart form against a PUT-scoped signature and COS rejected every upload
 * with 403 SignatureDoesNotMatch — with CI green. Anchor on the function body.
 */
/**
 * Extract ONE function body by name. THROWS when the function is absent rather
 * than returning '': an empty string makes every `/regex/.test(body)` below
 * return false, which a reviewer reads as "assertion failed for a real reason"
 * — but an upstream RENAME would then look identical to a genuine protocol
 * change, and (worse) any `!/.../.test(body)` negative assertion would pass
 * vacuously forever. Fail loudly at the extraction, not silently at the match.
 */
function sdkFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    throw new Error(
      `SDK contract: function ${name}() not found in the installed package — it was renamed, removed, or the module layout changed. Re-derive the wire contract from the installed source before touching this assertion.`,
    );
  }
  const end = source.indexOf(`exports.${name} =`, start);
  return end > start ? source.slice(start, end) : source.slice(start);
}
const nodeFunctionBody = sdkFunctionBody(
  readPackageFile(nodeSdk, 'dist/functions/index.js'),
  'callFunction',
);
requireCheck(
  typeof storageApp.callFunction === 'function' &&
    containsAll(nodeTypes, [
      'ICallFunctionOptions',
      'ICustomReqOpts',
      'CallFunctionResult',
      'retryOptions?: IRetryOptions',
    ]),
  'installed node-sdk exposes the typed function invocation and per-request retry options',
);
requireCheck(
  containsAll(nodeFunctionBody, [
    "action: 'functions.invokeFunction'",
    'function_name: name',
    'request_data: transformData',
    'JSON.stringify(data)',
    "method: 'post'",
    'opts,',
    'JSON.parse(res.data.response_data)',
    'requestId: res.requestId',
    'if (res.code)',
  ]),
  'installed callFunction body serializes data and returns result or provider error in its actual envelope',
);
const preparationInvocationConsumers = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter(
    (file) =>
      /\.(?:ts|tsx|astro|js|mjs)$/.test(file) &&
      !/\.test\.[cm]?[jt]sx?$/.test(file) &&
      existsSync(join(root, file)) &&
      /\bcallFunction\b/.test(readFileSync(join(root, file), 'utf8')),
  )
  .sort();
requireCheck(
  isDeepStrictEqual(preparationInvocationConsumers, [
    'apps/functions/admin/src/catalog-preparation-invoker.ts',
  ]),
  'server SDK function invocation consumer population is acknowledged',
  preparationInvocationConsumers.join(', '),
);
const invocationLoader = join(
  dirname(localServerRequire.resolve('tsx/package.json')),
  'dist/loader.mjs',
);
const invocationProbe = execFileSync(
  process.execPath,
  [
    '--import',
    invocationLoader,
    '--test',
    '--test-reporter=tap',
    'apps/functions/admin/src/catalog-preparation-invoker.test.ts',
  ],
  { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
);
const invocationCounts =
  /# tests (\d+)[\s\S]*# pass (\d+)[\s\S]*# fail (\d+)[\s\S]*# cancelled (\d+)[\s\S]*# skipped (\d+)/.exec(
    invocationProbe,
  );
requireCheck(
  invocationCounts !== null &&
    Number(invocationCounts[1]) >= 15 &&
    invocationCounts[1] === invocationCounts[2] &&
    invocationCounts.slice(3).every((value) => value === '0') &&
    [
      'installed SDK invocation encodes only the signed server call with fixed target deadline and no retries',
      'installed SDK may return a provider error object instead of throwing',
      'installed SDK keeps non-JSON response_data as a string instead of granting a worker result',
      'installed SDK uses zero retries even when its configured default permits retries',
      'installed SDK startup remains inside the total deadline before any response exists',
      'an already-streaming installed SDK request cannot extend the total preparation wait',
      'preparation deadline handles a late rejection without repeating the invocation',
    ].every((name) => invocationProbe.includes(name)),
  'actual installed function SDK encoding, error envelope, zero retry and streaming total deadline probes pass without skips',
);

const uploadFileBody = sdkFunctionBody(nodeStorage, 'uploadFile');
requireCheck(
  uploadFileBody.length > 0 && /method:\s*['"]put['"]/.test(uploadFileBody),
  '@cloudbase/node-sdk uploadFile sends the BYTES with PUT (not multipart POST)',
);
requireCheck(
  !/formData/.test(uploadFileBody) &&
    containsAll(uploadFileBody, ['Signature', 'x-cos-security-token', 'x-cos-meta-fileid']),
  '@cloudbase/node-sdk uploadFile carries the credential in HEADERS, with no multipart form',
);
requireCheck(
  uploadFileBody.includes(
    'if (!(fileContent instanceof fs_1.default.ReadStream) && !(fileContent instanceof Buffer))',
  ),
  '@cloudbase/node-sdk uploadFile accepts only fs.ReadStream or Buffer at runtime',
);
const trackedSender = readFileSync(
  join(root, 'packages/media-storage/src/cloudbase-put.ts'),
  'utf8',
);
const trackedSenderStart = trackedSender.indexOf('export async function putCloudBaseBytes(');
if (trackedSenderStart < 0) throw new Error('Tracked sender function is missing');
const trackedSenderBody = trackedSender.slice(trackedSenderStart);
requireCheck(
  /request\(url,\s*\{ method: 'PUT', headers: credential\.headers \}/.test(trackedSenderBody) &&
    /pipeline\(source, destination\)/.test(trackedSenderBody) &&
    !/FormData|formFields|method: 'POST'/.test(trackedSenderBody),
  'tracked server uploader sends the SDK-minted PUT headers and raw bytes',
);
requireCheck(
  /if \(response\.statusCode !== 200\) \{/.test(trackedSenderBody) &&
    /response\.on\('data', \(\) => \{\s*reject\(new Error\('media-storage\(cloudbase\): unexpected upload response body'\)\);\s*response\.destroy\(\);\s*\}\)/.test(
      trackedSenderBody,
    ) &&
    /setTimeout\(\s*\(\) => destination\.destroy\(new Error\('media-storage\(cloudbase\): upload timed out'\)\),\s*timeoutMs/.test(
      trackedSenderBody,
    ),
  'tracked server uploader requires bounded empty HTTP 200 acknowledgement',
);

const uploadMetadataBody = sdkFunctionBody(nodeStorage, 'getUploadMetadata');
requireCheck(
  /method:\s*['"]put['"]/.test(uploadMetadataBody),
  '@cloudbase/node-sdk requests the upload signature scoped to PUT',
);

// The application's own credential + browser client must match that verb.
const mediaIndex = readFileSync(join(root, 'packages/media-storage/src/index.ts'), 'utf8');
requireCheck(
  /method:\s*'PUT'/.test(mediaIndex) && !/formFields/.test(mediaIndex),
  'media-storage UploadCredential is a PUT+headers contract, not multipart form fields',
);
// EVERY browser upload client, not just one. The first pass pinned only the
// admin client and the OEM client in ProjectForm.astro kept POSTing a form
// against a PUT-scoped signature — caught by the deployed OEM smoke, not here.
for (const clientPath of [
  'apps/site/src/islands/admin/api.ts',
  'apps/site/src/components/ProjectForm.astro',
]) {
  const client = readFileSync(join(root, clientPath), 'utf8');
  requireCheck(
    /headers:\s*intent\.upload\.headers/.test(client) &&
      !/intent\.upload\.fields/.test(client) &&
      !/new FormData\(\)[\s\S]{0,400}intent\.upload/.test(client),
    `${clientPath} sends credential headers with a raw body (no multipart form)`,
  );
}

const uploadConsumers = execFileSync(
  'git',
  ['ls-files', '-z', '-co', '--exclude-standard', '--', 'apps', 'packages'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(
    (file) =>
      /\.(?:ts|tsx|astro)$/.test(file) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      existsSync(join(root, file)),
  )
  .filter((file) =>
    /\b(?:fetch|request)\([^;\n]{0,200}\{[\s\S]{0,200}\bheaders:\s*(?:credential\.headers|intent\.upload\.headers)/.test(
      readFileSync(join(root, file), 'utf8'),
    ),
  );
requireCheck(
  uploadConsumers.length === 3,
  'SDK credential sender population is exactly three clients; new senders require contract verification',
  uploadConsumers.join(', '),
);

const nodeCloudbase = readPackageFile(nodeSdk, 'dist/cloudbase.js');
requireCheck(
  nodeCloudbase.includes('getUploadMetadata({ cloudPath }'),
  '@cloudbase/node-sdk CloudBase class forwards getUploadMetadata',
);

// wx-server-sdk 4.x ships real types, so the repository's ambient shim must
// stay deleted — a `declare module 'wx-server-sdk'` beside package types is a
// conflicting augmentation.
requireCheck(
  !existsSync(join(root, 'packages/db/src/wx-server-sdk.d.ts')),
  'legacy local wx-server-sdk.d.ts shim stays deleted (wx 4.x ships its own types)',
);
requireCheck(
  readPackageFile(wxSdk, 'index.d.ts').includes('export function database'),
  'wx-server-sdk ships usable official types',
);

// The adapter's missing-document contract: wx doc().get() defaults
// throwOnNotFound=true and would REJECT for a missing row; the adapter must
// keep configuring it off, and the installed bundle must keep honoring it.
const wxBundle = readPackageFile(wxSdk, 'index.js');
requireCheck(
  wxBundle.includes('let throwOnNotFound = true') &&
    wxBundle.includes("hasOwnProperty('throwOnNotFound')"),
  'wx-server-sdk bundle defaults throwOnNotFound=true and honors the database config override',
);

const cloudbaseAdapter = readFileSync(join(root, 'packages/db/src/cloudbase-adapter.ts'), 'utf8');
requireCheck(
  containsAll(cloudbaseAdapter, [
    "import * as cloudbase from '@cloudbase/node-sdk'",
    'storageApp = cloudbase.init',
    'cloudStorageSdk',
  ]),
  'db cloudbase adapter explicitly initialises @cloudbase/node-sdk for storage injection',
);
requireCheck(
  containsAll(cloudbaseAdapter, [
    "case 'isLiteralTrue'",
    "case 'matchesProductFamily'",
    "case 'isFalseOrMissing'",
    '_.or([',
    '_.and([',
    '_.exists(false)',
    '_.eq(false)',
    "_.eq('headphones')",
    'LEGACY_HEADPHONES_CATEGORY_OPTIONS',
  ]),
  'db cloudbase strict publication/archive and legacy Headphones filters are composed server-side',
);
const typescript = rootRequire('typescript');
const adapterAst = typescript.createSourceFile(
  'cloudbase-adapter.ts',
  cloudbaseAdapter,
  typescript.ScriptTarget.Latest,
  true,
  typescript.ScriptKind.TS,
);
function objectMethodCalls(variableName, methodName) {
  const calls = [];
  function visit(node) {
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      typescript.isObjectLiteralExpression(node.initializer)
    ) {
      const method = node.initializer.properties.find(
        (property) =>
          typescript.isMethodDeclaration(property) &&
          property.name.getText(adapterAst) === methodName,
      );
      if (method) {
        function collect(child) {
          if (typescript.isCallExpression(child)) calls.push(child.expression.getText(adapterAst));
          typescript.forEachChild(child, collect);
        }
        collect(method);
      }
    }
    typescript.forEachChild(node, visit);
  }
  visit(adapterAst);
  return calls;
}
// Bind the production adapter to the exact tested helper, then inspect only
// that helper's transaction callback. Other methods cannot satisfy this gate.
for (const [method, helper, transition] of [
  ['acquireImageMutation', 'acquireImageMutationInCloudBase', 'transitionImageMutationAcquire'],
  ['releaseImageMutation', 'releaseImageMutationInCloudBase', 'transitionImageMutationRelease'],
]) {
  requireCheck(
    objectMethodCalls('cloudBaseAdapter', method).includes(helper) &&
      objectMethodCalls('cloudBaseAdapter', method).includes('cloudStorageSdk().database'),
    `db cloudbase ${method} delegates to its tested native SDK helper`,
  );
  const calls = transactionFunctionCalls(helper);
  requireCheck(
    ['transaction.collection', 'ref.get', 'ref.update', transition, 'confirmDocumentWrite'].every(
      (call) => calls.includes(call),
    ),
    `db cloudbase ${method} checks ownership and confirms its write inside runTransaction`,
  );
}
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'manageImageDeletion').includes(
    'manageImageDeletionInCloudBase',
  ) &&
    ['catalogRowStore', 'runImageDeletion'].every((call) =>
      transactionFunctionCalls('manageImageDeletionInCloudBase').includes(call),
    ),
  'image deletion production bridge executes the shared state machine in one native SDK transaction',
);
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'manageImageUpload').includes(
    'manageImageUploadInCloudBase',
  ) &&
    objectMethodCalls('cloudBaseAdapter', 'manageImageUpload').includes(
      'cloudStorageSdk().database',
    ),
  'upload finalization production adapter delegates to its tested node-sdk transaction helper',
);
requireCheck(
  ['catalogRowStore', 'runImageUpload'].every((call) =>
    transactionFunctionCalls('manageImageUploadInCloudBase').includes(call),
  ),
  'upload finalization executes inside one native SDK transaction callback',
);
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'manageSourceMediaImport').includes(
    'manageSourceMediaImportInCloudBase',
  ) &&
    objectMethodCalls('cloudBaseAdapter', 'manageSourceMediaImport').includes(
      'cloudStorageSdk().database',
    ),
  'source media production adapter delegates to its tested node-sdk transaction helper',
);
requireCheck(
  ['catalogRowStore', 'runSourceMediaImport'].every((call) =>
    transactionFunctionCalls('manageSourceMediaImportInCloudBase').includes(call),
  ),
  'source media state transitions execute inside one native SDK transaction callback',
);
// The FENCED conditional write (R1 E2) is the branch's one architecture
// amendment, and its PRODUCTION implementations had zero coverage — every
// lease assertion runs against a test-only adapter that re-implements the
// guard (blessing-gate P2). Assert the real methods here: each must re-verify
// the lease INSIDE the same transaction as its write, or a stale holder can
// promote after a fence takeover.
for (const method of [
  'acquireAlibabaSyncLease',
  'renewAlibabaSyncLease',
  'releaseAlibabaSyncLease',
  'createDocWithId',
  'upsertDocWithId',
]) {
  const calls = objectMethodCalls('cloudBaseAdapter', method);
  requireCheck(
    calls.includes('db.runTransaction') && calls.includes('transaction.collection'),
    `db cloudbase ${method} performs its read-and-write inside runTransaction`,
  );
}
const saveFunction = adapterAst.statements.find(
  (node) =>
    typescript.isFunctionDeclaration(node) && node.name?.text === 'saveCatalogProductInCloudBase',
);
const productTransactionCalls = [];
function inspectProductTransaction(node) {
  if (
    typescript.isCallExpression(node) &&
    node.expression.getText(adapterAst) === 'db.runTransaction'
  ) {
    const callback = node.arguments[0];
    if (
      callback &&
      (typescript.isArrowFunction(callback) || typescript.isFunctionExpression(callback))
    ) {
      const collect = (child) => {
        if (typescript.isCallExpression(child))
          productTransactionCalls.push(child.expression.getText(adapterAst));
        typescript.forEachChild(child, collect);
      };
      collect(callback.body);
    }
  }
  typescript.forEachChild(node, inspectProductTransaction);
}
if (saveFunction?.body) inspectProductTransaction(saveFunction.body);
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'saveCatalogProductWithIdentities').includes(
    'saveCatalogProductInCloudBase',
  ) &&
    [
      'transaction.collection',
      'planCatalogProductSave',
      'planProductSubcategorySave',
      'planCatalogSuggestionSave',
      'replaceNestedObjects',
      'productRef.update',
    ].every((name) => productTransactionCalls.includes(name)),
  'db cloudbase catalog save plans and writes product identities inside one transaction callback',
);
function transactionFunctionCalls(name) {
  const declaration = adapterAst.statements.find(
    (node) => typescript.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration?.body) throw new Error(`Missing production transaction helper: ${name}`);
  const calls = [];
  const inspect = (node) => {
    if (
      typescript.isCallExpression(node) &&
      node.expression.getText(adapterAst) === 'db.runTransaction'
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        (typescript.isArrowFunction(callback) || typescript.isFunctionExpression(callback))
      ) {
        const collect = (child) => {
          if (typescript.isCallExpression(child)) calls.push(child.expression.getText(adapterAst));
          typescript.forEachChild(child, collect);
        };
        collect(callback.body);
      }
    }
    typescript.forEachChild(node, inspect);
  };
  inspect(declaration.body);
  return calls;
}

function catalogBranchCalls(methodName) {
  let method;
  const find = (node) => {
    if (
      typescript.isVariableDeclaration(node) &&
      node.name.getText(adapterAst) === 'cloudBaseAdapter' &&
      node.initializer &&
      typescript.isObjectLiteralExpression(node.initializer)
    )
      method = node.initializer.properties.find(
        (item) =>
          typescript.isMethodDeclaration(item) && item.name.getText(adapterAst) === methodName,
      );
    typescript.forEachChild(node, find);
  };
  find(adapterAst);
  if (!method?.body) throw new Error(`Missing production adapter method: ${methodName}`);
  const guard = method.body.statements.find(
    (node) =>
      typescript.isIfStatement(node) &&
      typescript.isCallExpression(node.expression) &&
      node.expression.expression.getText(adapterAst) === 'isCatalogRowCollection',
  );
  if (!guard) throw new Error(`Missing catalog branch: ${methodName}`);
  const calls = [];
  const collect = (node) => {
    if (typescript.isCallExpression(node)) calls.push(node.expression.getText(adapterAst));
    typescript.forEachChild(node, collect);
  };
  collect(guard.thenStatement);
  return calls;
}
for (const method of [
  'create',
  'update',
  'remove',
  'incrementField',
  'createDocWithId',
  'upsertDocWithId',
  'removeDocIfFieldEquals',
]) {
  requireCheck(
    catalogBranchCalls(method).includes('mutateCatalogRowInCloudBase'),
    `catalog ${method} uses the tested child/parent transaction inside its collection branch`,
  );
}
requireCheck(
  ['catalogRowStore', 'runCatalogRowMutation'].every((call) =>
    transactionFunctionCalls('mutateCatalogRowInCloudBase').includes(call),
  ),
  'catalog input mutation plans and writes inside one runTransaction callback',
);
for (const helper of [
  'updateDocWithAlibabaLeaseInCloudBase',
  'upsertDocWithAlibabaLeaseInCloudBase',
]) {
  requireCheck(
    ['holdsAlibabaLease', 'catalogRowStore', 'runCatalogRowMutation'].every((call) =>
      transactionFunctionCalls(helper).includes(call),
    ),
    `${helper} reuses its existing fenced transaction for catalog inputs`,
  );
}
const rowBridge = adapterAst.statements.find(
  (node) => typescript.isFunctionDeclaration(node) && node.name?.text === 'catalogRowStore',
);
if (!rowBridge?.body) throw new Error('Missing catalogRowStore SDK bridge');
const rowBridgeCalls = [];
const collectBridge = (node) => {
  if (typescript.isCallExpression(node)) rowBridgeCalls.push(node.expression.getText(adapterAst));
  typescript.forEachChild(node, collectBridge);
};
collectBridge(rowBridge.body);
requireCheck(
  [
    'transaction.collection(collection).doc(id).get',
    'transaction.collection(collection).doc(_id).set',
    'transaction.collection(collection).doc(id).remove',
    'confirmDocumentWrite',
    'sdkAnswer',
  ].every((call) => rowBridgeCalls.includes(call)),
  'catalog row bridge uses the verified SDK get/set/remove and confirms writes/deletions',
);

for (const [method, helper, required] of [
  [
    'updateDocWithAlibabaLease',
    'updateDocWithAlibabaLeaseInCloudBase',
    [
      'transaction.collection',
      'holdsAlibabaLease',
      'target.get',
      'target.update',
      'replaceNestedObjects',
      'sourceInvalidation',
      'writeInvalidatedProduct',
    ],
  ],
  [
    'upsertDocWithAlibabaLease',
    'upsertDocWithAlibabaLeaseInCloudBase',
    [
      'transaction.collection',
      'leaseRef.get',
      'holdsAlibabaLease',
      'targetRef.get',
      'replaceNestedObjects',
      'targetRef.set',
      'sourceInvalidation',
      'writeInvalidatedProduct',
    ],
  ],
  [
    'upsertCatalogSourceObservation',
    'upsertCatalogSourceObservationInCloudBase',
    [
      'transaction.collection',
      'ref.get',
      'Date.parse',
      'replaceNestedObjects',
      'ref.set',
      'sourceInvalidation',
      'writeInvalidatedProduct',
      'confirmDocumentWrite',
    ],
  ],
]) {
  const calls = transactionFunctionCalls(helper);
  requireCheck(
    objectMethodCalls('cloudBaseAdapter', method).includes(helper) &&
      required.every((name) => calls.includes(name)),
    `db cloudbase ${method} delegates to its tested source/product transaction, with reads, guards and writes inside it`,
  );
}
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'claimAlibabaSyncRun').includes(
    'claimAlibabaSyncRunInCloudBase',
  ),
  'db cloudbase run claim delegates to the takeover-tested production helper',
);
const runClaimStart = cloudbaseAdapter.indexOf(
  'export async function claimAlibabaSyncRunInCloudBase',
);
const runClaimEnd = cloudbaseAdapter.indexOf(
  'export async function upsertCatalogSourceObservationInCloudBase',
  runClaimStart,
);
const runClaim =
  runClaimStart >= 0 && runClaimEnd > runClaimStart
    ? cloudbaseAdapter.slice(runClaimStart, runClaimEnd)
    : '';
requireCheck(
  containsAll(runClaim, [
    'db.runTransaction',
    'leaseRef.get',
    'checkpointRef.get',
    'runRef.get',
    'holdsAlibabaLease',
    "return 'checkpoint-busy'",
    'runRef.set',
    'checkpointRef.update',
  ]),
  'production atomic run claim reads lease checkpoint and run before writing both together',
);

requireCheck(
  cloudbaseAdapter.includes('throwOnNotFound: false'),
  'db cloudbase adapter configures throwOnNotFound=false so missing doc reads resolve null',
);
const getMethodStart = cloudbaseAdapter.indexOf('  async get(collection, id)');
const getMethodEnd = cloudbaseAdapter.indexOf('  async findByField', getMethodStart);
const getMethod =
  getMethodStart >= 0 && getMethodEnd > getMethodStart
    ? cloudbaseAdapter.slice(getMethodStart, getMethodEnd)
    : '';
requireCheck(
  !/\bcatch\s*(?:\(|\{)/.test(getMethod) && getMethod.includes('normalizeSingle(res.data)'),
  'db cloudbase get distinguishes missing data from request failures',
);

const mediaCloudbase = readFileSync(join(root, 'packages/media-storage/src/cloudbase.ts'), 'utf8');
requireCheck(
  containsAll(mediaCloudbase, [
    'getUploadMetadata',
    "requireStringField(fields, 'url'",
    "requireStringField(fields, 'authorization'",
    "requireStringField(fields, 'token'",
    "requireStringField(fields, 'cosFileId'",
    "requireStringField(fields, 'fileId'",
    "method: 'PUT'",
    'headers',
    'Signature',
    'x-cos-security-token',
    'x-cos-meta-fileid',
    // The SDK duplicates the signature lowercase and URI-encodes the key.
    'encodeURIComponent(cloudPath)',
  ]) && !mediaCloudbase.includes('formFields'),
  'media-storage maps node-sdk upload metadata to PUT header credentials',
);
const trackedUploadStart = mediaCloudbase.indexOf('async putObject(');
const trackedUploadEnd = mediaCloudbase.indexOf('async getObjectAsBase64(', trackedUploadStart);
if (trackedUploadStart < 0 || trackedUploadEnd < 0)
  throw new Error('Tracked adapter upload method is missing');
const trackedUploadBody = mediaCloudbase.slice(trackedUploadStart, trackedUploadEnd);
requireCheck(
  /await options\.beforeWrite\?\.\(\{ \.\.\.target \}\)/.test(trackedUploadBody) &&
    trackedUploadBody.indexOf('await options.beforeWrite?.({ ...target })') <
      trackedUploadBody.indexOf('await putCloudBaseBytes(') &&
    /Buffer\.from\(input\.content\)/.test(trackedUploadBody),
  'tracked upload checkpoints the permanent target before bytes and adapts Uint8Array to Buffer',
);

requireCheck(
  !mediaCloudbase.includes('cloudObjectMeta') && !mediaCloudbase.includes('cloudObjectId'),
  'media-storage does not use stale top-level cloudObjectMeta/cloudObjectId fields',
);

// The bounded reader sends the URL itself, so pin the SDK's corresponding wire path.
const sdkDownloadBody = sdkFunctionBody(nodeStorage, 'downloadFile');
const sdkTempUrlBody = sdkFunctionBody(nodeStorage, 'getTempFileURL');
requireCheck(
  containsAll(sdkDownloadBody, [
    "urlType === 'COS_URL' ? res.tempFileURL : encodeURI(res.tempFileURL)",
    "method: 'get'",
    "res.code !== 'SUCCESS'",
    'res.statusCode === 200',
  ]) &&
    sdkTempUrlBody.includes('url_type: file.urlType') &&
    nodeTypes.includes("urlType?: 'COS_URL'"),
  'installed storage COS_URL download is raw GET requiring SUCCESS and complete HTTP 200',
);
const boundedGetPath = 'packages/media-storage/src/cloudbase-get.ts';
const boundedGetAst = typescript.createSourceFile(
  boundedGetPath,
  readFileSync(join(root, boundedGetPath), 'utf8'),
  typescript.ScriptTarget.Latest,
);
function callNodes(node) {
  const calls = [];
  const visit = (entry) => {
    if (typescript.isCallExpression(entry)) calls.push(entry);
    typescript.forEachChild(entry, visit);
  };
  visit(node);
  return calls;
}
function assignedProperty(node, name) {
  if (!node || !typescript.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find(
    (item) =>
      typescript.isPropertyAssignment(item) &&
      (typescript.isIdentifier(item.name) || typescript.isStringLiteral(item.name)) &&
      item.name.text === name,
  )?.initializer;
}
function requestsCosUrl(node) {
  const list = assignedProperty(node.arguments[0], 'fileList');
  const first = list && typescript.isArrayLiteralExpression(list) ? list.elements[0] : undefined;
  const type = assignedProperty(first, 'urlType');
  return type && typescript.isStringLiteral(type) && type.text === 'COS_URL';
}
const boundedGetFunction = boundedGetAst.statements.find(
  (node) => typescript.isFunctionDeclaration(node) && node.name?.text === 'readCloudBaseBytes',
);
if (!boundedGetFunction?.body) throw new Error('Missing bounded COS GET function');
const boundedGetCalls = callNodes(boundedGetFunction.body);
const boundedMint = boundedGetCalls.find(
  (node) => node.expression.getText(boundedGetAst) === 'sdk.getTempFileURL',
);
const boundedSend = boundedGetCalls.find(
  (node) => node.expression.getText(boundedGetAst) === 'request',
);
const boundedMethod = assignedProperty(boundedSend?.arguments[1], 'method');
const mediaCloudAst = typescript.createSourceFile(
  'cloudbase.ts',
  mediaCloudbase,
  typescript.ScriptTarget.Latest,
);
let boundedAdapterBranch;
const inspectReadAdapter = (node) => {
  if (
    typescript.isMethodDeclaration(node) &&
    node.name.getText(mediaCloudAst) === 'getObjectAsBase64'
  ) {
    boundedAdapterBranch = node.body?.statements.find(
      (statement) =>
        typescript.isIfStatement(statement) &&
        statement.expression.getText(mediaCloudAst) === 'options',
    );
  }
  typescript.forEachChild(node, inspectReadAdapter);
};
inspectReadAdapter(mediaCloudAst);
requireCheck(
  boundedMint &&
    requestsCosUrl(boundedMint) &&
    boundedMethod &&
    typescript.isStringLiteral(boundedMethod) &&
    boundedMethod.text === 'GET' &&
    !assignedProperty(boundedSend.arguments[1], 'headers') &&
    boundedGetCalls.some((node) => node.expression.getText(boundedGetAst) === 'readMediaBytes') &&
    boundedAdapterBranch &&
    callNodes(boundedAdapterBranch.thenStatement).some(
      (node) =>
        node.expression.getText(mediaCloudAst) === 'readCloudBaseBytes' &&
        node.arguments.map((argument) => argument.getText(mediaCloudAst)).join(',') ===
          'sdk,fileId,options,transport',
    ),
  'production bounded adapter delegates options to the exact SDK-minted COS_URL raw GET reader',
);
const cosUrlConsumers = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '-co',
    '--exclude-standard',
    '--',
    'apps/functions',
    'apps/local-server',
    'packages',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.includes('/testing/') &&
      existsSync(join(root, file)),
  )
  .filter((file) => {
    const ast = typescript.createSourceFile(
      file,
      readFileSync(join(root, file), 'utf8'),
      typescript.ScriptTarget.Latest,
    );
    return callNodes(ast).some(
      (node) =>
        typescript.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'getTempFileURL' &&
        requestsCosUrl(node),
    );
  });
requireCheck(
  cosUrlConsumers.length === 1 && cosUrlConsumers[0] === boundedGetPath,
  'SDK COS_URL direct-download sender population is exactly the reviewed bounded reader',
  cosUrlConsumers.join(', '),
);

const localLeaseFile = join(root, `.cloudbase-sdk-contract-${process.pid}.json`);
const { rmSync } = await import('node:fs');
try {
  const tsxPackagePath = localServerRequire.resolve('tsx/package.json');
  const tsxPackage = localServerRequire(tsxPackagePath);
  const tsxBin = typeof tsxPackage.bin === 'string' ? tsxPackage.bin : tsxPackage.bin?.tsx;
  if (typeof tsxBin !== 'string') throw new Error('tsx package does not expose a CLI binary');
  const tsxCli = join(dirname(tsxPackagePath), tsxBin);
  const nestedProbe = `
    import { JsonFileAdapter } from './apps/local-server/src/json-adapter.ts';
    new JsonFileAdapter(${JSON.stringify(localLeaseFile)});
  `;
  const probe = `
    import { spawnSync } from 'node:child_process';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { JsonFileAdapter } from './apps/local-server/src/json-adapter.ts';
    void (async () => {
      const first = new JsonFileAdapter(${JSON.stringify(localLeaseFile)});
      const image = await first.create('images', { name: 'lease.jpg', mimeType: 'image/jpeg' });
      const imageId = String(image._id);
      const startedAt = '2026-01-02T00:00:00.000Z';
      // Construct "second" BEFORE first acquires so its in-memory snapshot
      // genuinely predates the lock, and write through it before it performs
      // any operation that would refresh that snapshot: a stale-cache writer
      // must reload before persisting rather than clobber the on-disk lock.
      const second = new JsonFileAdapter(${JSON.stringify(localLeaseFile)});
      const secondProcess = spawnSync(
        ${JSON.stringify(process.execPath)},
        [${JSON.stringify(tsxCli)}, '--eval', ${JSON.stringify(nestedProbe)}],
        { cwd: ${JSON.stringify(root)}, encoding: 'utf8' },
      );
      const secondProcessRejected =
        secondProcess.status !== 0 && secondProcess.stderr.includes('already owned by process');
      const firstAcquire = await first.acquireImageMutation(imageId, 'owner-1', startedAt);
      await second.create('products', { name: 'stale writer', category: 'wired' });
      const ownerAfterStaleWrite = (await first.get('images', imageId))?.imageMutationOwner ?? null;
      const concurrent = [firstAcquire, await second.acquireImageMutation(imageId, 'owner-2', startedAt)];
      const results = [
        await second.releaseImageMutation(imageId, 'owner-2'),
        await first.releaseImageMutation(imageId, 'owner-1'),
        await second.acquireImageMutation(imageId, 'owner-2', startedAt),
      ];
      await second.releaseImageMutation(imageId, 'owner-2');
      await second.update('images', imageId, {
        imageMutationOwner: 'owner-3',
        imageMutationStartedAt: 'invalid',
      });
      const corrupt = await first.acquireImageMutation(imageId, 'owner-4', startedAt);
      writeFileSync(${JSON.stringify(localLeaseFile)}, '{malformed', 'utf8');
      let corruptReadThrows = false;
      let corruptWriteThrows = false;
      try {
        await first.get('images', imageId);
      } catch {
        corruptReadThrows = true;
      }
      try {
        await second.create('products', { name: 'must not overwrite', category: 'wired' });
      } catch {
        corruptWriteThrows = true;
      }
      const corruptFilePreserved = readFileSync(${JSON.stringify(localLeaseFile)}, 'utf8') === '{malformed';
      writeFileSync(${JSON.stringify(localLeaseFile)}, '[]', 'utf8');
      let wrongShapeReadThrows = false;
      let wrongShapeWriteThrows = false;
      try {
        await first.get('images', imageId);
      } catch {
        wrongShapeReadThrows = true;
      }
      try {
        await second.create('products', { name: 'must not overwrite array', category: 'wired' });
      } catch {
        wrongShapeWriteThrows = true;
      }
      const wrongShapeFilePreserved = readFileSync(${JSON.stringify(localLeaseFile)}, 'utf8') === '[]';
      console.log(JSON.stringify({
        secondProcessRejected,
        concurrent,
        ownerAfterStaleWrite,
        results,
        corrupt,
        corruptReadThrows,
        corruptWriteThrows,
        corruptFilePreserved,
        wrongShapeReadThrows,
        wrongShapeWriteThrows,
        wrongShapeFilePreserved,
      }));
    })();
  `;
  const output = execFileSync(process.execPath, [tsxCli, '--eval', probe], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const localProbe = JSON.parse(output);
  requireCheck(
    localProbe.secondProcessRejected === true &&
      JSON.stringify(localProbe.concurrent) === JSON.stringify(['acquired', 'busy']) &&
      localProbe.ownerAfterStaleWrite === 'owner-1' &&
      JSON.stringify(localProbe.results) === JSON.stringify(['not-owner', 'released', 'acquired']),
    'local DB image mutation ownership survives stale writes and is exclusive across adapter instances',
  );
  requireCheck(
    localProbe.corrupt === 'corrupt',
    'local DB image mutation ownership fails closed on corrupt state',
  );
  requireCheck(
    localProbe.corruptReadThrows === true &&
      localProbe.corruptWriteThrows === true &&
      localProbe.corruptFilePreserved === true,
    'local DB preserves malformed storage and fails reads/writes closed',
  );
  requireCheck(
    localProbe.wrongShapeReadThrows === true &&
      localProbe.wrongShapeWriteThrows === true &&
      localProbe.wrongShapeFilePreserved === true,
    'local DB rejects parseable wrong-shape storage without overwriting it',
  );
} finally {
  rmSync(localLeaseFile, { force: true });
  rmSync(`${localLeaseFile}.owner`, { force: true });
}

const failures = results.filter((result) => !result.ok);
for (const result of results) {
  const prefix = result.ok ? 'PASS' : 'FAIL';
  console.log(`${prefix} ${result.label}${result.detail ? ` - ${result.detail}` : ''}`);
}

if (failures.length > 0) {
  console.error(`\nCloudBase SDK contract verification failed (${failures.length} failure(s)).`);
  process.exit(1);
}

console.log('\nCloudBase SDK contract verification passed.');
