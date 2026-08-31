import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  type AiApiErrorCode,
  type AiApiErrorEnvelope,
  type AppendMessageResponse,
  type CreateConversationResponse,
  type PublicSseEvent,
  isAppendMessageRequest,
  isCreateConversationRequest,
} from '@vibelingan-channel/ai-contracts';
import {
  type EngineProvenance,
  provenanceFromEnv,
} from '@vibelingan-channel/ai-engine/capabilities';
import { AiStore, type EventRow, migrateUp } from '@vibelingan-channel/ai-store';

export interface AiBffConfig {
  allowedOrigins: ReadonlySet<string>;
  credentialTtlSeconds: number;
  engineId: string;
  engineVersion: string;
  /** What produced the answers this BFF records. Must match the worker's. */
  engineProvenance?: EngineProvenance;
  globalRequestsPerMinute: number;
  ipRequestsPerMinute: number;
  ipHashSecret: string;
  trustProxy: boolean;
  ssePollMs: number;
  sseHeartbeatMs: number;
  sseMaxDurationMs: number;
}

export function createAiBffServer(store: AiStore, config: AiBffConfig): Server {
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    try {
      if (!applyCors(request, response, config.allowedOrigins)) return;
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }

      const url = new URL(request.url ?? '/', 'http://ai-bff.local');

      // Liveness: unauthenticated, no dependencies. It answers "is this process
      // up", never "is it able to serve". Calling the database here means a
      // database blip restarts a healthy container, and the restart cannot fix
      // the database — so the outage gets longer, not shorter.
      if (request.method === 'GET' && url.pathname === '/api/ai/healthz') {
        json(response, 200, { status: 'live', service: 'channel-ai-bff' });
        return;
      }

      // Readiness: every dependency this service needs in order to answer, and
      // a 503 when one is not there, so the platform takes a broken instance
      // out of rotation instead of routing visitors to it. It returns only safe
      // status — never a host, path or credential.
      if (request.method === 'GET' && url.pathname === '/api/ai/readyz') {
        try {
          const database = await store.health();
          json(response, 200, { status: 'ready', database, service: 'channel-ai-bff' });
        } catch {
          json(response, 503, { status: 'unavailable', database: 'unavailable' });
        }
        return;
      }

      const sourceIp = clientIp(request, config.trustProxy);
      const sourceKey = createHmac('sha256', config.ipHashSecret).update(sourceIp).digest('hex');
      const globalLimit = await store.reserveRateLimit({
        bucketKey: 'global',
        windowSeconds: 60,
        limit: config.globalRequestsPerMinute,
      });
      const ipLimit = await store.reserveRateLimit({
        bucketKey: `ip:${sourceKey}`,
        windowSeconds: 60,
        limit: config.ipRequestsPerMinute,
      });
      if (!globalLimit.allowed || !ipLimit.allowed) {
        response.setHeader('Retry-After', '60');
        error(response, 429, 'RATE_LIMITED', 'Too many requests', requestId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/conversations') {
        const body = await readJson(request);
        if (!isCreateConversationRequest(body)) {
          error(response, 400, 'BAD_REQUEST', 'Invalid conversation request', requestId);
          return;
        }
        const credential = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + config.credentialTtlSeconds * 1000);
        const conversation = await store.createConversationWithCredential(
          body.locale ?? 'en',
          hashCredential(credential),
          expiresAt,
        );
        const payload: CreateConversationResponse = {
          conversationId: conversation.id,
          credential,
          expiresAt: expiresAt.toISOString(),
        };
        json(response, 201, payload);
        return;
      }

      const route = conversationRoute(url.pathname);
      if (!route) {
        error(response, 404, 'NOT_FOUND', 'Route not found', requestId);
        return;
      }
      if (!(await authorizeConversation(request, store, route.conversationId))) {
        error(response, 401, 'UNAUTHORIZED', 'Conversation credential is invalid', requestId);
        return;
      }

      if (request.method === 'POST' && route.action === 'messages') {
        const body = await readJson(request);
        if (!isAppendMessageRequest(body)) {
          error(response, 400, 'BAD_REQUEST', 'Invalid message request', requestId);
          return;
        }
        const accepted = await store.appendVisitorMessage({
          conversationId: route.conversationId,
          idempotencyKey: body.idempotencyKey,
          content: body.message.trim(),
          engineId: config.engineId,
          engineVersion: config.engineVersion,
          ...(config.engineProvenance ? { provenance: config.engineProvenance } : {}),
        });
        const payload: AppendMessageResponse = {
          messageId: accepted.messageId,
          runId: accepted.run?.id ?? null,
          disposition: accepted.replayed ? 'replayed' : accepted.run ? 'started' : 'queued',
        };
        json(response, accepted.replayed ? 200 : 202, payload);
        return;
      }

      if (request.method === 'POST' && route.action === 'cancel') {
        const conversation = await store.getConversation(route.conversationId);
        if (!conversation) {
          error(response, 404, 'NOT_FOUND', 'Conversation not found', requestId);
          return;
        }
        const cancelled = await store.requestCancellation(
          route.conversationId,
          conversation.controlVersion,
        );
        json(response, cancelled ? 202 : 200, { cancelled });
        return;
      }

      if (request.method === 'GET' && route.action === 'events') {
        await streamEvents(request, response, store, route.conversationId, config);
        return;
      }

      error(response, 404, 'NOT_FOUND', 'Route not found', requestId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown';
      if (message === 'body_too_large' || message === 'invalid_json') {
        error(response, 400, 'BAD_REQUEST', 'Invalid JSON body', requestId);
      } else if (message === 'conversation_closed') {
        error(response, 409, 'CONFLICT', 'Conversation is closed', requestId);
      } else {
        console.error(JSON.stringify({ level: 'error', requestId, code: 'request_failed' }));
        if (!response.headersSent) {
          error(response, 500, 'INTERNAL', 'Request failed', requestId);
        } else {
          response.end();
        }
      }
    }
  });
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) {
    response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Origin denied' } }));
    return false;
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

async function authorizeConversation(
  request: IncomingMessage,
  store: AiStore,
  conversationId: string,
): Promise<boolean> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length);
  if (token.length < 32 || token.length > 128) return false;
  return store.verifyCredential(conversationId, hashCredential(token));
}

function hashCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function conversationRoute(
  pathname: string,
): { conversationId: string; action: 'messages' | 'cancel' | 'events' } | null {
  const match = pathname.match(
    /^\/api\/ai\/conversations\/([0-9a-f-]{36})\/(messages|cancel|events)$/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { conversationId: match[1], action: match[2] as 'messages' | 'cancel' | 'events' };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  store: AiStore,
  conversationId: string,
  config: AiBffConfig,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let sequence = parseSequence(request.headers['last-event-id']);
  const startedAt = Date.now();
  let heartbeatAt = startedAt;

  while (!request.destroyed && Date.now() - startedAt < config.sseMaxDurationMs) {
    const events = await store.listEvents(conversationId, sequence);
    for (const event of events) {
      const publicEvent = toPublicEvent(event);
      response.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(publicEvent)}\n\n`,
      );
      sequence = event.sequence;
    }
    if (Date.now() - heartbeatAt >= config.sseHeartbeatMs) {
      response.write(': heartbeat\n\n');
      heartbeatAt = Date.now();
    }
    await delay(config.ssePollMs, request);
  }
  response.end();
}

function toPublicEvent(event: EventRow): PublicSseEvent {
  const sequence = event.sequence;
  switch (event.type) {
    case 'token':
      return { type: 'token', sequence, text: stringField(event.payload, 'text') };
    case 'citation': {
      const url = optionalStringField(event.payload, 'url');
      return {
        type: 'citation',
        sequence,
        sourceId: stringField(event.payload, 'sourceId'),
        title: stringField(event.payload, 'title'),
        ...(url ? { url } : {}),
      };
    }
    case 'final':
      return { type: 'final', sequence, text: stringField(event.payload, 'text') };
    case 'error':
      return {
        type: 'error',
        sequence,
        category: stringField(event.payload, 'category'),
        retriable: event.payload.retriable === true,
      };
    case 'run.failed': {
      const category = optionalStringField(event.payload, 'category');
      return { type: 'run.failed', sequence, ...(category ? { category } : {}) };
    }
    case 'handoff.started':
    case 'assistant.cancelled':
    case 'conversation.closed':
      return { type: event.type, sequence };
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function optionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function parseSequence(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : (value ?? 0));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function delay(ms: number, request: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      request.off('close', onClose);
      resolve();
    }, ms);
    request.once('close', onClose);
  });
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (!trustProxy) return request.socket.remoteAddress || 'unknown';
  const forwarded = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return value?.trim() || request.socket.remoteAddress || 'unknown';
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function error(
  response: ServerResponse,
  status: number,
  code: AiApiErrorCode,
  message: string,
  requestId: string,
): void {
  const payload: AiApiErrorEnvelope = { error: { code, message, requestId } };
  json(response, status, payload);
}

function configFromEnvironment(): AiBffConfig {
  const origins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:4321')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    allowedOrigins: new Set(origins),
    credentialTtlSeconds: numberEnv('AI_CREDENTIAL_TTL_SECONDS', 86_400),
    engineId: process.env.AI_ENGINE_ID ?? 'fake',
    engineVersion: process.env.AI_ENGINE_VERSION ?? '0.1.0',
    // Read through the SAME parser the worker uses, so the two processes cannot
    // disagree about what produced a run: the BFF stamps the row, the worker
    // serves it, and a mismatch would make every run's provenance unfalsifiable.
    ...(process.env.AI_ENGINE_PROVENANCE_KIND
      ? { engineProvenance: provenanceFromEnv(process.env) }
      : {}),
    globalRequestsPerMinute: numberEnv('AI_GLOBAL_REQUESTS_PER_MINUTE', 600),
    ipRequestsPerMinute: numberEnv('AI_IP_REQUESTS_PER_MINUTE', 60),
    ipHashSecret: requiredSecretEnv('AI_IP_HASH_SECRET'),
    trustProxy: process.env.AI_TRUST_PROXY === '1',
    ssePollMs: numberEnv('AI_SSE_POLL_MS', 250),
    sseHeartbeatMs: numberEnv('AI_SSE_HEARTBEAT_MS', 15_000),
    sseMaxDurationMs: numberEnv('AI_SSE_MAX_DURATION_MS', 55_000),
  };
}

function requiredSecretEnv(name: string): string {
  const value =
    process.env[name] ??
    ((process.env.AI_ENGINE_ID ?? 'fake') === 'fake' ? 'local-development-only-secret' : '');
  if (value.length < 24) throw new Error(`${name} is required and must be at least 24 characters`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_${name}`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const store = new AiStore(databaseUrl);
  await migrateUp(store.pool);
  await store.health();
  const server = createAiBffServer(store, configFromEnvironment());
  const port = numberEnv('PORT', 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', event: 'listening', port }));
  });
  const shutdown = (): void => {
    server.close(() => void store.close());
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
