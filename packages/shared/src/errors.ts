/** Stable, machine-readable error codes returned by backend actions. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'UNKNOWN_COLLECTION',
  'CONFLICT',
  'RATE_LIMITED',
  /** Temporary contention: nothing was saved, and the same request may be retried. */
  'BUSY',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
