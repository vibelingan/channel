import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPermanentAlibabaPhotoFailure,
  readAlibabaPhotoFailure,
} from './alibaba-photo-failure.ts';
const failedAt = '2026-10-14T12:00:00.000Z';
const at = Date.parse(failedAt);

for (const reason of [
  'invalid-url',
  'host-not-allowed',
  'too-many-redirects',
  'not-found',
  'too-large',
  'bad-content',
])
  test(`permanent supplier failure ${reason} waits for an explicit retry`, () => {
    assert.equal(isPermanentAlibabaPhotoFailure(reason, 1), true);
    assert.deepEqual(
      readAlibabaPhotoFailure({ failedAt, failureReason: reason, failureAttempts: 1 }, at),
      { state: 'unusable', attempts: 1, recorded: true },
    );
  });

for (const reason of [
  'fetch-failed',
  'dns-blocked',
  'write-failed',
  'unknown',
  ['not-found'],
  null,
])
  test(`a non-permanent reason has a bounded retry wait: ${JSON.stringify(reason)}`, () => {
    const row = { failedAt, failureReason: reason, failureAttempts: 1 };
    assert.equal(isPermanentAlibabaPhotoFailure(reason, 1), false);
    assert.deepEqual(readAlibabaPhotoFailure(row, at + 599999), {
      state: 'waiting',
      attempts: 1,
      recorded: true,
    });
    assert.deepEqual(readAlibabaPhotoFailure(row, at + 600000), {
      state: null,
      attempts: 1,
      recorded: true,
    });
  });

test('six valid failed attempts stop automatic retry and a fixed manual cutoff retries only older failures', () => {
  const row = { failedAt, failureReason: 'fetch-failed', failureAttempts: 6 };
  assert.deepEqual(readAlibabaPhotoFailure(row, at + 600000), {
    state: 'unusable',
    attempts: 6,
    recorded: true,
  });
  assert.deepEqual(readAlibabaPhotoFailure(row, at + 600000, at + 1), {
    state: null,
    attempts: 6,
    recorded: true,
  });
  assert.deepEqual(readAlibabaPhotoFailure(row, at + 600000, at), {
    state: 'unusable',
    attempts: 6,
    recorded: true,
  });
});

for (const invalid of [
  undefined,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '6',
  Number.MAX_SAFE_INTEGER + 1,
])
  test(`a malformed attempt count cannot manufacture a permanent failure: ${String(invalid)}`, () => {
    const value = readAlibabaPhotoFailure(
      { failedAt, failureReason: 'fetch-failed', failureAttempts: invalid },
      at,
    );
    assert.deepEqual(value, { state: 'waiting', attempts: 1, recorded: true });
  });

for (const invalid of [undefined, null, 'invalid', 42])
  test(`an absent valid failure time cannot become a recorded failure: ${String(invalid)}`, () => {
    assert.deepEqual(
      readAlibabaPhotoFailure(
        { failedAt: invalid, failureReason: 'not-found', failureAttempts: 6 },
        at,
      ),
      { state: null, attempts: 0, recorded: false },
    );
  });
