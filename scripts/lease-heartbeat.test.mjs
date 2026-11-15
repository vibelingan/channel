import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  createExclusiveLeaseHeartbeat,
  renewCurrentSiteLease,
} from './release/lease-heartbeat.mjs';

function fixture(renew) {
  let clock = 0;
  let tick;
  let canceled = 0;
  const heart = createExclusiveLeaseHeartbeat({
    renew,
    now: () => clock,
    schedule: (callback, ms) => {
      assert.equal(ms, 30_000);
      tick = callback;
      return 'timer';
    },
    cancel: (timer) => {
      assert.equal(timer, 'timer');
      canceled++;
    },
  });
  return {
    heart,
    tick: () => tick(),
    advance: (ms) => {
      clock += ms;
    },
    canceled: () => canceled,
  };
}

test('a regional run longer than the 180-second lease keeps renewing without overlapping target writes', async () => {
  let active = false;
  let renewals = 0;
  let expiresAt = 0;
  let elapsed = 0;
  const f = fixture(async () => {
    assert.equal(active, false, 'WAN renewal must not race regional target writes');
    renewals++;
    expiresAt = elapsed + 180_000;
  });
  for (let n = 0; n < 40; n++)
    await f.heart.withLease(async () => {
      active = true;
      try {
        assert.ok(expiresAt > elapsed);
        elapsed += 6_000;
        f.advance(6_000);
        await f.tick();
        assert.ok(expiresAt > elapsed);
      } finally {
        active = false;
      }
    });
  assert.equal(elapsed, 240_000);
  assert.equal(
    renewals,
    8,
    'Fast calls reuse a fresh lease instead of adding a WAN renewal each time',
  );
  await f.heart.stop();
});

test('a regional call waits for an in-flight renewal and periodic ticks skip the queued work', async () => {
  let finish;
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const events = [];
  const f = fixture(async () => {
    events.push('renew-start');
    await hold;
    events.push('renew-end');
  });
  const tick = f.tick();
  await nextTurn();
  const call = f.heart.withLease(async () => {
    events.push('regional');
  });
  await nextTurn();
  assert.deepEqual(events, ['renew-start']);
  await f.tick();
  finish();
  await tick;
  await call;
  assert.deepEqual(events, ['renew-start', 'renew-end', 'regional']);
  await f.heart.stop();
});

test('a failed renewal stays failed even when the target would still report the same owner', async () => {
  const failure = Object.assign(Error('Transaction conflict exhausted'), {
    code: 'DATABASE_TRANSACTION_CONFLICT',
  });
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw failure;
  });
  await f.tick();
  assert.equal(f.heart.failure, failure);
  assert.throws(f.heart.check, (error) => error === failure);
  await assert.rejects(
    f.heart.withLease(async () => assert.fail('No operation after failed renewal')),
    (error) => error === failure,
  );
  await f.tick();
  assert.equal(calls, 1);
  await f.heart.stop();
});

test('switching guards invalidates freshness and forces renewal before the next regional invocation', async () => {
  let renewals = 0;
  const f = fixture(async () => {
    renewals++;
  });
  await f.heart.withLease(async () => {});
  await f.heart.withLease(async () => {});
  assert.equal(renewals, 1);
  f.heart.invalidate();
  await f.heart.withLease(async () => {});
  assert.equal(renewals, 2);
  await f.heart.stop();
});

test('stop cancels future work and drains a request already in flight before cleanup or release', async () => {
  let finish;
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const events = [];
  const f = fixture(async () => {});
  const running = f.heart.withLease(async () => {
    events.push('regional-start');
    await hold;
    events.push('regional-end');
  });
  await nextTurn();
  let drained = false;
  const stopping = f.heart.stop().then(() => {
    drained = true;
    events.push('cleanup');
  });
  await nextTurn();
  assert.equal(drained, false);
  await assert.rejects(
    f.heart.withLease(async () => assert.fail('Stopped work ran')),
    { code: 'LEASE_HEARTBEAT_STOPPED' },
  );
  finish();
  await running;
  await stopping;
  assert.deepEqual(events, ['regional-start', 'regional-end', 'cleanup']);
  await f.heart.stop();
  assert.equal(f.canceled(), 1);
});

test('an unconfirmed invocation pauses future renewals and retains its original stop reason', async () => {
  let renewals = 0;
  const f = fixture(async () => {
    renewals++;
  });
  const unknown = Object.assign(Error('Readback required'), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  await assert.rejects(
    f.heart.withLease(async () => {
      throw unknown;
    }),
    (error) => error === unknown,
  );
  f.advance(60_000);
  await f.tick();
  await assert.rejects(f.heart.checkpoint(), (error) => error === unknown);
  assert.equal(renewals, 1);
  await f.heart.stop();
});

test('a live or expired same-owner target cannot disguise a failed renewal as an accepted handover', async () => {
  const guard = { ownerRunId: 'site-original', fence: 7 };
  const failure = Error('Conflict exhausted');
  let status = {
    state: 'stalled',
    target: { lease: guard, currentRunId: null, dirtyRunId: null, unresolvedOperation: null },
    pendingStep: null,
    scope: { baseline: { sourceRunId: 'site-original' } },
  };
  const coordinator = {
    renew: async () => {
      throw failure;
    },
    status: async () => status,
  };
  const invoke = () =>
    renewCurrentSiteLease({
      coordinator,
      getGuard: () => guard,
      runnerRef: 'trusted',
      acceptedRunIds: ['site-original'],
    });
  await assert.rejects(invoke(), (error) => error === failure);
  status = { ...status, state: 'leased' };
  await assert.rejects(invoke(), (error) => error === failure);
  status = { ...status, state: 'idle', target: { ...status.target, lease: null } };
  await invoke();
  status = { ...status, scope: { baseline: { sourceRunId: 'other-site' } } };
  await assert.rejects(invoke(), (error) => error === failure);
});

test('an old renewal finishing after a same-owner fence handover verifies and renews the new guard', async () => {
  const original = {
    ownerRunId: 'site-original',
    targetId: 'target',
    fence: 7,
    acquiredVersion: 4,
  };
  const next = { ...original, fence: 8, acquiredVersion: 5 };
  let guard = original;
  const calls = [];
  await renewCurrentSiteLease({
    coordinator: {
      renew: async (value) => {
        calls.push(value);
        if (value === original) throw Error('Previous lease finished');
      },
      status: async () => {
        // The old timer was still waiting for its status reply when registration acquired a new fence.
        guard = next;
        return {
          state: 'leased',
          target: {
            lease: { ...next, runnerRef: 'trusted' },
            currentRunId: null,
            dirtyRunId: null,
            unresolvedOperation: null,
          },
          pendingStep: null,
          scope: { baseline: { sourceRunId: 'site-original' } },
        };
      },
    },
    getGuard: () => guard,
    runnerRef: 'trusted',
    acceptedRunIds: ['site-original'],
  });
  assert.deepEqual(calls, [original, next]);
});

test('an unproven same-owner replacement cannot hide the old renewal failure', async () => {
  const old = { targetId: 'target', ownerRunId: 'site-original', fence: 7, acquiredVersion: 4 };
  const replacement = { ...old, fence: 8, acquiredVersion: 5 };
  const failure = Error('Old lease expired');
  for (const changes of [
    { lease: old },
    { lease: { ...replacement, runnerRef: 'someone-else' } },
    { currentRunId: 'another-run' },
  ]) {
    let guard = old;
    await assert.rejects(
      renewCurrentSiteLease({
        coordinator: {
          renew: async (value) => {
            assert.equal(value, old);
            guard = replacement;
            throw failure;
          },
          status: async () => ({
            state: 'leased',
            target: {
              lease: { ...replacement, runnerRef: 'trusted' },
              currentRunId: null,
              dirtyRunId: null,
              unresolvedOperation: null,
              ...changes,
            },
            pendingStep: null,
            scope: { baseline: { sourceRunId: 'site-original' } },
          }),
        },
        getGuard: () => guard,
        runnerRef: 'trusted',
        acceptedRunIds: ['site-original'],
      }),
      (error) => error === failure,
    );
  }
});
