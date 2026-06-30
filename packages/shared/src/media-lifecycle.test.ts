import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type SweepCandidate,
  isValidMediaStatusTransition,
  selectExpiredPendingForSweep,
} from './media-lifecycle.ts';
import type { MediaStatus } from './media.ts';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const past = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();
const future = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
const EMPTY = { items: [], docIds: [], storageObjects: [] };

function candidate(over: Partial<SweepCandidate> & { _id: string }): SweepCandidate {
  return { status: 'pending', ...over };
}

// --- selectExpiredPendingForSweep ------------------------------------------

test('empty candidates -> empty selection', () => {
  assert.deepEqual(selectExpiredPendingForSweep([], NOW, 10), EMPTY);
});

test('selects only expired pending rows, oldest expiry first, pairing preserved', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'b', uploadExpiresAt: past(5), storageFileId: 'cloud://b' }),
    candidate({ _id: 'a', uploadExpiresAt: past(30), storageFileId: 'cloud://a' }),
    candidate({ _id: 'c', uploadExpiresAt: past(1) }),
  ];
  const sel = selectExpiredPendingForSweep(rows, NOW, 10);
  assert.deepEqual(sel.docIds, ['a', 'b', 'c']); // oldest expiry first
  // doc <-> object pairing preserved; the doc with no object ('c') is absent here
  assert.deepEqual(sel.storageObjects, [
    { docId: 'a', storageFileId: 'cloud://a' },
    { docId: 'b', storageFileId: 'cloud://b' },
  ]);
  assert.equal(sel.items.length, 3);
  assert.deepEqual(sel.items[2], { docId: 'c', uploadExpiresAt: past(1) });
});

test('never sweeps active / failed / deleted rows even if expired', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'act', status: 'active', uploadExpiresAt: past(99), storageFileId: 'x' }),
    candidate({ _id: 'fail', status: 'failed', uploadExpiresAt: past(99) }),
    candidate({ _id: 'del', status: 'deleted', uploadExpiresAt: past(99) }),
  ];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10), EMPTY);
});

test('skips pending rows with no expiry or not-yet-expired', () => {
  const rows: SweepCandidate[] = [
    candidate({ _id: 'noexp' }), // no uploadExpiresAt
    candidate({ _id: 'fut', uploadExpiresAt: future(10) }),
  ];
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 10), EMPTY);
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
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, 0), EMPTY);
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, -5), EMPTY);
  assert.deepEqual(selectExpiredPendingForSweep(rows, NOW, Number.NaN), EMPTY);
});

test('empty-string storage id -> item kept but excluded from storageObjects', () => {
  const rows = [candidate({ _id: 'a', uploadExpiresAt: past(5), storageFileId: '' })];
  const sel = selectExpiredPendingForSweep(rows, NOW, 10);
  assert.deepEqual(sel.docIds, ['a']);
  assert.deepEqual(sel.storageObjects, []);
  assert.equal(sel.items[0]?.storageFileId, undefined);
});

test('partial object-delete failure maps back to its doc (keeps only it; MIU-06 class)', () => {
  // Regression for Codex P2: a caller deleting objects first must be able to
  // keep ONLY the doc whose object delete failed, not falsely mark all deleted.
  const rows: SweepCandidate[] = [
    candidate({ _id: 'd1', uploadExpiresAt: past(20), storageFileId: 'cloud://o1' }),
    candidate({ _id: 'd2', uploadExpiresAt: past(10), storageFileId: 'cloud://o2' }),
    candidate({ _id: 'd3', uploadExpiresAt: past(5) }), // no object
  ];
  const sel = selectExpiredPendingForSweep(rows, NOW, 10);

  // Simulate: deleting o2 fails; o1 succeeds; d3 has no object.
  const failedObject = 'cloud://o2';
  const deletedDocIds: string[] = [];
  const keptDocIds: string[] = [];
  for (const item of sel.items) {
    if (item.storageFileId === failedObject) {
      keptDocIds.push(item.docId); // object delete failed -> keep doc retryable
    } else {
      deletedDocIds.push(item.docId); // object absent or deleted -> safe to mark deleted
    }
  }

  assert.deepEqual(keptDocIds, ['d2']); // only the failed-object doc is kept
  assert.deepEqual(deletedDocIds, ['d1', 'd3']); // including the no-object doc
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

test('same-state transition is an idempotent no-op (known statuses only)', () => {
  for (const s of ['pending', 'active', 'failed', 'deleted'] as const) {
    assert.equal(isValidMediaStatusTransition(s, s), true);
  }
});

test('fails closed on unknown/corrupt status values, including same-state', () => {
  // Regression for Codex P3: runtime DB rows can hold corrupt values.
  const bogus = 'unknown' as MediaStatus;
  assert.equal(isValidMediaStatusTransition(bogus, bogus), false);
  assert.equal(isValidMediaStatusTransition(bogus, 'active'), false);
  assert.equal(isValidMediaStatusTransition('pending', bogus), false);
  assert.equal(isValidMediaStatusTransition('' as MediaStatus, '' as MediaStatus), false);
});
