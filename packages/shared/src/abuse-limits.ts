/**
 * Abuse-control limits for the UNAUTHENTICATED admin-function endpoints
 * (`login`, `recover`, `submitProject`). These have no session and no natural
 * reservation row, so the handler enforces them over a dedicated
 * `rateLimitHits` collection using the SAME reserve-first fixed-window
 * machinery as the OEM upload-intent path (`evaluateFixedWindowRateLimit`).
 *
 * Two layers per scope, mirroring the OEM caps:
 *
 *  - **Per-source** (`*_RATE_MAX_PER_SOURCE`): the primary throttle, keyed by a
 *    SHA-256 of the client IP. An attacker only throttles their OWN source — a
 *    single hostile IP can never exhaust another user's budget. This is the
 *    lockout-safe layer the review demanded ("prefer per-source; a naive
 *    per-account lock enables attacker-driven lockout DoS").
 *
 *  - **Global backstop** (`*_RATE_MAX_GLOBAL`): a high emergency ceiling on the
 *    scope as a whole, enforced regardless of source. CloudBase may not expose a
 *    trusted client IP (a spoofed / absent `x-forwarded-for` collapses every
 *    request into the source-less bucket), so a per-source-only limiter could be
 *    trivially bypassed by IP rotation. The global ceiling bounds that, and is
 *    deliberately set FAR above real low-volume B2B-admin traffic so it only
 *    trips under a genuine flood. Crucially it returns a TEMPORARY 429 that the
 *    fixed window self-heals every `PUBLIC_RATE_WINDOW_MS` — it never mutates an
 *    account or persists a lock, so even a sustained global flood degrades to a
 *    brief, self-recovering availability dip, never a permanent lockout.
 *
 * Values are pure numbers so the limiter logic stays unit-testable and the
 * thresholds live with their meaning rather than buried in the handler.
 */

/** Fixed rate-limit window for the public endpoints (epoch-aligned). */
export const PUBLIC_RATE_WINDOW_MS = 60 * 1000;

/**
 * Password login. Generous for a human (typos, a shared office NAT), tight for
 * brute force — and argon2id verify cost is an additional per-attempt brake.
 */
export const LOGIN_RATE_MAX_PER_SOURCE = 10;
export const LOGIN_RATE_MAX_GLOBAL = 300;

/**
 * Password recovery. Rotates a live credential + emails it, so it is kept tight
 * per source; the endpoint ALSO keeps a per-account cooldown (`lastRecoverAt`)
 * so a victim's password cannot be churned even from many sources.
 */
export const RECOVER_RATE_MAX_PER_SOURCE = 5;
export const RECOVER_RATE_MAX_GLOBAL = 60;

/**
 * Public OEM enquiry submit. A real B2B OEM form is very low-volume; the tight
 * per-source cap is what bounds the "email a caller-chosen address" reputation
 * bomb. Matches the OEM upload-intent per-source rate (`OEM_UPLOAD_RATE_MAX_PER_WINDOW`).
 */
export const SUBMIT_PROJECT_RATE_MAX_PER_SOURCE = 5;
export const SUBMIT_PROJECT_RATE_MAX_GLOBAL = 60;

/**
 * How many stale `rateLimitHits` rows a single request may opportunistically
 * reap (rows whose window has already elapsed can never be counted again).
 * Bounded so the self-heal GC never turns one request into a large delete storm.
 */
export const RATE_LIMIT_HITS_SWEEP_LIMIT = 20;
