import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCanonicalJson } from '@vibelingan-channel/sales-contracts';
import { registrationKey } from '@vibelingan-channel/db/sales-inquiry-submission';
import { createWebsiteFixture } from './website-test-fixtures.ts';
import { createWebsiteDeliveryFixture } from './delivery-fixtures.ts';
import type { IntakeReceipt } from './inquiry-sender.ts';

const receipt: IntakeReceipt = { task_id: 1, run_id: 'a'.repeat(32), state: 'queued' };
async function prepared() {
  const fixture = createWebsiteFixture();
  const result = await fixture.submitProduct();
  assert.equal(result.statusCode, 200);
  const record = fixture.registrations()[0];
  assert.ok(record);
  const key = registrationKey(record);
  let now = Math.floor(Date.now() / 1000);
  let calls = 0;
  let hook: () => Promise<IntakeReceipt> = async () => receipt;
  const sender = {
    send: async () => {
      calls++;
      return hook();
    },
  };
  const worker = createWebsiteDeliveryFixture(fixture, { sender, now: () => now });
  return {
    ...fixture,
    ...worker,
    key,
    record,
    sender,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
    calls: () => calls,
    setHook: (value: () => Promise<IntakeReceipt>) => {
      hook = value;
    },
  };
}
function state(fixture: ReturnType<typeof createWebsiteFixture>, key: string) {
  const row = fixture.rows.get(`channelSalesSourceDeliveries/${key}`);
  assert.ok(row?.record && typeof row.record === 'object');
  return row.record;
}

test('actual product submission is delivered once and persists its exact receipt', async () => {
  const f = await prepared();
  const result = await f.delivery.tick(1);
  assert.equal(result.results[0]?.state, 'accepted');
  assert.deepEqual(result.results[0]?.receipt, receipt);
  assert.equal(f.calls(), 1);
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'accepted');
  assert.equal((await f.delivery.tick(1)).wrapped, true);
  assert.equal((await f.delivery.tick(1)).results.length, 0);
  assert.equal(f.calls(), 1);
});

test('sender runs outside the producer and delivery transaction', async () => {
  const f = await prepared();
  const original = f.database.runTransaction;
  let active = 0;
  f.database.runTransaction = (operation) =>
    original(async (tx) => {
      active++;
      try {
        return await operation(tx);
      } finally {
        active--;
      }
    });
  f.setHook(async () => {
    assert.equal(active, 0, 'network must not hold a database transaction');
    return receipt;
  });
  assert.equal((await f.delivery.deliver(f.key)).state, 'accepted');
});

test('failed or unknown HTTP outcome survives restart and retries the same registration', async () => {
  const f = await prepared();
  f.setHook(async () => {
    throw new Error('synthetic reply lost after server accepted');
  });
  assert.equal((await f.delivery.deliver(f.key)).state, 'retry');
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'retry');
  assert.equal((await f.delivery.deliver(f.key)).state, 'busy');
  f.setNow(f.now() + 3);
  f.setHook(async () => receipt);
  const restarted = createWebsiteDeliveryFixture(f, { sender: f.sender, now: f.now });
  assert.equal((await restarted.delivery.deliver(f.key)).state, 'accepted');
  assert.equal(Reflect.get(state(f, f.key), 'attempt'), 2);
  assert.equal(f.calls(), 2);
});

test('two overlapping workers claim only one send for the same registration', async () => {
  const f = await prepared();
  let finish: (value: IntakeReceipt) => void = () => {};
  f.setHook(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.delivery.deliver(f.key);
  for (let i = 0; i < 30 && !f.calls(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  const other = createWebsiteDeliveryFixture(f, { sender: f.sender, now: f.now });
  assert.equal((await other.delivery.deliver(f.key)).state, 'busy');
  finish(receipt);
  assert.equal((await first).state, 'accepted');
  assert.equal(f.calls(), 1);
});

test('expired sender cannot overwrite the replacement success or write a retry', async () => {
  const f = await prepared();
  let finish: (value: IntakeReceipt) => void = () => {};
  f.setHook(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.delivery.deliver(f.key);
  for (let i = 0; i < 30 && !f.calls(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  f.setNow(f.now() + 31);
  const other = createWebsiteDeliveryFixture(f, {
    sender: { send: async () => receipt },
    now: f.now,
  });
  assert.equal((await other.delivery.deliver(f.key)).state, 'accepted');
  finish({ ...receipt, task_id: 999 });
  assert.equal((await first).state, 'busy');
  assert.deepEqual(Reflect.get(state(f, f.key), 'receipt'), receipt);
  assert.equal(Reflect.get(state(f, f.key), 'attempt'), 2);
});

test('revocation during network prevents acceptance without reviving old authority', async () => {
  const f = await prepared();
  f.setHook(async () => {
    const row = f.rows.get('channelSalesBindings/site_a');
    assert.ok(row?.registry && typeof row.registry === 'object');
    Reflect.set(row.registry, 'enabled', false);
    return receipt;
  });
  assert.equal((await f.delivery.deliver(f.key)).state, 'retry');
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'retry');
});

test('invalid owner, incomplete source, changed facts, terminal state and disabled binding never send', async (t) => {
  for (const change of ['owner', 'incomplete', 'contact', 'terminal', 'binding'] as const) {
    await t.test(change, async () => {
      const f = await prepared();
      const source = f.rows.get(`catalogQuoteRequests/${f.record.source.id}`);
      assert.ok(source);
      if (change === 'owner') source.client_id = 'client_b';
      if (change === 'incomplete') source.salesSubmissionState = 'pending';
      if (change === 'contact') {
        assert.ok(source.fields && typeof source.fields === 'object');
        Reflect.set(source.fields, 'email', 'changed@example.invalid');
      }
      if (change === 'terminal') source.status = 'completed';
      if (change === 'binding') {
        const row = f.rows.get('channelSalesBindings/site_a');
        assert.ok(row?.registry && typeof row.registry === 'object');
        Reflect.set(row.registry, 'enabled', false);
      }
      assert.equal((await f.delivery.deliver(f.key)).state, 'rejected');
      assert.equal(f.calls(), 0);
      assert.equal(Reflect.get(state(f, f.key), 'status'), 'pending');
      assert.equal(Reflect.get(state(f, f.key), 'attempt'), 0);
    });
  }
});

test('multiple active pages and a late lower key are eventually visited; bad registration does not starve others', async () => {
  const f = await prepared();
  for (let i = 0; i < 5; i++) assert.equal((await f.submitProduct()).statusCode, 200);
  const keys = f.registrations().map(registrationKey).sort();
  const low = keys[0];
  const bad = keys[1];
  assert.ok(low && bad);
  const delayed = f.rows.get(`channelSalesSourceDeliveries/${low}`);
  assert.ok(delayed);
  f.rows.delete(`channelSalesSourceDeliveries/${low}`);
  const malformed = f.rows.get(`channelSalesSourceRegistrations/${bad}`);
  assert.ok(malformed?.record && typeof malformed.record === 'object');
  Reflect.set(malformed.record, 'event', {});
  const firstRound = [];
  for (let i = 0; i < 5; i++) firstRound.push(await f.delivery.tick(1));
  assert.ok(firstRound.some((result) => result.results[0]?.state === 'rejected'));
  assert.equal(f.calls(), 4);
  f.rows.set(`channelSalesSourceDeliveries/${low}`, delayed);
  assert.equal((await f.delivery.tick(1)).wrapped, true);
  for (let i = 0; i < 7; i++) await f.delivery.tick(1);
  assert.equal(f.calls(), 5);
  assert.equal(Reflect.get(state(f, low), 'status'), 'accepted');
});

test('accepted audit history never occupies the first active delivery page', async () => {
  const f = await prepared();
  const pending = state(f, f.key);
  const before = BigInt(`0x${f.key}`);
  assert.ok(before > 1000n);
  for (let i = 1n; i <= 1000n; i++) {
    const key = (before - i).toString(16).padStart(64, '0');
    f.rows.set(`channelSalesSourceDeliveries/${key}`, {
      _id: key,
      record: { ...pending, registration_key: key, status: 'accepted', attempt: 1, receipt },
    });
  }
  const first = await f.delivery.tick(1);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0]?.key, f.key);
  assert.equal(first.results[0]?.state, 'accepted');
  assert.equal(f.calls(), 1);
});

test('changed registration recipient cannot replace the actual saved contact', async () => {
  const f = await prepared();
  const registration = f.rows.get(`channelSalesSourceRegistrations/${f.key}`);
  assert.ok(registration?.record && typeof registration.record === 'object');
  const changed = structuredClone(f.record);
  changed.event.contact.email = 'different@example.invalid';
  registration.record = changed;
  Reflect.set(state(f, f.key), 'registration_sha256', hashCanonicalJson(changed));
  assert.equal((await f.delivery.deliver(f.key)).state, 'rejected');
  assert.equal(f.calls(), 0);
});

test('failed receipt storage never claims success and a new owner can recover', async () => {
  const f = await prepared();
  f.setHook(async () => {
    f.setFailAtWrite(1);
    return receipt;
  });
  await assert.rejects(f.delivery.deliver(f.key), /outcome could not be recorded/);
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'inflight');
  f.setFailAtWrite(undefined);
  f.setNow(f.now() + 31);
  f.setHook(async () => receipt);
  assert.equal((await f.delivery.deliver(f.key)).state, 'accepted');
});

test('a replacement still in flight cannot be completed by the stale owner', async () => {
  const f = await prepared();
  let firstFinish: (value: IntakeReceipt) => void = () => {};
  let secondFinish: (value: IntakeReceipt) => void = () => {};
  f.setHook(
    () =>
      new Promise((resolve) => {
        firstFinish = resolve;
      }),
  );
  const first = f.delivery.deliver(f.key);
  for (let i = 0; i < 30 && f.calls() < 1; i++)
    await new Promise((resolve) => setImmediate(resolve));
  f.setNow(f.now() + 31);
  let replacementCalled = false;
  const other = createWebsiteDeliveryFixture(f, {
    sender: {
      send: () => {
        replacementCalled = true;
        return new Promise((resolve) => {
          secondFinish = resolve;
        });
      },
    },
    now: f.now,
  });
  const second = other.delivery.deliver(f.key);
  for (let i = 0; i < 30 && !replacementCalled; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementCalled, true);
  const newOwner = Reflect.get(state(f, f.key), 'lease_id');
  firstFinish({ ...receipt, task_id: 999 });
  assert.equal((await first).state, 'busy');
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'inflight');
  assert.equal(Reflect.get(state(f, f.key), 'lease_id'), newOwner);
  secondFinish(receipt);
  assert.equal((await second).state, 'accepted');
});

test('a stale failure cannot schedule retry over the replacement in flight', async () => {
  const f = await prepared();
  let firstFail: (error: Error) => void = () => {};
  let secondFinish: (value: IntakeReceipt) => void = () => {};
  f.setHook(
    () =>
      new Promise((_resolve, reject) => {
        firstFail = reject;
      }),
  );
  const first = f.delivery.deliver(f.key);
  for (let i = 0; i < 30 && f.calls() < 1; i++)
    await new Promise((resolve) => setImmediate(resolve));
  f.setNow(f.now() + 31);
  let replacementCalled = false;
  const other = createWebsiteDeliveryFixture(f, {
    sender: {
      send: () => {
        replacementCalled = true;
        return new Promise((resolve) => {
          secondFinish = resolve;
        });
      },
    },
    now: f.now,
  });
  const second = other.delivery.deliver(f.key);
  for (let i = 0; i < 30 && !replacementCalled; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementCalled, true);
  const newOwner = Reflect.get(state(f, f.key), 'lease_id');
  firstFail(new Error('synthetic old request failed'));
  assert.equal((await first).state, 'busy');
  assert.equal(Reflect.get(state(f, f.key), 'status'), 'inflight');
  assert.equal(Reflect.get(state(f, f.key), 'lease_id'), newOwner);
  secondFinish(receipt);
  assert.equal((await second).state, 'accepted');
});
