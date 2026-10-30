import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARCHIVE_COS_OPTIONS, createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';

// The real SDK handles task queues, HTTP bodies, multipart XML and Range writes. Only the COS server is local.
test('the actual COS client uploads a small object, reads it, then completes a multipart archive and range read', async (t) => {
  const require = createRequire(import.meta.url);
  const COS = require('cos-nodejs-sdk-v5');
  const objects = new Map();
  const parts = new Map();
  const calls = [];
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
    ConfCwd: directory,
  });
  // This is a protocol/byte-integrity test; deadline and cancellation are exercised separately.
  const transfer = createCosArchiveTransfer({ cos, policy });
  const credential = (hash) => ({
    storageFileId: `cloud://${policy.envId}.${policy.archiveBucket}/seo-recovery/objects/${hash.repeat(64)}.bin`,
    uploadUrl: `https://${policy.archiveBucket}.cos.ap-shanghai.myqcloud.com/seo-recovery/objects/${hash.repeat(64)}.bin`,
    headers: { 'x-cos-meta-fileid': 'fixture-meta' },
  });
  try {
    const small = Buffer.from('small');
    const large = Buffer.alloc(8 * 1024 * 1024 + 23, 7);
    await transfer.put(credential('a'), small, { uploadTimeoutMs: 30000 });
    assert.deepEqual(
      await transfer.read(null, credential('a').storageFileId, {
        maxBytes: small.length,
        timeoutMs: 30000,
      }),
      small,
    );
    await transfer.put(credential('b'), large, { uploadTimeoutMs: 30000 });
    assert.deepEqual(
      await transfer.read(null, credential('b').storageFileId, {
        maxBytes: large.length,
        timeoutMs: 30000,
      }),
      large,
    );
    assert.equal(
      calls.filter((call) => call.method === 'PUT' && call.query.includes('partNumber')).length,
      9,
    );
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.query.includes('uploadId')).length,
      1,
    );
    t.diagnostic(JSON.stringify({ bytes: large.length, maximumActiveParts }));
    assert.ok(
      maximumActiveParts > 3 && maximumActiveParts <= 8,
      `Expected 4–8 overlapping parts, got ${maximumActiveParts}`,
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
