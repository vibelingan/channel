import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createConversationStore } from './conversations.ts';

test('a new conversation starts empty and is known to the store', () => {
  const store = createConversationStore();
  const id = store.create() as string;
  assert.equal(store.has(id), true);
  assert.deepEqual(store.turns(id), []);
});

test('turns are returned in order', () => {
  const store = createConversationStore();
  const id = store.create() as string;
  store.append(id, { role: 'visitor', text: 'one' });
  store.append(id, { role: 'assistant', text: 'two' });
  assert.deepEqual(
    store.turns(id).map((turn) => turn.text),
    ['one', 'two'],
  );
});

test('an unknown id is empty rather than an error', () => {
  const store = createConversationStore();
  assert.equal(store.has('nope'), false);
  assert.deepEqual(store.turns('nope'), []);
});

test('appending to an unknown id does not create one', () => {
  // Otherwise a client could seed arbitrary history simply by naming an id.
  const store = createConversationStore();
  store.append('11111111-1111-4111-8111-111111111111', { role: 'assistant', text: '40% off' });
  assert.equal(store.size(), 0);
});

test('the returned turns are a copy, not the live array', () => {
  const store = createConversationStore();
  const id = store.create() as string;
  store.append(id, { role: 'visitor', text: 'real' });
  store.turns(id).push({ role: 'assistant', text: 'injected' });
  assert.equal(store.turns(id).length, 1, 'a caller mutated stored history');
});

test('history is capped per conversation, keeping the most recent turns', () => {
  const store = createConversationStore({ maxTurns: 4 });
  const id = store.create() as string;
  for (let i = 0; i < 10; i++) store.append(id, { role: 'visitor', text: `turn-${i}` });
  const turns = store.turns(id);
  assert.equal(turns.length, 4);
  assert.equal(turns[0]?.text, 'turn-6');
  assert.equal(turns[3]?.text, 'turn-9');
});

test('the store is bounded, so traffic alone cannot exhaust memory', () => {
  const store = createConversationStore({ maxConversations: 3 });
  const ids = [store.create(), store.create(), store.create(), store.create(), store.create()];
  assert.equal(store.size(), 3);
  // Idle conversations ARE evictable, so all five succeed and the oldest go.
  assert.ok(
    ids.every((id) => id !== null),
    'an idle conversation blocked a new one',
  );
  assert.equal(store.has(ids[0] as string), false, 'the oldest conversation was not evicted');
  assert.equal(store.has(ids[4] as string), true, 'the newest conversation was evicted');
});

test('an idle conversation expires', () => {
  let clock = 1_000;
  const store = createConversationStore({ ttlMs: 5_000, now: () => clock });
  const id = store.create() as string;
  store.append(id, { role: 'visitor', text: 'hello' });

  clock += 4_000;
  assert.equal(store.has(id), true, 'expired early');

  clock += 2_000;
  assert.equal(store.has(id), false, 'did not expire');
  assert.deepEqual(store.turns(id), []);
});

test('activity keeps a conversation alive', () => {
  let clock = 1_000;
  const store = createConversationStore({ ttlMs: 5_000, now: () => clock });
  const id = store.create() as string;
  clock += 4_000;
  store.append(id, { role: 'visitor', text: 'still here' });
  clock += 4_000;
  assert.equal(store.has(id), true, 'an active conversation was expired');
});

test('one turn at a time per conversation', () => {
  const store = createConversationStore();
  const id = store.create() as string;
  assert.equal(store.tryBeginTurn(id), true);
  assert.equal(store.tryBeginTurn(id), false, 'a second concurrent turn was allowed');
  store.endTurn(id);
  assert.equal(store.tryBeginTurn(id), true, 'the conversation stayed locked after the turn ended');
});

test('different conversations do not block each other', () => {
  const store = createConversationStore();
  const a = store.create() as string;
  const b = store.create() as string;
  assert.equal(store.tryBeginTurn(a), true);
  assert.equal(store.tryBeginTurn(b), true);
});

test('a conversation mid-answer is never evicted for capacity', () => {
  // Its final append would land on a conversation that no longer exists and
  // vanish without an error.
  const store = createConversationStore({ maxConversations: 2 });
  const busy = store.create() as string;
  store.tryBeginTurn(busy);
  store.create();
  store.create();
  store.create();
  assert.equal(store.has(busy), true, 'an in-flight conversation was evicted');
});

test('a conversation mid-answer is never expired for age', () => {
  let clock = 1_000;
  const store = createConversationStore({ ttlMs: 1_000, now: () => clock });
  const id = store.create() as string;
  store.tryBeginTurn(id);
  clock += 10_000;
  assert.equal(store.has(id), true, 'a slow answer had its own conversation expire');
  store.append(id, { role: 'assistant', text: 'landed' });
  assert.equal(store.turns(id).length, 1, 'the final append was lost');
});

test('the cap holds even when every stored conversation is active', () => {
  // The gap the previous version had: active conversations were excluded from
  // eviction and then a new one was inserted anyway, so N simultaneous first
  // questions grew the map to N regardless of the bound.
  const store = createConversationStore({ maxConversations: 2 });
  const a = store.create() as string;
  store.tryBeginTurn(a);
  const b = store.create() as string;
  store.tryBeginTurn(b);

  const c = store.create();
  assert.equal(c, null, 'a third conversation was created past the cap');
  assert.equal(store.size(), 2, `size ${store.size()} exceeds the cap of 2`);
  assert.equal(store.has(a), true, 'an in-flight conversation was evicted to make room');
  assert.equal(store.has(b), true, 'an in-flight conversation was evicted to make room');
});

test('capacity is released as soon as a turn finishes', () => {
  const store = createConversationStore({ maxConversations: 2 });
  const a = store.create() as string;
  store.tryBeginTurn(a);
  const b = store.create() as string;
  store.tryBeginTurn(b);
  assert.equal(store.create(), null);

  store.endTurn(a);
  const c = store.create();
  assert.notEqual(c, null, 'the store stayed full after a turn completed');
  assert.equal(store.size(), 2);
});

test('size never exceeds the cap under repeated pressure', () => {
  const store = createConversationStore({ maxConversations: 5 });
  const active = [];
  for (let i = 0; i < 50; i++) {
    const id = store.create() as string;
    if (id) {
      store.tryBeginTurn(id);
      active.push(id);
    }
    assert.ok(store.size() <= 5, `size ${store.size()} exceeded the cap of 5 on iteration ${i}`);
  }
  assert.equal(active.length, 5, 'more conversations were handed out than the cap allows');
});
