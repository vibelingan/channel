import { performance } from 'node:perf_hooks';
import { manageCatalogProductOperation } from '@vibelingan-channel/db';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobStatus,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogPreparationReportSchema } from '@vibelingan-channel/shared/catalog-preparation';
import {
  type CatalogProductOperationBinding,
  CatalogProductOperationBindingSchema,
  type CatalogProductOperationPreparation,
  CatalogProductOperationPreparationSchema,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { manageHumanCatalogPreparation } from './catalog-preparation-api.ts';
import {
  CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
  type CatalogPreparationInvoker,
} from './catalog-preparation-invoker.ts';

export type OwnedMediaPreparationStep = (
  actorId: string,
  input: CatalogProductOperationBinding,
  budgetMs: number,
) => Promise<
  | { ok: true; ready: boolean; preparation: CatalogProductOperationPreparation }
  | { ok: false; code: string }
>;
export interface OwnedMediaPreparationDeps {
  operation: typeof manageCatalogProductOperation;
  human: typeof manageHumanCatalogPreparation;
  now: () => number;
}
const headroom = CATALOG_PREPARATION_INVOKE_TIMEOUT_MS + 2000;
/** Reuse the signed preparation workflow while the original operation still owns its inputs. */
export function createOwnedMediaPreparation(
  authority: CatalogPreparationAuthority,
  invoke: CatalogPreparationInvoker,
  deps: OwnedMediaPreparationDeps = {
    operation: manageCatalogProductOperation,
    human: manageHumanCatalogPreparation,
    now: () => performance.now(),
  },
): OwnedMediaPreparationStep {
  return async (actorId, input, budgetMs) => {
    if (!fitsJsonBudget(input, 4096, 12) || !Number.isFinite(budgetMs) || budgetMs < 0)
      return { ok: false, code: 'VALIDATION_ERROR' };
    const parsed = CatalogProductOperationBindingSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
    const scope = parsed.data;
    const started = deps.now();
    if (!Number.isFinite(started) || started < 0) throw Error('Invalid owned preparation clock');
    const hasHeadroom = () => {
      const now = deps.now();
      return Number.isFinite(now) && now >= started && budgetMs - (now - started) >= headroom;
    };
    const inspect = async () => {
      const raw = await deps.operation(actorId, {
        action: 'product-operation-get',
        productId: scope.productId,
        operationId: scope.operationId,
      });
      if (!raw.ok) return raw;
      const value = CatalogProductOperationStatusSchema.safeParse(raw);
      if (
        !value.success ||
        value.data.productId !== scope.productId ||
        value.data.operationId !== scope.operationId ||
        value.data.inputDigest !== scope.inputDigest ||
        value.data.intent !== 'publish'
      )
        return { ok: false as const, code: 'CONFLICT' as const };
      const current = value.data;
      if (
        current.state !== 'complete' &&
        ((current.state !== 'saved' && current.state !== 'staging') ||
          !current.current ||
          !current.revisionCurrent ||
          current.expired ||
          current.cancelledAt !== undefined)
      )
        return { ok: false as const, code: 'CONFLICT' as const };
      return { ok: true as const, status: current };
    };
    const view = (
      nextAction: CatalogProductOperationPreparation['nextAction'],
      state?: CatalogPreparationJobStatus,
      ready = false,
    ) => {
      const media = state?.progress.media;
      const preparation = CatalogProductOperationPreparationSchema.safeParse({
        nextAction,
        job: state ? { id: state.progress.jobId, leaseVersion: state.progress.leaseVersion } : null,
        progress: media ? { checked: media.checked, total: media.total } : null,
      });
      return preparation.success
        ? { ok: true as const, ready, preparation: preparation.data }
        : { ok: false as const, code: 'CONFLICT' };
    };
    const childFailure = (failure: { code: string }) =>
      ['CORRUPT', 'CONFLICT', 'STALE', 'NOT_FOUND'].includes(failure.code)
        ? view('repair')
        : failure.code === 'BUSY'
          ? view('wait')
          : { ok: false as const, code: failure.code };
    let owner = await inspect();
    if (!owner.ok) return owner;
    if (owner.status.state === 'complete') return view('continue', undefined, true);
    if (!hasHeadroom()) return view('wait');
    const opened = await deps.human(authority, actorId, {
      action: 'start',
      productId: scope.productId,
    });
    owner = await inspect();
    if (!owner.ok) return owner;
    if (owner.status.state === 'complete') return view('continue', undefined, true);
    if (!opened.ok) return childFailure(opened);
    if (
      !('progress' in opened) ||
      opened.progress.productId !== scope.productId ||
      !/^[a-f0-9]{64}$/.test(opened.progress.jobId)
    )
      return { ok: false, code: 'CONFLICT' };
    const jobId = opened.progress.jobId;
    let child = await deps.human(authority, actorId, { action: 'status', jobId });
    owner = await inspect();
    if (!owner.ok) return owner;
    if (owner.status.state === 'complete') return view('continue', undefined, true);
    if (!child.ok) return childFailure(child);
    if (
      !('status' in child) ||
      child.status.progress.jobId !== jobId ||
      child.status.progress.productId !== scope.productId
    )
      return { ok: false, code: 'CONFLICT' };
    if (child.status.current && child.status.nextAction === 'continue' && hasHeadroom()) {
      child = await deps.human(authority, actorId, { action: 'continue', jobId }, async (call) => {
        const current = await inspect();
        if (!current.ok || current.status.state === 'complete' || !hasHeadroom())
          throw Object.assign(Error('Owned media preparation no longer admitted'), {
            code: 'CONFLICT',
          });
        return invoke(call);
      });
      owner = await inspect();
      if (!owner.ok) return owner;
      if (owner.status.state === 'complete') return view('continue', undefined, true);
      if (!child.ok) return childFailure(child);
      if (
        !('status' in child) ||
        child.status.progress.jobId !== jobId ||
        child.status.progress.productId !== scope.productId
      )
        return { ok: false, code: 'CONFLICT' };
    }
    const state = child.status;
    if (!state.current) return view('repair', state);
    if (state.nextAction === 'ready') {
      const report = CatalogPreparationReportSchema.safeParse(state.report);
      return state.progress.state === 'completed' &&
        report.success &&
        report.data.state === 'ready' &&
        report.data.productId === scope.productId &&
        report.data.seal.jobId === jobId
        ? view('continue', state, true)
        : view('repair', state);
    }
    if (state.nextAction === 'continue')
      return view(
        'followUp' in child && child.followUp === 'continue' ? 'continue' : 'wait',
        state,
      );
    if (state.nextAction === 'wait') return view('wait', state);
    if (state.nextAction === 'retry') return view('retry', state);
    if (state.nextAction === 'edit') return view('edit', state);
    return view('repair', state);
  };
}
