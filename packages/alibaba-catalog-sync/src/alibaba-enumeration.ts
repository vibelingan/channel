/**
 * Full-catalog enumeration via modified-time window bisection
 * (ARCHITECTURE §11; algorithm verified in
 * docs/accio-alibaba-integration/REPORT.md §4.3).
 *
 * `product.list` pages 30 items and only reaches the 5,000th item, with no
 * documented stable secondary sort — so pagination past page one is unsafe.
 * Instead every window is bisected until `total_item <= pageSize`, and only
 * the FIRST page of each terminal bucket is fetched. Adjacent windows share
 * their boundary second; duplicates are absorbed downstream by deterministic
 * document ids.
 *
 * The machine is a pure, serializable work stack so MIU 11 checkpoints can
 * persist it mid-run and resume on a later invocation.
 */

export interface EnumerationWindow {
  /** Inclusive lower bound, epoch ms (second-aligned). */
  fromMs: number;
  /** Inclusive upper bound, epoch ms (second-aligned). */
  toMs: number;
}

interface PendingWindow {
  window: EnumerationWindow;
  /** Set once counted; a counted window <= pageSize is ready to list. */
  totalItems?: number;
}

export interface EnumerationState {
  pageSize: number;
  pending: PendingWindow[];
  blocked?: 'BLOCKED_UNSTABLE_TIE';
}

export type EnumerationAction =
  | { type: 'count'; window: EnumerationWindow }
  | { type: 'list'; window: EnumerationWindow }
  | { type: 'blocked'; reason: 'BLOCKED_UNSTABLE_TIE'; window: EnumerationWindow }
  | { type: 'done' };

const SECOND_MS = 1000;

function alignToSecond(ms: number): number {
  return Math.floor(ms / SECOND_MS) * SECOND_MS;
}

export function initialEnumerationState(
  window: EnumerationWindow,
  pageSize = 30,
): EnumerationState {
  const fromMs = alignToSecond(window.fromMs);
  const toMs = alignToSecond(window.toMs);
  if (toMs < fromMs) throw new Error('enumeration window end precedes start');
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0)
    throw new Error('pageSize must be a positive integer');
  return { pageSize, pending: [{ window: { fromMs, toMs } }] };
}

export function nextEnumerationAction(state: EnumerationState): EnumerationAction {
  const top = state.pending[state.pending.length - 1];
  if (state.blocked && top) {
    return { type: 'blocked', reason: state.blocked, window: top.window };
  }
  if (!top) return { type: 'done' };
  if (top.totalItems === undefined) return { type: 'count', window: top.window };
  return { type: 'list', window: top.window };
}

/**
 * Record a count result for the window the machine just asked to count.
 * Returns a NEW state; never mutates.
 */
export function applyCountResult(state: EnumerationState, totalItems: number): EnumerationState {
  const top = state.pending[state.pending.length - 1];
  if (!top || top.totalItems !== undefined) {
    throw new Error('applyCountResult called out of order');
  }
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) {
    throw new Error('totalItems must be a non-negative integer');
  }
  const rest = state.pending.slice(0, -1);
  if (totalItems === 0) {
    return { ...state, pending: rest };
  }
  if (totalItems <= state.pageSize) {
    return { ...state, pending: [...rest, { window: top.window, totalItems }] };
  }
  const { fromMs, toMs } = top.window;
  if (toMs === fromMs) {
    // A single second holds more items than one page and there is no stable
    // cursor contract — enumerating it would silently drop items. Hard block
    // (REPORT.md §4.3 step 3).
    return { ...state, blocked: 'BLOCKED_UNSTABLE_TIE' };
  }
  let lower: PendingWindow;
  let upper: PendingWindow;
  if (toMs - fromMs === SECOND_MS) {
    // Two adjacent seconds partition exactly; no boundary sharing needed.
    lower = { window: { fromMs, toMs: fromMs } };
    upper = { window: { fromMs: toMs, toMs } };
  } else {
    let midMs = alignToSecond(fromMs + (toMs - fromMs) / 2);
    if (midMs <= fromMs) midMs = fromMs + SECOND_MS; // guarantee progress
    // Halves share the boundary second on purpose: the endpoint-inclusion
    // semantics of gmt_modified filters are undocumented, so overlap + dedupe
    // beats a potential gap.
    lower = { window: { fromMs, toMs: midMs } };
    upper = { window: { fromMs: midMs, toMs } };
  }
  // LIFO order scans the EARLIER half first.
  return { ...state, pending: [...rest, upper, lower] };
}

/** Record that the listable top window's first page was fetched and persisted. */
export function applyListResult(state: EnumerationState): EnumerationState {
  const top = state.pending[state.pending.length - 1];
  if (!top || top.totalItems === undefined) {
    throw new Error('applyListResult called out of order');
  }
  return { ...state, pending: state.pending.slice(0, -1) };
}

export function isEnumerationComplete(state: EnumerationState): boolean {
  return !state.blocked && state.pending.length === 0;
}
