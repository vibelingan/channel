import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHttpAssistantAdapter } from './http-adapter';
import type { TurnEvent } from './model';

test('HTTP adapter replays a lost append acknowledgement using the same key, never invents completion', async () => {
  const conversationId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  const key = randomUUID();
  const bodies: string[] = [];
  let attempts = 0;
  const api: typeof fetch = async (_url, init) => {
    const path = String(_url);
    if (path.endsWith('/conversations'))
      return Response.json({
        conversationId,
        credential: 'test-token-'.repeat(4),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (path.endsWith('/messages')) {
      bodies.push(String(init?.body));
      if (++attempts === 1) throw new Error('Lost reply');
      return Response.json({
        protocolVersion: 2,
        conversationId,
        operationKey: key,
        messageId,
        runId,
        controlVersion: 1,
        status: 'completed',
        cancelRequested: false,
      });
    }
    return new Response(
      `data: ${JSON.stringify({ protocolVersion: 2, conversationId, messageId, runId, controlVersion: 1, type: 'final', sequence: 1, text: 'A verified answer' })}\n\n`,
    );
  };
  const adapter = createHttpAssistantAdapter('http://local.invalid', api);
  const request = {
    conversationKey: 'view-key',
    turnKey: key,
    idempotencyKey: key,
    message: 'Hello',
  };
  const events: TurnEvent[] = [];
  await assert.rejects(() =>
    adapter.run(request, 0, (e) => events.push(e), new AbortController().signal),
  );
  assert.equal(events.length, 0);
  await adapter.run(request, 0, (e) => events.push(e), new AbortController().signal);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(events.at(-1)?.type, 'finished');
});

test('HTTP adapter rejects a foreign terminal event before it can change the answer', async () => {
  const conversationId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  const key = randomUUID();
  const api: typeof fetch = async (url) =>
    String(url).endsWith('/conversations')
      ? Response.json({
          conversationId,
          credential: 'test-token-'.repeat(4),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })
      : String(url).endsWith('/messages')
        ? Response.json({
            protocolVersion: 2,
            conversationId,
            operationKey: key,
            messageId,
            runId,
            controlVersion: 1,
            status: 'running',
            cancelRequested: false,
          })
        : new Response(
            `data: ${JSON.stringify({ protocolVersion: 2, conversationId, messageId, runId: randomUUID(), controlVersion: 1, type: 'final', sequence: 1, text: 'Wrong run' })}\n\n`,
          );
  const adapter = createHttpAssistantAdapter('http://local.invalid', api);
  const events: TurnEvent[] = [];
  await assert.rejects(
    () =>
      adapter.run(
        { conversationKey: 'view', turnKey: key, idempotencyKey: key, message: 'Hi' },
        0,
        (e) => events.push(e),
        new AbortController().signal,
      ),
    /verified/,
  );
  assert.equal(events.length, 0);
});
