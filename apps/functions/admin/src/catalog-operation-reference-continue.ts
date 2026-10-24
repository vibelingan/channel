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
  type CatalogReferenceRecoveryCursor,
  CatalogReferenceRecoveryCursorSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';

export interface OwnedReferenceContinuationDeps {
  operation: typeof manageCatalogProductOperation;
  persist: typeof persistCatalogDetailApproval;
  now: () => number;
}
type Failure = {
  ok: false;
  code: string;
  validation?: ReturnType<typeof CatalogValidationReportSchema.parse>;
};
export type OwnedReferenceContinuationStep = (
  actorId: string,
  input: CatalogProductOperationBinding,
  budgetMs: number,
  recovery?: CatalogReferenceRecoveryCursor,
) => Promise<CatalogProductOperationStatus | Failure>;
/** Stage private reference pages; only the separate final transaction can grant public rights. */
export async function continueOwnedCatalogReferences(
  actorId: string,
  input: CatalogProductOperationBinding,
  budgetMs: number,
  recovery?: CatalogReferenceRecoveryCursor,
  deps: OwnedReferenceContinuationDeps = {
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
  const cursor =
    recovery === undefined ? undefined : CatalogReferenceRecoveryCursorSchema.safeParse(recovery);
  if (!parsed.success || (cursor && !cursor.success))
    return { ok: false, code: 'VALIDATION_ERROR' };
  const scope = parsed.data;
  const started = deps.now();
  if (!Number.isFinite(started) || started < 0) throw Error('Invalid reference continuation clock');
  let previous = started;
  const now = () => {
    const value = deps.now();
    if (!Number.isFinite(value) || value < previous)
      throw Error('Invalid reference continuation clock');
    previous = value;
    return value;
  };
  const deadline = started + budgetMs;
  const failure = (raw: { code: string; validation?: unknown }): Failure => {
    const validation = CatalogValidationReportSchema.safeParse(raw.validation);
    return {
      ok: false,
      code: raw.code,
      ...(validation.success ? { validation: validation.data } : {}),
    };
  };
  const get = async (): Promise<CatalogProductOperationStatus | Failure> => {
    const raw = await deps.operation(actorId, {
      action: 'product-operation-get',
      productId: scope.productId,
      operationId: scope.operationId,
    });
    if (!raw.ok) return failure(raw);
    const value = CatalogProductOperationStatusSchema.safeParse(raw);
    if (
      !value.success ||
      value.data.productId !== scope.productId ||
      value.data.operationId !== scope.operationId ||
      value.data.inputDigest !== scope.inputDigest ||
      !['publish', 'refresh-live'].includes(value.data.intent)
    )
      return { ok: false, code: 'CONFLICT' };
    const current = value.data;
    if (
      current.state !== 'complete' &&
      (current.state !== 'staging' ||
        !current.current ||
        !current.revisionCurrent ||
        current.expired ||
        current.cancelledAt !== undefined ||
        !current.approval.mediaReady ||
        current.approval.configurations.completed !== current.approval.configurations.total)
    )
      return { ok: false, code: 'CONFLICT' };
    return current;
  };
  let current = await get();
  if (!current.ok || current.state === 'complete' || now() >= deadline) return current;
  if (current.state !== 'staging') return { ok: false, code: 'CONFLICT' };
  if (!current.approval.references.prepared) {
    const raw = await deps.persist(actorId, { ...scope, action: 'operation-approval-references' });
    if (!raw.ok) return failure(raw);
    current = await get();
    if (!current.ok || current.state === 'complete') return current;
    if (current.state !== 'staging' || !current.approval.references.prepared)
      return { ok: false, code: 'CONFLICT' };
  }
  for (let attempt = 0; attempt < 65536; attempt++) {
    const references = current.approval.references;
    if (references.staged === references.total || now() >= deadline) return current;
    const raw = await deps.persist(
      actorId,
      { ...scope, action: 'operation-approval-reference-page', cursor: references.staged },
      cursor?.success ? cursor.data : undefined,
      Math.max(0, deadline - now()),
    );
    if (!raw.ok && raw.code !== 'MEDIA_BUSY') return failure(raw);
    current = await get();
    if (!current.ok || current.state === 'complete') return current;
    if (current.state !== 'staging') return { ok: false, code: 'CONFLICT' };
    if (!raw.ok) {
      if (current.approval.references.staged > references.staged) continue;
      const native =
        'referenceRecovery' in raw
          ? CatalogReferenceRecoveryCursorSchema.safeParse(raw.referenceRecovery)
          : undefined;
      if (native && !native.success) return { ok: false, code: 'CONFLICT' };
      const hinted = CatalogProductOperationStatusSchema.safeParse({
        ...current,
        referenceRecovery: { nextAction: 'wait', cursor: native?.success ? native.data : null },
      });
      return hinted.success && fitsJsonBudget(hinted.data, 4096, 12)
        ? hinted.data
        : { ok: false, code: 'CONFLICT' };
    }
    if (current.approval.references.staged <= references.staged)
      return { ok: false, code: 'CONFLICT' };
  }
  return current;
}
