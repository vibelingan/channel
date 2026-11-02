import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mock, test } from 'node:test';
import { FakeMailFailure, FakeMailProvider } from './fake-mail.ts';
import { validateContract } from './index.ts';

function snapshot() {
  return validateContract(
    'mail-snapshot',
    JSON.parse(readFileSync(new URL('../fixtures/mail-snapshot.json', import.meta.url), 'utf8')),
  );
}

test('fake stages defensive copies and never calls network transports', async () => {
  const forbidden = () => {
    throw new Error('Network forbidden');
  };
  const guards = [
    mock.method(globalThis, 'fetch', forbidden),
    mock.method(http, 'request', forbidden),
    mock.method(https, 'request', forbidden),
    mock.method(net, 'createConnection', forbidden),
  ];
  try {
    const fake = new FakeMailProvider();
    const input = snapshot();
    const draft = await fake.stageDraft(input);
    input.subject = 'changed after staging';
    assert.notEqual(fake.getDraft(draft.draft_id)?.subject, input.subject);
    const receipt = await fake.submit(snapshot(), 'operation_1');
    assert.equal(receipt.status, 'simulated_accepted');
    assert.equal(receipt.mode, 'fake');
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
    const read = fake.getDraft(draft.draft_id);
    assert.ok(read);
    read.subject = 'mutated read';
    assert.notEqual(fake.getDraft(draft.draft_id)?.subject, read.subject);
  } finally {
    for (const guard of guards) guard.mock.restore();
  }
});

test('fake same operation replays; changed payload conflicts', async () => {
  const fake = new FakeMailProvider();
  const receipt = await fake.submit(snapshot(), 'operation_1');
  assert.deepEqual(await fake.submit(snapshot(), 'operation_1'), receipt);
  await assert.rejects(
    fake.submit({ ...snapshot(), subject: 'changed' }, 'operation_1'),
    /conflict/,
  );
  assert.equal(fake.acceptedSubmissions.length, 1);
});

test('fake supports pre-accept failure and accepted-but-timeout recovery', async () => {
  const fake = new FakeMailProvider(['fail_before_accept', 'timeout_after_accept']);
  await assert.rejects(
    fake.submit(snapshot(), 'operation_1'),
    (error: unknown) => error instanceof FakeMailFailure && error.disposition === 'not_accepted',
  );
  assert.equal(fake.acceptedSubmissions.length, 0);
  await assert.rejects(
    fake.submit(snapshot(), 'operation_1'),
    (error: unknown) => error instanceof FakeMailFailure && error.disposition === 'outcome_unknown',
  );
  assert.equal(fake.acceptedSubmissions.length, 1);
  assert.equal((await fake.submit(snapshot(), 'operation_1')).status, 'simulated_accepted');
  assert.equal(fake.acceptedSubmissions.length, 1);
});
