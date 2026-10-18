/** Public start/get/cancel only; private approval steps remain server-owned. */
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogDetailHeaderSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { ApprovalStageResult } from './catalog-detail-staging.ts';
import { captureApprovalPersistenceCommand } from './catalog-detail-staging.ts';
import type { CatalogApprovalStore } from './catalog-detail-workflow.ts';
import {
  PRODUCT_OPERATION_INPUT_MAX_BYTES,
  PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
  ProductOperationCancelSchema,
  ProductOperationGetSchema,
  ProductOperationStartSchema,
  cleanProductOperationValues,
} from './catalog-product-operation.ts';
const SubmittedTextSchema = z.object({
  name: CatalogDetailHeaderSchema.shape.name.optional(),
  description: CatalogDetailHeaderSchema.shape.descriptionText,
});
const RequestSchema = z.discriminatedUnion('action', [
  ProductOperationStartSchema.omit({ submittedInputDigest: true }).extend({
    action: z.literal('product-operation-start'),
  }),
  ProductOperationGetSchema.extend({ action: z.literal('product-operation-get') }),
  ProductOperationCancelSchema.extend({ action: z.literal('product-operation-cancel') }),
]);
export type ProductOperationStartNormalizer = (
  values: Record<string, unknown>,
) => Promise<
  { ok: true; values: Record<string, unknown> } | Extract<ApprovalStageResult, { ok: false }>
>;
export async function runProductOperationWorkflow(
  store: Pick<CatalogApprovalStore, 'persist'>,
  actorId: string,
  input: unknown,
  normalizeStart?: ProductOperationStartNormalizer,
) {
  if (!fitsJsonBudget(input, PRODUCT_OPERATION_INPUT_MAX_BYTES, 24))
    return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const request = parsed.data;
  const command =
    request.action === 'product-operation-start'
      ? { ...request, action: 'operation-start' as const }
      : request.action === 'product-operation-get'
        ? { ...request, action: 'operation-get' as const }
        : { ...request, action: 'operation-cancel' as const };
  const captured = captureApprovalPersistenceCommand(command);
  if (!captured.ok) return captured;
  let result: ApprovalStageResult;
  if (captured.command.action === 'operation-start') {
    const start = captured.command;
    const values = cleanProductOperationValues(start.values);
    if (values === null) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
    const textInput = {
      ...values,
      ...(Object.hasOwn(values, 'description') && typeof values.description === 'string'
        ? { description: values.description.trim() || undefined }
        : {}),
    };
    const text = SubmittedTextSchema.safeParse(textInput);
    if (!text.success)
      return catalogValidationFailure(
        'commit',
        catalogIssuesFromZod(text.error.issues, textInput, { stage: 'commit', remedy: 'edit' }),
      );
    const submittedInputDigest = alibabaPricingFingerprint([
      actorId,
      start.productId,
      start.operationId,
      start.intent,
      start.expectedUpdatedAt,
      values,
    ]);
    if (normalizeStart) {
      const previous = await store.persist(actorId, {
        action: 'operation-get',
        productId: start.productId,
        operationId: start.operationId,
      });
      if (previous.ok) {
        if (
          !('record' in previous) ||
          previous.record.actorId !== actorId ||
          previous.record.productId !== start.productId ||
          previous.record.operationId !== start.operationId
        )
          return { ok: false as const, code: 'CONFLICT' as const };
        const operation = previous.record.operation;
        if (operation.submittedInputDigest !== undefined) {
          if (
            operation.submittedInputDigest !== submittedInputDigest ||
            operation.intent !== start.intent ||
            operation.expectedUpdatedAt !== start.expectedUpdatedAt
          )
            return { ok: false as const, code: 'CONFLICT' as const };
          result = previous;
        } else result = await store.persist(actorId, { ...start, values, submittedInputDigest });
      } else if (previous.code !== 'NOT_FOUND') return previous;
      else {
        const normalized = await normalizeStart(structuredClone(values));
        if (!normalized.ok) return normalized;
        const frozen = cleanProductOperationValues(
          normalized.values,
          PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
        );
        if (frozen === null) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
        const withoutDecisions = (patch: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'supplierDecisions'));
        if (
          alibabaPricingFingerprint(withoutDecisions(values)) !==
          alibabaPricingFingerprint(withoutDecisions(frozen))
        )
          return { ok: false as const, code: 'CONFLICT' as const };
        result = await store.persist(actorId, { ...start, values: frozen, submittedInputDigest });
      }
    } else result = await store.persist(actorId, { ...start, values, submittedInputDigest });
  } else result = await store.persist(actorId, captured.command);
  if (!result.ok) return result;
  if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
  const record = result.record;
  if (
    record.actorId !== actorId ||
    record.productId !== parsed.data.productId ||
    record.operationId !== parsed.data.operationId
  )
    return { ok: false as const, code: 'CONFLICT' as const };
  const status = {
    ok: true,
    kind: 'product-operation',
    state: record.state,
    productId: record.productId,
    operationId: record.operationId,
    intent: record.operation.intent,
    inputDigest: record.operation.inputDigest,
    createdAt: record.createdAt,
    current: result.current,
    revisionCurrent: result.revisionCurrent,
    expired: result.expired,
    ...(record.operation.cancelledAt === undefined
      ? {}
      : { cancelledAt: record.operation.cancelledAt }),
    ...(record.state === 'reserved'
      ? {}
      : { saved: { at: record.saved.at, productUpdatedAt: record.saved.productUpdatedAt } }),
    ...(record.state === 'staging' || record.state === 'complete'
      ? {
          approval: {
            revision: record.revision,
            configurations: { completed: record.nextPage, total: record.pageHashes.length },
            mediaReady: record.media !== undefined,
            references: {
              prepared: record.references !== undefined,
              staged: record.referenceStage?.cursor ?? 0,
              total: record.references?.leafCount ?? 0,
            },
          },
        }
      : {}),
    ...(record.state === 'complete'
      ? {
          completion: {
            at: record.completion.at,
            productUpdatedAt: record.completion.productUpdatedAt,
            revision: record.revision,
            published: record.completion.published,
          },
        }
      : {}),
  };
  const checked = CatalogProductOperationStatusSchema.safeParse(status);
  return checked.success &&
    fitsJsonBudget(checked.data, CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES, 12)
    ? checked.data
    : { ok: false as const, code: 'CONFLICT' as const };
}
