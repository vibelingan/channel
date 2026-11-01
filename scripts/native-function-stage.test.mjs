import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createNativeFunctionStage } from './release/native-function-stage.mjs';

const policy = {
  envId: 'fixture-env',
  region: 'ap-shanghai',
  archiveBucket: 'fixture-env-bucket-123456',
};
const payload = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 127, 128, 13, 10, 0, 42]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = hash(payload);
const sourceKey = `seo-recovery/objects/${digest}.bin`;
const stagingKey = 'fnzip-upload/1792732800-0123456789abcdef/alibaba-catalog-sync.zip';
const fileId = (key) => `cloud://${policy.envId}.${policy.archiveBucket}/${key}`;
const secret = 'fixture-private-authorization-must-not-escape';

function fixture(options = {}) {
  const files = new Map();
  const calls = [];
  const state = {
    config: {
      EnvId: policy.envId,
      Storages: [{ Bucket: policy.archiveBucket, Region: policy.region }],
    },
    managerConfig: { envId: policy.envId, region: policy.region },
    envId: policy.envId,
    archiveRef: undefined,
    metadata: undefined,
    archiveError: undefined,
    metadataError: undefined,
    environmentError: undefined,
    lazyInitError: undefined,
    configError: undefined,
    permissionError: undefined,
    sourceLength: undefined,
    sourceEtag: '"source-version"',
    beforeCopy: undefined,
    copyError: undefined,
    copyHang: false,
    copyThrow: false,
    completeCopy: undefined,
    corruptRead: false,
    privatePermission: true,
  };
  const assertTarget = (params) => {
    assert.equal(params.Bucket, policy.archiveBucket);
    assert.equal(params.Region, policy.region);
  };
  const forbidden =
    (method) =>
    (...args) => {
      calls.push({ method, args });
      throw Error(`Unexpected mutation: ${method}`);
    };
  const environment = {
    getEnvId: () => state.envId,
    async lazyInit() {
      calls.push({ method: 'lazyInit' });
      if (state.lazyInitError) throw state.lazyInitError;
    },
    get lazyEnvironmentConfig() {
      return state.config;
    },
  };
  const manager = {
    currentEnvironment: () => {
      if (state.environmentError) throw state.environmentError;
      return environment;
    },
    getManagerConfig: () => {
      if (state.configError) throw state.configError;
      return state.managerConfig;
    },
    permission: {
      async describeResourcePermission(params) {
        calls.push({ method: 'permission', params });
        if (state.permissionError) throw state.permissionError;
        return {
          Data: {
            PermissionList: [
              {
                Resource: policy.archiveBucket,
                ResourceType: 'storage',
                Permission: state.privatePermission ? 'PRIVATE' : 'READONLY',
              },
            ],
          },
        };
      },
      modifyResourcePermission: forbidden('modifyResourcePermission'),
    },
    functions: {
      updateFunctionCode: forbidden('updateFunctionCode'),
      updateFunctionConfig: forbidden('updateFunctionConfig'),
      deleteFunction: forbidden('deleteFunction'),
    },
  };
  const sdk = {
    async getUploadMetadata(params) {
      calls.push({ method: 'metadata', params });
      if (state.metadataError) throw state.metadataError;
      return {
        data: {
          url: `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${params.cloudPath}`,
          authorization: secret,
          token: 'fixture-private-token',
          cosFileId: 'fixture-native-fileid-metadata',
          fileId: fileId(params.cloudPath),
          ...state.metadata,
        },
      };
    },
    deleteFile: forbidden('deleteFile'),
  };
  const objects = {
    async put(bytes) {
      calls.push({ method: 'archive', bytes: Buffer.from(bytes) });
      if (state.archiveError) throw state.archiveError;
      const key = `seo-recovery/objects/${hash(bytes)}.bin`;
      files.set(key, { bytes: Buffer.from(bytes), etag: state.sourceEtag });
      return state.archiveRef ?? { fileID: fileId(key), bytes: bytes.length, sha256: hash(bytes) };
    },
  };
  const cos = {
    async headObject(params) {
      assertTarget(params);
      calls.push({ method: 'head', params });
      const entry = files.get(params.Key);
      if (!entry) throw Object.assign(Error(secret), { statusCode: 404 });
      return {
        ETag: entry.etag,
        headers: {
          'content-length': String(
            params.Key === sourceKey && state.sourceLength !== undefined
              ? state.sourceLength
              : entry.bytes.length,
          ),
        },
      };
    },
    putObjectCopy(params, done) {
      assertTarget(params);
      calls.push({ method: 'copy', params });
      if (state.copyThrow) throw Object.assign(Error(secret), { code: 'SignatureDoesNotMatch' });
      const complete = () => {
        state.beforeCopy?.();
        const source = files.get(sourceKey);
        if (state.copyError) return done(state.copyError);
        if (params.CopySourceIfMatch !== source?.etag)
          return done(Object.assign(Error(secret), { statusCode: 412 }));
        files.set(params.Key, { bytes: Buffer.from(source.bytes), etag: '"staged-version"' });
        done(null, { ETag: '"staged-version"' });
      };
      state.completeCopy = complete;
      if (!state.copyHang) complete();
      return {
        abort() {
          calls.push({ method: 'abort-copy' });
        },
      };
    },
    downloadFile(params, done) {
      assertTarget(params);
      calls.push({ method: 'download', params });
      const entry = files.get(params.Key);
      const bytes = Buffer.from(entry.bytes);
      if (state.corruptRead) bytes[bytes.length - 1] ^= 1;
      params.onProgress({ loaded: bytes.length, total: bytes.length });
      writeFile(params.FilePath, bytes).then(() => done(null, {}), done);
    },
    emit(name, params) {
      calls.push({ method: name, params });
    },
    deleteObject: forbidden('deleteObject'),
    deleteMultipleObject: forbidden('deleteMultipleObject'),
    putObjectACL: forbidden('putObjectACL'),
    putBucketACL: forbidden('putBucketACL'),
  };
  const stage = createNativeFunctionStage({
    manager,
    sdk,
    cos,
    policy,
    objects,
    now: () => 1792732800000,
    nonce: () => '0123456789abcdef',
    ...options,
  });
  return { stage, state, files, calls };
}

const count = (f, method) => f.calls.filter((call) => call.method === method).length;
const noCopy = (f) => {
  assert.equal(count(f, 'copy'), 0);
  assert.equal(count(f, 'download'), 0);
};
const safeError = (error) => {
  assert.equal(String(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(error.cause, undefined);
  return true;
};

test('native staging archives and reads the exact ZIP bytes without repacking or changing permissions', async () => {
  const f = fixture();
  const input = Buffer.from(payload);
  const result = await f.stage(input);
  assert.deepEqual(result, { fileID: fileId(stagingKey), bytes: payload.length, sha256: digest });
  assert.deepEqual(input, payload);
  assert.deepEqual(f.files.get(sourceKey).bytes, payload);
  assert.deepEqual(f.files.get(stagingKey).bytes, payload);
  assert.equal(count(f, 'archive'), 1);
  assert.equal(count(f, 'metadata'), 1);
  assert.equal(count(f, 'copy'), 1);
  assert.equal(count(f, 'download'), 1);
  assert(
    f.calls.findIndex((call) => call.method === 'archive') <
      f.calls.findIndex((call) => call.method === 'copy'),
  );
  assert.deepEqual(f.calls.find((call) => call.method === 'metadata').params, {
    cloudPath: stagingKey,
  });
  assert.deepEqual(f.calls.find((call) => call.method === 'copy').params, {
    Bucket: policy.archiveBucket,
    Region: policy.region,
    Key: stagingKey,
    CopySource: `${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${sourceKey}`,
    CopySourceIfMatch: '"source-version"',
    MetadataDirective: 'Replaced',
    Headers: { 'x-cos-meta-fileid': 'fixture-native-fileid-metadata' },
    ContentType: 'application/zip',
    CacheControl: 'private, no-store',
  });
  assert.equal(f.calls.find((call) => call.method === 'download').params.Key, stagingKey);
  assert.equal(count(f, 'permission'), 2);
  assert.equal(
    f.calls.some((call) => /delete|ACL|modifyResource|updateFunction/.test(call.method)),
    false,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

for (const [label, mutate] of [
  [
    'environment getter',
    (s) => {
      s.envId = 'other-env';
    },
  ],
  [
    'manager environment',
    (s) => {
      s.managerConfig.envId = 'other-env';
    },
  ],
  [
    'manager region',
    (s) => {
      s.managerConfig.region = 'ap-singapore';
    },
  ],
  [
    'resolved environment',
    (s) => {
      s.config.EnvId = 'other-env';
    },
  ],
  [
    'storage bucket',
    (s) => {
      s.config.Storages[0].Bucket = 'foreign-bucket';
    },
  ],
  [
    'storage region',
    (s) => {
      s.config.Storages[0].Region = 'ap-singapore';
    },
  ],
  [
    'missing storage',
    (s) => {
      s.config.Storages = [];
    },
  ],
]) {
  test(`native staging refuses ${label} drift before creating the staging object`, async () => {
    const f = fixture();
    mutate(f.state);
    await assert.rejects(f.stage(payload));
    noCopy(f);
    assert.equal(count(f, 'metadata'), 0);
  });
}

for (const [label, patch] of [
  ['foreign environment', { fileID: fileId(sourceKey).replace('fixture-env.', 'other-env.') }],
  ['foreign bucket', { fileID: fileId(sourceKey).replace(policy.archiveBucket, 'foreign-bucket') }],
  ['different owned path', { fileID: fileId(`seo-recovery/objects/${'a'.repeat(64)}.bin`) }],
  ['length mismatch', { bytes: payload.length + 1 }],
  ['hash mismatch', { sha256: 'a'.repeat(64) }],
]) {
  test(`native staging refuses an archive receipt with ${label}`, async () => {
    const f = fixture();
    f.state.archiveRef = {
      fileID: fileId(sourceKey),
      bytes: payload.length,
      sha256: digest,
      ...patch,
    };
    await assert.rejects(f.stage(payload));
    noCopy(f);
    assert.equal(count(f, 'metadata'), 0);
    assert.deepEqual(f.files.get(sourceKey).bytes, payload);
  });
}

for (const [label, metadata] of [
  ['foreign file ID', { fileId: `cloud://other-env.foreign-bucket/${stagingKey}` }],
  [
    'foreign URL host',
    { url: `https://foreign-bucket.cos.ap-shanghai.myqcloud.com/${stagingKey}` },
  ],
  [
    'foreign URL region',
    { url: `https://${policy.archiveBucket}.cos.ap-singapore.myqcloud.com/${stagingKey}` },
  ],
  [
    'wrong object',
    { url: `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/unowned.zip` },
  ],
  [
    'URL credentials',
    {
      url: `https://user:password@${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${stagingKey}`,
    },
  ],
  [
    'URL fragment',
    {
      url: `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com/${stagingKey}#unreviewed`,
    },
  ],
  ['missing file metadata', { cosFileId: '' }],
]) {
  test(`native staging refuses upload metadata containing ${label}`, async () => {
    const f = fixture();
    f.state.metadata = metadata;
    await assert.rejects(f.stage(payload));
    noCopy(f);
    assert.deepEqual(f.files.get(sourceKey).bytes, payload);
  });
}

test('copy uses the original ETag as a condition and stops if that object changes before copy', async () => {
  const f = fixture();
  f.state.beforeCopy = () => {
    f.files.get(sourceKey).etag = '"changed-after-head"';
  };
  await assert.rejects(f.stage(payload), safeError);
  assert.equal(count(f, 'copy'), 1);
  assert.equal(
    f.calls.find((call) => call.method === 'copy').params.CopySourceIfMatch,
    '"source-version"',
  );
  assert.equal(count(f, 'download'), 0);
  assert.equal(f.files.has(stagingKey), false);
  assert.deepEqual(f.files.get(sourceKey).bytes, payload);
});

test('matching readback length with different bytes never becomes a staged package', async () => {
  const f = fixture();
  f.state.corruptRead = true;
  await assert.rejects(f.stage(payload), safeError);
  assert.equal(count(f, 'download'), 1);
  assert.equal(count(f, 'permission'), 1);
  assert.deepEqual(f.files.get(sourceKey).bytes, payload);
});

test('a changed source length stops before the copy', async () => {
  const f = fixture();
  f.state.sourceLength = payload.length + 1;
  await assert.rejects(f.stage(payload), safeError);
  noCopy(f);
});

test('a non-private bucket stops staging before any archive or copy without changing permissions', async () => {
  const f = fixture();
  f.state.privatePermission = false;
  await assert.rejects(f.stage(payload), safeError);
  assert.equal(count(f, 'archive'), 0);
  assert.equal(count(f, 'metadata'), 0);
  noCopy(f);
  assert.equal(f.files.size, 0);
  assert.equal(
    f.calls.some((call) => /delete|ACL|modifyResource/.test(call.method)),
    false,
  );
});

test('private permissions are rechecked after readback before confirming the staged package', async () => {
  const f = fixture();
  f.state.beforeCopy = () => {
    f.state.privatePermission = false;
  };
  await assert.rejects(f.stage(payload), safeError);
  assert.equal(count(f, 'permission'), 2);
  assert.equal(count(f, 'download'), 1);
  assert.deepEqual(f.files.get(sourceKey).bytes, payload);
  assert.equal(f.files.has(stagingKey), true);
  assert.equal(
    f.calls.some((call) => /delete|ACL|modifyResource/.test(call.method)),
    false,
  );
});

for (const [label, configure] of [
  [
    'copy error callback',
    (s) => {
      s.copyError = Object.assign(Error(secret), { statusCode: 503 });
    },
  ],
  [
    'synchronous copy exception',
    (s) => {
      s.copyThrow = true;
    },
  ],
  [
    'upload metadata rejection',
    (s) => {
      s.metadataError = Error(secret);
    },
  ],
  [
    'permanent archive rejection',
    (s) => {
      s.archiveError = Error(secret);
    },
  ],
  [
    'manager environment rejection',
    (s) => {
      s.environmentError = Error(secret);
    },
  ],
  [
    'environment initialization rejection',
    (s) => {
      s.lazyInitError = Error(secret);
    },
  ],
  [
    'manager configuration rejection',
    (s) => {
      s.configError = Error(secret);
    },
  ],
  [
    'permission lookup rejection',
    (s) => {
      s.permissionError = Error(secret);
    },
  ],
]) {
  test(`native staging hides credential-bearing ${label} and does not blindly retry`, async () => {
    const f = fixture();
    configure(f.state);
    await assert.rejects(f.stage(payload), safeError);
    assert(count(f, 'copy') <= 1);
    assert(count(f, 'archive') <= 1);
    assert.equal(
      f.calls.some((call) => /delete|ACL|modifyResource/.test(call.method)),
      false,
    );
  });
}

test(
  'a hung copy has one deadline; a late successful callback cannot confirm staging',
  { timeout: 3000 },
  async () => {
    const f = fixture({ timeoutMs: 25 });
    f.state.copyHang = true;
    let accepted = false;
    const started = Date.now();
    const pending = f.stage(payload).then((result) => {
      accepted = true;
      return result;
    });
    await assert.rejects(pending, (error) => {
      safeError(error);
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    });
    assert(Date.now() - started < 2000);
    assert.equal(count(f, 'copy'), 1);
    assert.equal(count(f, 'download'), 0);
    f.state.completeCopy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accepted, false);
    assert.equal(count(f, 'download'), 0);
    assert.equal(count(f, 'copy'), 1);
    assert.deepEqual(f.files.get(sourceKey).bytes, payload);
    assert.equal(
      f.calls.some((call) => /delete|ACL|modifyResource/.test(call.method)),
      false,
    );
  },
);

for (const nonce of [
  '0123456789abcde',
  '0123456789abcdef0',
  '../0123456789abc',
  '0123456789abcdeF',
  '0123456789abcdef\n',
]) {
  test(`invalid nonce ${JSON.stringify(nonce)} cannot reach archive or upload`, async () => {
    const f = fixture({ nonce: () => nonce });
    await assert.rejects(f.stage(payload));
    assert.equal(count(f, 'archive'), 0);
    assert.equal(count(f, 'metadata'), 0);
    noCopy(f);
  });
}

for (const now of [0, Number.NaN, Number.POSITIVE_INFINITY, 10000000000000]) {
  test(`an out-of-range staging timestamp ${String(now)} cannot create an object`, async () => {
    const f = fixture({ now: () => now });
    await assert.rejects(f.stage(payload));
    assert.equal(count(f, 'archive'), 0);
    noCopy(f);
  });
}

test('invalid ZIP input never creates a permanent archive or deployment object', async () => {
  for (const input of [undefined, 'not-bytes', new Uint8Array(payload), Buffer.alloc(0)]) {
    const f = fixture();
    await assert.rejects(f.stage(input));
    assert.equal(count(f, 'archive'), 0);
    noCopy(f);
  }
});
