/** Public owned saves; approval and final publication remain server-owned. */
import { performance } from 'node:perf_hooks';
import { canonicalizeCatalogProductIdentities } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogDetailHeaderSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  CatalogIssueSchema,
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
  CatalogProductOperationStatusSchema,
  CatalogReferenceRecoveryCursorSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { ApprovalPersistenceCommand, ApprovalStageResult } from './catalog-detail-staging.ts';
import { captureApprovalPersistenceCommand } from './catalog-detail-staging.ts';
import type { ReferenceRecoveryPageResult } from './catalog-operation-reference-recovery.ts';
import {
  PRODUCT_OPERATION_INPUT_MAX_BYTES,
  PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
  ProductOperationCancelSchema,
  ProductOperationGetSchema,
  ProductOperationStartSchema,
  ProductOperationStopSchema,
  cleanProductOperationValues,
  productOperationPhotosPending,
  submittedProductOperationDigest,
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
  ProductOperationStopSchema.extend({ action: z.literal('product-operation-stop') }),
  ProductOperationCancelSchema.extend({ action: z.literal('product-operation-cancel') }),
  ProductOperationCancelSchema.extend({
    action: z.literal('product-operation-save'),
    referenceRecovery: CatalogReferenceRecoveryCursorSchema.optional(),
  }),
]);
export interface ProductOperationSaveContinuation {
  canContinue?: () => boolean;
  remainingBudgetMs?: () => number;
}
export type ProductOperationStartNormalizer = (
  values: Record<string, unknown>,
) => Promise<
  { ok: true; values: Record<string, unknown> } | Extract<ApprovalStageResult, { ok: false }>
>;
export async function runProductOperationWorkflow(
  store: {
    persist: (
      actorId: string,
      command: ApprovalPersistenceCommand,
      referenceRecovery?: unknown,
      referenceBudgetMs?: number,
    ) => Promise<ReferenceRecoveryPageResult>;
    save?: (input: CatalogProductSaveInput) => Promise<CatalogProductSaveResult>;
  },
  actorId: string,
  input: unknown,
  normalizeStart?: ProductOperationStartNormalizer,
  continuation?: ProductOperationSaveContinuation,
) {
  const deadline = performance.now() + 12_000;
  const remaining = () =>
    Math.max(
      0,
      Math.min(deadline - performance.now(), continuation?.remainingBudgetMs?.() ?? 12_000),
    );
  const canContinue = () => remaining() > 0 && (continuation?.canContinue?.() ?? true);
  if (!fitsJsonBudget(input, PRODUCT_OPERATION_INPUT_MAX_BYTES, 24))
    return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const request = parsed.data;
  const command =
    request.action === 'product-operation-start'
      ? { ...request, action: 'operation-start' as const }
      : request.action === 'product-operation-stop'
        ? { ...request, action: 'operation-stop' as const }
        : request.action === 'product-operation-get'
          ? { ...request, action: 'operation-get' as const }
          : request.action === 'product-operation-cancel'
            ? { ...request, action: 'operation-cancel' as const }
            : {
                action: 'operation-get' as const,
                productId: request.productId,
                operationId: request.operationId,
              };
  const captured = captureApprovalPersistenceCommand(command);
  if (!captured.ok) return captured;
  let result: ApprovalStageResult;
  if (captured.command.action === 'operation-start') {
    const start = captured.command;
    const values = cleanProductOperationValues(start.values);
    if (values === null) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
    const canonical = canonicalizeCatalogProductIdentities(values);
    if (!canonical.ok) return saveFailure({ result: 'invalid', kind: canonical.kind });
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
    const submittedInputDigest = submittedProductOperationDigest(actorId, start, values);
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
        const normalized = await normalizeStart(structuredClone(canonical.values));
        if (!normalized.ok) return normalized;
        const frozen = cleanProductOperationValues(
          normalized.values,
          PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
        );
        if (frozen === null) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
        const withoutDecisions = (patch: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'supplierDecisions'));
        if (
          alibabaPricingFingerprint(withoutDecisions(canonical.values)) !==
          alibabaPricingFingerprint(withoutDecisions(frozen))
        )
          return { ok: false as const, code: 'CONFLICT' as const };
        result = await store.persist(actorId, { ...start, values: frozen, submittedInputDigest });
      }
    } else
      result = await store.persist(actorId, {
        ...start,
        values: canonical.values,
        submittedInputDigest,
      });
  } else result = await store.persist(actorId, captured.command);
  if (request.action === 'product-operation-save') {
    if (!result.ok) return result;
    if (
      !('record' in result) ||
      result.record.actorId !== actorId ||
      result.record.productId !== request.productId ||
      result.record.operationId !== request.operationId ||
      result.record.operation.inputDigest !== request.inputDigest ||
      !['save-draft', 'publish', 'refresh-live'].includes(result.record.operation.intent) ||
      Object.hasOwn(result.record.operation, 'cancelledAt')
    )
      return { ok: false as const, code: 'CONFLICT' as const };
    if (result.record.state === 'reserved') {
      const identity = canonicalizeCatalogProductIdentities(result.record.operation.values);
      if (!identity.ok) return saveFailure({ result: 'invalid', kind: identity.kind });
      if (
        alibabaPricingFingerprint(identity.values) !==
        alibabaPricingFingerprint(result.record.operation.values)
      )
        return catalogValidationFailure('commit', [
          {
            code: 'INPUT_CHANGED',
            stage: 'commit',
            path: 'product',
            severity: 'error',
            remedy: 'reload',
          },
        ]);
      if (!result.current || !result.revisionCurrent || result.expired)
        return { ok: false as const, code: 'CONFLICT' as const };
      if (result.record.operation.intent === 'refresh-live' && canContinue()) {
        const scope = {
          productId: request.productId,
          operationId: request.operationId,
          inputDigest: request.inputDigest,
        };
        // New raw-row pictures must be held before staging. Both steps write the original Root.
        result = await store.persist(actorId, { ...scope, action: 'operation-photo-claim' });
        if (!result.ok) return result;
        if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
        if (result.record.state === 'reserved' && canContinue()) {
          result = await store.persist(actorId, {
            ...scope,
            action: 'operation-live-save-references',
          });
          if (!result.ok) return result;
          if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
        }
        // At most 63 raw-row changes. Stop at a page boundary, never pretend a partial save failed.
        for (let page = 0; page < 63 && result.record.state === 'reserved'; page++) {
          const references = result.record.liveSaveReferences;
          if (!references || references.cursor === references.changes.length || !canContinue())
            break;
          const previousCursor = references.cursor;
          const staged = await store.persist(
            actorId,
            { ...scope, action: 'operation-live-save-reference-page', cursor: previousCursor },
            request.referenceRecovery,
            remaining(),
          );
          if (!staged.ok && staged.code !== 'MEDIA_BUSY') return staged;
          result = await store.persist(actorId, {
            action: 'operation-get',
            productId: scope.productId,
            operationId: scope.operationId,
          });
          if (!result.ok) return result;
          if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
          if (result.record.state !== 'reserved') break;
          const progress = result.record.liveSaveReferences?.cursor;
          if (progress === undefined || progress < previousCursor)
            return { ok: false as const, code: 'CONFLICT' as const };
          if (!staged.ok && progress === previousCursor) {
            const cursor =
              'referenceRecovery' in staged
                ? CatalogReferenceRecoveryCursorSchema.safeParse(staged.referenceRecovery)
                : undefined;
            if (cursor && !cursor.success) return { ok: false as const, code: 'CONFLICT' as const };
            return projectStatus(result, actorId, request, {
              referenceRecovery: {
                nextAction: 'wait',
                cursor: cursor?.success ? cursor.data : null,
              },
            });
          }
          if (progress === previousCursor) return { ok: false as const, code: 'CONFLICT' as const };
        }
      }
      if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
      if (
        result.record.state === 'reserved' &&
        (!canContinue() ||
          (result.record.operation.intent === 'refresh-live' &&
            (!result.record.liveSaveReferences ||
              result.record.liveSaveReferences.cursor !==
                result.record.liveSaveReferences.changes.length)))
      )
        return projectStatus(result, actorId, request);
      if (result.record.state === 'reserved') {
        if (!store.save) throw new Error('Owned product save persistence unavailable');
        const saved = await store.save({
          mode: 'update',
          productId: request.productId,
          data: result.record.operation.values,
          expectedUpdatedAt: result.record.operation.expectedUpdatedAt,
          expectedOperation: {
            actorId,
            operationId: request.operationId,
            inputDigest: request.inputDigest,
          },
          ...((result.record.operation.photoClaimVersion ?? 0) > 0
            ? { expectedImageMutationOwner: result.record._id }
            : {}),
        });
        if (saved.result !== 'saved') return saveFailure(saved);
        result = await store.persist(actorId, captured.command);
      }
    }
  }
  if (!result.ok) return result;
  if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
  if (
    request.action === 'product-operation-save' &&
    result.record.state !== 'reserved' &&
    productOperationPhotosPending(result.record)
  ) {
    result = await store.persist(actorId, {
      action: 'operation-photo-release',
      productId: request.productId,
      operationId: request.operationId,
      inputDigest: result.record.operation.inputDigest,
    });
    if (!result.ok) return result;
    if (!('record' in result)) return { ok: false as const, code: 'CONFLICT' as const };
  }
  return projectStatus(result, actorId, request);
}

function projectStatus(
  result: Extract<ApprovalStageResult, { ok: true; record: unknown }>,
  actorId: string,
  request: { productId: string; operationId: string },
  hint?: { referenceRecovery: { nextAction: 'wait'; cursor: unknown } },
) {
  const record = result.record;
  if (
    record.actorId !== actorId ||
    record.productId !== request.productId ||
    record.operationId !== request.operationId
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
    ...(productOperationPhotosPending(record) ? { photosPending: true } : {}),
    ...(record.operation.cancelledAt === undefined
      ? {}
      : { cancelledAt: record.operation.cancelledAt }),
    ...(record.state === 'reserved'
      ? record.operation.intent === 'refresh-live'
        ? {
            saveReferences: {
              prepared: record.liveSaveReferences !== undefined,
              staged: record.liveSaveReferences?.cursor ?? 0,
              total: record.liveSaveReferences?.changes.length ?? 0,
            },
          }
        : {}
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
    ...hint,
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

function saveFailure(result: Exclude<CatalogProductSaveResult, { result: 'saved' }>) {
  if (result.result === 'media-busy') return { ok: false as const, code: 'MEDIA_BUSY' as const };
  const fields =
    result.result === 'invalid-product'
      ? result.issues.map((issue) => issue.field)
      : result.result === 'conflict' || result.result === 'invalid'
        ? [result.kind === 'sku' ? 'skuCode' : 'slug']
        : [];
  if (fields.length)
    return catalogValidationFailure(
      'commit',
      fields.map((field) => {
        const issue = {
          code: 'INVALID_VALUE' as const,
          stage: 'commit' as const,
          path: field,
          severity: 'error' as const,
          remedy: 'edit' as const,
        };
        const parsed = CatalogIssueSchema.safeParse(issue);
        return parsed.success ? parsed.data : { ...issue, path: 'product' };
      }),
    );
  return {
    ok: false as const,
    code: result.result === 'missing' ? ('NOT_FOUND' as const) : ('CONFLICT' as const),
  };
}

// Server orchestration may project the acknowledged native result from this same step.
export { projectStatus as projectCatalogProductOperationStatus };
