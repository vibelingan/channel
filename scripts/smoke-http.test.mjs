import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { decodeUtf8, fetchFully } from './smoke-http.mjs';

const TEST_WATCHDOG_MS = 1_000;

async function withWatchdog(promise, label) {
  let watchdog;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`${label} exceeded ${TEST_WATCHDOG_MS}ms test watchdog`)),
          TEST_WATCHDOG_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

test('fetchFully drains the complete response body', { timeout: 2_000 }, async () => {
  const payload = Buffer.alloc(256 * 1024, 0x61);

  await withServer(
    (_request, response) => {
      response.writeHead(200, {
        'content-length': String(payload.byteLength),
        'content-type': 'application/octet-stream',
      });
      response.end(payload);
    },
    async (origin) => {
      const result = await fetchFully('GET', `${origin}/large-response`, { timeoutMs: 2_000 });

      assert.equal(result.status, 200);
      assert.equal(result.body.byteLength, payload.byteLength);
      assert.deepEqual(result.body, payload);
    },
  );
});

test('fetchFully aborts before response headers arrive', { timeout: 2_000 }, async () => {
  await withServer(
    () => {},
    async (origin) => {
      const url = `${origin}/stalled-headers`;

      await assert.rejects(
        withWatchdog(fetchFully('GET', url, { timeoutMs: 100 }), 'stalled-header request'),
        (error) => error instanceof Error && error.message === `GET ${url} timed out after 100ms`,
      );
    },
  );
});

test('fetchFully aborts a response body that does not finish', { timeout: 2_000 }, async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial response');
    },
    async (origin) => {
      const url = `${origin}/stalled-response`;

      await assert.rejects(
        withWatchdog(fetchFully('GET', url, { timeoutMs: 100 }), 'stalled-body request'),
        (error) => error instanceof Error && error.message === `GET ${url} timed out after 100ms`,
      );
    },
  );
});

test('fetchFully cancels a response that exceeds the byte limit', { timeout: 2_000 }, async () => {
  let markConnectionClosed;
  const connectionClosed = new Promise((resolve) => {
    markConnectionClosed = resolve;
  });

  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(32 * 1024, 0x61);
      response.write(chunk);
      const stream = setInterval(() => response.write(chunk), 5);
      response.once('close', () => {
        clearInterval(stream);
        markConnectionClosed();
      });
    },
    async (origin) => {
      const url = `${origin}/oversized-response`;

      await assert.rejects(
        withWatchdog(fetchFully('GET', url, { maxBytes: 64 * 1024 }), 'oversized request'),
        (error) =>
          error instanceof Error &&
          error.message === `GET ${url} exceeded ${64 * 1024}-byte response limit`,
      );
      await withWatchdog(connectionClosed, 'oversized response transport cancellation');
    },
  );
});

test('decodeUtf8 strips a leading UTF-8 byte-order mark', () => {
  const encoded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]);
  assert.deepEqual(JSON.parse(decodeUtf8(encoded)), { ok: true });
});
