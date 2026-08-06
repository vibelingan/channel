/**
 * Resumable, lease-fenced sync runner (ARCHITECTURE §10-§12, MIU 11).
 *
 * One invocation = one bounded slice: acquire lease FIRST, read checkpoint,
 * create/resume the run (single-winner run-row creation), work until the
 * budget is exhausted, checkpoint after every durable page THROUGH THE FENCED
 * WRITE, release the lease at exit so the next tick resumes immediately.
 *
 * Stages: enumerate -> promote -> (full only) tombstone. Promotions happen at
 * completion over the run's candidates, AFTER quarantine evaluation — never
 * inline during enumeration ("quarantine before product promotion").
 * Incremental runs reuse the SAME bisection machine over [cursor, now] and
 * never tombstone; full runs cover the whole window and tombstone only after
 * complete enumeration, with per-candidate confirmation fetches (R1 E8).
 */
import { randomUUID } from 'node:crypto';
import {
  type AlibabaClient,
  type EnumerationState,
  type RunBudget,
  alibabaSourceKey,
  applyCountResult,
  applyListResult,
  budgetExhausted,
  buildPromotionCandidate,
  computeCandidateHash,
  computeNextFullDueAt,
  computeNextIncrementalDueAt,
  decideTick,
  evaluateQuarantine,
  extractProductListPage,
  initialEnumerationState,
  newRunBudget,
  nextEnumerationAction,
  parseAlibabaApiResponse,
  runOverdue,
} from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  type AlibabaLeaseGuard,
  acquireAlibabaSyncLease,
  list,
  releaseAlibabaSyncLease,
  renewAlibabaSyncLease,
  updateDocWithAlibabaLease,
} from '@vibelingan-channel/db';
import type { AlertSender } from './alerts.ts';
import { ingestProductDetail } from './ingest.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';
import { promoteLinkedProduct } from './promotion.ts';
import { type CollectionDoc, createDocWithId, getDoc, updateDoc, upsertDocWithId } from './repo.ts';

const LIST_PATH = '/alibaba/icbu/product/list';
const DETAIL_PATH = '/alibaba/icbu/product/get';
/** Full enumeration window start: safely before any live listing. */
const FULL_WINDOW_START = '2010-01-01T00:00:00.000Z';
const INCREMENTAL_LOOKBACK_MS = 4 * 3_600_000;

export interface RunnerDeps {
  client: AlibabaClient;
  /**
   * Resolved AFTER the lease is acquired (review R2 finding: pre-fetching
   * outside the lease let two concurrent ticks race the rotating refresh
   * token; under the lease, refresh is single-flight).
   */
  getAccessToken: () => Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>;
  now: () => string;
  alert: AlertSender;
}

export interface TickReport {
  outcome:
    | 'idle'
    | 'lease-busy'
    | 'not-connected'
    | 'continued'
    | 'completed'
    | 'quarantined'
    | 'failed'
    | 'lease-lost';
  runId?: string;
  detail?: string;
}

interface CheckpointState {
  activeRunId: string;
  mode: 'incremental' | 'full';
  stage: 'enumerate' | 'promote' | 'tombstone';
  enumerationState: EnumerationState;
  windowStart: string;
  windowEnd: string;
  continuationCount: number;
}

interface RunCounters {
  itemsProcessed: number;
  parseFailures: number;
  unsupportedCurrency: number;
  rawFailures: number;
}

function emptyCounters(): RunCounters {
  return { itemsProcessed: 0, parseFailures: 0, unsupportedCurrency: 0, rawFailures: 0 };
}

function readCounters(run: CollectionDoc | null): RunCounters {
  const raw = (run?.counters ?? {}) as Partial<RunCounters>;
  return { ...emptyCounters(), ...raw };
}

export async function runSyncTick(input: {
  deps: RunnerDeps;
  trigger: 'timer' | 'manual';
  budgetOverrides?: Partial<RunBudget>;
}): Promise<TickReport> {
  const { deps } = input;
  const now = deps.now();
  const holder = `tick-${randomUUID()}`;

  const grant = await acquireAlibabaSyncLease(
    PRIMARY_CONNECTION_ID,
    holder,
    now,
    ALIBABA_SYNC_LEASE_TTL_MS,
  );
  if (grant.result !== 'granted') return { outcome: 'lease-busy' };
  const fence = grant.fence;
  const guard = (at: string): AlibabaLeaseGuard => ({
    connectionId: PRIMARY_CONNECTION_ID,
    holder,
    fence,
    now: at,
  });
  const release = async () =>
    releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, fence, deps.now());
  /**
   * Token resolution under the lease (single-flight refresh, review R2 #3),
   * called at the LAST point before real work in each branch: never before a
   * run row exists (a token failure would strand a phantom run holding the
   * checkpoint slot for the full 24h run-age window) and never before the
   * resume pre-checks (self-heal and overdue cleanup need no token, so a dead
   * connection must not block them).
   */
  const resolveToken = async (): Promise<
    { ok: true; accessToken: string } | { ok: false; report: TickReport }
  > => {
    const access = await deps.getAccessToken();
    if (access.ok) return { ok: true, accessToken: access.accessToken };
    await release();
    return { ok: false, report: { outcome: 'not-connected', detail: access.reason } };
  };

  try {
    // Checkpoint bootstrap (upsert is safe: we hold the lease).
    let checkpointDoc = await getDoc('alibabaSyncCheckpoints', PRIMARY_CONNECTION_ID);
    if (!checkpointDoc) {
      checkpointDoc = await upsertDocWithId('alibabaSyncCheckpoints', PRIMARY_CONNECTION_ID, {
        connectionId: PRIMARY_CONNECTION_ID,
        activeRunId: '',
        nextFullDueAt: computeNextFullDueAt(now),
        nextIncrementalDueAt: computeNextIncrementalDueAt(now),
        committedCursor: '',
      });
    }

    const decision = decideTick(
      {
        ...(typeof checkpointDoc.activeRunId === 'string' && checkpointDoc.activeRunId !== ''
          ? { activeRunId: checkpointDoc.activeRunId }
          : {}),
        ...(typeof checkpointDoc.nextFullDueAt === 'string'
          ? { nextFullDueAt: checkpointDoc.nextFullDueAt }
          : {}),
        ...(typeof checkpointDoc.nextIncrementalDueAt === 'string'
          ? { nextIncrementalDueAt: checkpointDoc.nextIncrementalDueAt }
          : {}),
      },
      now,
    );
    if (decision.action === 'idle') {
      await release();
      return { outcome: 'idle' };
    }

    let state: CheckpointState;
    let runDoc: CollectionDoc | null;
    let accessToken: string;
    if (decision.action === 'resume') {
      runDoc = await getDoc('alibabaSyncRuns', decision.runId);
      const continuationCount = Number(checkpointDoc.continuationCount ?? 0);
      // Self-heal (review R2): a lost lease during a previous completion can
      // leave a terminal run still named in the checkpoint — clear it instead
      // of resuming a finished/quarantined run.
      const terminal =
        runDoc &&
        (runDoc.status === 'completed' ||
          runDoc.status === 'quarantined' ||
          runDoc.status === 'approved' ||
          runDoc.status === 'failed');
      if (terminal) {
        await clearActiveRun(guard, deps);
        await release();
        return { outcome: 'idle', runId: decision.runId, detail: 'stale-active-run-cleared' };
      }
      if (!runDoc || runOverdue(String(runDoc.startedAt ?? now), continuationCount, now)) {
        await failRun(decision.runId, 'run-overdue', guard(deps.now()), deps);
        // Vacate the slot (review R2 HIGH): without this every later tick
        // re-resumes the dead run forever and sync wedges permanently.
        await clearActiveRun(guard, deps);
        await release();
        return { outcome: 'failed', runId: decision.runId, detail: 'run-overdue' };
      }
      // Both no-token exits are behind us; the slice below needs the API.
      const resumed = await resolveToken();
      if (!resumed.ok) return resumed.report;
      accessToken = resumed.accessToken;
      state = {
        activeRunId: decision.runId,
        mode: runDoc.mode === 'full' ? 'full' : 'incremental',
        stage:
          checkpointDoc.stage === 'promote' || checkpointDoc.stage === 'tombstone'
            ? (checkpointDoc.stage as 'promote' | 'tombstone')
            : 'enumerate',
        enumerationState: checkpointDoc.enumerationState as EnumerationState,
        windowStart: String(checkpointDoc.windowStart ?? FULL_WINDOW_START),
        windowEnd: String(checkpointDoc.windowEnd ?? now),
        continuationCount: continuationCount + 1,
      };
      await updateDocWithAlibabaLease(
        'alibabaSyncCheckpoints',
        PRIMARY_CONNECTION_ID,
        { continuationCount: state.continuationCount },
        guard(now),
      );
      await updateDoc('alibabaSyncRuns', state.activeRunId, {
        status: 'continuing',
        holder,
        fence,
      });
    } else {
      // Nothing has been written yet — a token failure here leaves NO trace.
      const started = await resolveToken();
      if (!started.ok) return started.report;
      accessToken = started.accessToken;
      const mode = decision.action === 'start-full' ? 'full' : 'incremental';
      const windowStart =
        mode === 'full'
          ? FULL_WINDOW_START
          : typeof checkpointDoc.committedCursor === 'string' &&
              checkpointDoc.committedCursor !== ''
            ? checkpointDoc.committedCursor
            : new Date(Date.parse(now) - INCREMENTAL_LOOKBACK_MS).toISOString();
      const runId = `${mode}-${now.replace(/[:.]/g, '-')}`;
      const created = await createDocWithId('alibabaSyncRuns', runId, {
        connectionId: PRIMARY_CONNECTION_ID,
        mode,
        trigger: input.trigger,
        status: 'running',
        holder,
        fence,
        startedAt: now,
        completedAt: '',
        counters: emptyCounters(),
        alerts: [],
        approval: null,
        errorSummary: '',
      });
      if (created === 'exists') {
        // A same-instant duplicate lost the run-row race; the winner owns it.
        await release();
        return { outcome: 'lease-busy', detail: 'run-row-race' };
      }
      runDoc = await getDoc('alibabaSyncRuns', runId);
      state = {
        activeRunId: runId,
        mode,
        stage: 'enumerate',
        enumerationState: initialEnumerationState({
          fromMs: Date.parse(windowStart),
          toMs: Date.parse(now),
        }),
        windowStart,
        windowEnd: now,
        continuationCount: 0,
      };
      await updateDocWithAlibabaLease(
        'alibabaSyncCheckpoints',
        PRIMARY_CONNECTION_ID,
        {
          activeRunId: runId,
          mode,
          stage: 'enumerate',
          enumerationState: state.enumerationState,
          windowStart,
          windowEnd: now,
          continuationCount: 0,
        },
        guard(now),
      );
    }

    return await executeSlice(
      state,
      readCounters(runDoc),
      input,
      accessToken,
      guard,
      release,
      holder,
      fence,
    );
  } catch (error) {
    console.error('[alibaba-catalog-sync] tick failed:', error);
    await release();
    return { outcome: 'failed', detail: 'unexpected-error' };
  }
}

async function executeSlice(
  state: CheckpointState,
  counters: RunCounters,
  input: { deps: RunnerDeps; budgetOverrides?: Partial<RunBudget> },
  accessToken: string,
  guard: (at: string) => AlibabaLeaseGuard,
  release: () => Promise<boolean>,
  holder: string,
  fence: number,
): Promise<TickReport> {
  const { deps } = input;
  const budget = newRunBudget(Date.parse(deps.now()), input.budgetOverrides);
  let lastRenewMs = budget.startedAtMs;

  const keepLease = async (): Promise<boolean> => {
    const nowIso = deps.now();
    if (Date.parse(nowIso) - lastRenewMs < 60_000) return true;
    lastRenewMs = Date.parse(nowIso);
    return renewAlibabaSyncLease(
      PRIMARY_CONNECTION_ID,
      holder,
      fence,
      nowIso,
      ALIBABA_SYNC_LEASE_TTL_MS,
    );
  };

  const saveCheckpoint = async (): Promise<boolean> =>
    updateDocWithAlibabaLease(
      'alibabaSyncCheckpoints',
      PRIMARY_CONNECTION_ID,
      {
        stage: state.stage,
        enumerationState: state.enumerationState,
      },
      guard(deps.now()),
    );

  const listWindow = async (
    fromMs: number,
    toMs: number,
    pageSize: number,
  ): Promise<
    | { ok: true; totalItems?: number; ids: string[] }
    | { ok: false; kind: 'transport' | 'api-error' | 'malformed' | 'raw-failed' }
  > => {
    budget.apiCalls += 1;
    const params: Record<string, string> = {
      page: '1',
      page_size: String(pageSize),
      gmt_modified_from: new Date(fromMs).toISOString(),
      gmt_modified_to: new Date(toMs).toISOString(),
    };
    const response = await deps.client.callApi({
      apiPath: LIST_PATH,
      params,
      accessToken,
    });
    if (!response.ok) return { ok: false, kind: 'transport' };
    const { storeRawPayload } = await import('./ingest.ts');
    const raw = await storeRawPayload({
      bodyText: response.bodyText,
      endpointId: 'product.list',
      requestFingerprint: deps.client.fingerprintFor({ apiPath: LIST_PATH, params }),
      connectionId: PRIMARY_CONNECTION_ID,
      runId: state.activeRunId,
      now: deps.now(),
    });
    if (!raw.ok) return { ok: false, kind: 'raw-failed' };
    const envelope = parseAlibabaApiResponse(response.bodyText);
    if (envelope.kind === 'malformed') return { ok: false, kind: 'malformed' };
    if (envelope.kind === 'api-error') return { ok: false, kind: 'api-error' };
    const page = extractProductListPage(envelope.root);
    return {
      ok: true,
      ...(page.totalItems !== undefined ? { totalItems: page.totalItems } : {}),
      ids: page.items.map((item) => item.sourceProductId),
    };
  };

  // --- stage: enumerate ------------------------------------------------------
  if (state.stage === 'enumerate') {
    for (;;) {
      if (budgetExhausted(budget, Date.parse(deps.now()))) {
        if (!(await saveCheckpoint())) return { outcome: 'lease-lost', runId: state.activeRunId };
        await updateDoc('alibabaSyncRuns', state.activeRunId, { counters });
        await release();
        return { outcome: 'continued', runId: state.activeRunId };
      }
      if (!(await keepLease())) return { outcome: 'lease-lost', runId: state.activeRunId };

      const action = nextEnumerationAction(state.enumerationState);
      if (action.type === 'done') {
        state.stage = 'promote';
        if (!(await saveCheckpoint())) return { outcome: 'lease-lost', runId: state.activeRunId };
        break;
      }
      if (action.type === 'blocked') {
        await failRun(
          state.activeRunId,
          'enumeration-blocked-unstable-tie',
          guard(deps.now()),
          deps,
        );
        await clearActiveRun(guard, deps);
        await release();
        return { outcome: 'failed', runId: state.activeRunId, detail: 'BLOCKED_UNSTABLE_TIE' };
      }
      if (action.type === 'count') {
        const result = await listWindow(action.window.fromMs, action.window.toMs, 1);
        if (!result.ok) {
          return await handlePageFailure(result.kind, state, counters, guard, release, deps);
        }
        if (result.totalItems === undefined) {
          // §12 response-contract failure (review R2 #9): a page-size-1 count
          // without total_item would silently collapse the whole window into
          // one bucket. Quarantine instead of guessing.
          await updateDoc('alibabaSyncRuns', state.activeRunId, {
            status: 'quarantined',
            alerts: ['response-contract-failed'],
            counters,
            completedAt: deps.now(),
          });
          await clearActiveRun(guard, deps);
          await deps.alert(
            `Alibaba sync run ${state.activeRunId} quarantined: list response carried no total_item (response contract failed).`,
          );
          await release();
          return {
            outcome: 'quarantined',
            runId: state.activeRunId,
            detail: 'response-contract-failed',
          };
        }
        state.enumerationState = applyCountResult(state.enumerationState, result.totalItems);
        continue;
      }
      // action.type === 'list': fetch the terminal bucket then each detail.
      const result = await listWindow(action.window.fromMs, action.window.toMs, 30);
      if (!result.ok) {
        return await handlePageFailure(result.kind, state, counters, guard, release, deps);
      }
      let bucketComplete = true;
      for (const sourceProductId of result.ids) {
        if (budgetExhausted(budget, Date.parse(deps.now()))) {
          // Budget died MID-BUCKET: the bucket must NOT pop, or its remaining
          // items are silently lost. The un-popped state re-lists this bucket
          // next tick; deterministic ids make the repeat idempotent.
          bucketComplete = false;
          break;
        }
        budget.apiCalls += 1;
        budget.productsProcessed += 1;
        const params = { product_id: sourceProductId };
        const detailResponse = await deps.client.callApi({
          apiPath: DETAIL_PATH,
          params,
          accessToken,
        });
        if (!detailResponse.ok) {
          counters.parseFailures += 1;
          continue;
        }
        const ingest = await ingestProductDetail({
          bodyText: detailResponse.bodyText,
          endpointId: 'product.get',
          requestFingerprint: deps.client.fingerprintFor({ apiPath: DETAIL_PATH, params }),
          connectionId: PRIMARY_CONNECTION_ID,
          runId: state.activeRunId,
          now: deps.now(),
        });
        counters.itemsProcessed += 1;
        if (!ingest.ok) {
          if (ingest.error === 'raw-write-failed') counters.rawFailures += 1;
          else counters.parseFailures += 1;
        } else if (ingest.unsupportedCurrency) {
          counters.unsupportedCurrency += 1;
        }
      }
      if (bucketComplete) {
        state.enumerationState = applyListResult(state.enumerationState);
      }
      if (!(await saveCheckpoint())) return { outcome: 'lease-lost', runId: state.activeRunId };
      await updateDoc('alibabaSyncRuns', state.activeRunId, { counters });
    }
  }

  // --- stage: promote (quarantine gate BEFORE any product write) -------------
  if (state.stage === 'promote') {
    const seen = await list({
      collection: 'alibabaSourceProducts',
      page: 1,
      pageSize: 500,
      filter: {
        combinator: 'and',
        clauses: [{ field: 'lastSeenRunId', op: 'eq', value: state.activeRunId }],
      },
    });
    const linkedCandidates: { sourceKey: string }[] = [];
    for (const source of seen.items) {
      const link = await getDoc('alibabaProductLinks', source._id);
      if (link && typeof link.productId === 'string' && link.productId !== '') {
        linkedCandidates.push({ sourceKey: source._id });
      }
    }

    const allActive = await list({
      collection: 'alibabaSourceProducts',
      page: 1,
      pageSize: 1,
      filter: { combinator: 'and', clauses: [{ field: 'active', op: 'eq', value: true }] },
    });
    const allLinks = await list({ collection: 'alibabaProductLinks', page: 1, pageSize: 1 });
    const tombstoneCandidates =
      state.mode === 'full' ? await listTombstoneCandidates(state.activeRunId) : [];

    const quarantine = evaluateQuarantine({
      candidateChanges: linkedCandidates.length,
      linkedProductCount: allLinks.total,
      tombstoneCandidates: tombstoneCandidates.length,
      activeSourceCount: allActive.total,
      parseFailures: counters.parseFailures,
      itemsProcessed: counters.itemsProcessed,
      zeroItemFullWithActiveSources:
        state.mode === 'full' && counters.itemsProcessed === 0 && allActive.total > 0,
      signatureVectorFailed: false,
      responseContractFailed: false,
      unsupportedCurrency: counters.unsupportedCurrency > 0,
      rawEvidenceMissing: counters.rawFailures > 0,
      leaseOrFenceInvalid: false,
    });
    if (quarantine.quarantine) {
      // Hash STABLE identifiers only (review R2 #6): full docs carry mutable
      // stamps that would make approval's recomputation spuriously mismatch.
      const candidateHash = computeCandidateHash({
        runId: state.activeRunId,
        candidates: linkedCandidates,
        tombstones: tombstoneCandidates.map((doc) => doc._id),
      });
      await updateDoc('alibabaSyncRuns', state.activeRunId, {
        status: 'quarantined',
        candidateHash,
        counters,
        alerts: quarantine.reasons,
        completedAt: deps.now(),
      });
      // Quarantine RELEASES the lease and vacates the active slot (R1 E4);
      // the frozen candidate awaits approval, new runs may start.
      await clearActiveRun(guard, deps);
      await deps.alert(
        `Alibaba sync run ${state.activeRunId} quarantined: ${quarantine.reasons.join(', ')}.`,
      );
      await release();
      return { outcome: 'quarantined', runId: state.activeRunId };
    }

    let priceMoves = 0;
    for (const candidate of linkedCandidates) {
      if (!(await keepLease())) return { outcome: 'lease-lost', runId: state.activeRunId };
      const promoted = await promoteLinkedProduct({
        sourceKey: candidate.sourceKey,
        guard: guard(deps.now()),
        now: deps.now(),
      });
      if (promoted.ok && promoted.priceMoveAlert) priceMoves += 1;
      if (!promoted.ok && promoted.reason === 'fence-rejected') {
        return { outcome: 'lease-lost', runId: state.activeRunId };
      }
    }
    if (priceMoves > 0) {
      await deps.alert(
        `Alibaba sync run ${state.activeRunId}: ${priceMoves} linked product(s) moved price by more than 30%.`,
      );
    }

    state.stage = state.mode === 'full' ? 'tombstone' : 'promote';
    if (state.mode !== 'full') {
      if (!(await completeRun(state, counters, guard, deps))) {
        return { outcome: 'lease-lost', runId: state.activeRunId };
      }
      await release();
      return { outcome: 'completed', runId: state.activeRunId };
    }
    if (!(await saveCheckpoint())) return { outcome: 'lease-lost', runId: state.activeRunId };
  }

  // --- stage: tombstone (full runs only; per-candidate confirmation, R1 E8) --
  const candidates = await listTombstoneCandidates(state.activeRunId);
  for (const candidate of candidates) {
    if (budgetExhausted(budget, Date.parse(deps.now()))) {
      if (!(await saveCheckpoint())) return { outcome: 'lease-lost', runId: state.activeRunId };
      await release();
      return { outcome: 'continued', runId: state.activeRunId };
    }
    if (!(await keepLease())) return { outcome: 'lease-lost', runId: state.activeRunId };
    budget.apiCalls += 1;
    const params = { product_id: String(candidate.sourceProductId ?? '') };
    const confirm = await deps.client.callApi({
      apiPath: DETAIL_PATH,
      params,
      accessToken,
    });
    if (!confirm.ok) {
      // A confirmation TRANSPORT error must not tombstone; quarantine the set.
      await updateDoc('alibabaSyncRuns', state.activeRunId, {
        status: 'quarantined',
        alerts: ['tombstone-confirmation-failed'],
        counters,
        completedAt: deps.now(),
      });
      await clearActiveRun(guard, deps);
      await deps.alert(
        `Alibaba sync run ${state.activeRunId} quarantined: tombstone confirmation failed.`,
      );
      await release();
      return { outcome: 'quarantined', runId: state.activeRunId };
    }
    const envelope = parseAlibabaApiResponse(confirm.bodyText);
    const stillExists = envelope.kind === 'success';
    if (stillExists) {
      // Bisection miss (item moved mid-run): re-ingest so it survives.
      await ingestProductDetail({
        bodyText: confirm.bodyText,
        endpointId: 'product.get',
        requestFingerprint: deps.client.fingerprintFor({ apiPath: DETAIL_PATH, params }),
        connectionId: PRIMARY_CONNECTION_ID,
        runId: state.activeRunId,
        now: deps.now(),
      });
      continue;
    }
    // Fenced flip (R1 E7, review R2 #7): the tombstone DECISION input must not
    // be writable by a stale holder — the lease is re-verified inside the
    // same transaction as the write.
    const flipped = await updateDocWithAlibabaLease(
      'alibabaSourceProducts',
      candidate._id,
      { active: false, tombstonedAt: deps.now(), lastSeenRunId: state.activeRunId },
      guard(deps.now()),
    );
    if (!flipped) return { outcome: 'lease-lost', runId: state.activeRunId };
    const link = await getDoc('alibabaProductLinks', candidate._id);
    if (link && typeof link.productId === 'string' && link.productId !== '') {
      await promoteLinkedProduct({
        sourceKey: candidate._id,
        guard: guard(deps.now()),
        now: deps.now(),
      });
    }
  }

  if (!(await completeRun(state, counters, guard, deps))) {
    return { outcome: 'lease-lost', runId: state.activeRunId };
  }
  await release();
  return { outcome: 'completed', runId: state.activeRunId };
}

async function listTombstoneCandidates(runId: string): Promise<CollectionDoc[]> {
  const active = await list({
    collection: 'alibabaSourceProducts',
    page: 1,
    pageSize: 500,
    filter: { combinator: 'and', clauses: [{ field: 'active', op: 'eq', value: true }] },
  });
  return active.items.filter((doc) => doc.lastSeenRunId !== runId);
}

async function handlePageFailure(
  kind: 'transport' | 'api-error' | 'malformed' | 'raw-failed',
  state: CheckpointState,
  counters: RunCounters,
  guard: (at: string) => AlibabaLeaseGuard,
  release: () => Promise<boolean>,
  deps: RunnerDeps,
): Promise<TickReport> {
  // Retryable page failure: keep the run active; the next tick resumes from
  // the durable checkpoint. Raw-write failure aborts the PAGE with nothing
  // else written (MIU 6 contract) — same resume semantics.
  await updateDoc('alibabaSyncRuns', state.activeRunId, {
    counters,
    errorSummary: `page-failure:${kind}`,
  });
  await release();
  return { outcome: 'continued', runId: state.activeRunId, detail: `page-failure:${kind}` };
}

async function failRun(
  runId: string,
  reason: string,
  _guard: AlibabaLeaseGuard,
  deps: RunnerDeps,
): Promise<void> {
  await updateDoc('alibabaSyncRuns', runId, {
    status: 'failed',
    errorSummary: reason,
    completedAt: deps.now(),
  });
  await deps.alert(`Alibaba sync run ${runId} failed: ${reason}.`);
}

async function clearActiveRun(
  guard: (at: string) => AlibabaLeaseGuard,
  deps: RunnerDeps,
): Promise<boolean> {
  const now = deps.now();
  const applied = await updateDocWithAlibabaLease(
    'alibabaSyncCheckpoints',
    PRIMARY_CONNECTION_ID,
    {
      activeRunId: '',
      stage: 'enumerate',
      nextFullDueAt: computeNextFullDueAt(now),
      nextIncrementalDueAt: computeNextIncrementalDueAt(now),
    },
    guard(now),
  );
  // A lost lease here is tolerable: the run row already carries its terminal
  // status, and the resume path's terminal-run self-heal clears the slot on
  // the next tick. Callers that must NOT claim success check the boolean.
  return applied;
}

async function completeRun(
  state: CheckpointState,
  counters: RunCounters,
  guard: (at: string) => AlibabaLeaseGuard,
  deps: RunnerDeps,
): Promise<boolean> {
  const now = deps.now();
  // FENCED checkpoint first (review R2 #8): the cursor advance + slot clear
  // must not be lost while the run row claims completion. Only after the
  // fenced write lands is the run marked completed.
  const applied = await updateDocWithAlibabaLease(
    'alibabaSyncCheckpoints',
    PRIMARY_CONNECTION_ID,
    {
      activeRunId: '',
      stage: 'enumerate',
      committedCursor: state.windowEnd,
      nextFullDueAt: computeNextFullDueAt(now),
      nextIncrementalDueAt: computeNextIncrementalDueAt(now),
    },
    guard(now),
  );
  if (!applied) return false;
  await updateDoc('alibabaSyncRuns', state.activeRunId, {
    status: 'completed',
    counters,
    completedAt: now,
  });
  return true;
}
