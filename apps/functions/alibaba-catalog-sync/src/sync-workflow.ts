import { randomUUID } from 'node:crypto';
import {
  acquireAlibabaSyncLease,
  list,
  releaseAlibabaSyncLease,
  updateDocWithAlibabaLease,
} from '@vibelingan-channel/db';
import {
  type AlibabaSyncWorkflow,
  AlibabaSyncWorkflowSchema,
  type CollectionDoc,
} from '@vibelingan-channel/shared';
import { SyncPreparationSchema } from './sync-preparation.ts';
export { initialSyncPreparation } from './sync-preparation.ts';
import { materializeAlibabaDraftPage } from './draft-materialization.ts';
import { photoPreparationStatus, prepareAlibabaPhotosPage } from './photo-preparation.ts';
import { promoteLinkedProduct } from './promotion.ts';
import { getDoc } from './repo.ts';
import { type RunnerDeps, runSyncTick } from './runner.ts';

const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const stamp = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
async function pendingPreparation() {
  const result = await list({
    collection: 'alibabaSyncRuns',
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [{ field: 'preparationPending', op: 'eq', value: true }],
    },
  });
  return result.items[0] ?? null;
}
export async function syncWorkflowStatus(
  enabled: boolean,
  now = new Date().toISOString(),
): Promise<AlibabaSyncWorkflow> {
  const [checkpoint, recent, pending] = await Promise.all([
    getDoc('alibabaSyncCheckpoints', 'primary'),
    list({
      collection: 'alibabaSyncRuns',
      page: 1,
      pageSize: 20,
      sort: [{ field: 'startedAt', dir: 'desc' }],
    }),
    pendingPreparation(),
  ]);
  const activeId = typeof checkpoint?.activeRunId === 'string' ? checkpoint.activeRunId : '';
  const active = activeId ? await getDoc('alibabaSyncRuns', activeId) : null;
  const latest = active ?? pending ?? recent.items[0] ?? null;
  const prep = SyncPreparationSchema.safeParse(latest?.preparation);
  const counters = latest?.counters;
  let phase: AlibabaSyncWorkflow['phase'] = 'idle';
  let issue: AlibabaSyncWorkflow['issue'] = null;
  if (latest?.status === 'running' || latest?.status === 'continuing') {
    phase =
      Date.parse(now) - Date.parse(String(latest.updatedAt ?? latest.startedAt)) > 120_000
        ? 'queued'
        : 'syncing';
  } else if (latest?.status === 'quarantined') {
    phase = 'attention';
    issue = 'supplier-data';
  } else if (latest?.status === 'failed') {
    phase = 'attention';
    issue = latest.errorSummary === 'run-overdue' ? 'run-expired' : 'supplier-unavailable';
  } else if (prep.success) {
    phase =
      prep.data.phase === 'drafts' || prep.data.phase === 'photos' ? 'preparing' : prep.data.phase;
    if (phase === 'attention') issue = prep.data.photoIssues ? 'photos' : 'preparation';
  } else if (latest?.preparationPending === true || latest?.preparationError === 'invalid-state') {
    phase = 'attention';
    issue = 'preparation';
  }
  return AlibabaSyncWorkflowSchema.parse({
    version: 'alibaba-sync-workflow-v1',
    enabled,
    phase,
    runId: latest?._id ?? null,
    startedAt: stamp(latest?.startedAt),
    updatedAt: stamp(latest?.updatedAt),
    processed: number(
      counters && typeof counters === 'object' ? Reflect.get(counters, 'itemsProcessed') : 0,
    ),
    draftsCreated: prep.success ? prep.data.draftsCreated : 0,
    photosCopied: prep.success ? prep.data.photosCopied : 0,
    photoIssues: prep.success ? prep.data.photoIssues : 0,
    nextRetryAt: prep.success ? prep.data.retryAt : null,
    issue,
    history: recent.items.map((row) => ({
      id: row._id,
      startedAt: stamp(row.startedAt),
      result:
        row.status === 'running' || row.status === 'continuing' || row.preparationPending === true
          ? 'in-progress'
          : row.status === 'failed' ||
              row.status === 'quarantined' ||
              row.preparationError === 'invalid-state' ||
              (SyncPreparationSchema.safeParse(row.preparation).success &&
                Reflect.get(row.preparation as object, 'phase') === 'attention')
            ? 'attention'
            : SyncPreparationSchema.safeParse(row.preparation).success &&
                Reflect.get(row.preparation as object, 'phase') === 'complete'
              ? 'complete'
              : 'imported',
      processed: number(
        row.counters && typeof row.counters === 'object'
          ? Reflect.get(row.counters, 'itemsProcessed')
          : 0,
      ),
    })),
  });
}

export async function startSyncWorkflow(deps: RunnerDeps, enabled: boolean) {
  if (!enabled) throw new Error('Background synchronization is not available.');
  const status = await syncWorkflowStatus(enabled, deps.now());
  if (['queued', 'syncing', 'preparing', 'waiting'].includes(status.phase)) return status;
  const enqueue = () =>
    runSyncTick({
      deps,
      trigger: 'manual',
      budgetOverrides: { maxApiCalls: 0, maxProducts: 0, softDeadlineMs: 0 },
    });
  let report = await enqueue();
  if (report.outcome === 'idle' && report.detail === 'stale-active-run-cleared') {
    // A previous completion may have lost its reply before releasing the slot.
    // Healing that slot must not consume the operator's only click.
    report = await enqueue();
  }
  if (report.outcome === 'not-connected')
    throw new Error('Reconnect the Alibaba account before syncing.');
  if (report.outcome === 'failed')
    throw new Error('The sync could not be started. Check its saved status and try again.');
  return syncWorkflowStatus(enabled, deps.now());
}

interface BackgroundDeps {
  runner: RunnerDeps;
  enabled: boolean;
  tick?: typeof runSyncTick;
  drafts?: typeof materializeAlibabaDraftPage;
  photos?: typeof prepareAlibabaPhotosPage;
  photoStatus?: typeof photoPreparationStatus;
}
/** Timer resumes operator work only. It never creates a new scheduled supplier run. */
async function resumeSyncWorkflowPage(
  deps: BackgroundDeps,
): Promise<{ outcome: string; runId?: string }> {
  if (!deps.enabled) return { outcome: 'disabled' };
  const checkpoint = await getDoc('alibabaSyncCheckpoints', 'primary');
  if (typeof checkpoint?.activeRunId === 'string' && checkpoint.activeRunId) {
    return (deps.tick ?? runSyncTick)({
      deps: deps.runner,
      trigger: 'timer',
      budgetOverrides: { softDeadlineMs: 45_000, maxProducts: 200, maxApiCalls: 250 },
    });
  }
  const run = await pendingPreparation();
  if (!run) return { outcome: 'idle' };
  const holder = `preparation-${randomUUID()}`;
  const grant = await acquireAlibabaSyncLease('primary', holder, deps.runner.now(), 180_000);
  if (grant.result !== 'granted') return { outcome: 'lease-busy', runId: run._id };
  const guard = () => ({
    connectionId: 'primary',
    holder,
    fence: grant.fence,
    now: deps.runner.now(),
  });
  try {
    // Re-read after the lease: a duplicate timer may have finished this exact job.
    const current = await getDoc('alibabaSyncRuns', run._id);
    if (current?.status !== 'completed' || current.preparationPending !== true)
      return { outcome: 'idle' };
    const parsed = SyncPreparationSchema.safeParse(current.preparation);
    if (!parsed.success) {
      await updateDocWithAlibabaLease(
        'alibabaSyncRuns',
        run._id,
        {
          preparationPending: false,
          preparationError: 'invalid-state',
          updatedAt: deps.runner.now(),
        },
        guard(),
      );
      return { outcome: 'invalid-preparation', runId: run._id };
    }
    const state = parsed.data;
    if (state.phase === 'waiting') {
      if (state.retryAt && Date.parse(state.retryAt) > Date.parse(deps.runner.now()))
        return { outcome: 'waiting', runId: run._id };
      state.phase = state.resumePhase;
      state.retryAt = null;
      if (state.restartPass) {
        state.cursor = '';
        state.passWaiting = 0;
        state.passBusy = 0;
      }
      state.restartPass = false;
    }
    if (state.phase === 'drafts') {
      const page = await (deps.drafts ?? materializeAlibabaDraftPage)({
        afterSourceKey: state.cursor,
        limit: 20,
        completedOnly: true,
        runId: run._id,
        now: deps.runner.now,
        onPrepared: async (sourceKey) => {
          const result = await promoteLinkedProduct({
            sourceKey,
            guard: guard(),
            now: deps.runner.now(),
          });
          if (!result.ok) throw new Error('Source draft preparation could not be confirmed.');
        },
      });
      state.draftsCreated += page.created;
      state.failures += page.failures.length;
      state.cursor = page.nextSourceKey;
      if (page.done) {
        state.phase = 'photos';
        state.cursor = '';
      }
    } else if (state.phase === 'photos') {
      const page = await (deps.photos ?? prepareAlibabaPhotosPage)({
        afterProductId: state.cursor,
        limit: 100,
        budgetMs: 12_000,
        retryFailedBefore: state.retryBefore,
        now: deps.runner.now,
      });
      state.photosCopied += page.photosCopied;
      state.photoIssues += page.photosFailed;
      state.passWaiting += page.waiting;
      state.passBusy += page.busy;
      state.failures += page.failures.length;
      state.cursor = page.nextProductId;
      if (page.done) {
        if (state.passWaiting || state.passBusy) {
          state.phase = 'waiting';
          state.resumePhase = 'photos';
          state.restartPass = true;
          state.retryAt = new Date(Date.parse(deps.runner.now()) + 10 * 60_000).toISOString();
        } else {
          const remaining = await (deps.photoStatus ?? photoPreparationStatus)();
          state.photoIssues = remaining.draftsMissingPhotos;
          if (remaining.hiddenDrafts || remaining.draftsToFill) {
            state.phase = 'waiting';
            state.resumePhase = 'photos';
            state.restartPass = true;
            state.retryAt = new Date(Date.parse(deps.runner.now()) + 10 * 60_000).toISOString();
          } else state.phase = state.failures || state.photoIssues ? 'attention' : 'complete';
        }
      }
    }
    state.transportFailures = 0;
    const pending = !['complete', 'attention'].includes(state.phase);
    const written = await updateDocWithAlibabaLease(
      'alibabaSyncRuns',
      run._id,
      { preparation: state, preparationPending: pending, updatedAt: deps.runner.now() },
      guard(),
    );
    return { outcome: written ? state.phase : 'lease-lost', runId: run._id };
  } catch {
    const current = await getDoc('alibabaSyncRuns', run._id);
    const parsed = SyncPreparationSchema.safeParse(current?.preparation);
    if (!parsed.success) return { outcome: 'invalid-preparation', runId: run._id };
    const state = parsed.data;
    state.transportFailures += 1;
    state.resumePhase = state.phase === 'drafts' ? 'drafts' : state.resumePhase;
    state.restartPass = false;
    state.phase = state.transportFailures >= 3 ? 'attention' : 'waiting';
    state.retryAt =
      state.phase === 'waiting'
        ? new Date(Date.parse(deps.runner.now()) + 60_000).toISOString()
        : null;
    const written = await updateDocWithAlibabaLease(
      'alibabaSyncRuns',
      run._id,
      {
        preparation: state,
        preparationPending: state.phase === 'waiting',
        updatedAt: deps.runner.now(),
      },
      guard(),
    );
    return { outcome: written ? state.phase : 'lease-lost', runId: run._id };
  } finally {
    await releaseAlibabaSyncLease('primary', holder, grant.fence, deps.runner.now());
  }
}

/** Bound each timer invocation; commit after every page so timeout never loses the cursor. */
export async function resumeSyncWorkflow(
  deps: BackgroundDeps,
): Promise<{ outcome: string; runId?: string }> {
  const began = Date.now();
  let result: { outcome: string; runId?: string } = { outcome: 'idle' };
  for (let pages = 0; pages < 4; pages++) {
    result = await resumeSyncWorkflowPage(deps);
    if (!['photos', 'drafts'].includes(result.outcome) || Date.now() - began >= 45_000) break;
  }
  return result;
}
