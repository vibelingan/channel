import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { onAuthChange } from './session.ts';

function target(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const emit = (key: unknown) => {
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: key });
    window.dispatchEvent(event);
  };
  return { window, emit };
}

for (const key of ['channel.token', 'channel.user', null])
  test(`session storage key ${JSON.stringify(key)} still notifies subscribers`, (t) => {
    const h = target(t);
    let calls = 0;
    const unsubscribe = onAuthChange(() => {
      calls++;
    });
    h.emit(key);
    assert.equal(calls, 1);
    unsubscribe();
  });

for (const key of [
  'channel:publication:v1:["admin","https://test.example/api/admin"]:["p","original"]',
  'channel.table.preferences',
  'unrelated',
  '',
  undefined,
])
  test(`unrelated storage key ${JSON.stringify(key)} cannot trigger session synchronization`, (t) => {
    const h = target(t);
    let calls = 0;
    const unsubscribe = onAuthChange(() => {
      calls++;
    });
    h.emit(key);
    assert.equal(calls, 0);
    unsubscribe();
  });

test('the local session event still notifies without requiring a storage event', (t) => {
  const h = target(t);
  let calls = 0;
  const unsubscribe = onAuthChange(() => {
    calls++;
  });
  h.window.dispatchEvent(new Event('channel:auth'));
  assert.equal(calls, 1);
  unsubscribe();
});

test('unsubscribe removes both installed listeners and does not remove another subscriber', (t) => {
  const h = target(t);
  let a = 0;
  let b = 0;
  const unsubscribeA = onAuthChange(() => {
    a++;
  });
  const unsubscribeB = onAuthChange(() => {
    b++;
  });
  unsubscribeA();
  h.emit('channel.token');
  h.window.dispatchEvent(new Event('channel:auth'));
  assert.equal(a, 0);
  assert.equal(b, 2);
  unsubscribeB();
  h.emit('channel.user');
  h.window.dispatchEvent(new Event('channel:auth'));
  assert.equal(b, 2);
});
