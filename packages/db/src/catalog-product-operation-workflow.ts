/** Public start/get/cancel only; private approval steps remain server-owned. */
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import {
  CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { captureApprovalPersistenceCommand } from './catalog-detail-staging.ts';
import type { CatalogApprovalStore } from './catalog-detail-workflow.ts';
import {
  PRODUCT_OPERATION_INPUT_MAX_BYTES,
  ProductOperationCancelSchema,
  ProductOperationGetSchema,
  ProductOperationStartSchema,
} from './catalog-product-operation.ts';
const RequestSchema = z.discriminatedUnion('action', [
  ProductOperationStartSchema.extend({ action: z.literal('product-operation-start') }),
  ProductOperationGetSchema.extend({ action: z.literal('product-operation-get') }),
  ProductOperationCancelSchema.extend({ action: z.literal('product-operation-cancel') }),
]);
export async function runProductOperationWorkflow(
  store: Pick<CatalogApprovalStore, 'persist'>,
  actorId: string,
  input: unknown,
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
  const result = await store.persist(actorId, captured.command);
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
