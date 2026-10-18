import { performance } from 'node:perf_hooks';
import {
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
  prepareCatalogProductOperationApproval,
} from '@vibelingan-channel/db';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogValidationReportSchema } from '@vibelingan-channel/shared/catalog-issues';
import {
  type CatalogProductOperationBinding,
  CatalogProductOperationBindingSchema,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { createOwnedCatalogSourcePreparer } from './catalog-detail-source.ts';

const RequestSchema = CatalogProductOperationBindingSchema.extend({
  action: z.literal('product-operation-continue'),
});
const ProgressSchema = z.object({
  ok: z.literal(true),
  nextPage: z.number().int().min(0).max(500),
  pages: z.number().int().min(1).max(500),
  complete: z.boolean(),
});
const codes = [
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'MEDIA_NOT_READY',
  'MEDIA_BUSY',
  'APPROVAL_EXPIRED',
  'APPROVAL_TOO_LARGE',
  'SOURCE_NOT_READY',
  'MANUAL_CONFIGURATIONS',
] as const;
export const OWNED_CONTINUATION_BUDGET_MS = 12_000;
export interface OwnedContinuationDeps {
  operation: typeof manageCatalogProductOperation;
  seed: typeof prepareCatalogProductOperationApproval;
  prepare: (actorId: string, input: unknown, canBegin?: () => boolean) => Promise<unknown>;
  configuration: (
    actorId: string,
    scope: CatalogProductOperationBinding,
    page: number,
  ) => Promise<unknown>;
  now: () => number;
}
function failure(value: unknown) {
  const code = value && typeof value === 'object' ? Reflect.get(value, 'code') : undefined;
  const validation = CatalogValidationReportSchema.safeParse(
    value && typeof value === 'object' ? Reflect.get(value, 'validation') : undefined,
  );
  return {
    ok: false as const,
    code: codes.find((known) => known === code) ?? 'CONFLICT',
    ...(validation.success ? { validation: validation.data } : {}),
  };
}
function status(
  value: Awaited<ReturnType<typeof manageCatalogProductOperation>>,
  scope: CatalogProductOperationBinding,
) {
  if (!value.ok) return value;
  const parsed = CatalogProductOperationStatusSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.productId !== scope.productId ||
    parsed.data.operationId !== scope.operationId ||
    parsed.data.inputDigest !== scope.inputDigest
  )
    return { ok: false as const, code: 'CONFLICT' as const };
  if (
    parsed.data.state !== 'complete' &&
    (!parsed.data.current ||
      !parsed.data.revisionCurrent ||
      parsed.data.expired ||
      parsed.data.cancelledAt !== undefined)
  )
    return { ok: false as const, code: 'CONFLICT' as const };
  return parsed.data;
}
export async function continueAdminCatalogProductOperation(
  actorId: string,
  input: unknown,
  deps: OwnedContinuationDeps = {
    operation: manageCatalogProductOperation,
    ...ownedSourceDependencies(),
    configuration: (actorId, scope, page) =>
      persistCatalogDetailApproval(actorId, {
        ...scope,
        action: 'operation-approval-page',
        page,
      }),
    now: () => performance.now(),
  },
  budgetMs = OWNED_CONTINUATION_BUDGET_MS,
) {
  if (
    !fitsJsonBudget(input, 4096, 12) ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 0 ||
    budgetMs > OWNED_CONTINUATION_BUDGET_MS
  )
    return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const { action: _action, ...scope } = parsed.data;
  const deadline = deps.now() + budgetMs;
  const get = async () =>
    status(
      await deps.operation(actorId, {
        action: 'product-operation-get',
        productId: scope.productId,
        operationId: scope.operationId,
      }),
      scope,
    );
  const configure = async (initial: Awaited<ReturnType<typeof get>>) => {
    let current = initial;
    for (let attempt = 0; attempt < 500; attempt++) {
      if (
        !current.ok ||
        current.state !== 'staging' ||
        current.approval.configurations.completed === current.approval.configurations.total
      )
        return current;
      if (deps.now() >= deadline) return current;
      const page = current.approval.configurations.completed;
      const raw = await deps.configuration(actorId, scope, page);
      if (!raw || typeof raw !== 'object' || Reflect.get(raw, 'ok') !== true) return failure(raw);
      current = await get();
      if (!current.ok || current.state === 'complete') return current;
      if (current.state !== 'staging' || current.approval.configurations.completed <= page)
        return { ok: false as const, code: 'CONFLICT' as const };
    }
    return current;
  };
  if (deps.now() >= deadline) return get();
  let current = status(
    await deps.operation(actorId, { ...scope, action: 'product-operation-save' }),
    scope,
  );
  if (!current.ok) return current;
  if (current.state === 'complete') return current;
  if (current.intent === 'save-draft') return current;
  if (current.state === 'staging') return configure(current);
  if (current.intent !== 'publish' || current.state !== 'saved')
    return { ok: false as const, code: 'CONFLICT' as const };
  if (deps.now() >= deadline) return current;
  let seeded = await deps.seed(actorId, scope, () => deps.now() < deadline);
  if (seeded.ok) return configure(status(seeded, scope));
  if (seeded.code !== 'SOURCE_NOT_READY') return seeded;
  for (let page = 0, attempt = 0; attempt < 500; attempt++) {
    if (deps.now() >= deadline) return get();
    const raw = await deps.prepare(
      actorId,
      {
        action: 'prepare',
        productId: scope.productId,
        page,
      },
      () => deps.now() < deadline,
    );
    if (deps.now() >= deadline) return get();
    if (raw && typeof raw === 'object' && Reflect.get(raw, 'ok') === false) return failure(raw);
    const progress = ProgressSchema.safeParse(raw);
    if (!progress.success) return { ok: false as const, code: 'CONFLICT' as const };
    current = await get();
    if (!current.ok) return current;
    if (current.state === 'complete') return current;
    if (progress.data.complete) {
      if (deps.now() >= deadline) return current;
      seeded = await deps.seed(actorId, scope, () => deps.now() < deadline);
      return seeded.ok ? configure(status(seeded, scope)) : seeded;
    }
    if (progress.data.nextPage <= page || progress.data.nextPage >= progress.data.pages)
      return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
    page = progress.data.nextPage;
  }
  return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
}

function ownedSourceDependencies() {
  const source = createOwnedCatalogSourcePreparer();
  return {
    prepare: source.prepare,
    seed: (actorId: string, input: unknown, canBegin?: () => boolean) =>
      prepareCatalogProductOperationApproval(actorId, input, canBegin, source.readCandidate),
  };
}
