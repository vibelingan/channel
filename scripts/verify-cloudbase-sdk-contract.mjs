import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
} finally {
  databaseModule.Db.reqClass = originalRequestClass;
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
function sdkFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf(`exports.${name} =`, start);
  return end > start ? source.slice(start, end) : source.slice(start);
}
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
const acquireMutationStart = cloudbaseAdapter.indexOf('  async acquireImageMutation');
const acquireMutationEnd = cloudbaseAdapter.indexOf(
  '  async releaseImageMutation',
  acquireMutationStart,
);
const acquireMutationMethod =
  acquireMutationStart >= 0 && acquireMutationEnd > acquireMutationStart
    ? cloudbaseAdapter.slice(acquireMutationStart, acquireMutationEnd)
    : '';
requireCheck(
  acquireMutationMethod.includes('db.runTransaction') &&
    acquireMutationMethod.includes("transaction.collection('images')") &&
    acquireMutationMethod.includes('transitionImageMutationAcquire(doc, owner, startedAt)') &&
    acquireMutationMethod.includes('...transition.patch'),
  'db cloudbase adapter acquires image mutation ownership transactionally',
);
const releaseMutationStart = cloudbaseAdapter.indexOf('  async releaseImageMutation');
const releaseMutationEnd = cloudbaseAdapter.indexOf('\n};', releaseMutationStart);
const releaseMutationMethod =
  releaseMutationStart >= 0 && releaseMutationEnd > releaseMutationStart
    ? cloudbaseAdapter.slice(releaseMutationStart, releaseMutationEnd)
    : '';
requireCheck(
  releaseMutationMethod.includes('db.runTransaction') &&
    releaseMutationMethod.includes("transaction.collection('images')") &&
    releaseMutationMethod.includes('transitionImageMutationRelease(doc, owner)') &&
    releaseMutationMethod.includes('...transition.patch'),
  'db cloudbase adapter releases image mutation ownership transactionally for the exact owner',
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
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'acquireImageMutation').includes(
    'transitionImageMutationAcquire',
  ) &&
    objectMethodCalls('cloudBaseAdapter', 'releaseImageMutation').includes(
      'transitionImageMutationRelease',
    ),
  'db cloudbase acquire/release methods invoke shared ownership transitions',
);
// The transition must execute INSIDE a database transaction — a text needle
// alone would also match a non-transactional TOCTOU rewrite, so assert the
// actual call expressions in each method body.
requireCheck(
  objectMethodCalls('cloudBaseAdapter', 'acquireImageMutation').includes('db.runTransaction') &&
    objectMethodCalls('cloudBaseAdapter', 'releaseImageMutation').includes('db.runTransaction') &&
    objectMethodCalls('cloudBaseAdapter', 'acquireImageMutation').includes(
      'transaction.collection',
    ) &&
    objectMethodCalls('cloudBaseAdapter', 'releaseImageMutation').includes(
      'transaction.collection',
    ),
  'db cloudbase acquire/release run their transitions inside runTransaction',
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
requireCheck(
  !mediaCloudbase.includes('cloudObjectMeta') && !mediaCloudbase.includes('cloudObjectId'),
  'media-storage does not use stale top-level cloudObjectMeta/cloudObjectId fields',
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
