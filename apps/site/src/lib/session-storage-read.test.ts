import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { getToken, getUser, isLoggedIn, userCanSeeVip } from './session.ts';

const user = { id: 'admin', email: 'test@example.test', username: 'Admin', role: 'admin' };
function storage(t: TestContext, descriptor: PropertyDescriptor | null) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (descriptor)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  else Reflect.deleteProperty(globalThis, 'localStorage');
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}
function anonymous() {
  assert.equal(getToken(), '');
  assert.equal(getUser(), null);
  assert.equal(isLoggedIn(), false);
  assert.equal(userCanSeeVip(), false);
}
for (const fault of ['getter', 'getItem'])
  test(`session ${fault} SecurityError becomes unavailable identity without throwing`, (t) => {
    const denied = () => {
      throw new DOMException('Storage denied', 'SecurityError');
    };
    storage(t, fault === 'getter' ? { get: denied } : { value: { getItem: denied } });
    anonymous();
  });
test('session reads are anonymous without a browser storage global', (t) => {
  storage(t, null);
  anonymous();
});
test('normal session reads preserve the exact stored token and user', (t) => {
  storage(t, {
    value: {
      getItem: (key: string) => (key === 'channel.token' ? 'stored-token' : JSON.stringify(user)),
    },
  });
  assert.equal(getToken(), 'stored-token');
  assert.deepEqual(getUser(), user);
  assert.equal(isLoggedIn(), true);
  assert.equal(userCanSeeVip(), true);
});
test('malformed user JSON is unavailable while token reads retain their own value', (t) => {
  storage(t, {
    value: { getItem: (key: string) => (key === 'channel.token' ? 'stored-token' : '{bad') },
  });
  assert.equal(getUser(), null);
  assert.equal(getToken(), 'stored-token');
  assert.equal(userCanSeeVip(), false);
});
for (const fault of ['getter', 'getItem'])
  test(`restoring ${fault} storage reads the new identity without resurrecting cached credentials`, (t) => {
    const denied = () => {
      throw new DOMException('Storage denied', 'SecurityError');
    };
    storage(t, fault === 'getter' ? { get: denied } : { value: { getItem: denied } });
    anonymous();
    const next = { ...user, id: 'other', role: 'member' };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === 'channel.token' ? 'new-token' : JSON.stringify(next)),
      },
    });
    assert.equal(getToken(), 'new-token');
    assert.deepEqual(getUser(), next);
  });
