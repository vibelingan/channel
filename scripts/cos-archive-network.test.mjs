import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  ARCHIVE_COS_OPTIONS,
  PARALLEL_ARCHIVE_COS_OPTIONS,
  createCosArchiveTransfer,
} from './release/cos-archive-transfer.mjs';

// The real SDK handles task queues, HTTP bodies, multipart XML and Range writes. Only the COS server is local.
test('the actual COS client uploads a small object, reads it, then completes a multipart archive and range read', async (t) => {
  const require = createRequire(import.meta.url);
  const COS = require('cos-nodejs-sdk-v5');
  const objects = new Map();
  const parts = new Map();
  const calls = [];
  let slowRead = false;
  let activeParts = 0;
  let maximumActiveParts = 0;
  const directory = await mkdtemp(join(tmpdir(), 'archive-cos-network-'));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const partUpload = req.method === 'PUT' && url.searchParams.has('partNumber');
    if (partUpload) {
      activeParts++;
      maximumActiveParts = Math.max(maximumActiveParts, activeParts);
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method, query: [...url.searchParams.keys()], bytes: body.length });
    const xml = (value) => {
      res.setHeader('content-type', 'application/xml');
      res.end(value);
    };
    if (req.method === 'GET' && url.searchParams.has('uploads'))
      return xml(
        '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
      );
    if (req.method === 'POST' && url.searchParams.has('uploads'))
      return xml(
        '<InitiateMultipartUploadResult><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>',
      );
    if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      parts.set(Number(url.searchParams.get('partNumber')), body);
      // Hold replies briefly so the real client's parallel request limit is observable.
      await new Promise((done) => setTimeout(done, 100));
      activeParts--;
      res.setHeader('etag', `"${createHash('md5').update(body).digest('hex')}"`);
      return res.end();
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      objects.set(
        url.pathname,
        Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map((part) => part[1])),
      );
      return xml(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
      );
    }
    if (req.method === 'PUT') {
      objects.set(url.pathname, body);
      res.setHeader('etag', '"complete"');
      return res.end();
    }
    const data = objects.get(url.pathname);
    if (!data) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('etag', '"complete"');
    if (req.method === 'HEAD') {
      res.setHeader('content-length', data.length);
      return res.end();
    }
    if (req.method === 'GET') {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
        res.setHeader('content-length', end - start + 1);
        return res.end(data.subarray(start, end + 1));
      }
      res.setHeader('content-length', data.length);
      if (slowRead) {
        res.write(data.subarray(0, 1));
        await new Promise((done) => setTimeout(done, 100));
        return res.end(data.subarray(1));
      }
      return res.end(data);
    }
    res.statusCode = 500;
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const policy = {
    envId: 'fixture-env',
    archiveBucket: 'fixture-env-1234567890',
    region: 'ap-shanghai',
  };
  const cos = new COS({
    SecretId: 'fixture',
    SecretKey: 'fixture',
    Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`,
    ...ARCHIVE_COS_OPTIONS,
    ChunkParallelLimit: 3,
    ProgressInterval: 10,
    ConfCwd: directory,
  });
  const temporaryFiles = [];
  for (const method of ['uploadFile', 'downloadFile']) {
    const original = cos[method].bind(cos);
    cos[method] = (params, callback) => {
      temporaryFiles.push(params.FilePath);
      return original(params, callback);
    };
  }
  // This is a protocol/byte-integrity test; deadline and cancellation are exercised separately.
  const transfer = createCosArchiveTransfer({ cos, policy });
  const credential = (hash) => ({
    storageFileId: `cloud://${policy.envId}.${policy.archiveBucket}/seo-recovery/objects/${hash.repeat(64)}.bin`,
    uploadUrl: `https://${policy.archiveBucket}.cos.ap-shanghai.myqcloud.com/seo-recovery/objects/${hash.repeat(64)}.bin`,
    headers: { 'x-cos-meta-fileid': 'fixture-meta' },
  });
  try {
    const small = Buffer.from('small');
    const large = Buffer.alloc(32 * 1024 * 1024 + 23, 7);
    await transfer.put(credential('a'), small, { uploadTimeoutMs: 30000 });
    assert.deepEqual(
      await transfer.read(null, credential('a').storageFileId, {
        maxBytes: small.length,
        timeoutMs: 30000,
      }),
      small,
    );
    slowRead = true;
    await t.test(
      'slow small-object reads accept the actual SDK byte-count representation',
      async () => {
        assert.deepEqual(
          await transfer.read(null, credential('a').storageFileId, {
            maxBytes: small.length,
            timeoutMs: 30000,
          }),
          small,
        );
      },
    );
    slowRead = false;
    await transfer.put(credential('b'), large, { uploadTimeoutMs: 30000 });
    const downloaded = await transfer.read(null, credential('b').storageFileId, {
      maxBytes: large.length,
      timeoutMs: 30000,
    });
    assert.deepEqual(downloaded, large);
    assert.equal(
      createHash('sha256').update(downloaded).digest('hex'),
      createHash('sha256').update(large).digest('hex'),
    );
    assert(
      temporaryFiles.every((file) => !existsSync(file) && !existsSync(dirname(file))),
      'Every private transfer file and directory must be removed',
    );
    assert.equal(
      calls.filter((call) => call.method === 'PUT' && call.query.includes('partNumber')).length,
      33,
    );
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.query.includes('uploadId')).length,
      1,
    );
    t.diagnostic(JSON.stringify({ bytes: large.length, maximumActiveParts }));
    assert.ok(
      maximumActiveParts > 8 && maximumActiveParts <= 32,
      `Expected 9–32 overlapping parts, got ${maximumActiveParts}`,
    );
    assert.equal(
      cos.getTaskList().every((task) => task.state === 'success'),
      true,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Keep the real SDK, filesystem, task cancellation and HTTP/XML parsing. The local server owns only COS state.
async function multipartResumeFixture(t, sdkOptions = {}, stalledHeaders = false) {
  const require = createRequire(import.meta.url);
  assert.equal(require('cos-nodejs-sdk-v5/package.json').version, '2.15.4');
  const COS = require('cos-nodejs-sdk-v5');
  const chunkSize = 1024 * 1024;
  const bytes = Buffer.alloc(chunkSize * 3 + 23);
  for (let n = 0; n < 4; n++)
    bytes.fill(11 + n, n * chunkSize, Math.min((n + 1) * chunkSize, bytes.length));
  const policy = {
    envId: 'resume-fixture-env',
    archiveBucket: 'resume-fixture-env-1234567890',
    region: 'ap-shanghai',
  };
  const key = `seo-recovery/objects/${createHash('sha256').update(bytes).digest('hex')}.bin`;
  const credential = {
    storageFileId: `cloud://${policy.envId}.${policy.archiveBucket}/${key}`,
    uploadUrl: `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${key}`,
    headers: { 'x-cos-meta-fileid': 'resume-fixture-meta' },
  };
  const directory = await mkdtemp(join(tmpdir(), 'archive-cos-resume-'));
  const uploads = new Map();
  const objects = new Map();
  const calls = [];
  const temporaryFiles = [];
  const firstAcknowledged = deferred();
  const missingReceived = deferred();
  const secondMissingReceived = deferred();
  const secondResponses = deferred();
  const oldResponses = [];
  const firstAcks = new Set();
  const firstMissing = new Set();
  const errors = [];
  let phase = 1;
  let initialized = 0;
  let wrongSize = false;
  const md5 = (data) => `"${createHash('md5').update(data).digest('hex')}"`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const uploadId = url.searchParams.get('uploadId');
      const partNumber = Number(url.searchParams.get('partNumber')) || null;
      calls.push({
        phase,
        method: req.method,
        query: [...url.searchParams.keys()],
        uploadId,
        partNumber,
        bytes: body.length,
      });
      const xml = (value) => {
        res.setHeader('content-type', 'application/xml');
        res.end(value);
      };
      if (req.method === 'GET' && url.searchParams.has('uploads')) {
        assert.equal(url.searchParams.get('prefix'), key);
        return xml(
          `<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${[...uploads.keys()].map((id) => `<Upload><Key>${key}</Key><UploadId>${id}</UploadId><StorageClass>STANDARD</StorageClass></Upload>`).join('')}</ListMultipartUploadsResult>`,
        );
      }
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const id = `resume-upload-${++initialized}`;
        uploads.set(id, new Map());
        return xml(
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (req.method === 'GET' && uploadId) {
        assert.ok(uploads.has(uploadId));
        const listed = [...uploads.get(uploadId)].sort((a, b) => a[0] - b[0]);
        return xml(
          `<ListPartsResult><IsTruncated>false</IsTruncated>${listed.map(([number, data]) => `<Part><PartNumber>${number}</PartNumber><ETag>${md5(data)}</ETag><Size>${data.length - (wrongSize && uploadId === 'resume-upload-1' && number === 1 ? 1 : 0)}</Size></Part>`).join('')}</ListPartsResult>`,
        );
      }
      if (req.method === 'PUT' && partNumber) {
        assert.ok(uploads.has(uploadId));
        assert.equal(req.headers['content-md5'], createHash('md5').update(body).digest('base64'));
        const expected = bytes.subarray(
          (partNumber - 1) * chunkSize,
          Math.min(partNumber * chunkSize, bytes.length),
        );
        assert.deepEqual(body, expected);
        if (phase === 1 && partNumber >= 3) {
          // These requests reached the server, but COS has not accepted their bytes.
          const closed = deferred();
          res.once('close', closed.resolve);
          oldResponses.push({ res, closed });
          firstMissing.add(partNumber);
          if (firstMissing.size === 2) missingReceived.resolve();
          if (stalledHeaders) {
            res.writeHead(200, { 'content-length': 1 });
            res.flushHeaders();
          }
          return;
        }
        if (phase === 2 && partNumber >= 3) {
          secondMissingReceived.resolve();
          await secondResponses.promise;
        }
        uploads.get(uploadId).set(partNumber, body);
        res.setHeader('etag', md5(body));
        return res.end();
      }
      if (req.method === 'POST' && uploadId) {
        const parts = uploads.get(uploadId);
        assert.equal(parts.size, 4, 'Completion requires every part');
        const completed = [
          ...body
            .toString()
            .matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag><\/Part>/g),
        ];
        assert.equal(completed.length, 4, 'The real SDK must supply its complete part manifest');
        for (const [, number, etag] of completed)
          assert.equal(etag.replaceAll('&quot;', '"'), md5(parts.get(Number(number))));
        objects.set(
          url.pathname,
          Buffer.concat([...parts].sort((a, b) => a[0] - b[0]).map(([, data]) => data)),
        );
        uploads.delete(uploadId);
        return xml(
          '<CompleteMultipartUploadResult><ETag>"complete-resumed"</ETag></CompleteMultipartUploadResult>',
        );
      }
      const data = objects.get(url.pathname);
      if (!data) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('etag', '"complete-resumed"');
      if (req.method === 'HEAD') {
        res.setHeader('content-length', data.length);
        return res.end();
      }
      if (req.method === 'GET') {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (range) {
          const start = Number(range[1]);
          const end = Number(range[2]);
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
          res.setHeader('content-length', end - start + 1);
          return res.end(data.subarray(start, end + 1));
        }
        res.setHeader('content-length', data.length);
        return res.end(data);
      }
      throw Error('Unexpected COS request');
    } catch (error) {
      if (req.destroyed && error.code === 'ECONNRESET') return;
      errors.push(error);
      t.diagnostic(error.stack);
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    secondResponses.resolve();
    for (const task of cos.getTaskList()) if (task.state !== 'success') cos.cancelTask(task.id);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const cos = new COS({
    SecretId: 'fixture',
    SecretKey: 'fixture',
    Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`,
    ...ARCHIVE_COS_OPTIONS,
    ProgressInterval: 10,
    ConfCwd: directory,
    ...sdkOptions,
  });
  const upload = cos.uploadFile.bind(cos);
  cos.uploadFile = (params, callback) => {
    temporaryFiles.push(params.FilePath);
    return upload(params, callback);
  };
  const multipart = cos.multipartUpload.bind(cos);
  cos.multipartUpload = (params, callback) =>
    multipart(params, (error, value) => {
      // Observe an actual SDK acknowledgement, not merely a server write or a sleep.
      if (!error && phase === 1 && params.PartNumber <= 2) {
        firstAcks.add(params.PartNumber);
        if (firstAcks.size === 2) firstAcknowledged.resolve();
      }
      callback(error, value);
    });
  const transfer = createCosArchiveTransfer({ cos, policy });
  return {
    bytes,
    credential,
    calls,
    cos,
    uploads,
    objects,
    temporaryFiles,
    errors,
    firstAcknowledged: firstAcknowledged.promise,
    missingReceived: missingReceived.promise,
    secondMissingReceived: secondMissingReceived.promise,
    releaseSecond: secondResponses.resolve,
    oldResponses,
    secondPhase() {
      phase = 2;
    },
    corruptDigest() {
      const data = Buffer.from(uploads.get('resume-upload-1').get(1));
      data[0] ^= 0xff;
      uploads.get('resume-upload-1').set(1, data);
    },
    corruptSize() {
      wrongSize = true;
    },
    put: (options) => transfer.put(credential, bytes, options),
    read: () =>
      transfer.read(null, credential.storageFileId, { maxBytes: bytes.length, timeoutMs: 10_000 }),
  };
}

for (const mismatch of [null, 'md5', 'size'])
  test(
    `the real COS client resumes a canceled new-path upload${mismatch ? ` and rejects an old ${mismatch} mismatch` : ' by sending only missing parts'}`,
    { timeout: 25_000 },
    async (t) => {
      const f = await multipartResumeFixture(t);
      const firstOutcome = f.put({ uploadTimeoutMs: 4000 }).then(
        () => ({ succeeded: true }),
        (error) => error,
      );
      await Promise.all([f.firstAcknowledged, f.missingReceived]);
      assert.equal((await firstOutcome).code, 'ETIMEDOUT');
      await Promise.all(f.oldResponses.map(({ closed }) => closed.promise));
      assert.deepEqual([...f.uploads.get('resume-upload-1').keys()].sort(), [1, 2]);
      assert.equal(f.cos.getTaskList()[0].state, 'canceled');
      assert.equal(existsSync(f.temporaryFiles[0]), false);
      assert.equal(existsSync(dirname(f.temporaryFiles[0])), false);
      assert.equal(
        f.calls.some((call) => call.method === 'POST' && call.query.includes('uploadId')),
        false,
      );
      if (mismatch === 'md5') f.corruptDigest();
      if (mismatch === 'size') f.corruptSize();
      f.secondPhase();
      let secondCompleted = false;
      const second = f.put({ uploadTimeoutMs: 10_000 }).then(() => {
        secondCompleted = true;
      });
      await f.secondMissingReceived;
      // Replies attempted after the old socket was canceled cannot complete the new task.
      for (const { res } of f.oldResponses) {
        assert.equal(res.destroyed, true);
        res.end();
      }
      assert.equal(secondCompleted, false);
      assert.equal(f.cos.getTaskList()[0].state, 'canceled');
      assert.notEqual(f.cos.getTaskList()[1].state, 'success');
      assert.equal(
        f.calls.some(
          (call) => call.phase === 2 && call.method === 'POST' && call.query.includes('uploadId'),
        ),
        false,
      );
      f.releaseSecond();
      await second;
      assert.notEqual(
        f.temporaryFiles[0],
        f.temporaryFiles[1],
        'Each put must use a fresh private temporary path',
      );
      assert.ok(f.temporaryFiles.every((file) => !existsSync(file) && !existsSync(dirname(file))));
      const calls = f.calls.filter((call) => call.phase === 2);
      assert.equal(
        calls.filter((call) => call.method === 'GET' && call.query.includes('uploads')).length,
        1,
      );
      assert.equal(
        calls.filter((call) => call.method === 'GET' && call.uploadId === 'resume-upload-1').length,
        1,
      );
      const sent = calls.filter((call) => call.method === 'PUT' && call.partNumber);
      assert.deepEqual(
        sent.map((call) => call.partNumber).sort(),
        mismatch ? [1, 2, 3, 4] : [3, 4],
      );
      assert.equal(
        calls.filter((call) => call.method === 'POST' && call.query.includes('uploads')).length,
        mismatch ? 1 : 0,
      );
      assert.ok(
        sent.every((call) => call.uploadId === (mismatch ? 'resume-upload-2' : 'resume-upload-1')),
      );
      assert.equal(calls.filter((call) => call.method === 'POST' && call.uploadId).length, 1);
      assert.deepEqual(await f.read(), f.bytes);
      assert.deepEqual(
        f.cos.getTaskList().map((task) => task.state),
        ['canceled', 'success'],
      );
      assert.deepEqual(f.errors, []);
      t.diagnostic(
        JSON.stringify({
          sdk: '2.15.4',
          mismatch,
          reusedParts: mismatch ? 0 : 2,
          sentParts: sent.length,
          bytes: f.bytes.length,
        }),
      );
    },
  );

for (const retries of [0, 1])
  test(
    `a real connected COS socket timeout preserves its cause, cancels ownership and resumes safely (${retries} chunk retries)`,
    { timeout: 15_000 },
    async (t) => {
      const require = createRequire(import.meta.url);
      const requestPackage = require.resolve('request/package.json', {
        paths: [require.resolve('cos-nodejs-sdk-v5')],
      });
      assert.equal(require(requestPackage).version, '2.88.2');
      const f = await multipartResumeFixture(
        t,
        { Timeout: 200, ChunkRetryTimes: retries },
        retries === 1,
      );
      assert.equal(f.cos.options.Timeout, 200);
      assert.equal(f.cos.options.ChunkRetryTimes, retries);
      const rawErrors = [];
      const cancellations = [];
      const upload = f.cos.uploadFile.bind(f.cos);
      const cancel = f.cos.cancelTask.bind(f.cos);
      f.cos.cancelTask = (id) => {
        cancellations.push(id);
        return cancel(id);
      };
      f.cos.uploadFile = (params, callback) =>
        upload(params, (error, result) => {
          if (error)
            rawErrors.push({
              code: error.code,
              connect: error.connect,
              statusCode: error.statusCode,
            });
          callback(error, result);
        });
      // The overall budget is 25 times the socket deadline. No global cancellation is triggered by this test.
      const outcome = f.put({ uploadTimeoutMs: 5000 }).then(
        () => assert.fail('A stalled multipart response succeeded'),
        (error) => error,
      );
      await Promise.all([f.firstAcknowledged, f.missingReceived]);
      const failure = await outcome;
      assert.equal(rawErrors.length, 1);
      assert.equal(rawErrors[0].code, 'ESOCKETTIMEDOUT');
      if (retries === 1) assert.equal(rawErrors[0].statusCode, 200);
      assert.ok(
        f.calls.some((call) => call.method === 'PUT' && call.partNumber >= 3),
        'The server received the entire HTTP request before withholding its reply',
      );
      t.diagnostic(
        JSON.stringify({
          sdk: '2.15.4',
          request: '2.88.2',
          retries,
          raw: rawErrors[0],
          publicCode: failure.code,
        }),
      );
      const firstTask = f.cos.getTaskList()[0];
      assert.deepEqual(
        { code: failure.code, state: firstTask.state, cancellations: cancellations.length },
        { code: 'ESOCKETTIMEDOUT', state: 'canceled', cancellations: 1 },
        'A native SDK error must release only its local task ownership and retain the actual timeout cause',
      );
      assert.deepEqual(cancellations, [firstTask.id]);
      await Promise.all(f.oldResponses.map(({ closed }) => closed.promise));
      assert.deepEqual([...f.uploads.get('resume-upload-1').keys()].sort(), [1, 2]);
      assert.equal(
        f.calls.some((call) => call.method === 'DELETE'),
        false,
        'Local cancel must not abort remote multipart data',
      );
      f.secondPhase();
      const second = f.put({ uploadTimeoutMs: 5000 });
      await f.secondMissingReceived;
      f.releaseSecond();
      await second;
      const sent = f.calls.filter(
        (call) => call.phase === 2 && call.method === 'PUT' && call.partNumber,
      );
      assert.deepEqual(sent.map((call) => call.partNumber).sort(), [3, 4]);
      assert.ok(sent.every((call) => call.uploadId === 'resume-upload-1'));
      assert.equal(
        f.calls.filter(
          (call) => call.phase === 2 && call.method === 'POST' && call.query.includes('uploads'),
        ).length,
        0,
      );
      assert.equal(
        f.calls.filter(
          (call) => call.phase === 2 && call.method === 'GET' && call.query.includes('uploads'),
        ).length,
        1,
      );
      assert.equal(
        f.calls.filter(
          (call) =>
            call.phase === 2 && call.method === 'GET' && call.uploadId === 'resume-upload-1',
        ).length,
        1,
      );
      assert.notEqual(f.temporaryFiles[0], f.temporaryFiles[1]);
      assert.ok(f.temporaryFiles.every((file) => !existsSync(file) && !existsSync(dirname(file))));
      assert.deepEqual(await f.read(), f.bytes);
      assert.deepEqual(
        f.cos.getTaskList().map((task) => task.state),
        ['canceled', 'success'],
      );
      assert.deepEqual(f.errors, []);
    },
  );

// Run 43212545234: uploads handed to a one-file-at-a-time client timed out while still queued.
test('concurrent archive uploads need a client that runs them at once, not a queue under their deadlines', async (t) => {
  const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
  const directory = await mkdtemp(join(tmpdir(), 'archive-cos-parallel-'));
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    await new Promise((done) => setTimeout(done, 300));
    res.setHeader('etag', '"complete"');
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const policy = {
    envId: 'fixture-env',
    archiveBucket: 'fixture-env-1234567890',
    region: 'ap-shanghai',
  };
  const credential = (hash) => ({
    storageFileId: `cloud://${policy.envId}.${policy.archiveBucket}/seo-recovery/objects/${hash.repeat(64)}.bin`,
    uploadUrl: `https://${policy.archiveBucket}.cos.ap-shanghai.myqcloud.com/seo-recovery/objects/${hash.repeat(64)}.bin`,
    headers: { 'x-cos-meta-fileid': 'fixture-meta' },
  });
  const attempt = (options) => {
    const cos = new COS({
      SecretId: 'fixture',
      SecretKey: 'fixture',
      Protocol: 'http:',
      Domain: `127.0.0.1:${server.address().port}`,
      ...options,
      ConfCwd: directory,
    });
    const transfer = createCosArchiveTransfer({ cos, policy });
    return Promise.allSettled(
      ['a', 'b', 'c'].map((hash) =>
        transfer.put(credential(hash), Buffer.from(hash), { uploadTimeoutMs: 700 }),
      ),
    );
  };
  const queued = await attempt(ARCHIVE_COS_OPTIONS);
  assert.ok(
    queued.some((r) => r.status === 'rejected'),
    'a queued upload ran out of time',
  );
  const parallel = await attempt(PARALLEL_ARCHIVE_COS_OPTIONS);
  assert.deepEqual(
    parallel.map((r) => r.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
  );
});

// Run 43217655741: sized deadlines above the transfer layer's 300 s maximum were refused.
// This drives the private archive through the real transfer and SDK, not a fake transport.
test('slow-link deadlines pass the real transfer layer for objects of every size', async (t) => {
  const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
  const { createPrivateArchive } = await import('./release/private-archive.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'archive-cos-deadline-'));
  const objects = new Map();
  const parts = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const xml = (value) => {
      res.setHeader('content-type', 'application/xml');
      res.end(value);
    };
    if (req.method === 'GET' && url.searchParams.has('uploads'))
      return xml(
        '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
      );
    if (req.method === 'POST' && url.searchParams.has('uploads'))
      return xml(
        '<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>',
      );
    if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      parts.set(`${url.pathname}:${url.searchParams.get('partNumber')}`, body);
      res.setHeader('etag', `"${createHash('md5').update(body).digest('hex')}"`);
      return res.end();
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const mine = [...parts.entries()]
        .filter(([key]) => key.startsWith(`${url.pathname}:`))
        .sort((a, b) => Number(a[0].split(':').pop()) - Number(b[0].split(':').pop()));
      objects.set(url.pathname, Buffer.concat(mine.map((entry) => entry[1])));
      return xml(
        '<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>',
      );
    }
    if (req.method === 'PUT') {
      objects.set(url.pathname, body);
      res.setHeader('etag', '"done"');
      return res.end();
    }
    const data = objects.get(url.pathname);
    if (!data) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('etag', '"done"');
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (req.method === 'GET' && range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
      res.setHeader('content-length', end - start + 1);
      return res.end(data.subarray(start, end + 1));
    }
    res.setHeader('content-length', data.length);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const policy = {
    envId: 'fixture-env',
    archiveBucket: 'fixture-env-1234567890',
    region: 'ap-shanghai',
  };
  const cos = new COS({
    SecretId: 'fixture',
    SecretKey: 'fixture',
    Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`,
    ...PARALLEL_ARCHIVE_COS_OPTIONS,
    ConfCwd: directory,
  });
  const archive = createPrivateArchive({
    ...createCosArchiveTransfer({ cos, policy }),
    policy,
    sdk: {
      getUploadMetadata: async ({ cloudPath }) => ({
        data: {
          url: `https://${policy.archiveBucket}.cos.ap-shanghai.myqcloud.com/${cloudPath}`,
          fileId: `cloud://fixture-env.${policy.archiveBucket}/${cloudPath}`,
          cosFileId: 'fixture-meta',
          authorization: 'fixture-authorization',
          token: 'fixture-token',
        },
      }),
    },
    manager: {
      permission: {
        describeResourcePermission: async () => ({
          Data: {
            PermissionList: [
              { Resource: policy.archiveBucket, ResourceType: 'storage', Permission: 'PRIVATE' },
            ],
          },
        }),
      },
    },
    readLifecycle: async () => ({ Rules: [] }),
    slowLinkBytesPerSecond: 8 * 1024,
    policyCacheMs: 600000,
  });
  for (const size of [100, 1024 * 1024, 3 * 1024 * 1024, 9 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, size % 251);
    const ref = await archive.put(bytes);
    assert.equal((await archive.get(ref)).equals(bytes), true, `${size} bytes round trip`);
    assert.equal((await archive.stat(ref)).bytes, size);
  }
});
