import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  IMAGE_MUTATION_STALE_MS,
  readImageMutationState,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from './adapter.ts';

const OWNER = 'admin-fn-1';
const OTHER = 'admin-fn-2';
const STARTED = '2026-08-05T12:00:00.000Z';

function imageDoc(over: Record<string, unknown> = {}): CollectionDoc {
  return { _id: 'img-1', ...over };
}

const owned = (owner = OWNER, startedAt = STARTED) =>
  imageDoc({ imageMutationOwner: owner, imageMutationStartedAt: startedAt });

// --- readImageMutationState -------------------------------------------------

test('absent lock fields read as free', () => {
  assert.deepEqual(readImageMutationState(imageDoc()), { state: 'free' });
});

test('both fields cleared to empty strings read as free', () => {
  assert.deepEqual(
    readImageMutationState(imageDoc({ imageMutationOwner: '', imageMutationStartedAt: '' })),
    { state: 'free' },
  );
});

test('a canonical owner and start read as owned', () => {
  assert.deepEqual(readImageMutationState(owned()), {
    state: 'owned',
    owner: OWNER,
    startedAt: STARTED,
  });
});

// Half-written state must never read as free: a torn write would otherwise let
// a second caller acquire a lock another caller believes it holds.
test('an owner without a start is corrupt', () => {
  assert.deepEqual(readImageMutationState(imageDoc({ imageMutationOwner: OWNER })), {
    state: 'corrupt',
  });
});

test('a start without an owner is corrupt', () => {
  assert.deepEqual(readImageMutationState(imageDoc({ imageMutationStartedAt: STARTED })), {
    state: 'corrupt',
  });
});

test('a cleared owner beside a live start is corrupt', () => {
  assert.deepEqual(readImageMutationState(owned('', STARTED)), { state: 'corrupt' });
});

test('a live owner beside a cleared start is corrupt', () => {
  assert.deepEqual(readImageMutationState(owned(OWNER, '')), { state: 'corrupt' });
});

test('an unparseable start is corrupt', () => {
  assert.deepEqual(readImageMutationState(owned(OWNER, 'not-a-date')), { state: 'corrupt' });
});

// Only the exact `toISOString()` form round-trips. An equivalent-but-different
// spelling is rejected so every writer is forced onto one canonical encoding.
test('an offset-form start that is not the canonical UTC spelling is corrupt', () => {
  assert.deepEqual(readImageMutationState(owned(OWNER, '2026-08-05T12:00:00+00:00')), {
    state: 'corrupt',
  });
});

test('a second-precision start without milliseconds is corrupt', () => {
  assert.deepEqual(readImageMutationState(owned(OWNER, '2026-08-05T12:00:00Z')), {
    state: 'corrupt',
  });
});

test('non-string lock fields are corrupt', () => {
  assert.deepEqual(readImageMutationState(imageDoc({ imageMutationOwner: 42 })), {
    state: 'corrupt',
  });
  assert.deepEqual(readImageMutationState(owned(OWNER, 0 as unknown as string)), {
    state: 'corrupt',
  });
});

// --- transitionImageMutationAcquire ----------------------------------------

test('acquiring a free lock writes exactly the owner and start', () => {
  const transition = transitionImageMutationAcquire(imageDoc(), OWNER, STARTED);
  assert.deepEqual(transition, {
    result: 'acquired',
    patch: { imageMutationOwner: OWNER, imageMutationStartedAt: STARTED },
  });
  if (transition.result !== 'acquired') return;
  assert.deepEqual(Object.keys(transition.patch).sort(), [
    'imageMutationOwner',
    'imageMutationStartedAt',
  ]);
});

test('acquiring a lock held by another owner is busy', () => {
  assert.deepEqual(transitionImageMutationAcquire(owned(OTHER), OWNER, STARTED), {
    result: 'busy',
  });
});

// The lock is not reentrant: a retry that already holds it must not extend its
// own start time and silently widen the window it believes it owns.
test('acquiring a lock the same owner already holds is busy', () => {
  assert.deepEqual(
    transitionImageMutationAcquire(owned(OWNER), OWNER, '2026-08-05T12:05:00.000Z'),
    { result: 'busy' },
  );
});

test('acquiring a corrupt lock fails closed rather than stealing it', () => {
  assert.deepEqual(transitionImageMutationAcquire(owned(OWNER, 'not-a-date'), OWNER, STARTED), {
    result: 'corrupt',
  });
});

// A crashed holder can never release its lock and no admin surface exposes the
// fields, so a lock older than the stale window must be claimable.
test('a lock older than the stale window is taken over', () => {
  const staleStart = new Date(Date.parse(STARTED) - IMAGE_MUTATION_STALE_MS - 1_000).toISOString();
  assert.deepEqual(transitionImageMutationAcquire(owned(OTHER, staleStart), OWNER, STARTED), {
    result: 'acquired',
    patch: { imageMutationOwner: OWNER, imageMutationStartedAt: STARTED },
  });
});

test('a lock exactly at the stale boundary is still busy', () => {
  const boundaryStart = new Date(Date.parse(STARTED) - IMAGE_MUTATION_STALE_MS).toISOString();
  assert.deepEqual(transitionImageMutationAcquire(owned(OTHER, boundaryStart), OWNER, STARTED), {
    result: 'busy',
  });
});

test('the displaced owner of a taken-over lock cannot release it', () => {
  const staleStart = new Date(Date.parse(STARTED) - IMAGE_MUTATION_STALE_MS - 1_000).toISOString();
  const takeover = transitionImageMutationAcquire(owned(OTHER, staleStart), OWNER, STARTED);
  assert.equal(takeover.result, 'acquired');
  if (takeover.result !== 'acquired') return;
  const afterTakeover = imageDoc(takeover.patch);
  assert.deepEqual(transitionImageMutationRelease(afterTakeover, OTHER), { result: 'not-owner' });
  assert.equal(transitionImageMutationRelease(afterTakeover, OWNER).result, 'released');
});

// --- transitionImageMutationRelease ----------------------------------------

test('the holder releases by clearing both fields', () => {
  assert.deepEqual(transitionImageMutationRelease(owned(), OWNER), {
    result: 'released',
    patch: { imageMutationOwner: '', imageMutationStartedAt: '' },
  });
});

test('a non-holder cannot release another owner lock', () => {
  assert.deepEqual(transitionImageMutationRelease(owned(OTHER), OWNER), { result: 'not-owner' });
});

test('releasing an already-free lock is not-owner', () => {
  assert.deepEqual(transitionImageMutationRelease(imageDoc(), OWNER), { result: 'not-owner' });
});

test('releasing a corrupt lock fails closed and leaves it for recovery', () => {
  assert.deepEqual(transitionImageMutationRelease(owned(OWNER, 'not-a-date'), OWNER), {
    result: 'corrupt',
  });
});

// --- round trip -------------------------------------------------------------

test('applying the acquire patch yields an owned lock, and the release patch frees it', () => {
  const acquire = transitionImageMutationAcquire(imageDoc(), OWNER, STARTED);
  assert.equal(acquire.result, 'acquired');
  if (acquire.result !== 'acquired') return;

  const afterAcquire = imageDoc(acquire.patch);
  assert.deepEqual(readImageMutationState(afterAcquire), {
    state: 'owned',
    owner: OWNER,
    startedAt: STARTED,
  });
  // A competing caller sees the lock the moment the patch lands.
  assert.deepEqual(transitionImageMutationAcquire(afterAcquire, OTHER, STARTED), {
    result: 'busy',
  });

  const release = transitionImageMutationRelease(afterAcquire, OWNER);
  assert.equal(release.result, 'released');
  if (release.result !== 'released') return;

  const afterRelease = imageDoc(release.patch);
  assert.deepEqual(readImageMutationState(afterRelease), { state: 'free' });
  assert.deepEqual(transitionImageMutationAcquire(afterRelease, OTHER, STARTED), {
    result: 'acquired',
    patch: { imageMutationOwner: OTHER, imageMutationStartedAt: STARTED },
  });
});
