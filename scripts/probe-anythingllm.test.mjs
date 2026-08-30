import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { probeAnythingLlm, sanitizedProbeReport } from './probe-anythingllm.mjs';

const testCredential = ['fixture', 'value', 'must', 'not', 'leak'].join('-');
const workspaceSlug = 'workspace-1';
let baseUrl;
let server;

before(async () => {
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${testCredential}`);
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/api/v1/auth') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ authenticated: true }));
      return;
    }

    if (request.method === 'GET' && url.pathname === `/api/v1/workspace/${workspaceSlug}`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          workspace: [
            {
              name: 'Public KB',
              slug: workspaceSlug,
              similarityThreshold: 0.25,
              topN: 4,
            },
          ],
        }),
      );
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === `/api/v1/workspace/${workspaceSlug}/vector-search`
    ) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          results: [
            {
              score: 0.81,
              metadata: { title: 'public-faq.md', chunkSource: 'public-faq.md' },
            },
          ],
        }),
      );
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === `/api/v1/workspace/${workspaceSlug}/thread/new`
    ) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ thread: { slug: 'thread-1', name: 'probe' } }));
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === `/api/v1/workspace/${workspaceSlug}/thread/thread-1/chat`
    ) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: '403 upstream model denied access',
        }),
      );
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === `/api/v1/workspace/${workspaceSlug}/thread/thread-1/stream-chat`
    ) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.message === 'exercise-sse-abort') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: 'event-1',
            type: 'abort',
            close: true,
            error: '403 upstream model denied access',
          })}\n\n`,
        );
        return;
      }
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: '403 upstream model denied access' }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('probe separates working retrieval from failed generation without leaking the key', async () => {
  const report = await probeAnythingLlm({
    baseUrl,
    apiKey: testCredential,
    workspaceSlug,
    retrievalQuery: 'What does the company do?',
    chatQuery: 'What does the company do?',
  });

  assert.equal(report.auth.ok, true);
  assert.equal(report.retrieval.ok, true);
  assert.equal(report.retrieval.results[0].title, 'public-faq.md');
  assert.equal(report.syncChat.ok, false);
  assert.match(report.syncChat.error, /403/);
  assert.equal(report.streamChat.ok, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(testCredential));
});

test('probe rejects a non-local HTTP base URL unless explicitly allowed', async () => {
  await assert.rejects(
    probeAnythingLlm({
      baseUrl: 'http://203.0.113.10:3001',
      apiKey: testCredential,
      workspaceSlug,
      retrievalQuery: 'test',
      chatQuery: 'test',
    }),
    /Refusing to send a bearer token over remote HTTP/,
  );
});

test('probe classifies an SSE abort as a generation failure', async () => {
  const report = await probeAnythingLlm({
    baseUrl,
    apiKey: testCredential,
    workspaceSlug,
    retrievalQuery: 'test',
    chatQuery: 'exercise-sse-abort',
  });

  assert.equal(report.retrieval.ok, true);
  assert.equal(report.streamChat.ok, false);
  assert.equal(report.streamChat.type, 'abort');
  assert.match(report.streamChat.error, /403/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(testCredential));
});

test('the CLI-safe report exposes counts and status only', () => {
  const safe = sanitizedProbeReport({
    transport: { baseUrl: 'http://internal-kb.example:3001', https: false },
    auth: { ok: true },
    workspace: { name: 'INTERNAL WORKSPACE', slug: 'internal-workspace' },
    retrieval: {
      ok: true,
      resultCount: 1,
      results: [{ title: 'hermes-skills-private.md', chunkSource: '/opt/private/source.md' }],
    },
    thread: { slug: 'INTERNAL THREAD', name: 'probe' },
    syncChat: {
      ok: true,
      textResponse: 'INTERNAL GENERATED ANSWER',
      sources: [{ title: 'hermes-skills-private.md', text: 'INTERNAL SOURCE CHUNK' }],
    },
    streamChat: {
      ok: true,
      textResponse: 'STREAMED INTERNAL ANSWER',
      sources: [],
    },
  });
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /INTERNAL|STREAMED|hermes|private|source\.md|internal-kb/);
  assert.equal(safe.retrieval.resultCount, 1);
  assert.equal(safe.syncChat.sourceCount, 1);
});
