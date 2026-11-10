import assert from 'node:assert/strict';
import test from 'node:test';
import type { TurnEvent, TurnRequest } from './model';
import { initialAssistantState, reduceAssistant, resumableRequest } from './state';
const request: TurnRequest = {
  conversationKey: 'conversation-a',
  turnKey: 'turn-a',
  idempotencyKey: 'submission-a',
  message: '500 headphones please',
};
function started() {
  return reduceAssistant(initialAssistantState('conversation-a'), { type: 'begin', request });
}
function event(sequence: number, patch: Partial<TurnEvent> = {}): TurnEvent {
  return {
    type: 'token',
    conversationKey: 'conversation-a',
    turnKey: 'turn-a',
    sequence,
    text: 'Hello',
    ...patch,
  } as TurnEvent;
}

test('begin has visible receipt and one question, retaining the assigned operation identity', () => {
  const state = started();
  assert.equal(state.turn?.phase, 'queued');
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.turn?.request, request);
});
test('duplicate event cannot append the same token twice', () => {
  const first = reduceAssistant(started(), { type: 'event', event: event(1) });
  assert.deepEqual(reduceAssistant(first, { type: 'event', event: event(1) }), first);
});
test('a real tool event advances the visible activity without overriding a pending stop', () => {
  const tool = {
    ...event(1),
    type: 'tool',
    label: 'Checking current published products',
  } as TurnEvent;
  const reading = reduceAssistant(started(), { type: 'event', event: tool });
  assert.equal(reading.turn?.phase, 'reading');
  assert.deepEqual(reading.turn?.steps, ['Checking current published products']);
  const stopping = reduceAssistant(started(), { type: 'stop_requested' });
  assert.equal(reduceAssistant(stopping, { type: 'event', event: tool }).turn?.phase, 'stopping');
});
test('foreign conversation and old turn events cannot modify current answer', () => {
  const state = started();
  for (const patch of [{ conversationKey: 'foreign' }, { turnKey: 'old-turn' }])
    assert.deepEqual(reduceAssistant(state, { type: 'event', event: event(1, patch) }), state);
});
test('terminal answers ignore late text even with a newer sequence', () => {
  for (const type of ['finished', 'cancelled'] as const) {
    const state = reduceAssistant(started(), {
      type: 'event',
      event: { ...event(1), type } as TurnEvent,
    });
    assert.deepEqual(reduceAssistant(state, { type: 'event', event: event(2) }), state);
  }
});
test('requesting stop and uncertain acknowledgement never pretend the answer stopped', () => {
  const pending = reduceAssistant(started(), { type: 'stop_requested' });
  assert.equal(pending.turn?.phase, 'stopping');
  const unknown = reduceAssistant(pending, { type: 'stop_unknown' });
  assert.equal(unknown.turn?.phase, 'stop_unknown');
  const late = reduceAssistant(unknown, { type: 'event', event: event(1) });
  assert.equal(late.turn?.phase, 'stop_unknown');
  assert.equal(late.messages[1]?.text, 'Hello');
});
test('completion wins over a delayed stop acknowledgement', () => {
  let state = reduceAssistant(started(), { type: 'stop_requested' });
  state = reduceAssistant(state, {
    type: 'event',
    event: { ...event(1), type: 'finished' } as TurnEvent,
  });
  assert.equal(reduceAssistant(state, { type: 'stop_confirmed' }).turn?.phase, 'complete');
});
test('closing only hides the panel and preserves the running answer', () => {
  const state = started();
  const closed = reduceAssistant(state, { type: 'open', open: false });
  assert.deepEqual(closed.turn, state.turn);
  assert.deepEqual(closed.messages, state.messages);
});
test('retry preserves operation, partial text and cursor without a duplicate question', () => {
  let state = reduceAssistant(started(), { type: 'event', event: event(3) });
  state = reduceAssistant(state, { type: 'connection_error' });
  const retry = reduceAssistant(state, { type: 'resume' });
  assert.equal(retry.messages.length, 2);
  assert.equal(retry.messages[1]?.text, 'Hello');
  assert.equal(retry.turn?.cursor, 3);
  assert.equal(retry.turn?.request.idempotencyKey, request.idempotencyKey);
});
test('ordinary unsupported answers complete instead of disabling the whole assistant', () => {
  const state = reduceAssistant(started(), {
    type: 'event',
    event: {
      ...event(1),
      type: 'finished',
      kind: 'unsupported',
      text: 'I can help with products and OEM needs.',
    },
  });
  assert.equal(state.sessionStatus, 'ready');
  assert.equal(state.turn?.phase, 'complete');
  assert.equal(state.messages[1]?.kind, 'unsupported');
});
test('restoring an expired conversation removes old visible history', () => {
  const state = reduceAssistant(started(), { type: 'expired' });
  assert.equal(state.messages.length, 0);
  assert.equal(state.turn, null);
  assert.equal(state.sessionStatus, 'expired');
});
test('a deliberate new answer receives a new key and preserves the stopped answer', () => {
  const stopped = reduceAssistant(started(), { type: 'stop_confirmed' });
  const next = reduceAssistant(stopped, {
    type: 'begin',
    request: { ...request, turnKey: 'turn-b', idempotencyKey: 'submission-b' },
    regenerate: true,
  });
  assert.equal(next.messages.filter((m) => m.role === 'visitor').length, 1);
  assert.equal(next.messages.filter((m) => m.role === 'assistant').length, 2);
  assert.equal(next.turn?.request.turnKey, 'turn-b');
});
test('invalid sequence cannot poison the cursor', () => {
  for (const sequence of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const state = started();
    assert.deepEqual(reduceAssistant(state, { type: 'event', event: event(sequence) }), state);
  }
});
test('empty completion still displays a response and allows another question', () => {
  const state = reduceAssistant(started(), {
    type: 'event',
    event: { ...event(1), type: 'finished', text: '' },
  });
  assert.match(state.messages[1]?.text ?? '', /could not find an answer/);
  assert.equal(state.sessionStatus, 'ready');
});

test('temporary history failure preserves the current conversation and allows retry', () => {
  const original = started();
  const restoring = reduceAssistant(original, { type: 'restoring' });
  const failed = reduceAssistant(restoring, { type: 'restore_failed' });
  assert.equal(failed?.sessionStatus, 'ready');
  assert.deepEqual(failed.messages, original.messages);
  assert.equal(failed.restoreFailed, true);
});

test('terminal failure writes a visible reply and retries as a new answer', () => {
  const initial = initialAssistantState('c');
  const request = {
    conversationKey: 'c',
    turnKey: 't',
    idempotencyKey: 'k',
    message: 'Find a product',
  };
  const working = reduceAssistant(initial, { type: 'begin', request });
  const failed = reduceAssistant(working, {
    type: 'event',
    event: {
      conversationKey: 'c',
      turnKey: 't',
      sequence: 1,
      type: 'failed',
      message: 'The product service is unavailable. Try again.',
    },
  });
  assert.equal(failed.messages.at(-1)?.text, 'The product service is unavailable. Try again.');
  assert.equal(failed.turn?.retryMode, 'new_answer');
});

test('a restored in-flight question keeps its message and waits to resume from cursor 0', () => {
  const resume = {
    conversationKey: 'website-chat',
    turnKey: 'turn_700',
    idempotencyKey: 'turn_700',
    message: 'And for 700?',
  };
  const restored = reduceAssistant(initialAssistantState('website-chat'), {
    type: 'restored',
    conversation: {
      conversationKey: 'website-chat',
      messages: [{ id: 'visitor:turn_700', role: 'visitor', text: 'And for 700?' }],
      resume,
      open: false,
    },
  });
  assert.deepEqual(
    restored.messages.map((m) => m.id),
    ['visitor:turn_700', 'answer:turn_700'],
  );
  assert.equal(restored.turn?.phase, 'queued');
  assert.equal(restored.turn?.cursor, 0);
  assert.equal(restored.open, false);
  const lost = reduceAssistant(initialAssistantState('website-chat'), {
    type: 'restored',
    conversation: { conversationKey: 'website-chat', messages: [], resume },
  });
  assert.deepEqual(
    lost.messages.map((m) => [m.id, m.text]),
    [
      ['visitor:turn_700', 'And for 700?'],
      ['answer:turn_700', ''],
    ],
  );
});

test('a refresh keeps every turn the visitor could still resume, not one that needs a new answer', () => {
  const streaming = reduceAssistant(started(), { type: 'event', event: event(1) });
  // The message POST succeeded, then opening its event stream failed (e.g. 503): the run lives on.
  const streamFailed = reduceAssistant(streaming, { type: 'transport_error', message: 'busy' });
  assert.equal(streamFailed.turn?.phase, 'failed');
  assert.deepEqual(resumableRequest(streamFailed.turn), request);
  const limited = reduceAssistant(streaming, {
    type: 'transport_error',
    message: 'slow down',
    retryAt: Date.now() + 5_000,
  });
  assert.deepEqual(resumableRequest(limited.turn), request);
  assert.deepEqual(resumableRequest(streaming.turn), request);
  // A run that itself failed is retried as a new answer, so nothing is left to reattach.
  const runFailed = reduceAssistant(streaming, {
    type: 'event',
    event: event(2, { type: 'failed', message: 'engine down' } as Partial<TurnEvent>),
  });
  assert.equal(runFailed.turn?.retryMode, 'new_answer');
  assert.equal(resumableRequest(runFailed.turn), undefined);
  assert.equal(resumableRequest(null), undefined);
});
