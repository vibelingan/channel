import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { sha256 } from './release/input.mjs';
import { createNativeFunctionStage } from './release/native-function-stage.mjs';

test('the installed COS client copies a ZIP inside storage with conditional metadata, then reads exact bytes', async () => {
  const require = createRequire(import.meta.url);
  const COS = require('cos-nodejs-sdk-v5');
  const policy = {
    envId: 'fixture-env',
    region: 'ap-shanghai',
    archiveBucket: 'fixture-env-1234567890',
  };
  const data = Buffer.alloc(1024 * 1024 + 19, 7);
  const digest = sha256(data);
  const sourceKey = `seo-recovery/objects/${digest}.bin`;
  const destination = 'fnzip-upload/1793520000-0123456789abcdef/alibaba-catalog-sync.zip';
  const objects = new Map([[`/${sourceKey}`, data]]);
  const copies = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'PUT' && req.headers['x-cos-copy-source']) {
      copies.push({ path, headers: req.headers, bytes: Buffer.concat(chunks).length });
      if (req.headers['x-cos-copy-source-if-match'] !== '"source-etag"') {
        res.statusCode = 412;
        return res.end();
      }
      objects.set(path, data);
      res.setHeader('content-type', 'application/xml');
      return res.end(
        '<CopyObjectResult><ETag>"copied"</ETag><LastModified>2026-11-01T00:00:00Z</LastModified></CopyObjectResult>',
      );
    }
    const body = objects.get(path);
    if (!body) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('etag', path === `/${sourceKey}` ? '"source-etag"' : '"copied"');
    res.setHeader('content-length', body.length);
    if (req.method === 'HEAD') return res.end();
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      res.setHeader('content-length', end - start + 1);
      return res.end(body.subarray(start, end + 1));
    }
    res.end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const manager = {
    currentEnvironment: () => ({
      getEnvId: () => policy.envId,
      lazyInit: async () => {},
      lazyEnvironmentConfig: {
        EnvId: policy.envId,
        Storages: [{ Bucket: policy.archiveBucket, Region: policy.region }],
      },
    }),
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    permission: {
      describeResourcePermission: async () => ({
        Data: {
          PermissionList: [
            { Resource: policy.archiveBucket, ResourceType: 'storage', Permission: 'PRIVATE' },
          ],
        },
      }),
    },
  };
  const sdk = {
    getUploadMetadata: async ({ cloudPath }) => ({
      data: {
        fileId: `cloud://${policy.envId}.${policy.archiveBucket}/${cloudPath}`,
        url: `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${cloudPath}`,
        authorization: 'private-auth',
        token: 'private-token',
        cosFileId: 'destination-meta',
      },
    }),
  };
  const cos = new COS({
    SecretId: 'fixture',
    SecretKey: 'fixture',
    Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`,
    Timeout: 1000,
    ChunkRetryTimes: 0,
  });
  try {
    const stage = createNativeFunctionStage({
      manager,
      sdk,
      cos,
      policy,
      objects: {
        put: async (body) => {
          assert.deepEqual(body, data);
          return {
            fileID: `cloud://${policy.envId}.${policy.archiveBucket}/${sourceKey}`,
            bytes: data.length,
            sha256: digest,
          };
        },
      },
      now: () => 1793520000000,
      nonce: () => '0123456789abcdef',
    });
    assert.deepEqual(await stage(data), {
      fileID: `cloud://${policy.envId}.${policy.archiveBucket}/${destination}`,
      bytes: data.length,
      sha256: digest,
    });
    assert.equal(copies.length, 1);
    const copy = copies[0];
    assert.equal(copy.path, `/${destination}`);
    assert.equal(copy.bytes, 0);
    assert.equal(
      copy.headers['x-cos-copy-source'],
      `${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${sourceKey}`,
    );
    assert.equal(copy.headers['x-cos-metadata-directive'], 'Replaced');
    assert.equal(copy.headers['x-cos-meta-fileid'], 'destination-meta');
    assert.equal(copy.headers['content-type'], 'application/zip');
    assert.equal(copy.headers['cache-control'], 'private, no-store');
    assert.equal(copy.headers['x-cos-acl'], undefined);
    assert.deepEqual(objects.get(`/${sourceKey}`), data);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
