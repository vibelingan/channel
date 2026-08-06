/**
 * Reserve-first rate limiting for this function's unauthenticated surfaces
 * (OAuth callback, failed starts) — the same rateLimitHits ledger pattern as
 * the admin function's login/recover throttles (R1 L8): WRITE the hit, COUNT
 * within the fixed window, ROLL BACK on deny. Fails safe: over-reject under
 * contention, never over-admit; a failed rollback only makes the window
 * stricter.
 */
import { createHash } from 'node:crypto';
import { list, remove } from '@vibelingan-channel/db';
import {
  type FilterClause,
  PUBLIC_RATE_WINDOW_MS,
  RATE_LIMIT_HITS_SWEEP_LIMIT,
  evaluateFixedWindowRateLimit,
} from '@vibelingan-channel/shared';
import { createDoc } from './repo.ts';

export const OAUTH_CALLBACK_RATE_MAX_PER_SOURCE = 10;
export const OAUTH_CALLBACK_RATE_MAX_GLOBAL = 60;

export function hashSourceIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(ip).digest('hex');
}

async function countHits(clauses: FilterClause[]): Promise<number> {
  const result = await list({
    collection: 'rateLimitHits',
    page: 1,
    pageSize: 1,
    filter: { combinator: 'and', clauses },
  });
  return result.total;
}

/**
 * Bounded opportunistic GC of expired ledger rows (blessing-gate P2), mirroring
 * the admin function's sweep. Without it this ledger only ever GROWS: every
 * callback hit is a permanent row, and since the counting query is a filtered
 * `total` over the same collection, an unbounded ledger degrades the very
 * check that gates the unauthenticated endpoint. Best-effort — a sweep failure
 * must never block or fail the request.
 */
async function sweepExpiredHits(windowStartIso: string): Promise<void> {
  try {
    const stale = await list({
      collection: 'rateLimitHits',
      page: 1,
      pageSize: RATE_LIMIT_HITS_SWEEP_LIMIT,
      filter: {
        combinator: 'and',
        clauses: [{ field: 'createdAt', op: 'lt', value: windowStartIso }],
      },
      sort: [{ field: 'createdAt', dir: 'asc' }],
    });
    for (const row of stale.items) {
      await remove('rateLimitHits', String(row._id)).catch((e) =>
        console.error('[alibaba-catalog-sync] stale rate-limit row reap failed', e),
      );
    }
  } catch (error) {
    console.error('[alibaba-catalog-sync] rate-limit sweep failed', error);
  }
}

export interface RateLimitDenied {
  denied: true;
  retryAfterSeconds: number;
}

/** Null = proceed. Denial carries Retry-After seconds. */
export async function enforceOAuthRateLimit(opts: {
  scope: string;
  sourceHash: string | undefined;
  nowMs: number;
}): Promise<RateLimitDenied | null> {
  const { scope, sourceHash, nowMs } = opts;
  const windowStartIso = new Date(
    Math.floor(nowMs / PUBLIC_RATE_WINDOW_MS) * PUBLIC_RATE_WINDOW_MS,
  ).toISOString();
  // Sweep BEFORE reserving, exactly as the admin ledger does.
  await sweepExpiredHits(windowStartIso);
  const reserved = await createDoc('rateLimitHits', {
    scope,
    sourceHash: sourceHash ?? '',
    createdAt: new Date(nowMs).toISOString(),
  });
  const rollback = (): Promise<void> =>
    remove('rateLimitHits', reserved._id)
      .then(() => undefined)
      .catch((e) => console.error(`[alibaba-catalog-sync] ${scope}: rollback failed`, e));

  const inWindow: FilterClause[] = [
    { field: 'scope', op: 'eq', value: scope },
    { field: 'createdAt', op: 'gte', value: windowStartIso },
  ];
  const globalRate = evaluateFixedWindowRateLimit({
    countInWindow: await countHits(inWindow),
    maxPerWindow: OAUTH_CALLBACK_RATE_MAX_GLOBAL,
    windowMs: PUBLIC_RATE_WINDOW_MS,
    nowMs,
  });
  if (!globalRate.allowed) {
    await rollback();
    return { denied: true, retryAfterSeconds: globalRate.retryAfterSeconds };
  }
  if (sourceHash) {
    const sourceRate = evaluateFixedWindowRateLimit({
      countInWindow: await countHits([
        ...inWindow,
        { field: 'sourceHash', op: 'eq', value: sourceHash },
      ]),
      maxPerWindow: OAUTH_CALLBACK_RATE_MAX_PER_SOURCE,
      windowMs: PUBLIC_RATE_WINDOW_MS,
      nowMs,
    });
    if (!sourceRate.allowed) {
      await rollback();
      return { denied: true, retryAfterSeconds: sourceRate.retryAfterSeconds };
    }
  }
  return null;
}
