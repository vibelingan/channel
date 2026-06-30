/**
 * Media lifecycle helpers — pure, dependency-free domain logic shared by the
 * admin function, the storage adapter, and cleanup paths.
 *
 * Two responsibilities:
 *  1. Opportunistic cleanup selection (the "piggyback reaper"): choose which
 *     expired `pending` media rows to sweep on each intent-create, so abuse
 *     cleanup runs WITHOUT a dedicated scheduler (design §20.13 decision —
 *     replaces the §27.2-1 Scheduler Agent Supervisor item).
 *  2. Quarantine status-transition validation: enforce the legal
 *     `pending -> active|failed|deleted`, `active -> deleted`, ... state machine
 *     so a row can never jump to `active` without passing verification
 *     (§27.2-3 / MIU-12 groundwork).
 *
 * See docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.13 and §27.2.
 */
import type { MediaStatus } from './media.ts';

/** Minimal shape a row needs to be considered for an opportunistic sweep. */
export interface SweepCandidate {
  _id: string;
  status: MediaStatus;
  /** ISO-8601 expiry; absent means the row has no expiry and is never swept here. */
  uploadExpiresAt?: string;
  /** Durable storage id (`cloud://…`); present once bytes were minted/landed. */
  storageFileId?: string;
}

export interface SweepSelection {
  /** Doc ids to mark `deleted`/`failed` after their storage objects are removed. */
  docIds: string[];
  /** Storage objects to delete first; the subset of swept docs that have one. */
  storageFileIds: string[];
}

function expiryMs(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function isExpired(iso: string | undefined, nowMs: number): boolean {
  const ms = expiryMs(iso);
  return Number.isFinite(ms) && ms < nowMs;
}

/**
 * Select expired `pending` rows to reap, oldest-expiry first, capped at `limit`.
 * Pure and deterministic: callers pass a bounded candidate page and `now`.
 *
 * A row is swept only when it is still `pending` AND has an `uploadExpiresAt`
 * strictly before `now`. Rows without an expiry, with an unparseable expiry, or
 * already active/failed/deleted are never swept here: active rows are real
 * assets, and failed/deleted are handled by their own paths. The boundary is
 * strict (`expiry === now` is not yet expired) so a just-minted intent is never
 * reaped by its own create call.
 */
export function selectExpiredPendingForSweep(
  candidates: readonly SweepCandidate[],
  now: Date,
  limit: number,
): SweepSelection {
  if (!Number.isFinite(limit) || limit <= 0) return { docIds: [], storageFileIds: [] };
  const nowMs = now.getTime();

  const expired = candidates
    .filter((c) => c.status === 'pending' && isExpired(c.uploadExpiresAt, nowMs))
    .sort((a, b) => expiryMs(a.uploadExpiresAt) - expiryMs(b.uploadExpiresAt))
    .slice(0, Math.trunc(limit));

  const docIds = expired.map((c) => c._id);
  const storageFileIds = expired
    .map((c) => c.storageFileId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return { docIds, storageFileIds };
}

/**
 * Legal media lifecycle transitions (quarantine state machine). A storage-backed
 * row starts `pending` and may only become `active` after verification, or
 * `failed`/`deleted` otherwise. `active` and `failed` may later be `deleted`.
 * `deleted` is terminal. Same-state is allowed as an idempotent no-op so retried
 * writes do not falsely fail.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<MediaStatus, readonly MediaStatus[]>> = {
  pending: ['active', 'failed', 'deleted'],
  active: ['deleted'],
  failed: ['deleted'],
  deleted: [],
};

/** True if `to` is reachable from `from` (same-state allowed as idempotent). */
export function isValidMediaStatusTransition(from: MediaStatus, to: MediaStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
