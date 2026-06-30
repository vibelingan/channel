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
  /** Seconds the caller should wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate-limit decision. `countInWindow` is the count AFTER this
 * request was counted (i.e. the value the atomic increment returned), so the
 * request is allowed iff `countInWindow <= maxPerWindow`.
 *
 * Retry-After is the time until the window resets: `windowResetAtMs` if provided,
 * otherwise an epoch-aligned fixed window (`ceil(now/windowMs)` boundary), which
 * matches a counter keyed by `floor(now / windowMs)`.
 *
 * Fails CLOSED (deny) on misconfiguration (non-positive/non-finite limits or a
 * non-finite count) rather than letting a config bug disable the limiter.
 */
export function evaluateFixedWindowRateLimit(input: {
  countInWindow: number;
  maxPerWindow: number;
  windowMs: number;
  nowMs?: number;
  windowResetAtMs?: number;
}): RateLimitDecision {
  const { countInWindow, maxPerWindow, windowMs } = input;
  const nowMs = input.nowMs ?? Date.now();

  const windowOk = Number.isFinite(windowMs) && windowMs > 0;
  const maxOk = Number.isFinite(maxPerWindow) && maxPerWindow > 0;
  const countOk = Number.isFinite(countInWindow);

  const resetAtMs =
    input.windowResetAtMs ??
    (windowOk ? (Math.floor(nowMs / windowMs) + 1) * windowMs : nowMs + 1000);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  // Misconfig or unreadable count → fail closed.
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
 * stays within `maxPending` (i.e. `currentPending < maxPending`). Fails CLOSED on
 * a non-positive/non-finite max or unreadable count.
 */
export function withinPendingCap(currentPending: number, maxPending: number): boolean {
  if (!Number.isFinite(maxPending) || maxPending <= 0) return false;
  if (!Number.isFinite(currentPending)) return false;
  return currentPending < maxPending;
}
