import { strict as assert } from 'node:assert';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildServer } from './server.ts';

/** The default shape: a normal, non-harness service. */
const config = {
  port: 0,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ai:ai@localhost:55432/ai_assistant',
  corsAllowedOrigins: ['https://allowed.example'],
  localHarness: false,
};

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server, pool } = buildServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
}

test('liveness answers without touching the database', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('readiness proves a transaction and the isolation level, not just a connection', async () => {
  // `select 1` also succeeds against a read-only replica and against a role
  // that cannot open a transaction. LLD-001's fence needs both, so readiness
  // reports what it actually established — and the deployed environment's
  // isolation level is a property of the managed database, not of our code,
  // which is exactly why it is worth reading back from a running instance.
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/readyz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      store: 'live',
      txn: 'proven',
      isolation: 'read committed',
    });
  });
});

test('readiness reports 503, not 200, when the store is unreachable', async () => {
  const { server, pool } = buildServer({
    ...config,
    databaseUrl: 'postgres://ai:ai@127.0.0.1:1/nope',
  });
  pool.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/readyz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, store: 'unavailable' });
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});

test('readiness output carries no host, path, or credential', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/ai/readyz`)).text();
    assert.ok(!/postgres:\/\//.test(body), 'readiness leaked a connection string');
    assert.ok(!/(password|secret|token)/i.test(body), 'readiness looks credential-shaped');
  });
});

test('an allowed origin gets CORS headers; an unlisted one gets none', async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://allowed.example' },
    });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(ok.headers.get('vary'), 'origin');

    const denied = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://evil.example' },
    });
    // Not an error status — the browser enforces CORS. The server's job is to
    // withhold the header, and reflecting the origin back is the actual bug.
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('preflight is answered for an allowed origin', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`, {
      method: 'OPTIONS',
      headers: { origin: 'https://allowed.example' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });
});

test('unknown routes return the shared error envelope', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('a cross-origin caller can actually read the conversation handle', async () => {
  // Browsers hide every response header from cross-origin JavaScript except a
  // short safelist, unless the server names it in access-control-expose-headers.
  // The assistant runs on its own hostname by design, so without this the
  // website can never read x-conversation-id and every follow-up question
  // starts a brand-new conversation — while a same-origin local harness works
  // perfectly and hides the defect.
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://allowed.example' },
    });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase());
    assert.ok(
      exposed.includes('x-conversation-id'),
      'x-conversation-id is not readable by a cross-origin client',
    );
  });
});

test('an unlisted origin gets no expose-headers either', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/healthz`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.headers.get('access-control-expose-headers'), null);
  });
});

const harnessConfig = { ...config, localHarness: true };

async function withHarnessServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server, pool } = buildServer(harnessConfig, {});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
}

test('outside the harness the conversation route does not exist at all', async () => {
  // 404, not 503. Not "exists but refuses", and not "exists when an engine
  // happens to be injected" — that was the defect this closes. CORS is not a
  // control here: the request below carries no Origin, exactly like curl.
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is your MOQ?' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('outside the harness the route stays absent even with an engine injected', async () => {
  // The previous shape registered the route whenever deps.engine existed, so
  // hiding the page did nothing for the route.
  const stub = {
    capabilities: {
      engineId: 'stub',
      engineVersion: '0',
      supportsIdempotentCreate: false,
      supportsRunLookupByOperationId: false,
      supportsStop: true,
      supportsOutOfBandStop: false,
      supportsCitations: true,
    },
  };
  const { server, pool } = buildServer(config, { engine: stub as never });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 404, 'the route existed outside the harness');
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});

test('inside the harness the route exists and reports a missing engine', async () => {
  await withHarnessServer(async (base) => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'ENGINE_NOT_CONFIGURED');
  });
});

test('the dev page follows the harness flag, not NODE_ENV', async () => {
  // It used to key off NODE_ENV, which is a different switch that a deployment
  // sets for unrelated reasons.
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/dev/chat`)).status, 404);
  });
  await withHarnessServer(async (base) => {
    assert.equal((await fetch(`${base}/dev/chat`)).status, 200);
  });
});

/**
 * Cancellation over a real socket.
 *
 * The unit tests drive `streamChatToResponse` with a fake response object,
 * which cannot express "the client went away". These use an actual HTTP
 * connection and destroy it, because the defect being guarded against —
 * cancellation bound to the request rather than the response — is invisible to
 * anything that does not have a socket to close.
 */
function countingEngine(onSignal: (signal: AbortSignal) => void) {
  return {
    capabilities: {
      engineId: 'stub',
      engineVersion: '0',
      supportsIdempotentCreate: false,
      supportsRunLookupByOperationId: false,
      supportsStop: true,
      supportsOutOfBandStop: false,
      supportsCitations: true,
    },
    async createRun(request: { operationId: string }, signal: AbortSignal) {
      onSignal(signal);
      return { operationId: request.operationId, engineRunId: 'stub-run' };
    },
    async *streamRun(_handle: unknown, signal: AbortSignal) {
      for (let i = 0; i < 50; i++) {
        if (signal.aborted) return;
        yield { type: 'token' as const, text: `chunk-${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      yield { type: 'final' as const, text: 'done', citations: [] };
    },
    async cancelRun() {
      return 'stopped' as const;
    },
    async health() {
      return { status: 'live' as const, checkedAt: new Date().toISOString() };
    },
    async attestKnowledgeCredential() {
      return { credentialId: 'stub', rotationCounter: 0, spaceId: 'stub' };
    },
  };
}

test('destroying the client socket mid-stream aborts the engine exactly once', async () => {
  let aborts = 0;
  let captured: AbortSignal | undefined;
  const engine = countingEngine((signal) => {
    captured = signal;
    signal.addEventListener('abort', () => {
      aborts++;
    });
  });

  const { server, pool } = buildServer(harnessConfig, { engine: engine as never });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const body = JSON.stringify({ message: 'What is your MOQ?' });
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/ai/chat',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    request.end(body);

    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });

    // Read one chunk so the stream is genuinely in progress, then cut the wire.
    await new Promise<void>((resolve) => response.once('data', () => resolve()));
    assert.equal(aborts, 0, 'the engine was aborted while the client was still connected');

    request.destroy();

    // Give the server a moment to notice the socket is gone.
    const deadline = Date.now() + 3_000;
    while (aborts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(aborts, 1, `expected exactly one abort, saw ${aborts}`);
    assert.equal(captured?.aborted, true);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});

test('a normally completed response never aborts the engine', async () => {
  // The previous wiring listened on the REQUEST, which closes as soon as its
  // body is read — on every successful call, not only on disconnect.
  let aborts = 0;
  const engine = {
    ...countingEngine((signal) => {
      signal.addEventListener('abort', () => {
        aborts++;
      });
    }),
    async *streamRun() {
      yield { type: 'token' as const, text: 'Our MOQ is 500.' };
      yield { type: 'final' as const, text: 'Our MOQ is 500.', citations: [] };
    },
  };

  const { server, pool } = buildServer(harnessConfig, { engine: engine as never });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'MOQ?' }),
    });
    const text = await res.text();
    assert.ok(text.includes('"type":"final"'), 'the stream did not complete');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(aborts, 0, 'a completed response aborted the engine');
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
  }
});
