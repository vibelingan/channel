import assert from 'node:assert/strict';
import { type RequestListener, createServer, request as httpRequest } from 'node:http';
import test, { type TestContext } from 'node:test';
import { type CloudBaseStorageSdk, createCloudBaseMediaStorage } from './cloudbase.ts';
import { MediaReadError } from './index.ts';

const fileId = 'cloud://opaque/Case%2f ID ';
async function fixture(
  t: TestContext,
  listener: RequestListener = (_req, res) => res.end(Buffer.from([1, 2, 3, 4, 5])),
) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const controls = {
    url: 'https://cos.example/%E4%B8%AD%20%E6%96%87%252F?a=%2F&signed=private-test-token',
    code: 'SUCCESS',
    returnedId: fileId,
    requests: 0,
    sdkCalls: 0,
    downloadCalls: 0,
    mintGate: null as (() => Promise<void>) | null,
    requestOptions: [] as Record<string, unknown>[],
    urlInputs: [] as unknown[],
    outgoingClosed: 0,
  };
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected storage mutation or direct download');
  };
  const sdk: CloudBaseStorageSdk = {
    uploadFile: unused,
    deleteFile: unused,
    getUploadMetadata: unused,
    downloadFile: async () => {
      controls.downloadCalls++;
      return { fileContent: Buffer.from([1, 2, 3, 4, 5]) };
    },
    getTempFileURL: async (input) => {
      controls.sdkCalls++;
      controls.urlInputs.push(structuredClone(input));
      await controls.mintGate?.();
      return {
        fileList: [{ fileID: controls.returnedId, code: controls.code, tempFileURL: controls.url }],
      };
    },
  };
  const storage = createCloudBaseMediaStorage(sdk, {
    downloadRequest: (url, options, callback) => {
      controls.requests++;
      controls.requestOptions.push({
        method: options.method,
        headers: options.headers,
        url: url.href,
      });
      const outgoing = httpRequest(
        { hostname: '127.0.0.1', port: address.port, path: url.pathname + url.search, ...options },
        callback,
      );
      outgoing.on('close', () => controls.outgoingClosed++);
      return outgoing;
    },
  });
  const read = (timeoutMs = 1000, maxBytes = 5) =>
    storage.getObjectAsBase64(fileId, { maxBytes, timeoutMs });
  return { storage, controls, read, server };
}
test('bounded CloudBase reading uses exact COS_URL, one raw GET and actual bytes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), { body: 'AQIDBAU=', byteSize: 5 });
  assert.deepEqual(f.controls.urlInputs, [
    { fileList: [{ fileID: fileId, maxAge: 60, urlType: 'COS_URL' }] },
  ]);
  assert.deepEqual(f.controls.requestOptions, [
    { method: 'GET', headers: undefined, url: f.controls.url },
  ]);
  assert.equal(f.controls.downloadCalls, 0);
});
test('legacy callers without limits keep the existing SDK download contract', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.storage.getObjectAsBase64(fileId), { body: 'AQIDBAU=', byteSize: 5 });
  assert.equal(f.controls.downloadCalls, 1);
  assert.equal(f.controls.sdkCalls, 0);
  assert.equal(f.controls.requests, 0);
});
test('a real streamed oversized body is stopped at the cap', async (t) => {
  let closed = false;
  const f = await fixture(t, (_req, res) => {
    const timer = setInterval(() => res.write(Buffer.alloc(4)), 5);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });
  await assert.rejects(
    f.read(),
    (error) => error instanceof MediaReadError && error.reason === 'too-large',
  );
  for (let i = 0; i < 50 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(closed);
});
for (const stage of ['headers', 'body'] as const)
  test(`a real ${stage} stall reaches the total deadline and closes its connection`, async (t) => {
    let closed = false;
    const f = await fixture(t, (_req, res) => {
      if (stage === 'body') {
        res.writeHead(200);
        res.write(Buffer.alloc(1));
      }
      res.on('close', () => {
        closed = true;
      });
    });
    await assert.rejects(
      f.read(60),
      (error) => error instanceof MediaReadError && error.reason === 'timeout',
    );
    for (let i = 0; i < 100 && !closed; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(closed);
    assert.equal(f.controls.requests, 1);
  });
test('a mint finishing after the deadline cannot start a late GET', async (t) => {
  const f = await fixture(t);
  let release: (() => void) | undefined;
  f.controls.mintGate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await assert.rejects(
    f.read(30),
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.ok(release);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.controls.requests, 0);
});
for (const patch of [
  { returnedId: 'cloud://foreign' },
  { code: 'FAILED' },
  { code: '' },
  { url: 'http://cos.example/file' },
  { url: 'https://user:password@cos.example/file' },
  { url: 'https://cos.example/file#fragment' },
  { url: 'file:///private/file' },
  { url: 'not a URL' },
])
  test(`a bad SDK target cannot start a request: ${JSON.stringify(patch)}`, async (t) => {
    const f = await fixture(t);
    Object.assign(f.controls, patch);
    await assert.rejects(
      f.read(),
      (error) =>
        error instanceof MediaReadError &&
        error.reason === 'unavailable' &&
        !String(error).includes('private-test-token'),
    );
    assert.equal(f.controls.requests, 0);
  });
for (const status of [206, 301, 302, 403, 404, 500])
  test(`HTTP ${status} is not accepted as a complete COS object`, async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status, { location: 'https://other.example/private' });
      res.end('failure');
    });
    await assert.rejects(
      f.read(),
      (error) => error instanceof MediaReadError && error.reason === 'unavailable',
    );
    assert.equal(f.controls.requests, 1);
  });
test('a complete oversized response is rejected by actual bytes', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(6));
  });
  await assert.rejects(
    f.read(),
    (error) => error instanceof MediaReadError && error.reason === 'too-large',
  );
});
test('native request failures are redacted', async (t) => {
  const f = await fixture(t);
  const sdk: CloudBaseStorageSdk = {
    uploadFile: async () => {
      throw Error('unused');
    },
    deleteFile: async () => {
      throw Error('unused');
    },
    getUploadMetadata: async () => {
      throw Error('unused');
    },
    downloadFile: async () => {
      throw Error('unused');
    },
    getTempFileURL: async () => ({
      fileList: [{ fileID: fileId, code: 'SUCCESS', tempFileURL: f.controls.url }],
    }),
  };
  const storage = createCloudBaseMediaStorage(sdk, {
    downloadRequest: () => {
      throw Error(f.controls.url);
    },
  });
  await assert.rejects(
    storage.getObjectAsBase64(fileId, { maxBytes: 5, timeoutMs: 1000 }),
    (error) =>
      error instanceof MediaReadError &&
      error.reason === 'unavailable' &&
      !String(error).includes('signed='),
  );
});

test('a native body connection failure remains unavailable after error cleanup is attached', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(1));
    setImmediate(() => res.destroy());
  });
  await assert.rejects(
    f.read(),
    (error) => error instanceof MediaReadError && error.reason === 'unavailable',
  );
});

test('repeated completed reads preserve native connection cleanup without accumulating abort failures', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) assert.deepEqual(await f.read(), { body: 'AQIDBAU=', byteSize: 5 });
  assert.equal(f.controls.requests, 20);
});

for (const status of [200, 500])
  test(`repeated rejected responses do not leave busy native sockets: ${status}`, async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status);
      res.end(Buffer.alloc(6));
    });
    for (let i = 0; i < 20; i++) await assert.rejects(f.read());
    let connections = 100;
    for (let i = 0; i < 50 && connections > 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      connections = await new Promise<number>((resolve, reject) =>
        f.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
    }
    assert.ok(connections <= 1, `rejected responses retained ${connections} busy sockets`);
  });
