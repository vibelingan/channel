/**
 * The AI assistant worker (MIU 2a skeleton).
 *
 * A separate process from the BFF on purpose: it holds long-lived engine
 * streams, and coupling that to the HTTP server would tie their failure and
 * scaling together. MIU 5b/5c fill in the outbox dispatcher and start-run
 * handler; this establishes the process shape only.
 */

import { createServer } from 'node:http';
import { createAiPool, createStoreReadiness } from '@vibelingan-channel/ai-store';

export interface WorkerConfig {
  databaseUrl: string;
  /** Health port. Even a non-HTTP worker needs a readiness surface. */
  port: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('refusing to start; DATABASE_URL is not set');
  const port = Number(env.PORT?.trim() ?? '8081');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`refusing to start; PORT is not a valid port number: ${env.PORT}`);
  }
  return { databaseUrl, port };
}

export function buildWorker(config: WorkerConfig) {
  const pool = createAiPool({ connectionString: config.databaseUrl, max: 5 });
  const readiness = createStoreReadiness(pool);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/readyz') {
      try {
        const proof = await readiness.check();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, store: 'live', ...proof }));
      } catch {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, store: 'unavailable' }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  return { server, pool };
}

export function startWorker(config: WorkerConfig) {
  const { server, pool } = buildWorker(config);
  server.listen(config.port);

  // Shutdown is not a formality for this process. Once MIU 5c lands, a running
  // worker owns an in-flight engine stream and a claim on a run row. Dropping
  // it without releasing means waiting out the lease before another worker can
  // take over — and, with no out-of-band stop (LLD-002 §7.1), the vendor keeps
  // generating with nobody left to abort the connection.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: 'shutdown.begin', signal }));
    server.close();
    // MIU 5c: abort in-flight engine streams and release claims here, before
    // the pool closes.
    await pool.end().catch(() => undefined);
    console.log(JSON.stringify({ event: 'shutdown.complete' }));
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return { server, pool };
}

if (process.argv[1]?.endsWith('worker.ts')) {
  try {
    const config = loadWorkerConfig();
    startWorker(config);
    console.log(JSON.stringify({ event: 'listening', port: config.port }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
