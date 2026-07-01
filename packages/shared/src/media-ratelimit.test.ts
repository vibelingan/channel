import { strict as assert } from 'node:assert';
import test from 'node:test';
import { evaluateFixedWindowRateLimit, withinPendingCap } from './media-ratelimit.ts';

// --- evaluateFixedWindowRateLimit ------------------------------------------

test('allows requests within the window budget', () => {
  const d = evaluateFixedWindowRateLimit({ countInWindow: 3, maxPerWindow: 5, windowMs: 60_000 });
  assert.deepEqual(d, { allowed: true, retryAfterSeconds: 0 });
});

test('allows exactly at the limit (count == max)', () => {
  const d = evaluateFixedWindowRateLimit({ countInWindow: 5, maxPerWindow: 5, windowMs: 60_000 });
  assert.equal(d.allowed, true);
});

test('denies over the limit with an epoch-aligned Retry-After', () => {
  // nowMs=1000 is 1s into the epoch-aligned 60s window → resets at 60000 → 59s.
  const d = evaluateFixedWindowRateLimit({
    countInWindow: 6,
    maxPerWindow: 5,
    windowMs: 60_000,
    nowMs: 1000,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSeconds, 59);
});

test('uses an explicit windowResetAtMs when provided', () => {
  const d = evaluateFixedWindowRateLimit({
    countInWindow: 9,
    maxPerWindow: 5,
    windowMs: 60_000,
    nowMs: 1000,
    windowResetAtMs: 3500,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSeconds, 3); // ceil((3500-1000)/1000)
});

test('Retry-After is never below 1 second', () => {
  const d = evaluateFixedWindowRateLimit({
    countInWindow: 6,
    maxPerWindow: 5,
    windowMs: 60_000,
    nowMs: 59_999, // resets at 60000 → 1ms away → 1s floor
  });
  assert.equal(d.retryAfterSeconds, 1);
});

test('fails closed on bad counters/limits (deny; never opens)', () => {
  const bad = [
    { countInWindow: 1, maxPerWindow: 0, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: -5, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: Number.NaN, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: 5.5, windowMs: 60_000 }, // fractional max
    { countInWindow: 1, maxPerWindow: 5, windowMs: 0 },
    { countInWindow: 1, maxPerWindow: 5, windowMs: Number.NaN },
    { countInWindow: 1, maxPerWindow: 5, windowMs: 60_000.5 }, // fractional window
    { countInWindow: Number.NaN, maxPerWindow: 5, windowMs: 60_000 },
    { countInWindow: -1, maxPerWindow: 5, windowMs: 60_000 }, // negative count
    { countInWindow: 0, maxPerWindow: 5, windowMs: 60_000 }, // post-increment min is 1
    { countInWindow: 2.5, maxPerWindow: 5, windowMs: 60_000 }, // fractional count
  ];
  for (const b of bad) {
    const d = evaluateFixedWindowRateLimit(b);
    assert.equal(d.allowed, false, JSON.stringify(b));
    assert.ok(Number.isInteger(d.retryAfterSeconds) && d.retryAfterSeconds >= 1, JSON.stringify(b));
  }
});

test('malformed time inputs still yield a finite integer Retry-After on deny', () => {
  for (const t of [
    { nowMs: Number.NaN },
    { nowMs: Number.POSITIVE_INFINITY },
    { windowResetAtMs: Number.NaN },
    { windowResetAtMs: Number.POSITIVE_INFINITY },
  ]) {
    const d = evaluateFixedWindowRateLimit({
      countInWindow: 9,
      maxPerWindow: 5,
      windowMs: 60_000,
      ...t,
    });
    assert.equal(d.allowed, false);
    assert.ok(Number.isInteger(d.retryAfterSeconds) && d.retryAfterSeconds >= 1, JSON.stringify(t));
  }
});

// --- withinPendingCap -------------------------------------------------------

test('pending cap: allows below max, denies at/above', () => {
  assert.equal(withinPendingCap(0, 3), true);
  assert.equal(withinPendingCap(2, 3), true);
  assert.equal(withinPendingCap(3, 3), false); // creating the 4th would exceed
  assert.equal(withinPendingCap(9, 3), false);
});

test('pending cap fails closed on bad max or count', () => {
  assert.equal(withinPendingCap(0, 0), false);
  assert.equal(withinPendingCap(0, -1), false);
  assert.equal(withinPendingCap(0, Number.NaN), false);
  assert.equal(withinPendingCap(0, 3.5), false); // fractional max
  assert.equal(withinPendingCap(Number.NaN, 3), false);
  assert.equal(withinPendingCap(-1, 3), false); // negative count
  assert.equal(withinPendingCap(1.5, 3), false); // fractional count
});
