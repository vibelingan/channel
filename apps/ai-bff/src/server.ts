/**
 * The AI assistant BFF (MIU 2a skeleton).
 *
 * At this stage it proves the runtime shape only: it starts, refuses to start
 * on bad configuration, answers liveness and readiness, applies the CORS policy
 * the separate-origin decision requires, and shuts down gracefully. The public
 * API routes belong to MIU 6 and the SSE stream to MIU 7.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationEngine } from '@vibelingan-channel/ai-engine';
import { createAiPool, createStoreReadiness } from '@vibelingan-channel/ai-store';
import { parseChatRequest, streamChatToResponse } from './chat.ts';
import type { BffConfig } from './config.ts';

/**
 * The engine is INJECTED, never imported here. LLD-002 is explicit that the BFF
 * must not depend on an adapter package — the composition root in `main.ts`
 * builds the adapter and hands it in, which is what keeps "swapping engines
 * costs one package" true.
 */
export interface BffDependencies {
  engine?: ConversationEngine;
}

async function readBody(
  req: import('node:http').IncomingMessage,
  maxBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function buildServer(config: BffConfig, deps: BffDependencies = {}) {
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

    // A development-only harness for using the assistant by hand. Guarded on
    // NODE_ENV so it cannot be reached from a production image, which is set to
    // production in the Dockerfile.
    if (url.pathname === '/dev/chat' && process.env.NODE_ENV !== 'production') {
      try {
        const page = readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), '../dev/chat.html'),
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }

    // The conversation route. MIU 2a's skeleton had no routes at all; this is
    // the first one that does the product's actual job.
    if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
      if (!deps.engine) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'ENGINE_NOT_CONFIGURED', message: 'The assistant is not configured.' },
          }),
        );
        return;
      }

      const raw = await readBody(req, 64 * 1024);
      if (raw === null) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request too large.' },
          }),
        );
        return;
      }

      const parsed = parseChatRequest(raw);
      if (!parsed.ok) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: parsed.error } }),
        );
        return;
      }

      // Abort the engine stream when the visitor closes the tab. Without this
      // the model keeps generating — and billing — for a page nobody is on.
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      await streamChatToResponse({
        engine: deps.engine,
        request: parsed.value,
        res,
        signal: controller.signal,
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }),
    );
  });

  return { server, pool };
}

export function startServer(config: BffConfig, deps: BffDependencies = {}) {
  const { server, pool } = buildServer(config, deps);

  // Without this, a port clash surfaces as an unhandled 'error' event and a
  // raw stack trace, which reads like a crash in the application rather than
  // "something else is already on this port".
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`refusing to start; port ${config.port} is already in use`);
      process.exit(1);
    }
    throw error;
  });
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
