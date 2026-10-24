/**
 * Durable, secret-free OAuth attempt trail.
 *
 * WHY THIS EXISTS: `startOAuth()` calls `sweepExpiredStates()` before minting a
 * new state, so the next Connect deletes the previous attempt's only record.
 * After a failed merchant test there was nothing left to say whether Alibaba
 * ever returned the browser to our callback — the single most important fact
 * for deciding whether the problem is on their side or ours.
 *
 * These rows outlive the 10-minute state TTL and answer exactly one question:
 * how far did this attempt get? They deliberately hold NOTHING sensitive — no
 * raw state, no authorization code, no token, no signature, no full URL, no
 * cookies, no IP. Only a random attempt id, timestamps, an outcome, and the
 * NAMES (never values) of the authorization parameters we sent.
 *
 * Every write is best-effort: diagnostics must never break authorization.
 */
import { randomUUID } from 'node:crypto';
import { createDocWithId, getDoc, listDocs, removeDoc, updateDoc } from './repo.ts';

export const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ATTEMPT_SWEEP_LIMIT = 20;

/**
 * Ordered outcomes. Each names the boundary the flow reached, so a stuck
 * attempt points at the layer to investigate rather than a generic failure.
 */
export type AttemptStatus =
  | 'started'
  | 'callback_received'
  | 'rejected_missing_params'
  | 'rejected_unknown_state'
  | 'rejected_expired_state'
  | 'rejected_replayed_state'
  | 'exchange_started'
  | 'exchange_failed_transport'
  | 'exchange_failed_response'
  | 'connected';

export interface StartAttemptInput {
  requestedByUserId: string;
  now: string;
  /** Which authorization shape was sent, e.g. 'force_auth-only-2026-08-31'. */
  authorizationVariant: string;
  authorizationHost: string;
  /** Parameter NAMES only — never values, several of which are secret. */
  authorizationParameterNames: string[];
}

/** Returns the attempt id, or '' when diagnostics are unavailable. */
export async function startAttempt(input: StartAttemptInput): Promise<string> {
  const attemptId = randomUUID();
  try {
    await sweepExpiredAttempts(input.now);
    const created = await createDocWithId('alibabaOAuthAttempts', attemptId, {
      requestedByUserId: input.requestedByUserId,
      status: 'started' satisfies AttemptStatus,
      failureCategory: '',
      authorizationVariant: input.authorizationVariant,
      authorizationHost: input.authorizationHost,
      // Sorted + joined so the stored value is stable and diffable.
      authorizationParameterNames: [...input.authorizationParameterNames].sort().join(','),
      startedAt: input.now,
      callbackReceivedAt: '',
      exchangeStartedAt: '',
      completedAt: '',
      expiresAt: new Date(Date.parse(input.now) + ATTEMPT_RETENTION_MS).toISOString(),
      lastUpdatedAt: input.now,
    });
    if (created !== 'created') return '';
    return attemptId;
  } catch (error) {
    console.error('[alibaba-catalog-sync] attempt-start diagnostics failed:', error);
    return '';
  }
}

export interface AdvanceAttemptInput {
  attemptId: string;
  status: AttemptStatus;
  now: string;
  /** Short, non-secret category such as 'http-500' or 'unparseable-grant'. */
  failureCategory?: string;
}

/** Best-effort transition. A missing or unknown attempt id is a silent no-op. */
export async function advanceAttempt(input: AdvanceAttemptInput): Promise<void> {
  if (!input.attemptId) return;
  try {
    const patch: Record<string, unknown> = {
      status: input.status,
      lastUpdatedAt: input.now,
    };
    if (input.failureCategory !== undefined) patch.failureCategory = input.failureCategory;
    if (input.status === 'callback_received') patch.callbackReceivedAt = input.now;
    if (input.status === 'exchange_started') patch.exchangeStartedAt = input.now;
    if (input.status === 'connected') patch.completedAt = input.now;
    await updateDoc('alibabaOAuthAttempts', input.attemptId, patch);
  } catch (error) {
    console.error('[alibaba-catalog-sync] attempt-advance diagnostics failed:', error);
  }
}

/**
 * Retention sweep, deliberately separate from the STATE sweep: states expire in
 * 10 minutes, these survive a week so a Monday failure is still readable on
 * Friday.
 */
async function sweepExpiredAttempts(now: string): Promise<void> {
  try {
    const page = await listDocs('alibabaOAuthAttempts', ATTEMPT_SWEEP_LIMIT);
    for (const doc of page) {
      if (typeof doc.expiresAt === 'string' && doc.expiresAt !== '' && doc.expiresAt < now) {
        await removeDoc('alibabaOAuthAttempts', doc._id);
      }
    }
  } catch {
    // Hygiene only — never blocks an authorization.
  }
}

/** Admin-facing view. Redaction is structural: only these fields are read. */
export async function recentAttempts(limit = 10): Promise<Record<string, unknown>[]> {
  const docs = await listDocs('alibabaOAuthAttempts', Math.min(Math.max(limit, 1), 50));
  return docs
    .map((doc) => ({
      attemptId: doc._id,
      status: doc.status ?? 'unknown',
      failureCategory: doc.failureCategory ?? '',
      authorizationVariant: doc.authorizationVariant ?? '',
      authorizationHost: doc.authorizationHost ?? '',
      authorizationParameterNames: doc.authorizationParameterNames ?? '',
      startedAt: doc.startedAt ?? '',
      callbackReceivedAt: doc.callbackReceivedAt ?? '',
      exchangeStartedAt: doc.exchangeStartedAt ?? '',
      completedAt: doc.completedAt ?? '',
    }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Reads the attempt id recorded on a consumed state, if diagnostics stored one. */
export async function attemptIdForStateHash(stateHash: string): Promise<string> {
  try {
    const record = await getDoc('alibabaOAuthStates', stateHash);
    const value = record?.attemptId;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
