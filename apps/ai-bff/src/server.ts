/**
 * The AI assistant BFF (MIU 2a skeleton).
 *
 * At this stage it proves the runtime shape only: it starts, refuses to start
 * on bad configuration, answers liveness and readiness, applies the CORS policy
 * the separate-origin decision requires, and shuts down gracefully. The public
 * API routes belong to MIU 6 and the SSE stream to MIU 7.
 */

import { createServer } from 'node:http';
import { createAiPool, createStoreReadiness } from '@vibelingan-channel/ai-store';
import { type BffConfig, loadConfig } from './config.ts';

export function buildServer(config: BffConfig) {
  const pool = createAiPool({ connectionString: config.databaseUrl, max: 10 });
  const readiness = createStoreReadiness(pool);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && config.corsAllowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, last-event-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Liveness: unauthenticated, no dependencies. Answers "is this process up",
    // never "is it able to serve" — conflating the two makes a database blip
    // restart a healthy container.
    if (url.pathname === '/api/ai/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Readiness: dependencies checked, and it returns only safe status —
    // never a host, path, or credential (SECURITY.md §7).
    if (url.pathname === '/api/ai/readyz') {
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

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }),
    );
  });

  return { server, pool };
}

export function startServer(config: BffConfig) {
  const { server, pool } = buildServer(config);
  server.listen(config.port);

  // Graceful shutdown matters more here than in a request/response service:
  // MIU 7 will hold SSE connections open for tens of seconds, and killing the
  // process mid-stream drops a visitor's answer with no error event.
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ event: 'shutdown.begin', signal }));
    server.close();
    await pool.end().catch(() => undefined);
    console.log(JSON.stringify({ event: 'shutdown.complete' }));
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return { server, pool };
}

// Entry point when run directly (not when imported by a test).
if (process.argv[1]?.endsWith('server.ts')) {
  try {
    const config = loadConfig();
    startServer(config);
    console.log(JSON.stringify({ event: 'listening', port: config.port }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
