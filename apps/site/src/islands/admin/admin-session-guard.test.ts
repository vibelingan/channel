import assert from 'node:assert/strict';
import test from 'node:test';
import { installAdminSessionGuard, isCurrentAdminError } from './admin-session-guard.ts';
import { AdminApiError, fetchCurrentUser, getRecord } from './api.ts';

function fixture(t: test.TestContext) {
  let session = { token: 'private-token-a', actorId: 'admin' };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === 'channel.token'
          ? session.token
          : JSON.stringify({ id: session.actorId, role: 'admin' }),
    },
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  let pauses = 0;
  const initial = { ...session };
  const guard = installAdminSessionGuard(initial, () => pauses++);
  t.after(() => guard.release());
  let calls = 0;
  let held: Promise<void> | undefined;
  let expired = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls++;
    const fail = expired;
    const wait = held;
    held = undefined;
    if (wait) await wait;
    return Response.json(
      fail
        ? { ok: false, error: { code: 'UNAUTHORIZED', message: 'Owned expiry' } }
        : {
            ok: true,
            data:
              body.action === 'me'
                ? { user: { id: session.actorId, role: 'admin' } }
                : { _id: 'p', name: 'Owned product' },
          },
      { status: fail ? 401 : 200 },
    );
  });
  return {
    guard,
    initial,
    pauses: () => pauses,
    calls: () => calls,
    setSession: (token: string, actorId = 'admin') => {
      session = { token, actorId };
    },
    hold: (fail: boolean) => {
      let release = () => {};
      expired = fail;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    healthy: () => {
      expired = false;
    },
  };
}

test('paused dashboard makes no record request while original session verification remains available', async (t) => {
  const f = fixture(t);
  f.guard.pause();
  await assert.rejects(
    getRecord('products', 'p'),
    (error: unknown) => error instanceof AdminApiError && error.code === 'SESSION_PAUSED',
  );
  assert.equal(f.calls(), 0);
  assert.equal((await fetchCurrentUser()).user.id, 'admin');
  assert.equal(f.calls(), 1);
});

for (const expired of [false, true])
  test(`late ${expired ? 'unauthorized' : 'success'} cannot overwrite or pause a renewed original session`, async (t) => {
    const f = fixture(t);
    const release = f.hold(expired);
    const old = getRecord('products', 'p').catch((error: unknown) => error);
    f.guard.pause();
    f.setSession('private-token-b');
    f.guard.resume({ token: 'private-token-b', actorId: 'admin' });
    f.healthy();
    release();
    const error = await old;
    assert.ok(error instanceof AdminApiError);
    assert.equal(error.code, expired ? 'UNAUTHORIZED' : 'SESSION_PAUSED');
    if (expired) assert.equal(isCurrentAdminError(error), false);
    assert.doesNotMatch(JSON.stringify(error), /private-token/);
    assert.equal(f.pauses(), 1);
    assert.equal((await getRecord('products', 'p'))._id, 'p');
  });

test('another actor pauses before transport and cannot replace the original owner by mutating input', async (t) => {
  const f = fixture(t);
  f.initial.actorId = 'other';
  f.setSession('other-token', 'other');
  await assert.rejects(getRecord('products', 'p'), /original account/);
  assert.equal(f.calls(), 0);
  assert.equal(f.pauses(), 1);
  assert.throws(
    () => f.guard.resume({ token: 'other-token', actorId: 'other' }),
    /original account/,
  );
});

for (const expired of [false, true])
  test(`returning to the original token rejects its old ${expired ? 'unauthorized' : 'success'} response`, async (t) => {
    const f = fixture(t);
    const release = f.hold(expired);
    const old = getRecord('products', 'p').catch((error: unknown) => error);
    f.guard.pause();
    f.setSession('private-token-b');
    f.guard.resume({ token: 'private-token-b', actorId: 'admin' });
    f.setSession('private-token-a');
    f.guard.resume({ token: 'private-token-a', actorId: 'admin' });
    f.healthy();
    release();
    const error = await old;
    assert.ok(error instanceof AdminApiError);
    assert.equal(error.code, expired ? 'UNAUTHORIZED' : 'SESSION_PAUSED');
    if (expired) assert.equal(isCurrentAdminError(error), false);
    assert.equal(f.pauses(), 1);
    assert.equal((await getRecord('products', 'p'))._id, 'p');
  });

test('an earlier cached unauthorized error cannot pause a reverified unchanged token', async (t) => {
  const f = fixture(t);
  const release = f.hold(true);
  const request = getRecord('products', 'p').catch((error: unknown) => error);
  release();
  const error = await request;
  assert.ok(error instanceof AdminApiError);
  assert.equal(isCurrentAdminError(error), true);
  f.guard.resume({ token: 'private-token-a', actorId: 'admin' });
  assert.equal(isCurrentAdminError(error), false);
  f.healthy();
  assert.equal((await getRecord('products', 'p'))._id, 'p');
});
