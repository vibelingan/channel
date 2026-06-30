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

test('fails closed on misconfiguration (denies, never opens)', () => {
  for (const bad of [
    { countInWindow: 1, maxPerWindow: 0, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: -5, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: Number.NaN, windowMs: 60_000 },
    { countInWindow: 1, maxPerWindow: 5, windowMs: 0 },
    { countInWindow: 1, maxPerWindow: 5, windowMs: Number.NaN },
    { countInWindow: Number.NaN, maxPerWindow: 5, windowMs: 60_000 },
  ]) {
    const d = evaluateFixedWindowRateLimit(bad);
    assert.equal(d.allowed, false, JSON.stringify(bad));
    assert.ok(d.retryAfterSeconds >= 1, JSON.stringify(bad));
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
  assert.equal(withinPendingCap(Number.NaN, 3), false);
});
