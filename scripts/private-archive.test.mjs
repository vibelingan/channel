import assert from 'node:assert/strict';
import test from 'node:test';
import { assertArchiveLifecycle, createPrivateArchive } from './release/private-archive.mjs';
const policy = { envId: 'fixture-env', region: 'ap-shanghai', archiveBucket: 'fixture-bucket' };
function setup() {
  const objects = new Map();
  const calls = [];
  const bucket = 'fixture-bucket';
  const sdk = {
    getUploadMetadata: async ({ cloudPath }) => ({
      data: {
        url: `https://${bucket}.cos.ap-shanghai.myqcloud.com/${cloudPath}`,
        fileId: `cloud://fixture-env.${bucket}/${cloudPath}`,
        cosFileId: 'file-meta',
        authorization: 'fixture-signature',
        token: 'fixture-token',
      },
    }),
  };
  const manager = {
    permission: {
      describeResourcePermission: async (input) => {
        calls.push(['permission', input]);
        return {
          Data: {
            PermissionList: [{ Resource: bucket, ResourceType: 'storage', Permission: 'PRIVATE' }],
          },
        };
      },
    },
  };
  const put = async (credential, bytes) => {
    calls.push(['put', credential]);
    objects.set(credential.storageFileId, Buffer.from(bytes));
  };
  const read = async (_sdk, id, options) => {
    calls.push(['read', id, options]);
    const value = objects.get(id);
    if (!value) throw Error('absent');
    return Buffer.from(value);
  };
  return { sdk, manager, put, read, objects, calls, readLifecycle: async () => ({ Rules: [] }) };
}
test('archive objects retain CloudBase identity and require complete readback bytes', async () => {
  const x = setup();
  const archive = createPrivateArchive({ ...x, policy });
  const ref = await archive.put(Buffer.from('program bytes'));
  assert.match(
    ref.fileID,
    /^cloud:\/\/fixture-env\.fixture-bucket\/seo-recovery\/objects\/[a-f0-9]{64}\.bin$/,
  );
  assert.equal((await archive.get(ref)).toString(), 'program bytes');
  const write = x.calls.find((c) => c[0] === 'put');
  assert.equal(write[1].method, 'PUT');
  assert.equal(write[1].headers['x-cos-security-token'], 'fixture-token');
  assert.ok(
    x.calls
      .filter((c) => c[0] === 'permission')
      .every((c) => c[1].resourceType === 'storage' && c[1].resources[0] === 'fixture-bucket'),
  );
});
test('a public bucket is refused without changing its permissions or uploading', async () => {
  const x = setup();
  x.manager.permission.describeResourcePermission = async () => ({
    Data: {
      PermissionList: [
        { Resource: 'fixture-bucket', ResourceType: 'storage', Permission: 'PUBLICREAD' },
      ],
    },
  });
  await assert.rejects(
    createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes')),
    /already be private/,
  );
  assert.equal(x.calls.filter((c) => c[0] === 'put').length, 0);
});
test('another environment or upload host is rejected before bytes leave', async () => {
  const x = setup();
  const original = x.sdk.getUploadMetadata;
  x.sdk.getUploadMetadata = async (input) => {
    const result = await original(input);
    result.data.fileId = result.data.fileId.replace('fixture-env.', 'other-env.');
    return result;
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes')),
    /another environment/,
  );
  assert.equal(x.calls.length, 0);
  const y = setup();
  const mint = y.sdk.getUploadMetadata;
  y.sdk.getUploadMetadata = async (input) => {
    const result = await mint(input);
    result.data.url = result.data.url.replace(
      'fixture-bucket.cos.ap-shanghai.myqcloud.com',
      'foreign.example',
    );
    return result;
  };
  await assert.rejects(
    createPrivateArchive({ ...y, policy }).put(Buffer.from('bytes')),
    /target differs/,
  );
  assert.equal(y.calls.filter((c) => c[0] === 'put').length, 0);
});
test('a lost PUT reply is accepted only when exact immutable bytes can be read back', async () => {
  const x = setup();
  const send = x.put;
  x.put = async (...args) => {
    await send(...args);
    throw Error('lost reply');
  };
  const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('same bytes'));
  assert.ok(x.objects.has(ref.fileID));
  const y = setup();
  y.put = async () => {
    throw Error('lost reply');
  };
  await assert.rejects(
    createPrivateArchive({ ...y, policy }).put(Buffer.from('missing bytes')),
    /needs readback/,
  );
});
test('same-length corruption fails hash verification', async () => {
  const x = setup();
  const archive = createPrivateArchive({ ...x, policy });
  const ref = await archive.put(Buffer.from('bytes'));
  x.objects.set(ref.fileID, Buffer.from('other'));
  await assert.rejects(archive.get(ref), /byte verification failed/);
});

test('lifecycle guards reject matching expiry and archive rules but preserve unrelated policies', () => {
  const path = 'seo-recovery/objects/hash.bin';
  assert.doesNotThrow(() => assertArchiveLifecycle({ Rules: [] }, path));
  assert.doesNotThrow(() =>
    assertArchiveLifecycle(
      { Rules: [{ Status: 'Enabled', Filter: { Prefix: 'articles/' }, Expiration: { Days: 7 } }] },
      path,
    ),
  );
  for (const rule of [
    { Status: 'Enabled', Filter: { Prefix: 'seo-recovery/' }, Expiration: { Days: 90 } },
    { Status: 'Enabled', Transition: { StorageClass: 'ARCHIVE' } },
    { Status: 'unknown' },
  ])
    assert.throws(() => assertArchiveLifecycle({ Rules: [rule] }, path));
});

test('large immutable archives get a bounded transfer budget without leaking error details', async () => {
  const x = setup();
  const observations = [];
  const original = x.put;
  x.put = async (credential, bytes, options) => {
    assert.equal(options.uploadTimeoutMs, 300000);
    await original(credential, bytes);
  };
  const ref = await createPrivateArchive({
    ...x,
    policy,
    onTransfer: (event) => observations.push(event),
  }).put(Buffer.alloc(9 * 1024 * 1024));
  assert.equal(ref.bytes, 9 * 1024 * 1024);
  assert.equal(observations.find((e) => e.action === 'read').outcome, 'complete');
  const y = setup();
  y.put = async () => {
    throw Object.assign(Error('https://private.example/?signature=never-log-this'), {
      code: 'NEVERLOGTHISCODE',
    });
  };
  const failures = [];
  await assert.rejects(
    createPrivateArchive({ ...y, policy, onTransfer: (event) => failures.push(event) }).put(
      Buffer.from('failed bytes'),
    ),
    /needs readback/,
  );
  assert.equal(JSON.stringify(failures).includes('never-log-this'), false);
  assert.equal(JSON.stringify(failures).includes('NEVERLOGTHISCODE'), false);
  assert.equal(failures[0].cause, 'unconfirmed');
});

test('another bucket under the same environment is rejected before any permission query', async () => {
  const x = setup();
  const original = x.sdk.getUploadMetadata;
  x.sdk.getUploadMetadata = async (input) => {
    const result = await original(input);
    result.data.fileId = result.data.fileId.replace('fixture-bucket/', 'another-bucket/');
    return result;
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes')),
    /Wrong archive bucket/,
  );
  assert.equal(x.calls.length, 0);
});
