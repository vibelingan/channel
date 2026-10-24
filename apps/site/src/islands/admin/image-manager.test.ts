import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type PendingUpload,
  availableImageSlots,
  boundedSelectedFiles,
  claimRetryAttempt,
  failPendingAttempt,
  settlePendingAttempt,
} from './ImageManager.tsx';

function files(count: number): File[] {
  return Array.from(
    { length: count },
    (_, index) => new File([`image-${index}`], `image-${index}.jpg`, { type: 'image/jpeg' }),
  );
}

test('availableImageSlots counts committed and in-flight uploads', () => {
  assert.equal(availableImageSlots(18, 15, 2), 1);
  assert.equal(availableImageSlots(18, 18, 0), 0);
  assert.equal(availableImageSlots(18, 20, 3), 0);
  assert.equal(availableImageSlots(undefined, 20, 3), Number.POSITIVE_INFINITY);
  assert.equal(availableImageSlots(Number.NaN, 0, 0), 0);
});

test('boundedSelectedFiles admits only the remaining upload slots', () => {
  assert.equal(boundedSelectedFiles(files(4), 2).length, 2);
  assert.equal(boundedSelectedFiles(files(4), 0).length, 0);
  assert.equal(boundedSelectedFiles(files(4), Number.POSITIVE_INFINITY).length, 4);
});

function failedUpload(): PendingUpload {
  return {
    key: 'pending-1',
    name: 'failed.jpg',
    file: files(1)[0] as File,
    attemptId: 'attempt-1',
    status: 'failed',
    error: 'Upload failed',
  };
}

test('retry claims once and stale attempts cannot settle the reservation', () => {
  const first = claimRetryAttempt([failedUpload()], 'pending-1', 'attempt-2');
  assert.ok(first.claimed);
  assert.equal(first.claimed.status, 'uploading');
  assert.equal(first.claimed.error, undefined);

  const duplicate = claimRetryAttempt(first.pending, 'pending-1', 'attempt-3');
  assert.equal(duplicate.claimed, undefined);

  const stale = settlePendingAttempt(first.pending, 'pending-1', 'attempt-1');
  assert.equal(stale.accepted, false);
  assert.equal(stale.pending.length, 1);

  const current = settlePendingAttempt(first.pending, 'pending-1', 'attempt-2');
  assert.equal(current.accepted, true);
  assert.equal(current.pending.length, 0);
});

test('only the current attempt can transition to failed', () => {
  const claimed = claimRetryAttempt([failedUpload()], 'pending-1', 'attempt-2').pending;
  assert.equal(
    failPendingAttempt(claimed, 'pending-1', 'attempt-1', 'stale')[0]?.status,
    'uploading',
  );
  const failed = failPendingAttempt(claimed, 'pending-1', 'attempt-2', 'current');
  assert.equal(failed[0]?.status, 'failed');
  assert.equal(failed[0]?.error, 'current');
});
