import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHttpAssistantAdapter } from './http-adapter';
import type { TurnEvent } from './model';
import { sessionAssistantPersistence } from './persistence';
import { InquiryRejectedError } from './transport-error';

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

test('stop waits for queued cancellation of the same run instead of immediately reporting unknown', async () => {
  const conversationId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  const key = randomUUID();
  let polls = 0;
  let cancellations = 0;
  const turn = {
    protocolVersion: 2,
    conversationId,
    operationKey: key,
    messageId,
    runId,
    controlVersion: 1,
    status: 'running',
    cancelRequested: false,
  };
  const api: typeof fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/conversations'))
      return Response.json({
        conversationId,
        credential: 'test-token-'.repeat(4),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (path.endsWith('/messages')) return Response.json(turn);
    if (path.endsWith('/cancel')) {
      cancellations++;
      return Response.json({ ...turn, cancelRequested: true }, { status: 202 });
    }
    polls++;
    return Response.json({
      ...turn,
      status: polls > 1 ? 'cancelled' : 'running',
      cancelRequested: true,
    });
  };
  const adapter = createHttpAssistantAdapter('http://local.invalid', api);
  assert.equal(
    await adapter.stop(
      { conversationKey: 'view', turnKey: key, idempotencyKey: key, message: 'Question' },
      AbortSignal.timeout(1000),
    ),
    'stopped',
  );
  assert.equal(cancellations, 1);
  assert.equal(polls, 2);
});

test('known_rejection_stays_editable: a refusal before saving frees the key; an unknown result keeps it frozen', async () => {
  const conversationId = randomUUID();
  const key = randomUUID();
  const draft = {
    requirement: '500 gifts',
    name: 'Nina',
    email: 'nina@vibelingan.com',
    company: 'VibeLingan',
    consent: true,
  };
  let reply: () => Response = () => new Response('', { status: 500 });
  const api: typeof fetch = async (url) => {
    if (String(url).endsWith('/conversations'))
      return Response.json({ conversationId, credential: 't'.repeat(40) });
    return reply();
  };
  const adapter = createHttpAssistantAdapter('', api);
  const signal = new AbortController().signal;
  const refusal =
    (status: number, reason: string, outcome = 'not_started') =>
    () =>
      Response.json(
        { error: { code: 'INQUIRY_REJECTED', message: 'x', requestId: 'r', outcome, reason } },
        { status },
      );
  reply = refusal(422, 'PRODUCT_UNVERIFIED');
  await assert.rejects(
    adapter.submitInquiry(draft, key, signal),
    (e) => e instanceof InquiryRejectedError && e.reason === 'PRODUCT_UNVERIFIED',
  );
  // Nothing was saved, so the corrected draft may use the same key.
  reply = () =>
    Response.json(
      { error: { code: 'UNAVAILABLE', message: 'x', requestId: 'r', outcome: 'unknown' } },
      { status: 503 },
    );
  const corrected = { ...draft, requirement: '500 gifts, blue' };
  await assert.rejects(
    adapter.submitInquiry(corrected, key, signal),
    (e) => !(e instanceof InquiryRejectedError),
  );
  // That attempt may have been saved: the content is frozen again.
  await assert.rejects(
    adapter.submitInquiry(draft, key, signal),
    (e) => !(e instanceof InquiryRejectedError),
  );
  for (const bogus of [
    refusal(422, 'DB_DOWN'),
    refusal(422, 'INVALID_DETAILS', 'unknown'),
    refusal(503, 'INVALID_DETAILS'),
  ]) {
    reply = bogus;
    await assert.rejects(
      adapter.submitInquiry(corrected, key, signal),
      (e) => !(e instanceof InquiryRejectedError),
    );
  }
});

class TabStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
/** One fake BFF shared by two page loads in the same tab. */
function fakeBff() {
  const conversationId = randomUUID();
  const credential = 'r'.repeat(40);
  const turns = new Map<
    string,
    { runId: string; messageId: string; text: string; done: boolean }
  >();
  const calls = { conversations: 0, inquiries: [] as string[], snapshots: 0 };
  let dropAfterFirstToken = true;
  let snapshotStatus = 401;
  const api: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://site.test');
    const path = url.pathname;
    if (path.endsWith('/conversations')) {
      calls.conversations++;
      return Response.json(
        { conversationId, credential, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        { status: 201 },
      );
    }
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${credential}`)
      return new Response('', { status: 401 });
    if (path.endsWith('/messages')) {
      const body = JSON.parse(String(init?.body));
      const prior = turns.get(body.idempotencyKey);
      const turn = prior ?? {
        runId: randomUUID(),
        messageId: randomUUID(),
        text: body.message,
        done: false,
      };
      turns.set(body.idempotencyKey, turn);
      return Response.json(
        {
          protocolVersion: 2,
          conversationId,
          operationKey: body.idempotencyKey,
          messageId: turn.messageId,
          runId: turn.runId,
          controlVersion: 1,
          status: 'running',
          cancelRequested: false,
        },
        { status: 202 },
      );
    }
    if (path.endsWith('/events')) {
      const turn = turns.get(url.searchParams.get('turn') ?? '');
      assert.ok(turn);
      const after = Number(new Headers(init?.headers).get('last-event-id'));
      const base = {
        protocolVersion: 2,
        conversationId,
        messageId: turn.messageId,
        runId: turn.runId,
        controlVersion: 1,
      };
      const events = [
        { ...base, type: 'token', sequence: 1, text: 'Model A ' },
        { ...base, type: 'final', sequence: 2, text: 'Model A suits 700 gifts.' },
      ].filter((e) => e.sequence > after);
      const shown = dropAfterFirstToken ? events.slice(0, 1) : events;
      if (!dropAfterFirstToken) turn.done = true;
      return new Response(
        shown.map((e) => `id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    }
    if (path.endsWith('/snapshot')) {
      calls.snapshots++;
      if (snapshotStatus !== 200) return new Response('', { status: snapshotStatus });
      const messages = [...turns.entries()].flatMap(([key, t]) => [
        {
          role: 'visitor',
          operationKey: key,
          runId: t.runId,
          status: t.done ? 'completed' : 'running',
          text: t.text,
        },
        ...(t.done
          ? [
              {
                role: 'assistant',
                runId: t.runId,
                text: 'Model A suits 700 gifts.',
                kind: 'answer',
              },
            ]
          : []),
      ]);
      return Response.json({ protocolVersion: 2, conversationId, messages });
    }
    if (path.endsWith('/inquiries')) {
      calls.inquiries.push(String(init?.body));
      throw new Error('Lost after commit');
    }
    return new Response('', { status: 404 });
  };
  return {
    api,
    calls,
    turns,
    conversationId,
    set dropAfterFirstToken(v: boolean) {
      dropAfterFirstToken = v;
    },
    set snapshotStatus(v: number) {
      snapshotStatus = v;
    },
  };
}

test('refresh_resumes_same_conversation and inflight_reply_resumes_without_second_model_run', async () => {
  const bff = fakeBff();
  const storage = new TabStorage();
  const signal = new AbortController().signal;
  const firstLoad = sessionAssistantPersistence('site.test:website_sales', storage);
  const before = createHttpAssistantAdapter('', bff.api, firstLoad);
  const request = {
    conversationKey: 'website-chat',
    turnKey: 'turn_700_gifts',
    idempotencyKey: 'turn_700_gifts',
    message: 'And for 700?',
  };
  const seen: TurnEvent[] = [];
  await before.run(request, 0, (e) => seen.push(e), signal);
  assert.deepEqual(
    seen.map((e) => e.type),
    ['token'],
  );
  // The session records the in-flight question; the page then navigates.
  firstLoad.update({
    turn: {
      turnKey: request.turnKey,
      idempotencyKey: request.idempotencyKey,
      message: request.message,
    },
  });
  bff.snapshotStatus = 200;
  bff.dropAfterFirstToken = false;
  const after = createHttpAssistantAdapter(
    '',
    bff.api,
    sessionAssistantPersistence('site.test:website_sales', storage),
  );
  const restored = await after.restore(signal);
  assert.ok(restored);
  assert.equal(restored.conversationKey, 'website-chat');
  assert.deepEqual(restored.resume, request);
  assert.deepEqual(
    restored.messages.map((m) => m.id),
    ['visitor:turn_700_gifts'],
  );
  const replay: TurnEvent[] = [];
  await after.run(restored.resume, 0, (e) => replay.push(e), signal);
  assert.deepEqual(
    replay.map((e) => e.type),
    ['token', 'finished'],
  );
  assert.equal(bff.calls.conversations, 1);
  assert.equal(bff.turns.size, 1);
});

test('finished_run_during_navigation_shows_final_answer without resuming it', async () => {
  const bff = fakeBff();
  const storage = new TabStorage();
  const signal = new AbortController().signal;
  const p = sessionAssistantPersistence('s', storage);
  const before = createHttpAssistantAdapter('', bff.api, p);
  bff.dropAfterFirstToken = false;
  const request = {
    conversationKey: 'website-chat',
    turnKey: 'turn_gift_1',
    idempotencyKey: 'turn_gift_1',
    message: 'Gifts?',
  };
  await before.run(request, 0, () => undefined, signal);
  p.update({
    turn: {
      turnKey: request.turnKey,
      idempotencyKey: request.idempotencyKey,
      message: request.message,
    },
  });
  bff.snapshotStatus = 200;
  const restored = await createHttpAssistantAdapter(
    '',
    bff.api,
    sessionAssistantPersistence('s', storage),
  ).restore(signal);
  assert.ok(restored);
  assert.equal(restored.resume, undefined);
  // launcher_marks_answer_finished_while_away: the next page knows to show a dot.
  assert.equal(restored.finishedWhileAway, true);
  assert.deepEqual(
    restored.messages.map((m) => [m.id, m.text]),
    [
      ['visitor:turn_gift_1', 'Gifts?'],
      ['answer:turn_gift_1', 'Model A suits 700 gifts.'],
    ],
  );
});

test('expired_session_is_not_silently_resubmitted and unknown_submission_survives_refresh_with_same_key', async () => {
  const bff = fakeBff();
  const storage = new TabStorage();
  const signal = new AbortController().signal;
  const draft = {
    requirement: '700 gifts',
    name: 'Nina',
    email: 'nina@vibelingan.com',
    company: 'VibeLingan',
    consent: true,
  };
  const before = createHttpAssistantAdapter('', bff.api, sessionAssistantPersistence('s', storage));
  await assert.rejects(before.submitInquiry(draft, 'inquiry_key_1', signal));
  bff.snapshotStatus = 200;
  const after = createHttpAssistantAdapter('', bff.api, sessionAssistantPersistence('s', storage));
  assert.ok(await after.restore(signal));
  await assert.rejects(after.submitInquiry(draft, 'inquiry_key_1', signal));
  assert.equal(bff.calls.inquiries.length, 2);
  assert.equal(new Set(bff.calls.inquiries).size, 1);
  // A changed draft cannot reuse the uncertain key, even after refresh.
  await assert.rejects(
    after.submitInquiry({ ...draft, requirement: '900 gifts' }, 'inquiry_key_1', signal),
  );
  assert.equal(bff.calls.inquiries.length, 2);
  // The credential expired on the server: restoring reports expiry and clears the tab record.
  bff.snapshotStatus = 401;
  const expired = createHttpAssistantAdapter(
    '',
    bff.api,
    sessionAssistantPersistence('s', storage),
  );
  assert.equal(await expired.restore(signal), null);
  assert.equal(sessionAssistantPersistence('s', storage).load(), null);
  assert.equal(bff.calls.inquiries.length, 2);
});
