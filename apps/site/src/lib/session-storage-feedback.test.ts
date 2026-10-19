import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SessionApiError, clearSession, setSession } from './session.ts';
const user = {
  id: 'admin',
  email: 'fixture@example.test',
  username: 'Admin',
  role: 'admin' as const,
};
function target(
  t: TestContext,
  fault?: 'getter' | 'write' | 'second',
  operation?: 'save' | 'clear',
) {
  const data = new Map<string, string>([
    ['channel.token', 'previous'],
    ['channel.user', JSON.stringify(user)],
    ['other', 'keep'],
  ]);
  const window = new EventTarget();
  let events = 0;
  window.addEventListener('channel:auth', () => events++);
  const denied = () => {
    throw new DOMException('Storage unavailable', 'SecurityError');
  };
  const store = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (
        operation === 'save' &&
        (fault === 'write' || (fault === 'second' && key === 'channel.user'))
      )
        denied();
      data.set(key, value);
    },
    removeItem: (key: string) => {
      if (
        operation === 'clear' &&
        (fault === 'write' || (fault === 'second' && key === 'channel.user'))
      )
        denied();
      data.delete(key);
    },
  };
  for (const [name, descriptor] of [
    ['window', { value: window }],
    ['localStorage', fault === 'getter' ? { get: denied } : { value: store }],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { data, events: () => events };
}
for (const operation of ['save', 'clear'] as const)
  for (const fault of ['getter', 'write', 'second'] as const)
    test(`${operation} ${fault} failure has an actionable typed error and never reports success`, (t) => {
      const h = target(t, fault, operation);
      assert.throws(
        () => (operation === 'save' ? setSession('new', user) : clearSession()),
        (error) =>
          error instanceof SessionApiError &&
          error.code === 'STORAGE_UNAVAILABLE' &&
          error.message.includes('site storage'),
      );
      assert.equal(h.events(), 0);
      assert.equal(
        h.data.get('channel.token'),
        fault === 'second' ? (operation === 'save' ? 'new' : undefined) : 'previous',
      );
      assert.deepEqual(JSON.parse(h.data.get('channel.user') ?? ''), user);
    });
test('successful session save keeps both values and emits one existing auth event', (t) => {
  const h = target(t);
  setSession('new', user);
  assert.equal(h.data.get('channel.token'), 'new');
  assert.deepEqual(JSON.parse(h.data.get('channel.user') ?? ''), user);
  assert.equal(h.events(), 1);
  assert.equal(h.data.get('other'), 'keep');
});
test('successful sign out removes both auth keys, preserves other records and emits once', (t) => {
  const h = target(t);
  clearSession();
  assert.equal(h.data.has('channel.token'), false);
  assert.equal(h.data.has('channel.user'), false);
  assert.equal(h.data.get('other'), 'keep');
  assert.equal(h.events(), 1);
});
