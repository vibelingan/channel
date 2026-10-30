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

test('inquiry retries freeze the form and bind receipt to the original conversation even after credential expiry', async () => {
  const conversationId = randomUUID();
  let auths = 0;
  let posts = 0;
  const sent: string[] = [];
  let mode = 'lost';
  const key = randomUUID();
  const draft = {
    requirement: '500 gifts',
    name: '',
    email: 'buyer@example.invalid',
    company: '',
    consent: true,
  };
  const api: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/conversations')) {
      auths++;
      return Response.json({ conversationId, credential: 't'.repeat(40) });
    }
    posts++;
    sent.push(String(init?.body));
    if (mode === 'lost') throw new Error('Lost after commit');
    if (mode === 'expired') return new Response('', { status: 401 });
    return Response.json({
      schemaVersion: '1',
      conversationId: mode === 'foreign' ? randomUUID() : conversationId,
      submissionKey: key,
      reference: `ai_${'a'.repeat(64)}`,
      submittedAt: new Date().toISOString(),
    });
  };
  const adapter = createHttpAssistantAdapter('', api);
  const signal = new AbortController().signal;
  await assert.rejects(adapter.submitInquiry(draft, key, signal));
  mode = 'foreign';
  await assert.rejects(adapter.submitInquiry(draft, key, signal));
  mode = 'expired';
  await assert.rejects(adapter.submitInquiry(draft, key, signal));
  mode = 'ok';
  assert.deepEqual(await adapter.submitInquiry(draft, key, signal), {
    reference: `ai_${'a'.repeat(64)}`,
  });
  assert.equal(auths, 1);
  assert.equal(new Set(sent).size, 1);
  const before = posts;
  await assert.rejects(adapter.submitInquiry({ ...draft, requirement: 'changed' }, key, signal));
  assert.equal(posts, before);
});
