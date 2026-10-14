/** Shared retry rules for the copier and private preparation inspection. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const PERMANENT_FAILURES = new Set([
  'invalid-url',
  'host-not-allowed',
  'too-many-redirects',
  'not-found',
  'too-large',
  'bad-content',
]);

export function isPermanentAlibabaPhotoFailure(reason: unknown, attempts: number): boolean {
  return (
    (typeof reason === 'string' && PERMANENT_FAILURES.has(reason)) ||
    (Number.isSafeInteger(attempts) && attempts >= MAX_ATTEMPTS)
  );
}

/** A valid failure record can supersede an older product-level summary. */
export function readAlibabaPhotoFailure(
  link: Record<string, unknown>,
  nowMs: number,
  retryBeforeMs: number | null = null,
): { state: 'unusable' | 'waiting' | null; attempts: number; recorded: boolean } {
  const failedAt = typeof link.failedAt === 'string' ? Date.parse(link.failedAt) : Number.NaN;
  if (!Number.isFinite(failedAt)) return { state: null, attempts: 0, recorded: false };
  const attempts =
    typeof link.failureAttempts === 'number' &&
    Number.isSafeInteger(link.failureAttempts) &&
    link.failureAttempts > 0
      ? link.failureAttempts
      : 1;
  // A manual run retries once; its fixed cutoff prevents retries on every resumed call.
  if (retryBeforeMs !== null && failedAt < retryBeforeMs)
    return { state: null, attempts, recorded: true };
  if (isPermanentAlibabaPhotoFailure(link.failureReason, attempts))
    return { state: 'unusable', attempts, recorded: true };
  return { state: nowMs - failedAt < RETRY_AFTER_MS ? 'waiting' : null, attempts, recorded: true };
}
