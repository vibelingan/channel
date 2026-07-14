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
import { MEDIA_STATUSES, type MediaStatus } from './media.ts';

/** Minimal shape a row needs to be considered for an opportunistic sweep. */
export interface SweepCandidate {
  _id: string;
  status: MediaStatus;
  /** ISO-8601 expiry; absent means the row has no expiry and is never swept here. */
  uploadExpiresAt?: string;
  /** Durable storage id (`cloud://…`); present once bytes were minted/landed. */
  storageFileId?: string;
}

/** One selected row, with its doc id paired to its storage object (if any). */
export interface SweepItem {
  docId: string;
  /** The expiry that made this row eligible (ISO-8601). */
  uploadExpiresAt: string;
  /** Durable storage id to delete first; absent if the intent never minted one. */
  storageFileId?: string;
}

export interface SweepSelection {
  /**
   * Selected rows, oldest-expiry first, doc↔object pairing PRESERVED. This is the
   * authoritative output: a caller deleting storage objects must iterate `items`
   * (or `storageObjects`) so a failed `deleteObject` can be mapped back to its
   * doc and that doc kept retryable — never blindly mark all `docIds` deleted on
   * a partial failure (that is the MIU-06 cleanup false-success class).
   */
  items: SweepItem[];
  /** Convenience: every swept doc id, in `items` order. Safe only when every object delete succeeds. */
  docIds: string[];
  /** Convenience: only the swept items that have a storage object, paired. */
  storageObjects: Array<{ docId: string; storageFileId: string }>;
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
  if (!Number.isFinite(limit) || limit <= 0) return { items: [], docIds: [], storageObjects: [] };
  const nowMs = now.getTime();

  const expired = candidates
    .filter((c) => c.status === 'pending' && isExpired(c.uploadExpiresAt, nowMs))
    .sort((a, b) => expiryMs(a.uploadExpiresAt) - expiryMs(b.uploadExpiresAt))
    .slice(0, Math.trunc(limit));

  const items: SweepItem[] = expired.map((c) => ({
    docId: c._id,
    // `isExpired` guaranteed a present, parseable expiry above.
    uploadExpiresAt: c.uploadExpiresAt as string,
    ...(typeof c.storageFileId === 'string' && c.storageFileId.length > 0
      ? { storageFileId: c.storageFileId }
      : {}),
  }));

  const docIds = items.map((i) => i.docId);
  const storageObjects = items
    .filter((i): i is SweepItem & { storageFileId: string } => typeof i.storageFileId === 'string')
    .map((i) => ({ docId: i.docId, storageFileId: i.storageFileId }));

  return { items, docIds, storageObjects };
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

/** Known media statuses, for fail-closed runtime validation of DB values. */
const VALID_STATUSES: ReadonlySet<string> = new Set(MEDIA_STATUSES);

/**
 * True if `to` is reachable from `from`. Fails CLOSED on values outside
 * `MEDIA_STATUSES` — these are runtime DB rows, not just compile-time types, so a
 * corrupt/unknown status is never a valid transition, not even same-state.
 * Same-state among known statuses is allowed as an idempotent no-op.
 */
export function isValidMediaStatusTransition(from: MediaStatus, to: MediaStatus): boolean {
  if (!VALID_STATUSES.has(from) || !VALID_STATUSES.has(to)) return false;
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
