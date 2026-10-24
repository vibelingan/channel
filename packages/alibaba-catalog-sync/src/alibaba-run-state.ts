/**
 * Run lifecycle + scheduler decision math (ARCHITECTURE §10-§12, MIU 11).
 * Pure and fully deterministic: the function layer supplies instants and
 * counters; nothing here touches storage or clocks.
 *
 * Due-time semantics are MISSED-TICK-PROOF (R1 E6): the checkpoint persists
 * `nextFullDueAt`/`nextIncrementalDueAt` watermarks; a tick starts the
 * highest-priority job whose dueAt <= now, and the next due is recomputed
 * FROM THE SCHEDULE (never from `now`), so a delayed tick can never skip a
 * cycle. The weekly/4-hourly cadence lives here as UTC math and must never
 * migrate into the cron expression (SCF evaluates cron in UTC+8).
 */

export const RUN_SOFT_DEADLINE_MS = 720_000;
export const RUN_MAX_PRODUCTS_PER_INVOCATION = 200;
export const RUN_MAX_API_CALLS_PER_INVOCATION = 50;
export const RUN_MAX_CONTINUATIONS = 96;
export const RUN_MAX_AGE_MS = 24 * 3_600_000;

/** Sunday 18:30 UTC weekly full sync. */
export function computeNextFullDueAt(after: string): string {
  const base = new Date(after);
  const candidate = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 18, 30, 0, 0),
  );
  const daysUntilSunday = (7 - candidate.getUTCDay()) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday);
  if (candidate.getTime() <= base.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate.toISOString();
}

/** Every four hours at minute :15 UTC (00:15, 04:15, …, 20:15). */
export function computeNextIncrementalDueAt(after: string): string {
  const base = new Date(after);
  const candidate = new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      Math.floor(base.getUTCHours() / 4) * 4,
      15,
      0,
      0,
    ),
  );
  if (candidate.getTime() <= base.getTime()) {
    candidate.setTime(candidate.getTime() + 4 * 3_600_000);
  }
  return candidate.toISOString();
}

export interface SchedulerCheckpointView {
  activeRunId?: string;
  nextFullDueAt?: string;
  nextIncrementalDueAt?: string;
}

export type TickDecision =
  | { action: 'resume'; runId: string }
  | { action: 'start-full' }
  | { action: 'start-incremental' }
  | { action: 'idle' };

/** Resume-first; then full outranks incremental when both are due. */
export function decideTick(checkpoint: SchedulerCheckpointView, now: string): TickDecision {
  if (checkpoint.activeRunId) return { action: 'resume', runId: checkpoint.activeRunId };
  if (checkpoint.nextFullDueAt !== undefined && checkpoint.nextFullDueAt <= now) {
    return { action: 'start-full' };
  }
  if (checkpoint.nextIncrementalDueAt !== undefined && checkpoint.nextIncrementalDueAt <= now) {
    return { action: 'start-incremental' };
  }
  return { action: 'idle' };
}

// --- quarantine evaluation (§12, R1 denominators) ---------------------------

export interface QuarantineInput {
  /** Candidate linked-product changes this run. */
  candidateChanges: number;
  /** Linked-product count at run start (denominator). */
  linkedProductCount: number;
  /** Tombstone candidates after a complete full enumeration. */
  tombstoneCandidates: number;
  /** Active source count at run start (denominator). */
  activeSourceCount: number;
  parseFailures: number;
  itemsProcessed: number;
  /** Full enumeration completed with zero items while active sources > 0 (R1). */
  zeroItemFullWithActiveSources: boolean;
  signatureVectorFailed: boolean;
  responseContractFailed: boolean;
  unsupportedCurrency: boolean;
  rawEvidenceMissing: boolean;
  leaseOrFenceInvalid: boolean;
}

export interface QuarantineDecision {
  quarantine: boolean;
  reasons: string[];
}

function ratioTrips(count: number, floor: number, denominator: number, ratio: number): boolean {
  if (count < floor) return false;
  // A zero denominator never trips the RATIO guard; the absolute floor and
  // the dedicated zero-item trigger cover the degenerate catalogs (R1 E5).
  if (denominator <= 0) return false;
  return count / denominator > ratio;
}

export function evaluateQuarantine(input: QuarantineInput): QuarantineDecision {
  const reasons: string[] = [];
  if (ratioTrips(input.candidateChanges, 20, input.linkedProductCount, 0.3)) {
    reasons.push('candidate-change-surge');
  }
  if (ratioTrips(input.tombstoneCandidates, 5, input.activeSourceCount, 0.1)) {
    reasons.push('tombstone-surge');
  }
  if (ratioTrips(input.parseFailures, 5, input.itemsProcessed, 0.05)) {
    reasons.push('parse-failure-surge');
  }
  if (input.zeroItemFullWithActiveSources) reasons.push('zero-item-enumeration');
  if (input.signatureVectorFailed) reasons.push('signature-vector-failed');
  if (input.responseContractFailed) reasons.push('response-contract-failed');
  if (input.unsupportedCurrency) reasons.push('unsupported-currency');
  if (input.rawEvidenceMissing) reasons.push('raw-evidence-missing');
  if (input.leaseOrFenceInvalid) reasons.push('lease-invalid');
  return { quarantine: reasons.length > 0, reasons };
}

// --- run budget --------------------------------------------------------------

export interface RunBudget {
  startedAtMs: number;
  softDeadlineMs: number;
  productsProcessed: number;
  maxProducts: number;
  apiCalls: number;
  maxApiCalls: number;
}

export function newRunBudget(nowMs: number, overrides?: Partial<RunBudget>): RunBudget {
  return {
    startedAtMs: nowMs,
    softDeadlineMs: RUN_SOFT_DEADLINE_MS,
    productsProcessed: 0,
    maxProducts: RUN_MAX_PRODUCTS_PER_INVOCATION,
    apiCalls: 0,
    maxApiCalls: RUN_MAX_API_CALLS_PER_INVOCATION,
    ...overrides,
  };
}

export function budgetExhausted(budget: RunBudget, nowMs: number): boolean {
  return (
    nowMs - budget.startedAtMs >= budget.softDeadlineMs ||
    budget.productsProcessed >= budget.maxProducts ||
    budget.apiCalls >= budget.maxApiCalls
  );
}

/** Run failure bounds (§10): 24 hours from run start or 96 continuations. */
export function runOverdue(runStartedAt: string, continuationCount: number, now: string): boolean {
  return (
    continuationCount >= RUN_MAX_CONTINUATIONS ||
    Date.parse(now) - Date.parse(runStartedAt) >= RUN_MAX_AGE_MS
  );
}
