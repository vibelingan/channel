import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createConversationStore } from './conversations.ts';

test('a new conversation starts empty and is known to the store', () => {
  const store = createConversationStore();
  const id = store.create();
  assert.equal(store.has(id), true);
  assert.deepEqual(store.turns(id), []);
});

test('turns are returned in order', () => {
  const store = createConversationStore();
  const id = store.create();
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
  const id = store.create();
  store.append(id, { role: 'visitor', text: 'real' });
  store.turns(id).push({ role: 'assistant', text: 'injected' });
  assert.equal(store.turns(id).length, 1, 'a caller mutated stored history');
});

test('history is capped per conversation, keeping the most recent turns', () => {
  const store = createConversationStore({ maxTurns: 4 });
  const id = store.create();
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
  assert.equal(store.has(ids[0] as string), false, 'the oldest conversation was not evicted');
  assert.equal(store.has(ids[4] as string), true, 'the newest conversation was evicted');
});

test('an idle conversation expires', () => {
  let clock = 1_000;
  const store = createConversationStore({ ttlMs: 5_000, now: () => clock });
  const id = store.create();
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
  const id = store.create();
  clock += 4_000;
  store.append(id, { role: 'visitor', text: 'still here' });
  clock += 4_000;
  assert.equal(store.has(id), true, 'an active conversation was expired');
});
