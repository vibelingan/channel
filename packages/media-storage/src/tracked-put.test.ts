import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import {
  type IncomingMessage,
  type RequestOptions,
  createServer,
  request as httpRequest,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { type CloudBaseStorageSdk, createCloudBaseMediaStorage } from './cloudbase.ts';
import type { StoredMediaObject } from './index.ts';
import { LocalDiskMediaStorage } from './local-disk.ts';

const input = {
  namespace: 'catalog',
  logicalId: 'tracked',
  fileName: 'a.png',
  mimeType: 'image/png',
  content: Buffer.from('actual raw bytes'),
} as const;
async function wire(t: TestContext, status = 200, responseBody = '') {
  const received: {
    method: string | undefined;
    headers: IncomingMessage['headers'];
    body: Buffer;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (status === 0) return;
    res.writeHead(status, status === 302 ? { location: '/redirect' } : {});
    res.end(responseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `https://127.0.0.1:${address.port}/object`;
  let startedRequests = 0;
  const request = (url: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
    startedRequests++;
    const local = new URL(url);
    local.protocol = 'http:';
    return httpRequest(local, options, callback);
  };
  let minted = 0;
  let nativeUploads = 0;
  const sdk: CloudBaseStorageSdk = {
    async uploadFile() {
      nativeUploads++;
      throw new Error('tracked PUT must not remint in uploadFile');
    },
    async getUploadMetadata({ cloudPath }) {
      minted++;
      return {
        data: {
          url,
          authorization: 'signature',
          token: 'sts',
          cosFileId: 'cos-id',
          fileId: `cloud://env.bucket/${cloudPath}`,
        },
      };
    },
    async downloadFile() {
      return { fileContent: undefined };
    },
    async getTempFileURL() {
      return { fileList: [] };
    },
    async deleteFile() {
      return { fileList: [] };
    },
  };
  const store = createCloudBaseMediaStorage(sdk, { request, uploadTimeoutMs: 1000 });
  return {
    store,
    received,
    sdk,
    request,
    counts: () => ({ minted, nativeUploads }),
    startedRequests: () => startedRequests,
  };
}
test('local tracked PUT checkpoints exact permanent target before any bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-tracked-put-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalDiskMediaStorage(directory);
  let checkpoint: StoredMediaObject | undefined;
  const stored = await store.putObject(input, {
    beforeWrite: async (target) => {
      checkpoint = target;
      await assert.rejects(stat(join(directory, target.storagePath)), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(checkpoint?.storageFileId, stored.storageFileId);
  assert.equal(
    (await store.getObjectAsBase64(stored.storageFileId)).body,
    input.content.toString('base64'),
  );
});
test('local rejected checkpoint prevents bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-tracked-put-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalDiskMediaStorage(directory);
  let checkpoint: StoredMediaObject | undefined;
  await assert.rejects(
    store.putObject(input, {
      beforeWrite: async (target) => {
        checkpoint = target;
        throw new Error('checkpoint unavailable');
      },
    }),
    /checkpoint unavailable/,
  );
  assert.ok(checkpoint);
  await assert.rejects(store.getObjectAsBase64(checkpoint.storageFileId), { code: 'ENOENT' });
});
test('cloud tracked PUT mints once, checkpoints first, and sends actual raw bytes and SDK headers', async (t) => {
  const f = await wire(t);
  let checkpoint: StoredMediaObject | undefined;
  const stored = await f.store.putObject(input, {
    beforeWrite: async (target) => {
      checkpoint = target;
      assert.equal(f.received.length, 0);
    },
  });
  assert.deepEqual(checkpoint, stored);
  assert.deepEqual(f.counts(), { minted: 1, nativeUploads: 0 });
  assert.equal(f.received.length, 1);
  const request = f.received[0];
  assert.ok(request);
  assert.equal(request.method, 'PUT');
  assert.deepEqual(request.body, input.content);
  assert.equal(request.headers.signature, 'signature');
  assert.equal(request.headers.authorization, 'signature');
  assert.equal(request.headers['x-cos-security-token'], 'sts');
  assert.equal(request.headers['x-cos-meta-fileid'], 'cos-id');
  assert.equal(request.headers.key, encodeURIComponent(stored.storagePath));
  assert.ok(!String(request.headers['content-type']).includes('multipart'));
});
test('cloud rejected checkpoint sends no bytes', async (t) => {
  const f = await wire(t);
  await assert.rejects(
    f.store.putObject(input, {
      beforeWrite: async () => {
        throw new Error('not durable');
      },
    }),
    /not durable/,
  );
  assert.equal(f.received.length, 0);
  assert.deepEqual(f.counts(), { minted: 1, nativeUploads: 0 });
});
for (const [status, body] of [
  [503, 'unavailable'],
  [503, ''],
  [302, ''],
  [200, '<Error><Code>SignatureDoesNotMatch</Code></Error>'],
  [204, ''],
] as const) {
  test(`cloud tracked PUT rejects unconfirmed response ${status}/${body.length}`, async (t) => {
    const f = await wire(t, status, body);
    let checkpoint: StoredMediaObject | undefined;
    await assert.rejects(
      f.store.putObject(input, {
        beforeWrite: async (target) => {
          checkpoint = target;
        },
      }),
    );
    assert.ok(checkpoint);
    assert.equal(f.received.length, 1, 'no redirect or automatic byte retry');
  });
}
test('cloud tracked PUT bounds a stalled acknowledgement and preserves checkpoint', async (t) => {
  const f = await wire(t, 0);
  const store = createCloudBaseMediaStorage(f.sdk, { request: f.request, uploadTimeoutMs: 50 });
  let checkpoint: StoredMediaObject | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        store.putObject(input, {
          beforeWrite: async (target) => {
            checkpoint = target;
          },
        }),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('upload deadline missing')), 500);
        }),
      ]),
      /timed out/,
    );
  } finally {
    clearTimeout(watchdog);
  }
  assert.ok(checkpoint);
});
test('cloud generic readable stream uses raw PUT rather than an unsupported SDK input', async (t) => {
  const f = await wire(t);
  const stored = await f.store.putObject({
    ...input,
    content: Readable.from([Buffer.from('streamed')]),
  });
  assert.equal(stored.byteSize, undefined);
  assert.deepEqual(f.received[0]?.body, Buffer.from('streamed'));
  assert.equal(f.counts().nativeUploads, 0);
});

for (const uploadUrl of [
  'http://127.0.0.1/object',
  'https://user:secret@example.test/object',
  'https://example.test/object#fragment',
]) {
  test(`cloud tracked PUT rejects an invalid minted target before checkpoint (${new URL(uploadUrl).protocol}/${new URL(uploadUrl).hash.length})`, async (t) => {
    const f = await wire(t);
    f.sdk.getUploadMetadata = async () => ({
      data: {
        url: uploadUrl,
        authorization: 'signature',
        token: 'sts',
        cosFileId: 'cos',
        fileId: 'cloud://env.bucket/object',
      },
    });
    let checkpoints = 0;
    await assert.rejects(
      f.store.putObject(input, {
        beforeWrite: async () => {
          checkpoints++;
        },
      }),
      /invalid upload target/,
    );
    assert.equal(checkpoints, 0);
    assert.equal(f.received.length, 0);
  });
}
test('cloud synchronous request error is consumed and leaves its durable target', async (t) => {
  const f = await wire(t);
  const store = createCloudBaseMediaStorage(f.sdk, {
    request: () => {
      throw new Error('request construction failed');
    },
  });
  let checkpoint: StoredMediaObject | undefined;
  await assert.rejects(
    store.putObject(input, {
      beforeWrite: async (target) => {
        checkpoint = target;
      },
    }),
    /request construction failed/,
  );
  assert.ok(checkpoint);
});
test('cloud source-stream failure rejects the PUT and retains its checkpoint', async (t) => {
  const f = await wire(t);
  const stream = new Readable({
    read() {
      this.destroy(new Error('source failed'));
    },
  });
  let checkpoint: StoredMediaObject | undefined;
  await assert.rejects(
    f.store.putObject(
      { ...input, content: stream },
      {
        beforeWrite: async (target) => {
          checkpoint = target;
        },
      },
    ),
    /source failed/,
  );
  assert.ok(checkpoint);
});

test('cloud checkpoint must finish before constructing the byte request', async (t) => {
  const f = await wire(t);
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkpointStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const upload = f.store.putObject(input, {
    beforeWrite: async () => {
      entered();
      await blocked;
    },
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  void upload.catch(() => {});
  try {
    await Promise.race([
      checkpointStarted,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('checkpoint was never called')), 500);
      }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.startedRequests(), 0);
  } finally {
    clearTimeout(watchdog);
    release();
    await upload;
  }
  assert.equal(f.startedRequests(), 1);
});
