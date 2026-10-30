import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';
const policy = { envId: 'fixture-env', region: 'ap-shanghai', archiveBucket: 'fixture-env-bucket' };
const key = `seo-recovery/objects/${'a'.repeat(64)}.bin`;
const fileID = `cloud://${policy.envId}.${policy.archiveBucket}/${key}`;
const credential = {
  storageFileId: fileID,
  uploadUrl: `https://${policy.archiveBucket}.cos.ap-shanghai.myqcloud.com/${key}`,
  headers: { 'x-cos-meta-fileid': 'native-file-meta', authorization: 'never-log-this-signature' },
};
function fixture() {
  const calls = [];
  const files = new Map();
  let path;
  const cos = {
    uploadFile(params, done) {
      calls.push(['upload', params]);
      path = params.FilePath;
      params.onTaskReady('owned-upload');
      readFile(path).then((bytes) => {
        files.set(params.Key, bytes);
        done(null, { ETag: 'version' });
      }, done);
    },
    async headObject(params) {
      calls.push(['head', params]);
      const bytes = files.get(params.Key);
      if (!bytes)
        throw Object.assign(Error('private signed URL must not leak'), { statusCode: 404 });
      return { ETag: 'version', headers: { 'content-length': String(bytes.length) } };
    },
    downloadFile(params, done) {
      calls.push(['download', params]);
      path = params.FilePath;
      const bytes = files.get(params.Key);
      params.onProgress({ loaded: 0, total: bytes.length });
      writeFile(path, bytes).then(() => done(null, { ETag: 'version' }), done);
    },
    cancelTask(id) {
      calls.push(['cancel-upload', id]);
    },
    emit(name, params) {
      calls.push([name, params]);
    },
  };
  return {
    cos,
    calls,
    files,
    getPath: () => path,
    transport: createCosArchiveTransfer({ cos, policy }),
  };
}
test('the installed official COS SDK exposes the reviewed multipart, range and cancellation methods', () => {
  const require = createRequire(import.meta.url);
  assert.equal(require('cos-nodejs-sdk-v5/package.json').version, '2.15.4');
  const COS = require('cos-nodejs-sdk-v5');
  const cos = new COS({ SecretId: 'fixture', SecretKey: 'fixture' });
  for (const method of ['uploadFile', 'downloadFile', 'headObject', 'cancelTask', 'emit'])
    assert.equal(typeof cos[method], 'function');
});
test('native multipart upload keeps the CloudBase file metadata and writes only the exact private content target', async () => {
  const x = fixture();
  const body = Buffer.from('archive bytes');
  await x.transport.put(credential, body, { uploadTimeoutMs: 1000 });
  const p = x.calls.find((c) => c[0] === 'upload')[1];
  assert.equal(p.Bucket, policy.archiveBucket);
  assert.equal(p.Region, policy.region);
  assert.equal(p.Key, key);
  assert.equal(p.SliceSize, 1048576);
  assert.equal(p.ChunkSize, 1048576);
  assert.equal(p.AsyncLimit, 8);
  assert.deepEqual(p.Headers, { 'x-cos-meta-fileid': 'native-file-meta' });
  assert.equal(p.ACL, undefined);
  assert.deepEqual(x.files.get(key), body);
  assert.equal(existsSync(x.getPath()), false);
});
test('parallel range download verifies source length and version and removes its private local file', async () => {
  const x = fixture();
  const body = Buffer.from('restored bytes');
  x.files.set(key, body);
  assert.deepEqual(
    await x.transport.read(null, fileID, { maxBytes: body.length, timeoutMs: 1000 }),
    body,
  );
  const p = x.calls.find((c) => c[0] === 'download')[1];
  assert.equal(p.ParallelLimit, 3);
  assert.equal(p.RetryTimes, 1);
  assert.equal(p.ChunkSize, 1048576);
  assert.equal(existsSync(x.getPath()), false);
  assert.equal(x.calls.filter((c) => c[0] === 'head').length, 2);
});
test('another bucket, environment or namespace cannot reach COS', async () => {
  const x = fixture();
  for (const bad of [
    fileID.replace('fixture-env.', 'another-env.'),
    fileID.replace('fixture-env-bucket/', 'another-bucket/'),
    fileID.replace('seo-recovery/objects/', 'articles/'),
  ])
    await assert.rejects(
      x.transport.read(null, bad, { maxBytes: 10, timeoutMs: 1000 }),
      /another|escapes/,
    );
  assert.equal(x.calls.length, 0);
});
test('unexpected remote size is rejected before any file download', async () => {
  const x = fixture();
  x.files.set(key, Buffer.alloc(11));
  await assert.rejects(
    x.transport.read(null, fileID, { maxBytes: 10, timeoutMs: 1000 }),
    /unconfirmed/,
  );
  assert.equal(
    x.calls.some((c) => c[0] === 'download'),
    false,
  );
});
test('a source version change during a native download cannot be accepted', async () => {
  const x = fixture();
  x.files.set(key, Buffer.from('bytes'));
  const head = x.cos.headObject;
  let reads = 0;
  x.cos.headObject = async (p) => ({
    ...(await head(p)),
    ETag: ++reads === 1 ? 'before' : 'after',
  });
  await assert.rejects(
    x.transport.read(null, fileID, { maxBytes: 5, timeoutMs: 1000 }),
    /unconfirmed/,
  );
  assert.equal(existsSync(x.getPath()), false);
});
test('a timed-out upload is canceled once and raw SDK credential details never escape', async () => {
  const x = fixture();
  x.cos.uploadFile = (params) => {
    x.calls.push(['upload', params]);
    params.onTaskReady('owned-upload');
  };
  await assert.rejects(
    x.transport.put(credential, Buffer.from('bytes'), { uploadTimeoutMs: 5 }),
    /timed out/,
  );
  assert.equal(x.calls.filter((c) => c[0] === 'cancel-upload').length, 1);
  const y = fixture();
  y.cos.uploadFile = (_params, done) =>
    done(
      Object.assign(Error('https://private/?signature=never-log-this-signature'), {
        statusCode: 403,
      }),
    );
  try {
    await y.transport.put(credential, Buffer.from('bytes'), { uploadTimeoutMs: 1000 });
    assert.fail('must reject');
  } catch (e) {
    assert.equal(e.statusCode, 403);
    assert.equal(String(e).includes('signature'), false);
  }
});
test('a late metadata response cannot start a download after the overall deadline', async () => {
  const x = fixture();
  let release;
  x.cos.headObject = () =>
    new Promise((done) => {
      release = done;
    });
  await assert.rejects(x.transport.read(null, fileID, { maxBytes: 5, timeoutMs: 5 }), /timed out/);
  release({ ETag: 'version', headers: { 'content-length': '5' } });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(
    x.calls.some((c) => c[0] === 'download'),
    false,
  );
});

test('SDK diagnostics expose only bounded stage names and byte counts and detach after transfer', async () => {
  const x = fixture();
  const events = [];
  let listener;
  let detached = false;
  x.cos.on = (name, fn) => {
    assert.equal(name, 'before-send');
    listener = fn;
  };
  x.cos.off = (name, fn) => {
    assert.equal(name, 'before-send');
    assert.equal(fn, listener);
    detached = true;
  };
  const original = x.cos.uploadFile;
  x.cos.uploadFile = (params, done) => {
    listener({
      method: 'PUT',
      url: `${credential.uploadUrl}?partNumber=1&uploadId=do-not-print&signature=private`,
      headers: { Authorization: 'do-not-print' },
    });
    params.onTaskStart();
    params.onProgress({ loaded: 2, total: 5, secret: 'do-not-print' });
    original(params, done);
  };
  const transfer = createCosArchiveTransfer({
    cos: x.cos,
    policy,
    onStatus: (event) => {
      events.push(event);
      throw Error('An observer cannot stop the transfer');
    },
  });
  await transfer.put(credential, Buffer.from('bytes'), { uploadTimeoutMs: 1000 });
  assert.equal(detached, true);
  assert.equal(
    events.some((event) => event.stage === 'multipart-part'),
    true,
  );
  assert.equal(
    events.some((event) => event.stage === 'task-started'),
    true,
  );
  for (const event of events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      (event.loadedBytes === undefined
        ? ['stage', 'totalBytes']
        : ['loadedBytes', 'stage', 'totalBytes']
      ).sort(),
    );
    assert.equal(event.totalBytes, 5);
  }
  assert.doesNotMatch(JSON.stringify(events), /do-not-print|signature|uploadId|Authorization/);
});
