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
import type { OwnedMediaPreparationStep } from './catalog-operation-media-preparation.ts';

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
  media: (actorId: string, scope: CatalogProductOperationBinding) => Promise<unknown>;
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
    media: (actorId, scope) =>
      persistCatalogDetailApproval(actorId, { ...scope, action: 'operation-approval-media' }),
    now: () => performance.now(),
  },
  budgetMs = OWNED_CONTINUATION_BUDGET_MS,
  prepareMedia?: OwnedMediaPreparationStep,
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
  const advance = async (initial: Awaited<ReturnType<typeof get>>) => {
    const configured = await configure(initial);
    if (
      !configured.ok ||
      configured.state !== 'staging' ||
      configured.approval.mediaReady ||
      configured.approval.configurations.completed !== configured.approval.configurations.total ||
      deps.now() >= deadline
    )
      return configured;
    const raw = await deps.media(actorId, scope);
    const success = raw && typeof raw === 'object' && Reflect.get(raw, 'ok') === true;
    const pending =
      raw &&
      typeof raw === 'object' &&
      Reflect.get(raw, 'ok') === false &&
      Reflect.get(raw, 'code') === 'MEDIA_NOT_READY';
    if (!success && !pending) return failure(raw);
    const current = await get();
    if (success && current.ok && current.state === 'staging' && !current.approval.mediaReady)
      return { ok: false as const, code: 'CONFLICT' as const };
    return current;
  };
  const prepareMissingMedia = async (initial: Awaited<ReturnType<typeof get>>) => {
    if (!prepareMedia || !initial.ok || (initial.state !== 'saved' && initial.state !== 'staging'))
      return initial;
    const step = await prepareMedia(actorId, scope, Math.max(0, deadline - deps.now()));
    const current = await get();
    if (!current.ok || current.state === 'complete') return current;
    if (!step.ok) return failure(step);
    if (current.state !== 'saved' && current.state !== 'staging')
      return { ok: false as const, code: 'CONFLICT' as const };
    const prepared = current.state === 'staging' && step.ready ? await advance(current) : current;
    if (
      !prepared.ok ||
      prepared.state === 'complete' ||
      (prepared.state === 'staging' && prepared.approval.mediaReady)
    )
      return prepared;
    const preparation =
      step.ready && prepared.state === 'staging'
        ? { ...step.preparation, nextAction: 'repair' as const }
        : step.preparation;
    const hinted = { ...prepared, preparation };
    const parsed = CatalogProductOperationStatusSchema.safeParse(hinted);
    return parsed.success && fitsJsonBudget(parsed.data, 4096, 12)
      ? parsed.data
      : { ok: false as const, code: 'CONFLICT' as const };
  };
  const resume = async (initial: Awaited<ReturnType<typeof get>>) => {
    const current = await advance(initial);
    return current.ok &&
      current.state === 'staging' &&
      !current.approval.mediaReady &&
      current.approval.configurations.completed === current.approval.configurations.total
      ? prepareMissingMedia(current)
      : current;
  };
  if (deps.now() >= deadline) return get();
  let current = status(
    await deps.operation(actorId, { ...scope, action: 'product-operation-save' }),
    scope,
  );
  if (!current.ok) return current;
  if (current.state === 'complete') return current;
  if (current.intent === 'save-draft') return current;
  if (current.state === 'staging') return resume(current);
  if (current.intent !== 'publish' || current.state !== 'saved')
    return { ok: false as const, code: 'CONFLICT' as const };
  if (deps.now() >= deadline) return current;
  let seeded = await deps.seed(actorId, scope, () => deps.now() < deadline);
  if (seeded.ok) return resume(status(seeded, scope));
  if (seeded.code === 'MEDIA_NOT_READY' && prepareMedia) return prepareMissingMedia(await get());
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
      if (seeded.ok) return resume(status(seeded, scope));
      return seeded.code === 'MEDIA_NOT_READY' && prepareMedia
        ? prepareMissingMedia(await get())
        : seeded;
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
