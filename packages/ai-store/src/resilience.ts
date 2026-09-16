/**
 * Telling a database outage apart from a mistake.
 *
 * TencentDB restarts for maintenance, fails over, and the network between
 * CloudRun and the database can drop. Those failures pass on their own, so the
 * services should wait them out: exiting only turns a thirty-second blip into a
 * restart loop that cannot fix the database. Everything else, such as a wrong
 * password, a missing certificate, a database that does not exist or a broken
 * query, is a mistake, and retrying it forever would hide it behind a service
 * that never becomes ready.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { migrateUp } from './migrations.ts';
import type { AiStore } from './store.ts';

/** Socket-level failures: the database host is down, unreachable or went away. */
const UNREACHABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * PostgreSQL codes for a server that is shutting down, starting up or out of
 * connection slots. Class 08, connection exception, is matched as a whole.
 */
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

/** pg raises these without a code when a connection dies or cannot open in time. */
const UNAVAILABLE_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /not queryable/i,
];

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => isDatabaseUnavailable(inner));
  }
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code !== undefined) {
    return (
      UNREACHABLE_NETWORK_CODES.has(code) ||
      UNAVAILABLE_SQLSTATES.has(code) ||
      code.startsWith('08')
    );
  }
  return UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(error.message));
}

export interface WaitForDatabaseOptions {
  /** Pause before each retry; the last value repeats once the list runs out. */
  delaysMs?: readonly number[];
  /** Ends the wait, for example when the process is asked to shut down. */
  signal?: AbortSignal;
  /** Called after each failed attempt that is about to be retried. */
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Apply the migrations and prove the store answers, waiting out an unreachable
 * database for as long as it takes. Rejects at once on any other failure, and
 * when `signal` aborts.
 */
export async function waitForDatabase(
  store: AiStore,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;
  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      await migrateUp(store.pool);
      await store.health();
      return;
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      options.onRetry?.(attempt, error);
      await sleep(delays[Math.min(attempt, delays.length) - 1], undefined, {
        signal: options.signal,
      });
    }
  }
}
