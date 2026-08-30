import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AnythingLlmEngine } from './index.ts';

const fixtureCredential = 'fixture-key-that-must-not-leak';
const apiKey = fixtureCredential;
let baseUrl = '';
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/v1/auth') {
    response.setHeader('content-type', 'application/json');
    response.end('{"authenticated":true}');
    return;
  }
  if (request.method === 'POST' && url.pathname.endsWith('/workspace/public-kb/stream-chat')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"textResponseChunk","textResponse":"Grounded "}\n\n');
    response.end(
      'data: {"type":"finalizeResponseStream","textResponse":"answer.","sources":[{"title":"Public FAQ","id":"faq-1"}],"close":true}\n\n',
    );
    return;
  }
  response.writeHead(404).end();
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('adapter streams normalized tokens, citation and final without leaking credentials', async () => {
  const engine = new AnythingLlmEngine({
    baseUrl,
    apiKey,
    workspaceSlug: 'public-kb',
    engineVersion: '1.0.0',
    citationsVerified: true,
    credentialRotationCounter: 2,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const handle = await engine.createRun(
    {
      operationId: 'op-1',
      conversationRef: 'conversation-1',
      turns: [{ role: 'visitor', text: 'Question' }],
      profileId: 'channel-public-v1',
      locale: 'en',
      limits: { maxDeliveredOutputUnits: 100, maxStreamDurationMs: 1_000, maxToolCalls: 1 },
    },
    new AbortController().signal,
  );
  const events = [];
  for await (const event of engine.streamRun(handle, new AbortController().signal)) {
    events.push(event);
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['token', 'citation', 'token', 'final'],
  );
  const finalEvent = events.at(-1);
  assert.equal(finalEvent?.type === 'final' ? finalEvent.text : null, 'Grounded answer.');
  assert.doesNotMatch(JSON.stringify(events), new RegExp(apiKey));
  assert.equal((await engine.health()).status, 'live');
  assert.equal((await engine.attestKnowledgeCredential()).rotationCounter, 2);
});

test('remote HTTP is rejected and unverified citations are declared false', () => {
  assert.throws(
    () =>
      new AnythingLlmEngine({
        baseUrl: 'http://203.0.113.10:3001',
        apiKey,
        workspaceSlug: 'public-kb',
        engineVersion: '1.0.0',
        citationsVerified: false,
        credentialRotationCounter: 1,
      }),
    /requires HTTPS/,
  );
  const local = new AnythingLlmEngine({
    baseUrl,
    apiKey,
    workspaceSlug: 'public-kb',
    engineVersion: '1.0.0',
    citationsVerified: false,
    credentialRotationCounter: 1,
  });
  assert.equal(local.capabilities.supportsCitations, false);
  assert.equal(local.capabilities.supportsIdempotentCreate, false);
  assert.equal(local.capabilities.supportsOutOfBandStop, false);
});

test('a remote knowledge base on plain HTTP is refused', () => {
  // The supplied hosted KB was reachable over plain HTTP on a public port while
  // carrying an instance-wide developer token. Constructing the engine against
  // that must fail loudly at startup, not send the bearer in cleartext.
  assert.throws(
    () =>
      new AnythingLlmEngine({
        baseUrl: 'http://kb.example.com',
        apiKey: 'x'.repeat(24),
        workspaceSlug: 'public',
        engineVersion: '1.16.0',
        citationsVerified: false,
        credentialRotationCounter: 1,
      }),
    /HTTPS/,
  );
});

test('the same host over HTTPS is accepted', () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.com',
    apiKey: 'x'.repeat(24),
    workspaceSlug: 'public',
    engineVersion: '1.16.0',
    citationsVerified: false,
    credentialRotationCounter: 1,
  });
  assert.equal(engine.capabilities.engineId, 'anythingllm');
});

test('unverified citations are never advertised as supported', () => {
  // supportsCitations is an operator assertion, not an assumption: the hosted
  // KB has never returned a citation, because generation 403s before it can.
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.com',
    apiKey: 'x'.repeat(24),
    workspaceSlug: 'public',
    engineVersion: '1.16.0',
    citationsVerified: false,
    credentialRotationCounter: 1,
  });
  assert.equal(engine.capabilities.supportsCitations, false);
});
