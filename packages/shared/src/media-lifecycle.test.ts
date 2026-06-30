import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type SweepCandidate,
  isValidMediaStatusTransition,
  selectExpiredPendingForSweep,
} from './media-lifecycle.ts';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const past = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();
const future = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();

function candidate(over: Partial<SweepCandidate> & { _id: string }): SweepCandidate {
  return { status: 'pending', ...over };
}

// --- selectExpiredPendingForSweep ------------------------------------------

test('empty candidates -> empty selection', () => {
  assert.deepEqual(selectExpiredPendingForSweep([], NOW, 10), { docIds: [], storageFileIds: [] });
});

test('selects only expired pending rows, oldest expiry first', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'b', uploadExpiresAt: past(5), storageFileId: 'cloud://b' }),
    candidate({ _id: 'a', uploadExpiresAt: past(30), storageFileId: 'cloud://a' }),
    candidate({ _id: 'c', uploadExpiresAt: past(1) }),
  ];
  const sel = selectExpiredPendingForSweep(rows, NOW, 10);
  assert.deepEqual(sel.docIds, ['a', 'b', 'c']); // oldest expiry first
  assert.deepEqual(sel.storageFileIds, ['cloud://a', 'cloud://b']); // only those with a storage object
});

test('never sweeps active / failed / deleted rows even if expired', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'act', status: 'active', uploadExpiresAt: past(99), storageFileId: 'x' }),
    candidate({ _id: 'fail', status: 'failed', uploadExpiresAt: past(99) }),
    candidate({ _id: 'del', status: 'deleted', uploadExpiresAt: past(99) }),
  ];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10), { docIds: [], storageFileIds: [] });
});

test('skips pending rows with no expiry or not-yet-expired', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'noexp' }), // no uploadExpiresAt
    candidate({ _id: 'fut', uploadExpiresAt: future(10) }),
  ];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10), { docIds: [], storageFileIds: [] });
});

test('expiry exactly equal to now is NOT yet expired (strict boundary)', () => {
  const rows = [candidate({ _id: 'edge', uploadExpiresAt: NOW.toISOString() })];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10).docIds, []);
});

test('unparseable expiry is treated as non-expired (never swept)', () => {
  const rows = [candidate({ _id: 'junk', uploadExpiresAt: 'not-a-date' })];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10).docIds, []);
});

test('respects the limit cap (bounded sweep)', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'a', uploadExpiresAt: past(40) }),
    candidate({ _id: 'b', uploadExpiresAt: past(30) }),
    candidate({ _id: 'c', uploadExpiresAt: past(20) }),
  ];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 2).docIds, ['a', 'b']);
});

test('non-positive or non-finite limit -> empty (no accidental full sweep)', () => {
  const rows = [candidate({ _id: 'a', uploadExpiresAt: past(40) })];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 0).docIds, []);
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, -5).docIds, []);
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, Number.NaN).docIds, []);
});

test('filters out empty-string storage ids', () => {
  const rows = [candidate({ _id: 'a', uploadExpiresAt: past(5), storageFileId: '' })];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10), {
    docIds: ['a'],
    storageFileIds: [],
  });
});

// --- isValidMediaStatusTransition ------------------------------------------

test('pending may verify to active, or fail/delete', () => {
  assert.equal(isValidMediaStatusTransition('pending', 'active'), true);
  assert.equal(isValidMediaStatusTransition('pending', 'failed'), true);
  assert.equal(isValidMediaStatusTransition('pending', 'deleted'), true);
});

test('active may only be deleted; never revert to pending/failed', () => {
  assert.equal(isValidMediaStatusTransition('active', 'deleted'), true);
  assert.equal(isValidMediaStatusTransition('active', 'pending'), false);
  assert.equal(isValidMediaStatusTransition('active', 'failed'), false);
});

test('failed may only be deleted; never silently become active', () => {
  assert.equal(isValidMediaStatusTransition('failed', 'deleted'), true);
  assert.equal(isValidMediaStatusTransition('failed', 'active'), false);
});

test('deleted is terminal (except idempotent same-state)', () => {
  assert.equal(isValidMediaStatusTransition('deleted', 'active'), false);
  assert.equal(isValidMediaStatusTransition('deleted', 'pending'), false);
  assert.equal(isValidMediaStatusTransition('deleted', 'deleted'), true);
});

test('same-state transition is an idempotent no-op', () => {
  for (const s of ['pending', 'active', 'failed', 'deleted'] as const) {
    assert.equal(isValidMediaStatusTransition(s, s), true);
  }
});
