/** Local acceptance runtime: real database/BFF/worker; deterministic model only. */
import { randomUUID } from 'node:crypto';
import { createAiBffServer } from '../apps/ai-bff/src/server.ts';
import { processOne } from '../apps/ai-worker/src/worker.ts';
import { FakeEngine } from '../packages/ai-engine/src/fake-engine.ts';
import { AiStore, migrateUp } from '../packages/ai-store/src/index.ts';
const database = process.env.CHAT_TEST_DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost'].includes(new URL(database).hostname))
  throw new Error('CHAT_TEST_DATABASE_URL must identify an isolated local database');
const store = new AiStore(database);
await migrateUp(store.pool);
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
const stream = engine.streamRun.bind(engine);
engine.streamRun = async function* (handle, signal) {
  const context = await store.pool.query<{ content: string }>(
    "SELECT content FROM conversation_messages WHERE answered_by_run=(SELECT id FROM ai_runs WHERE operation_id=$1) AND role='visitor'",
    [handle.operationId],
  );
  const question = context.rows[0]?.content ?? '';
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
  if (question.includes('fail')) {
    yield { type: 'error', category: 'transient', retriable: true };
    return;
  }
  yield* stream(handle, signal);
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
  await loop;
  await store.close();
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
