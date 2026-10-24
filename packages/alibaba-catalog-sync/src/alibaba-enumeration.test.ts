import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type EnumerationState,
  applyCountResult,
  applyListResult,
  initialEnumerationState,
  isEnumerationComplete,
  nextEnumerationAction,
} from './alibaba-enumeration.ts';

const HOUR = 3_600_000;
const T0 = 1_722_800_000_000 - (1_722_800_000_000 % 1000);

test('empty window completes after one zero count', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + HOUR });
  const action = nextEnumerationAction(state);
  assert.equal(action.type, 'count');
  state = applyCountResult(state, 0);
  assert.equal(nextEnumerationAction(state).type, 'done');
  assert.equal(isEnumerationComplete(state), true);
});

test('small window lists a single page then completes', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + HOUR });
  state = applyCountResult(state, 12);
  const action = nextEnumerationAction(state);
  assert.equal(action.type, 'list');
  state = applyListResult(state);
  assert.equal(isEnumerationComplete(state), true);
});

test('oversized window splits with a shared boundary, earlier half first', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + 2 * HOUR });
  state = applyCountResult(state, 100);
  const action = nextEnumerationAction(state);
  assert.equal(action.type, 'count');
  if (action.type === 'count') {
    assert.equal(action.window.fromMs, T0, 'earlier half is scanned first');
    const mid = action.window.toMs;
    assert.ok(mid > T0 && mid < T0 + 2 * HOUR);
    assert.equal(mid % 1000, 0, 'split point is second-aligned');
    // The sibling upper half must start at the SAME boundary (overlap, no gap).
    state = applyCountResult(state, 10);
    state = applyListResult(state);
    const sibling = nextEnumerationAction(state);
    assert.equal(sibling.type, 'count');
    if (sibling.type === 'count') {
      assert.equal(sibling.window.fromMs, mid);
      assert.equal(sibling.window.toMs, T0 + 2 * HOUR);
    }
  }
});

test('drives a full bisection to completion', () => {
  // Synthetic catalog: 100 items spread across the window; count() reports
  // per-window counts, so any window with >30 splits until buckets fit.
  const itemsAt: number[] = [];
  for (let i = 0; i < 100; i += 1)
    itemsAt.push(T0 + Math.floor((i * 2 * HOUR) / 100 / 1000) * 1000);
  const countIn = (fromMs: number, toMs: number) =>
    itemsAt.filter((t) => t >= fromMs && t <= toMs).length;

  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + 2 * HOUR });
  let listedWindows = 0;
  let listedItems = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const action = nextEnumerationAction(state);
    if (action.type === 'done') break;
    assert.notEqual(action.type, 'blocked');
    if (action.type === 'count') {
      state = applyCountResult(state, countIn(action.window.fromMs, action.window.toMs));
    } else if (action.type === 'list') {
      listedWindows += 1;
      listedItems += countIn(action.window.fromMs, action.window.toMs);
      state = applyListResult(state);
    }
  }
  assert.equal(isEnumerationComplete(state), true);
  assert.ok(listedWindows >= 4, `expected multiple terminal buckets, got ${listedWindows}`);
  // Boundary seconds may double-count (dedup happens downstream); every item
  // must be covered at least once.
  assert.ok(listedItems >= 100, `expected full coverage, got ${listedItems}`);
});

test('a single second with more than a page blocks as unstable tie', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 });
  state = applyCountResult(state, 50); // one second, > pageSize, cannot split
  const action = nextEnumerationAction(state);
  assert.equal(action.type, 'blocked');
  if (action.type === 'blocked') assert.equal(action.reason, 'BLOCKED_UNSTABLE_TIE');
  assert.equal(isEnumerationComplete(state), false);
});

test('an adjacent-second window partitions exactly and can still block deeper', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + 1000 });
  state = applyCountResult(state, 50); // splits into [T0,T0] and [T0+1s,T0+1s]
  const first = nextEnumerationAction(state);
  assert.equal(first.type, 'count');
  if (first.type === 'count') {
    assert.equal(first.window.fromMs, T0);
    assert.equal(first.window.toMs, T0);
  }
  state = applyCountResult(state, 40); // the single second still exceeds a page
  assert.equal(nextEnumerationAction(state).type, 'blocked');
});

test('state survives JSON round-trip (checkpoint resumability)', () => {
  let state = initialEnumerationState({ fromMs: T0, toMs: T0 + 2 * HOUR });
  state = applyCountResult(state, 100);
  const revived = JSON.parse(JSON.stringify(state)) as EnumerationState;
  const action = nextEnumerationAction(revived);
  assert.equal(action.type, 'count');
  const advanced = applyCountResult(revived, 5);
  assert.equal(nextEnumerationAction(advanced).type, 'list');
});

test('rejects out-of-order apply calls', () => {
  const state = initialEnumerationState({ fromMs: T0, toMs: T0 + HOUR });
  assert.throws(() => applyListResult(state));
  const counted = applyCountResult(state, 5);
  assert.throws(() => applyCountResult(counted, 5));
});

test('rejects invalid windows and page sizes', () => {
  assert.throws(() => initialEnumerationState({ fromMs: T0 + 1000, toMs: T0 }));
  assert.throws(() => initialEnumerationState({ fromMs: T0, toMs: T0 + 1000 }, 0));
});
