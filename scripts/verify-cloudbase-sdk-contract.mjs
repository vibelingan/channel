import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));

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

record(true, `resolved @cloudbase/node-sdk ${nodeSdk.meta.version}`, nodeSdk.packagePath);
record(true, `resolved wx-server-sdk ${wxSdk.meta.version}`, wxSdk.packagePath);

const cloudbase = dbRequire('@cloudbase/node-sdk');
const storageApp = cloudbase.init({ env: 'contract-check' });
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

const nodeTypes = readPackageFile(nodeSdk, nodeSdk.meta.types ?? 'types/index.d.ts');
requireCheck(
  containsAll(nodeTypes, [
    'IGetUploadMetadataItem',
    'url: string',
    'token: string',
    'authorization: string',
    'fileId: string',
    'cosFileId: string',
    'getUploadMetadata',
  ]),
  '@cloudbase/node-sdk types define getUploadMetadata data.url/token/authorization/fileId/cosFileId',
);

const nodeStorage = readPackageFile(nodeSdk, 'lib/storage/index.js');
requireCheck(
  containsAll(nodeStorage, [
    'getUploadMetadata',
    'storage.getUploadMetadata',
    'Signature',
    'x-cos-security-token',
    'x-cos-meta-fileid',
    'fileId',
    'cosFileId',
  ]) && /method:\s*['"]post['"]/.test(nodeStorage),
  '@cloudbase/node-sdk storage implementation uses upload metadata and multipart POST form fields',
);

const nodeCloudbase = readPackageFile(nodeSdk, 'lib/cloudbase.js');
requireCheck(
  nodeCloudbase.includes('getUploadMetadata({ cloudPath }'),
  '@cloudbase/node-sdk CloudBase class forwards getUploadMetadata',
);

const wxTypes = readFileSync(join(root, 'packages/db/src/wx-server-sdk.d.ts'), 'utf8');
requireCheck(
  !wxTypes.includes('getUploadMetadata'),
  'local wx-server-sdk.d.ts does not reintroduce fake getUploadMetadata',
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

const mediaCloudbase = readFileSync(join(root, 'packages/media-storage/src/cloudbase.ts'), 'utf8');
requireCheck(
  containsAll(mediaCloudbase, [
    'getUploadMetadata',
    "requireStringField(fields, 'url'",
    "requireStringField(fields, 'authorization'",
    "requireStringField(fields, 'token'",
    "requireStringField(fields, 'cosFileId'",
    "requireStringField(fields, 'fileId'",
    "method: 'POST'",
    'formFields',
    'Signature',
    'x-cos-security-token',
    'x-cos-meta-fileid',
  ]),
  'media-storage maps node-sdk upload metadata to POST form credentials',
);
requireCheck(
  !mediaCloudbase.includes('cloudObjectMeta') && !mediaCloudbase.includes('cloudObjectId'),
  'media-storage does not use stale top-level cloudObjectMeta/cloudObjectId fields',
);

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
