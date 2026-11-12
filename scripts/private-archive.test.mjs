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

test('known archive integrity failures retain only their fixed diagnostic labels', async () => {
  for (const code of [
    'ARCHIVE_SOURCE_MISMATCH',
    'ARCHIVE_PROGRESS_INVALID',
    'ARCHIVE_SOURCE_CHANGED',
    'ARCHIVE_LOCAL_SIZE_MISMATCH',
  ]) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes'));
    const observations = [];
    x.read = async () => {
      throw Object.assign(Error('https://private.example/?signature=never-log-this'), { code });
    };
    await assert.rejects(
      createPrivateArchive({ ...x, policy, onTransfer: (event) => observations.push(event) }).get(
        ref,
      ),
    );
    assert.equal(observations[0].cause, code);
    assert.equal(observations[0].outcome, 'unconfirmed');
    assert.equal(JSON.stringify(observations).includes('never-log-this'), false);
  }
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

test('a large interrupted upload resumes once only after the exact object is confirmed absent', async () => {
  const x = setup();
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  const send = x.put;
  let writes = 0;
  let clock = 0;
  const attempts = [];
  const events = [];
  x.read = async (_sdk, id, options) => {
    if (!x.objects.has(id)) {
      assert.equal(writes, 1);
      assert.equal(options.timeoutMs, 300000);
      clock += 500;
      throw Object.assign(Error('private URL must not escape'), {
        statusCode: 404,
        code: 'ARCHIVE_OBJECT_NOT_FOUND',
      });
    }
    return Buffer.from(x.objects.get(id));
  };
  x.put = async (credential, input, options) => {
    writes++;
    attempts.push({ credential, input, options });
    if (writes === 1) throw Object.assign(Error('deadline'), { code: 'ETIMEDOUT' });
    await send(credential, input);
  };
  const ref = await createPrivateArchive({
    ...x,
    policy,
    now: () => clock,
    onTransfer: (event) => events.push(event),
  }).put(bytes);
  assert.equal(writes, 2);
  assert.equal(attempts[0].options.uploadTimeoutMs, 300000);
  assert.equal(attempts[1].options.uploadTimeoutMs, 239500);
  assert.equal(attempts[0].credential, attempts[1].credential);
  assert.equal(attempts[0].input, attempts[1].input);
  assert.deepEqual(x.objects.get(ref.fileID), bytes);
  assert.equal(events.filter((event) => event.action === 'resume').length, 1);
});

test('a continuation never loops and can resolve its own lost reply with exact readback', async () => {
  for (const completed of [false, true]) {
    const x = setup();
    const send = x.put;
    let writes = 0;
    x.read = async (_sdk, id) => {
      if (!x.objects.has(id))
        throw Object.assign(Error('absent'), { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' });
      return Buffer.from(x.objects.get(id));
    };
    x.put = async (...args) => {
      writes++;
      if (completed && writes === 2) await send(...args);
      throw Object.assign(Error('lost reply'), { code: 'ECONNRESET' });
    };
    const operation = createPrivateArchive({ ...x, policy }).put(Buffer.alloc(9 * 1024 * 1024));
    if (completed) await operation;
    else await assert.rejects(operation, /needs readback/);
    assert.equal(writes, 2);
  }
});

test('connected socket timeouts can resume after absent-object readback, including incomplete HTTP 200 responses', async () => {
  for (const statusCode of [undefined, 200]) {
    const x = setup();
    const send = x.put;
    const events = [];
    let writes = 0;
    x.put = async (...args) => {
      if (++writes === 1)
        throw Object.assign(Error('private signed URL must not escape'), {
          code: 'ESOCKETTIMEDOUT',
          ...(statusCode === undefined ? {} : { statusCode }),
        });
      return send(...args);
    };
    x.read = async (_sdk, id) => {
      if (!x.objects.has(id))
        throw Object.assign(Error('absent'), { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' });
      return Buffer.from(x.objects.get(id));
    };
    const bytes = Buffer.alloc(9 * 1024 * 1024, 17);
    const ref = await createPrivateArchive({
      ...x,
      policy,
      onTransfer: (event) => events.push(event),
    }).put(bytes);
    assert.equal(writes, 2);
    assert.deepEqual(x.objects.get(ref.fileID), bytes);
    assert.equal(events.find((event) => event.action === 'put').cause, 'ESOCKETTIMEDOUT');
    assert.equal(events.filter((event) => event.action === 'resume').length, 1);
    assert.equal(JSON.stringify(events).includes('private signed URL'), false);
  }
});

test('permission failures, unknown errors, small files and unconfirmed reads cannot start a continuation', async () => {
  for (const scenario of [
    {
      upload: { statusCode: 403 },
      read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' },
    },
    {
      upload: { statusCode: 400 },
      read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' },
    },
    ...[301, 400, 403, 429].map((statusCode) => ({
      upload: { code: 'ESOCKETTIMEDOUT', statusCode },
      read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' },
    })),
    { upload: { statusCode: 200 }, read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' } },
    { upload: {}, read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' } },
    { upload: { code: 'ETIMEDOUT' }, read: { statusCode: 503 } },
    { upload: { code: 'ETIMEDOUT' }, read: { code: 'ETIMEDOUT' } },
    { upload: { code: 'ETIMEDOUT' }, read: { statusCode: 403 } },
    { upload: { code: 'ETIMEDOUT' }, read: { statusCode: 404 } },
    {
      upload: { code: 'ETIMEDOUT' },
      read: { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' },
      small: true,
    },
    { upload: { code: 'ETIMEDOUT' }, corrupt: true },
  ]) {
    const x = setup();
    const bytes = Buffer.alloc(scenario.small ? 10 : 9 * 1024 * 1024);
    let writes = 0;
    x.put = async () => {
      writes++;
      throw Object.assign(Error('private URL must not escape'), scenario.upload);
    };
    x.read = async () => {
      if (scenario.corrupt) return Buffer.alloc(bytes.length, 1);
      throw Object.assign(Error('private URL must not escape'), scenario.read);
    };
    await assert.rejects(createPrivateArchive({ ...x, policy }).put(bytes), /needs readback/);
    assert.equal(writes, 1, JSON.stringify(scenario));
  }
});

test('continuation budget includes readback and renewed ACL checks', async () => {
  const x = setup();
  let clock = 0;
  let writes = 0;
  x.put = async () => {
    writes++;
    throw Object.assign(Error('deadline'), { code: 'ETIMEDOUT' });
  };
  x.read = async () => {
    clock = 300001;
    throw Object.assign(Error('absent'), { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' });
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy, now: () => clock }).put(Buffer.alloc(9 * 1024 * 1024)),
    /needs readback/,
  );
  assert.equal(writes, 1);
});

test('the private archive owns a fixed byte copy across asynchronous upload continuation', async () => {
  const x = setup();
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  const original = Buffer.from(bytes);
  const send = x.put;
  let writes = 0;
  x.put = async (...args) => {
    writes++;
    assert.deepEqual(args[1], original);
    if (writes === 1) {
      bytes.fill(9);
      throw Object.assign(Error('temporary unavailable'), { statusCode: 503 });
    }
    await send(...args);
  };
  x.read = async (_sdk, id) => {
    if (!x.objects.has(id))
      throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
    return Buffer.from(x.objects.get(id));
  };
  const ref = await createPrivateArchive({ ...x, policy }).put(bytes);
  assert.equal(writes, 2);
  assert.deepEqual(x.objects.get(ref.fileID), original);
});

test('late permission checks cannot outlive the continuation budget or start another upload', async () => {
  const x = setup();
  let clock = 0;
  let writes = 0;
  let permissions = 0;
  let finishPolicy;
  const permission = x.manager.permission.describeResourcePermission;
  x.manager.permission.describeResourcePermission = async (input) => {
    permissions++;
    if (permissions >= 3)
      await new Promise((resolve) => {
        finishPolicy = resolve;
      });
    return permission(input);
  };
  x.put = async () => {
    writes++;
    throw Object.assign(Error('deadline'), { code: 'ETIMEDOUT' });
  };
  x.read = async () => {
    clock = 299995;
    throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy, now: () => clock }).put(Buffer.alloc(9 * 1024 * 1024)),
    /needs readback/,
  );
  finishPolicy?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
});

test('changed transport bytes cannot be written again under the original content hash', async () => {
  const x = setup();
  let writes = 0;
  x.put = async (_credential, bytes) => {
    writes++;
    bytes[0] = 7;
    throw Object.assign(Error('deadline'), { code: 'ETIMEDOUT' });
  };
  x.read = async () => {
    throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy }).put(Buffer.alloc(9 * 1024 * 1024)),
    /needs readback/,
  );
  assert.equal(writes, 1);
});

for (const changedPolicy of ['permission', 'lifecycle'])
  test(`a ${changedPolicy} change after confirmed absence prevents the continuation upload`, async () => {
    const x = setup();
    const events = [];
    const observations = [];
    let absent = false;
    let writes = 0;
    let reads = 0;
    const permission = x.manager.permission.describeResourcePermission;
    x.manager.permission.describeResourcePermission = async (input) => {
      events.push(absent ? 'permission-after-absence' : 'permission-before-absence');
      if (absent && changedPolicy === 'permission')
        return {
          Data: {
            PermissionList: [
              { Resource: policy.archiveBucket, ResourceType: 'storage', Permission: 'PUBLICREAD' },
            ],
          },
        };
      return permission(input);
    };
    x.readLifecycle = async () => {
      events.push(absent ? 'lifecycle-after-absence' : 'lifecycle-before-absence');
      return {
        Rules:
          absent && changedPolicy === 'lifecycle'
            ? [{ Status: 'Enabled', Filter: { Prefix: 'seo-recovery/' }, Expiration: { Days: 1 } }]
            : [],
      };
    };
    x.put = async () => {
      writes++;
      events.push('first-upload');
      throw Object.assign(Error('temporary interruption'), { code: 'ETIMEDOUT' });
    };
    x.read = async () => {
      reads++;
      absent = true;
      events.push('confirmed-absent');
      throw Object.assign(Error('exact object missing'), {
        statusCode: 404,
        code: 'ARCHIVE_OBJECT_NOT_FOUND',
      });
    };
    await assert.rejects(
      createPrivateArchive({ ...x, policy, onTransfer: (event) => observations.push(event) }).put(
        Buffer.alloc(9 * 1024 * 1024),
      ),
      /needs readback/,
    );
    assert.equal(writes, 1, 'A changed storage policy must stop before the second put');
    assert.equal(reads, 1, 'A policy failure must stop before another byte read');
    assert.equal(
      observations.some((event) => event.action === 'resume'),
      false,
    );
    const missing = events.indexOf('confirmed-absent');
    assert.ok(missing > events.indexOf('first-upload'));
    assert.ok(
      events.indexOf(`${changedPolicy}-after-absence`) > missing,
      'The new policy must be checked after the exact missing-object confirmation',
    );
  });

test('a progressing large continuation has time beyond two minutes and reserves exact readback', async () => {
  const x = setup();
  let clock = 0;
  let writes = 0;
  const send = x.put;
  x.put = async (credential, bytes, options) => {
    if (++writes === 1) throw Object.assign(Error('socket timeout'), { code: 'ESOCKETTIMEDOUT' });
    assert.equal(options.uploadTimeoutMs, 240000);
    clock = 180000;
    await send(credential, bytes);
  };
  x.read = async (_sdk, id, options) => {
    if (!x.objects.has(id))
      throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
    assert.equal(options.timeoutMs, 120000);
    return Buffer.from(x.objects.get(id));
  };
  const ref = await createPrivateArchive({ ...x, policy, now: () => clock }).put(
    Buffer.alloc(9 * 1024 * 1024, 3),
  );
  assert.equal(writes, 2);
  assert.equal(x.objects.get(ref.fileID).length, ref.bytes);
});

test('a stalled continuation cannot consume the time reserved for verifying its lost reply', async () => {
  const x = setup();
  let clock = 0;
  let writes = 0;
  let finishUpload;
  const send = x.put;
  x.put = async (credential, bytes, options) => {
    if (++writes === 1) throw Object.assign(Error('socket timeout'), { code: 'ESOCKETTIMEDOUT' });
    assert.equal(options.uploadTimeoutMs, 5);
    await send(credential, bytes);
    await new Promise((resolve) => {
      finishUpload = resolve;
    });
  };
  x.read = async (_sdk, id, options) => {
    if (!x.objects.has(id)) {
      clock = 239995;
      throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
    }
    assert.equal(options.timeoutMs, 60005);
    return Buffer.from(x.objects.get(id));
  };
  const ref = await createPrivateArchive({ ...x, policy, now: () => clock }).put(
    Buffer.alloc(9 * 1024 * 1024, 4),
  );
  finishUpload();
  assert.equal(writes, 2);
  assert.equal(x.objects.get(ref.fileID).length, ref.bytes);
});

test('insufficient continuation time never starts another upload', async () => {
  const x = setup();
  let clock = 0;
  let writes = 0;
  x.put = async () => {
    writes++;
    throw Object.assign(Error('socket timeout'), { code: 'ESOCKETTIMEDOUT' });
  };
  x.read = async () => {
    clock = 240001;
    throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
  };
  await assert.rejects(
    createPrivateArchive({ ...x, policy, now: () => clock }).put(Buffer.alloc(9 * 1024 * 1024)),
    /needs readback/,
  );
  assert.equal(writes, 1);
});

test('successful continuation readback is still bounded and verifies every byte', async () => {
  for (const failure of ['late', 'length', 'hash']) {
    const x = setup();
    let clock = 0;
    let writes = 0;
    let finalReadBudget;
    const send = x.put;
    x.put = async (...args) => {
      if (++writes === 1) throw Object.assign(Error('socket timeout'), { code: 'ESOCKETTIMEDOUT' });
      await send(...args);
      clock = 180000;
    };
    x.read = async (_sdk, id, options) => {
      if (!x.objects.has(id))
        throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
      finalReadBudget = options.timeoutMs;
      const value = Buffer.from(x.objects.get(id));
      if (failure === 'late') clock = 300001;
      if (failure === 'length') return value.subarray(1);
      if (failure === 'hash') value[0] ^= 1;
      return value;
    };
    await assert.rejects(
      createPrivateArchive({ ...x, policy, now: () => clock }).put(Buffer.alloc(9 * 1024 * 1024)),
      /needs readback/,
    );
    assert.equal(writes, 2);
    assert.equal(finalReadBudget, 120000);
  }
});

test('an interrupted archive read retries once with fresh policy checks and safe per-attempt diagnostics', async () => {
  const x = setup();
  const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('verified bytes'));
  const events = [];
  const read = x.read;
  let reads = 0;
  let lifecycleChecks = 0;
  x.calls.length = 0;
  x.readLifecycle = async () => {
    lifecycleChecks++;
    return { Rules: [] };
  };
  x.read = async (...args) => {
    reads++;
    if (reads === 1)
      throw Object.assign(Error('https://private.example/?signature=NEVER_LOG_THIS'), {
        code: 'ECONNRESET',
      });
    return read(...args);
  };
  const bytes = await createPrivateArchive({
    ...x,
    policy,
    onTransfer: (event) => events.push(event),
  }).get(ref);
  assert.equal(bytes.toString(), 'verified bytes');
  assert.equal(reads, 2);
  assert.equal(x.calls.filter((call) => call[0] === 'permission').length, 2);
  assert.equal(lifecycleChecks, 2);
  assert.deepEqual(
    events.map((event) => [event.action, event.outcome, event.cause]),
    [
      ['read', 'unconfirmed', 'ECONNRESET'],
      ['read', 'complete', undefined],
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /signature|NEVER_LOG_THIS|private\.example/);
});

test('transient network and server read failures stop after two complete attempts', async () => {
  for (const fault of [{ code: 'ECONNRESET' }, { statusCode: 503 }]) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes'));
    let reads = 0;
    x.read = async () => {
      reads++;
      throw Object.assign(Error('PRIVATE_READ_ERROR'), fault);
    };
    await assert.rejects(createPrivateArchive({ ...x, policy }).get(ref));
    assert.equal(reads, 2);
  }
});

test('client errors, unknown failures and byte mismatches never retry an archive read', async () => {
  for (const fault of [
    { statusCode: 403, code: 'ECONNRESET' },
    { statusCode: 404, code: 'ARCHIVE_OBJECT_NOT_FOUND' },
    { statusCode: 429 },
    {},
    { code: 'ARCHIVE_SOURCE_CHANGED' },
    'not-buffer',
    'length',
    'hash',
  ]) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes'));
    let reads = 0;
    x.read = async () => {
      reads++;
      if (fault === 'not-buffer') return 'bytes';
      if (fault === 'length') return Buffer.from('shorter');
      if (fault === 'hash') return Buffer.from('other');
      throw Object.assign(Error('PRIVATE_READ_ERROR'), fault);
    };
    await assert.rejects(createPrivateArchive({ ...x, policy }).get(ref));
    assert.equal(reads, 1, JSON.stringify(fault));
  }
});

test('initial and changed ACL or lifecycle failures never enter another network read', async () => {
  for (const failure of ['acl-network', 'lifecycle-network', 'changed-acl', 'changed-lifecycle']) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes'));
    let reads = 0;
    let permissions = 0;
    const permission = x.manager.permission.describeResourcePermission;
    x.manager.permission.describeResourcePermission = async (input) => {
      permissions++;
      if (failure === 'acl-network')
        throw Object.assign(Error('PRIVATE_POLICY_ERROR'), { code: 'ECONNRESET' });
      const result = await permission(input);
      if (failure === 'changed-acl' && reads === 1)
        result.Data.PermissionList[0].Permission = 'PUBLICREAD';
      return result;
    };
    x.readLifecycle = async () => {
      if (failure === 'lifecycle-network')
        throw Object.assign(Error('PRIVATE_POLICY_ERROR'), { code: 'ECONNRESET' });
      return {
        Rules:
          failure === 'changed-lifecycle' && reads === 1
            ? [{ Status: 'Enabled', Prefix: 'seo-recovery/', Expiration: { Days: 1 } }]
            : [],
      };
    };
    x.read = async () => {
      reads++;
      throw Object.assign(Error('PRIVATE_READ_ERROR'), { code: 'ECONNRESET' });
    };
    await assert.rejects(createPrivateArchive({ ...x, policy }).get(ref));
    const changed = failure.startsWith('changed-');
    assert.equal(reads, changed ? 1 : 0, failure);
    assert.equal(permissions, changed ? 2 : 1, failure);
  }
});

test('both read attempts share one size budget including repeated policy checks', async () => {
  for (const size of [5, 9 * 1024 * 1024]) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.alloc(size));
    let clock = 0;
    const budgets = [];
    const permission = x.manager.permission.describeResourcePermission;
    x.manager.permission.describeResourcePermission = async (input) => {
      clock += 1000;
      return permission(input);
    };
    x.readLifecycle = async () => {
      clock += 1000;
      return { Rules: [] };
    };
    x.read = async (_sdk, id, options) => {
      budgets.push(options.timeoutMs);
      if (budgets.length === 1) {
        clock += 10000;
        throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
      }
      return Buffer.from(x.objects.get(id));
    };
    assert.equal(
      (await createPrivateArchive({ ...x, policy, now: () => clock }).get(ref)).length,
      size,
    );
    assert.deepEqual(budgets, size === 5 ? [58000, 46000] : [298000, 286000]);
  }
});

test('an exhausted initial or retry read deadline cannot issue another GET', async () => {
  for (const exhaustedBeforeRead of [true, false]) {
    const x = setup();
    const ref = await createPrivateArchive({ ...x, policy }).put(Buffer.from('bytes'));
    let clock = 0;
    let reads = 0;
    x.read = async () => {
      reads++;
      clock = 60000;
      throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
    };
    await assert.rejects(
      createPrivateArchive({ ...x, policy, now: () => clock }).get(
        ref,
        exhaustedBeforeRead ? 0 : undefined,
      ),
      { code: 'ETIMEDOUT' },
    );
    assert.equal(reads, exhaustedBeforeRead ? 0 : 1);
  }
});

test('read retries during upload continuation cannot extend its original deadline', async () => {
  for (const exhausted of [false, true]) {
    const x = setup();
    let clock = 0;
    let writes = 0;
    let presentReads = 0;
    const budgets = [];
    const send = x.put;
    x.put = async (...args) => {
      if (++writes === 1) throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
      clock = 240000;
      return send(...args);
    };
    x.read = async (_sdk, id, options) => {
      budgets.push(options.timeoutMs);
      if (!x.objects.has(id))
        throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND', statusCode: 404 });
      if (++presentReads === 1) {
        clock = exhausted ? 300001 : 290000;
        throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
      }
      return Buffer.from(x.objects.get(id));
    };
    const attempt = createPrivateArchive({ ...x, policy, now: () => clock }).put(
      Buffer.alloc(9 * 1024 * 1024),
    );
    if (exhausted) await assert.rejects(attempt, /needs readback/);
    else assert.equal((await attempt).bytes, 9 * 1024 * 1024);
    assert.equal(writes, 2);
    assert.deepEqual(budgets, exhausted ? [300000, 60000] : [300000, 60000, 10000]);
    assert.equal(presentReads, exhausted ? 1 : 2);
  }
});
test('stat reads only the stored size and version, after the same bucket checks', async () => {
  const x = setup();
  const versions = new Map();
  const head = async (_sdk, id) => {
    x.calls.push(['head', id]);
    if (!x.objects.has(id))
      throw Object.assign(Error('absent'), { code: 'ARCHIVE_OBJECT_NOT_FOUND' });
    return { bytes: x.objects.get(id).length, etag: versions.get(id) ?? '"v1"' };
  };
  const archive = createPrivateArchive({ ...x, head, policy });
  const ref = await archive.put(Buffer.from('program bytes'));
  assert.deepEqual(await archive.stat(ref), { bytes: 13, etag: '"v1"' });
  versions.set(ref.fileID, '"v2"');
  assert.equal((await archive.stat(ref)).etag, '"v2"');
  x.objects.delete(ref.fileID);
  await assert.rejects(archive.stat(ref), (error) => error.code === 'ARCHIVE_OBJECT_NOT_FOUND');
  await assert.rejects(
    createPrivateArchive({ ...x, policy }).stat(ref),
    /version check unavailable/,
  );
});
test('the opt-in policy window checks the bucket once, again after the window, and never keeps a failure', async () => {
  const x = setup();
  let clock = 0;
  const archive = createPrivateArchive({ ...x, policy, now: () => clock, policyCacheMs: 600000 });
  const first = await archive.put(Buffer.from('one'));
  await archive.put(Buffer.from('two'));
  await archive.get(first);
  const checks = () => x.calls.filter((c) => c[0] === 'permission').length;
  assert.equal(checks(), 1);
  clock = 600000;
  await archive.get(first);
  assert.equal(checks(), 2);
  clock = 1200000;
  const allowed = x.manager.permission.describeResourcePermission;
  x.manager.permission.describeResourcePermission = async () => ({
    Data: {
      PermissionList: [
        { Resource: 'fixture-bucket', ResourceType: 'storage', Permission: 'PUBLICREAD' },
      ],
    },
  });
  await assert.rejects(archive.get(first), /already be private/);
  x.manager.permission.describeResourcePermission = allowed;
  await archive.get(first);
  assert.equal(checks(), 3);
  assert.throws(() => createPrivateArchive({ ...x, policy, policyCacheMs: 3600000 }), /15 minutes/);
  const always = createPrivateArchive({ ...x, policy });
  await always.get(first);
  await always.get(first);
  assert.equal(checks(), 5);
});
test('an opt-in slow-link rate sizes each deadline to its bytes, capped at 15 minutes', async () => {
  const budgets = [];
  const sized = (rate, bytes) => {
    const x = setup();
    const send = x.put;
    x.put = async (credential, body, options) => {
      budgets.push(options.uploadTimeoutMs);
      return send(credential, body, options);
    };
    return createPrivateArchive({ ...x, policy, slowLinkBytesPerSecond: rate }).put(
      Buffer.alloc(bytes, 1),
    );
  };
  await sized(0, 1024 * 1024);
  await sized(8 * 1024, 1024 * 1024);
  await sized(8 * 1024, 100);
  await sized(8 * 1024, 2 * 1024 * 1024);
  await sized(1024, 9 * 1024 * 1024);
  assert.deepEqual(budgets, [60000, 188000, 60013, 316000, 900000]);
  assert.throws(
    () => createPrivateArchive({ ...setup(), policy, slowLinkBytesPerSecond: 10 }),
    /1 KiB/,
  );
});
