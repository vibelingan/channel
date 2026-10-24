/**
 * Rate-limit & pending-cap decision logic for public upload-intent abuse control
 * (design §20.10 OEM intent caps; §27.2-2 / MIU-11). Pure and **constant-agnostic**:
 * the caller passes the observed counts and the limits, so the OEM (or any other)
 * thresholds live with their owning MIU, not here. The fiddly windowing /
 * Retry-After math is isolated and unit-tested.
 *
 * Intended call shape (MIU-08): the handler atomically increments a per-source
 * counter (`incrementField` — shared DB state, never per-instance memory) keyed
 * by an epoch-aligned window bucket, then asks these helpers to decide. On deny,
 * the handler returns HTTP 429 with `Retry-After: <retryAfterSeconds>`.
 *
 * See docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.10, §27.2-2.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying. 0 when allowed. Always an integer ≥ 1 on deny. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate-limit decision. `countInWindow` is the count AFTER this
 * request was counted (i.e. the value the atomic increment returned), so the
 * request is allowed iff `countInWindow <= maxPerWindow`.
 *
 * Retry-After is the time until the window resets: `windowResetAtMs` if provided,
 * otherwise an epoch-aligned fixed window (`ceil(now/windowMs)` boundary), which
 * matches a counter keyed by `floor(now / windowMs)`. It is always a finite
 * integer ≥ 1, even if `nowMs`/`windowResetAtMs` are missing or malformed.
 *
 * Fails CLOSED (deny) unless the counter integrity holds: `countInWindow` is an
 * integer ≥ 1 (it is post-increment), `maxPerWindow` and `windowMs` are positive
 * integers. This is the same non-negative-integer counter discipline hardened for
 * `incrementField`/`publishedRefCount` — a corrupt `-1`/fractional counter must
 * never disable the limiter.
 */
export function evaluateFixedWindowRateLimit(input: {
  countInWindow: number;
  maxPerWindow: number;
  windowMs: number;
  nowMs?: number;
  windowResetAtMs?: number;
}): RateLimitDecision {
  const { countInWindow, maxPerWindow, windowMs } = input;

  // Time inputs: guard so Retry-After is always a finite integer >= 1.
  const nowMs =
    typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const windowOk = Number.isInteger(windowMs) && windowMs > 0;
  const resetAtMs =
    typeof input.windowResetAtMs === 'number' && Number.isFinite(input.windowResetAtMs)
      ? input.windowResetAtMs
      : windowOk
        ? (Math.floor(nowMs / windowMs) + 1) * windowMs
        : nowMs + 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  // Counter integrity: safe non-negative integers or fail CLOSED.
  const maxOk = Number.isInteger(maxPerWindow) && maxPerWindow > 0;
  const countOk = Number.isInteger(countInWindow) && countInWindow >= 1; // post-increment
  if (!windowOk || !maxOk || !countOk) {
    return { allowed: false, retryAfterSeconds };
  }
  if (countInWindow <= maxPerWindow) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { allowed: false, retryAfterSeconds };
}

/**
 * Concurrent pending-intent cap. `currentPending` is how many `pending` intents
 * the source already holds (before creating this one); allowed iff adding one
 * stays within `maxPending` (`currentPending < maxPending`). Fails CLOSED unless
 * `maxPending` is a positive integer and `currentPending` is an integer ≥ 0 — a
 * corrupt `-1`/fractional count must never let an unbounded number through.
 */
export function withinPendingCap(currentPending: number, maxPending: number): boolean {
  const maxOk = Number.isInteger(maxPending) && maxPending > 0;
  const currentOk = Number.isInteger(currentPending) && currentPending >= 0;
  if (!maxOk || !currentOk) return false;
  return currentPending < maxPending;
}
