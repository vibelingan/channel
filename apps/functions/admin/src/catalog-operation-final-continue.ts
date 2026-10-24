import { performance } from 'node:perf_hooks';
import {
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
} from '@vibelingan-channel/db';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogValidationReportSchema } from '@vibelingan-channel/shared/catalog-issues';
import {
  type CatalogProductOperationBinding,
  CatalogProductOperationBindingSchema,
  type CatalogProductOperationStatus,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
type Failure = {
  ok: false;
  code: string;
  validation?: ReturnType<typeof CatalogValidationReportSchema.parse>;
};
export type OwnedFinalContinuationStep = (
  actorId: string,
  input: CatalogProductOperationBinding,
  budgetMs: number,
) => Promise<CatalogProductOperationStatus | Failure>;
export interface OwnedFinalContinuationDeps {
  operation: typeof manageCatalogProductOperation;
  persist: typeof persistCatalogDetailApproval;
  now: () => number;
}
/** Only the original native final transaction grants publication; its durable receipt confirms an uncertain reply. */
export async function continueOwnedCatalogPublication(
  actorId: string,
  input: CatalogProductOperationBinding,
  budgetMs: number,
  deps: OwnedFinalContinuationDeps = {
    operation: manageCatalogProductOperation,
    persist: persistCatalogDetailApproval,
    now: () => performance.now(),
  },
): Promise<CatalogProductOperationStatus | Failure> {
  if (
    !fitsJsonBudget(input, 4096, 12) ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 0 ||
    budgetMs > 12000
  )
    return { ok: false, code: 'VALIDATION_ERROR' };
  const parsed = CatalogProductOperationBindingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const scope = parsed.data;
  const started = deps.now();
  if (!Number.isFinite(started) || started < 0) throw Error('Invalid owned publication clock');
  const failure = (raw: { code: string; validation?: unknown }): Failure => {
    const validation = CatalogValidationReportSchema.safeParse(raw.validation);
    return {
      ok: false,
      code: raw.code,
      ...(validation.success ? { validation: validation.data } : {}),
    };
  };
  const read = async (): Promise<CatalogProductOperationStatus | Failure> => {
    const raw = await deps.operation(actorId, {
      action: 'product-operation-get',
      productId: scope.productId,
      operationId: scope.operationId,
    });
    if (!raw.ok) return failure(raw);
    const parsed = CatalogProductOperationStatusSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.productId !== scope.productId ||
      parsed.data.operationId !== scope.operationId ||
      parsed.data.inputDigest !== scope.inputDigest ||
      !['publish', 'refresh-live'].includes(parsed.data.intent)
    )
      return { ok: false, code: 'CONFLICT' };
    const status = parsed.data;
    if (
      status.state !== 'complete' &&
      (status.state !== 'staging' ||
        !status.current ||
        !status.revisionCurrent ||
        status.expired ||
        status.cancelledAt !== undefined ||
        status.approval.configurations.completed !== status.approval.configurations.total ||
        !status.approval.mediaReady ||
        !status.approval.references.prepared ||
        status.approval.references.staged !== status.approval.references.total)
    )
      return { ok: false, code: 'CONFLICT' };
    return status;
  };
  const initial = await read();
  if (!initial.ok || initial.state === 'complete') return initial;
  if (initial.state !== 'staging') return { ok: false, code: 'CONFLICT' };
  const now = deps.now();
  if (!Number.isFinite(now) || now < started) throw Error('Invalid owned publication clock');
  if (budgetMs - (now - started) < 2000) return initial;
  const confirmed = (value: Awaited<ReturnType<typeof read>>) =>
    value.ok &&
    value.state === 'complete' &&
    value.approval.revision === initial.approval.revision &&
    value.completion.revision === initial.approval.revision;
  let raw: Awaited<ReturnType<typeof persistCatalogDetailApproval>>;
  try {
    raw = await deps.persist(actorId, { ...scope, action: 'operation-publish' });
  } catch (cause) {
    let current: Awaited<ReturnType<typeof read>>;
    try {
      current = await read();
    } catch (confirmation) {
      throw new AggregateError([cause, confirmation], 'Owned publication could not be confirmed');
    }
    if (confirmed(current)) return current;
    throw cause;
  }
  if (!raw.ok) return failure(raw);
  const current = await read();
  if (!current.ok) return current;
  return confirmed(current) ? current : { ok: false, code: 'CONFLICT' };
}
