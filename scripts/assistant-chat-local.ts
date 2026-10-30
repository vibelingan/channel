/** Local acceptance runtime: real database/BFF/worker; deterministic model only. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAiBffServer } from '../apps/ai-bff/src/server.ts';
import { PublicCatalog } from '../apps/ai-worker/src/product-workflow.ts';
import { processOne } from '../apps/ai-worker/src/worker.ts';
import { FakeEngine } from '../packages/ai-engine/src/fake-engine.ts';
import { AiStore, migrateUp } from '../packages/ai-store/src/index.ts';
const database = process.env.CHAT_TEST_DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost'].includes(new URL(database).hostname))
  throw new Error('CHAT_TEST_DATABASE_URL must identify an isolated local database');
const store = new AiStore(database);
await migrateUp(store.pool);
const runCatalog = new Map<
  string,
  import('../packages/ai-engine/src/port.ts').EngineTurn['publicCatalog']
>();
const engine = new FakeEngine({
  script: [
    'This local test answer confirms that the website, API, database and worker are connected.',
  ],
  citations: [
    {
      sourceId: 'channelkb/local-demo',
      title: 'Local test fixture',
      url: 'https://example.invalid/local-demo',
    },
  ],
});
const createEngineRun = engine.createRun.bind(engine);
engine.createRun = async (request, signal) => {
  const result = await createEngineRun(request, signal);
  runCatalog.set(
    request.operationId,
    request.turns.findLast((turn) => turn.publicCatalog)?.publicCatalog,
  );
  return result;
};
// Isolated public HTTP fixture; production uses the existing public-api service.
let catalogState = 'normal';
const catalogServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:62383');
  if (req.method === 'POST' && url.pathname === '/__fixture/control') {
    catalogState = url.searchParams.get('state') ?? 'normal';
    res.end('ok');
    return;
  }
  if (url.pathname.startsWith('/api/images/')) {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100" viewBox="0 0 240 100"><rect width="240" height="100" fill="#eff6ff"/><path d="M85 65V45a35 35 0 0 1 70 0v20M85 52H75v35h18V52Zm70 0h10v35h-18V52Z" fill="none" stroke="#164e63" stroke-width="7"/></svg>',
    );
    return;
  }
  const query = url.searchParams.get('search') ?? '';
  if (query === 'failure') {
    res.writeHead(503);
    res.end();
    return;
  }
  if (query === 'slowcatalog') await new Promise((resolve) => setTimeout(resolve, 10000));
  const rows = [
    {
      _id: 'demo-1',
      name: 'Everyday wireless headphones',
      description:
        catalogState === 'updated'
          ? 'Updated published details: folding design, USB-C charging.'
          : 'Folding design for everyday use. USB-C charging.',
      published: true,
      images: ['http://127.0.0.1:62383/api/images/demo-1'],
      privateNote: 'PRIVATE_FIXTURE_SENTINEL',
    },
    {
      _id: 'demo-2',
      name: 'Office wireless headphones',
      description: 'Over-ear design for office and travel. Carry case included.',
      published: true,
      images: ['http://127.0.0.1:62383/api/images/demo-2'],
    },
  ].filter((p) => catalogState !== 'withdrawn' || p._id !== 'demo-2');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/products')
    res.end(JSON.stringify({ ok: true, data: { items: query === 'unknown' ? [] : rows } }));
  else {
    const product = rows.find((p) => url.pathname === `/api/products/${p._id}`);
    res.statusCode = product ? 200 : 404;
    res.end(JSON.stringify({ ok: Boolean(product), data: product ?? null }));
  }
});
await new Promise<void>((resolve) => catalogServer.listen(62383, '127.0.0.1', resolve));

engine.streamRun = async function* (handle, signal) {
  const context = await store.pool.query<{ content: string }>(
    "SELECT content FROM conversation_messages WHERE answered_by_run=(SELECT id FROM ai_runs WHERE operation_id=$1) AND role='visitor'",
    [handle.operationId],
  );
  const question = context.rows[0]?.content ?? '';
  const earlier = runCatalog.get(handle.operationId);
  runCatalog.delete(handle.operationId);
  const duration = question.includes('slow') ? 10000 : 500;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, duration);
    signal.addEventListener('abort', done, { once: true });
  });
  if (signal.aborted) return;
  if (question.startsWith('fail')) {
    yield { type: 'error', category: 'transient', retriable: true };
    return;
  }
  const plan = question.includes('those again')
    ? { kind: 'lookup', ids: earlier?.products.slice(0, 2).map((p) => p.id) ?? [] }
    : question.includes('headphones')
      ? { kind: 'search', query: 'headphones' }
      : question.includes('no matching')
        ? { kind: 'search', query: 'unknown' }
        : question.includes('catalog failure')
          ? { kind: 'search', query: 'failure' }
          : question.includes('catalog slow')
            ? { kind: 'search', query: 'slowcatalog' }
            : question.includes('not sure')
              ? {
                  kind: 'clarify',
                  question: 'What type of product do you need, and what will it be used for?',
                }
              : {
                  kind: 'answer',
                  text: 'This local test answer confirms that the website, API, database and worker are connected.',
                };
  yield {
    type: 'final',
    text: JSON.stringify(plan),
    citations: [
      {
        sourceId: 'channelkb/local-demo',
        title: 'Local test fixture',
        url: 'https://example.invalid/local-demo',
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
};
const server = createAiBffServer(store, {
  allowedOrigins: new Set(['http://127.0.0.1:62058']),
  credentialTtlSeconds: 3600,
  engineId: 'fake',
  engineVersion: '0.1.0',
  globalRequestsPerMinute: 10000,
  ipRequestsPerMinute: 10000,
  ipHashSecret: randomUUID(),
  trustProxy: false,
  ssePollMs: 30,
  sseHeartbeatMs: 1000,
  sseMaxDurationMs: 30000,
});
await new Promise<void>((resolve) => server.listen(62382, '127.0.0.1', resolve));
console.log(
  'LOCAL TEST ENGINE ONLY. BFF on 127.0.0.1:62382; no outbound model, email, or inquiry requests.',
);
let stopping = false;
const loop = (async () => {
  while (!stopping) {
    await processOne(store, engine, {
      catalog: new PublicCatalog('http://127.0.0.1:62383', fetch, true),
      pollMs: 20,
      leaseSeconds: 30,
      maxAttempts: 2,
      profileId: 'channel-public-v1',
      maxDeliveredOutputUnits: 2000,
      maxStreamDurationMs: 15000,
      maxToolCalls: 0,
      approvedSourcePrefix: 'channelkb',
      citationSiteOrigin: 'https://example.invalid',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
})();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  catalogServer.closeAllConnections();
  await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
  await loop;
  await store.close();
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
