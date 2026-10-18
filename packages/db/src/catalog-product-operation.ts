/** One durable operation binds draft, private approval pages and the atomic publication receipt. */
import { createHash } from 'node:crypto';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import {
  type CollectionDoc,
  buildWriteSchema,
  catalogReferencedImageIds,
  getCollection,
  validateProductPublication,
  writableFields,
} from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import {
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_APPROVAL_JOB_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-approval';
import { CATALOG_DETAIL_PAGINATION_POLICY } from '@vibelingan-channel/shared/catalog-detail-pagination';
import {
  CatalogIssueSchema,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
} from '@vibelingan-channel/shared/catalog-preparation';
import { CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES } from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import { parseAlibabaProductLink } from './alibaba-link-identity.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { alibabaLinkRevision } from './alibaba-product-identity.ts';
import { APPROVAL_JOB_MAX_AGE_MS } from './approval-job-age.ts';
import {
  type ApprovalFailure,
  ApprovalJobSchema,
  type PreparedApproval,
  fitsApprovalJobBudget,
  readApprovalJob,
  sameApprovalProduct,
} from './catalog-approval-job.ts';
import { isApprovalPage, prepareApprovalPage, storeApprovalPage } from './catalog-approval-page.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  CATALOG_IMAGE_REFERENCE_MAX_LEAVES,
  catalogImageReferenceCancelProof,
} from './catalog-image-references.ts';
import {
  CatalogOwnedApprovalMediaSchema,
  prepareOwnedApprovalMedia,
  readOwnedApprovalMedia,
} from './catalog-operation-media.ts';
import {
  CatalogOwnedReferenceStageSchema,
  type OwnedReferenceStageFailure,
  ownedReferenceStageProgress,
  planOwnedReferenceStagePage,
  readOwnedReferenceStage,
} from './catalog-operation-reference-stage.ts';
import {
  CatalogOwnedApprovalReferencesSchema,
  prepareOwnedApprovalReferences,
  readOwnedApprovalReferencePlan,
} from './catalog-operation-references.ts';
import {
  CatalogProductStateError,
  advanceCatalogProduct,
  assertCatalogProductVersions,
} from './catalog-product-state.ts';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';
import {
  normalizedSourceInputDigest,
  sourceBindingInputs,
  sourceInputDigest,
  sourceObservationInputs,
} from './catalog-source-inputs.ts';

export const PRODUCT_OPERATION_INPUT_MAX_BYTES = CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES;
export const PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES = PRODUCT_OPERATION_INPUT_MAX_BYTES + 2048;
export const PRODUCT_OPERATION_RECORD_MAX_BYTES = 512 * 1024;
export const PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const collection = 'catalogDetailApprovals';
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe();
const intent = z.enum(['save-draft', 'refresh-live', 'publish', 'unpublish', 'archive']);
const identifiers = z.object({ productId: id, operationId: z.string().uuid() });
export const ProductOperationStartSchema = identifiers
  .extend({
    action: z.literal('operation-start'),
    intent,
    expectedUpdatedAt: z.string().datetime().nullable(),
    values: z.record(z.unknown()),
    submittedInputDigest: digest.optional(),
  })
  .strict();
export const ProductOperationGetSchema = identifiers
  .extend({ action: z.literal('operation-get') })
  .strict();
export const ProductOperationApprovalBeginSchema = identifiers
  .extend({
    action: z.literal('operation-approval-begin'),
    inputDigest: digest,
    prepared: ApprovalJobSchema,
  })
  .strict();
export const ProductOperationApprovalPageSchema = identifiers
  .extend({
    action: z.literal('operation-approval-page'),
    inputDigest: digest,
    page: z.number().int().min(0).max(499),
  })
  .strict();
export const ProductOperationCancelSchema = identifiers
  .extend({ action: z.literal('operation-cancel'), inputDigest: digest })
  .strict();
export const ProductOperationMediaSchema = identifiers
  .extend({ action: z.literal('operation-approval-media'), inputDigest: digest })
  .strict();
export const ProductOperationReferencesSchema = identifiers
  .extend({ action: z.literal('operation-approval-references'), inputDigest: digest })
  .strict();
export const ProductOperationReferencePageSchema = identifiers
  .extend({
    action: z.literal('operation-approval-reference-page'),
    inputDigest: digest,
    cursor: counter.max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
  })
  .strict();
export const ProductOperationPublishSchema = identifiers
  .extend({ action: z.literal('operation-publish'), inputDigest: digest })
  .strict();
export const ProductOperationRecoverSchema = identifiers
  .extend({ action: z.literal('operation-recover'), operationRootId: digest, inputDigest: digest })
  .strict();
const CommandSchema = z.discriminatedUnion('action', [
  ProductOperationStartSchema,
  ProductOperationGetSchema,
  ProductOperationApprovalBeginSchema,
  ProductOperationApprovalPageSchema,
  ProductOperationCancelSchema,
  ProductOperationMediaSchema,
  ProductOperationReferencesSchema,
  ProductOperationReferencePageSchema,
  ProductOperationPublishSchema,
  ProductOperationRecoverSchema,
]);
const SnapshotSchema = z
  .object({
    contentGeneration: counter,
    lifecycleVersion: counter,
    classificationRevision: counter,
    websiteDigest: digest,
    identityDigest: digest,
    approvalDigest: digest.optional(),
    source: z
      .object({
        key: id,
        linkRevision: counter,
        sourceHash: digest,
        observationHash: digest,
        linkHash: digest,
      })
      .strict()
      .nullable(),
  })
  .strict();
const PolicySchema = z.object({ preparation: id, media: id, pixels: id }).strict();
const currentPolicy = () => ({
  preparation: CATALOG_PREPARATION_POLICY,
  media: CATALOG_MEDIA_SEAL_POLICY,
  pixels: CATALOG_PIXEL_POLICY,
});
const RecoveryAuditSchema = z
  .object({
    actorId: id,
    reason: z.enum(['expired', 'owner-unavailable', 'input-changed']),
    at: z.string().datetime(),
  })
  .strict();
const ReservedSchema = z
  .object({
    _id: digest,
    actorId: id,
    productId: id,
    operationId: z.string().uuid(),
    state: z.literal('reserved'),
    createdAt: z.string().datetime(),
    operation: z
      .object({
        protocolVersion: z.literal(2),
        intent,
        expectedUpdatedAt: z.string().datetime().nullable(),
        inputDigest: digest,
        submittedInputDigest: digest.optional(),
        policy: PolicySchema,
        values: z.record(z.unknown()),
        base: SnapshotSchema,
        cancelledAt: z.string().datetime().optional(),
        recovery: RecoveryAuditSchema.optional(),
      })
      .strict(),
  })
  .strict();
const SavedSchema = ReservedSchema.extend({
  state: z.literal('saved'),
  saved: z
    .object({
      at: z.string().datetime(),
      productUpdatedAt: z.string().datetime(),
      snapshot: SnapshotSchema,
    })
    .strict(),
});
const ApprovalOperationSchema = SavedSchema.merge(ApprovalJobSchema).extend({
  state: z.literal('staging'),
  media: CatalogOwnedApprovalMediaSchema.optional(),
  references: CatalogOwnedApprovalReferencesSchema.optional(),
  referenceStage: CatalogOwnedReferenceStageSchema.optional(),
});
const CompleteOperationSchema = ApprovalOperationSchema.extend({
  state: z.literal('complete'),
  media: CatalogOwnedApprovalMediaSchema,
  references: CatalogOwnedApprovalReferencesSchema,
  referenceStage: CatalogOwnedReferenceStageSchema,
  completion: z
    .object({
      at: z.string().datetime(),
      productUpdatedAt: z.string().datetime(),
      published: z.literal(true),
      snapshot: SnapshotSchema,
    })
    .strict(),
});
const RecordSchema = z.discriminatedUnion('state', [
  ReservedSchema,
  SavedSchema,
  ApprovalOperationSchema,
  CompleteOperationSchema,
]);
export type SavedProductOperation = z.infer<typeof SavedSchema>;
export type ProductOperationRecord = z.infer<typeof RecordSchema>;
type Command = z.infer<typeof CommandSchema>;
type Intent = z.infer<typeof intent>;
export type ReservedProductOperation = z.infer<typeof ReservedSchema>;
export type ProductOperationResult =
  | {
      ok: true;
      record: ProductOperationRecord;
      current: boolean;
      revisionCurrent: boolean;
      expired: boolean;
      recovery?: 'not-needed' | 'cancelled' | 'already-cancelled' | 'already-complete';
    }
  | OwnedReferenceStageFailure;
const fail = (
  code: Extract<ProductOperationResult, { ok: false }>['code'],
): Extract<ProductOperationResult, { ok: false }> => ({ ok: false, code });
const definition = getCollection('products');
if (!definition) throw new Error('Product registry is unavailable');
const fields = [...writableFields(definition).map((field) => field.name), 'subcategoryIds'];
// Visibility belongs to intent. A generic patch cannot smuggle another transition.
const ValuesSchema = buildWriteSchema(definition)
  .partial()
  .omit({ published: true, archived: true })
  .strict();
const operationKey = (actorId: string, productId: string, operationId: string) =>
  // Share the approval key so one record contains every stage.
  createHash('sha256')
    .update(JSON.stringify([actorId, productId, operationId]))
    .digest('hex');

export async function runProductOperation(
  tx: CatalogApprovalTransaction,
  actorId: string,
  input: unknown,
): Promise<ProductOperationResult> {
  if (!fitsJsonBudget(input, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_ERROR');
  const command = parsed.data;
  const normalizedStart =
    command.action === 'operation-start' && command.submittedInputDigest !== undefined;
  if (
    command.action === 'operation-start' &&
    Object.hasOwn(command, 'submittedInputDigest') &&
    command.submittedInputDigest === undefined
  )
    return fail('VALIDATION_ERROR');
  if (
    command.action !== 'operation-approval-begin' &&
    !fitsJsonBudget(
      input,
      normalizedStart
        ? PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES
        : PRODUCT_OPERATION_INPUT_MAX_BYTES,
      24,
    )
  )
    return fail('VALIDATION_ERROR');
  const actor = id.safeParse(actorId);
  if (!actor.success) return fail('FORBIDDEN');
  // Clone the entire JSON patch before the first await, including unknown JSON fields.
  const values =
    command.action === 'operation-start'
      ? cleanProductOperationValues(
          command.values,
          normalizedStart
            ? PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES
            : PRODUCT_OPERATION_INPUT_MAX_BYTES,
        )
      : {};
  if (values === null) return fail('VALIDATION_ERROR');
  const user = await tx.get('users', actorId);
  if (user?.role !== 'admin' || user.status === 'suspended') return fail('FORBIDDEN');
  if (command.action === 'operation-approval-begin')
    return beginOperationApproval(tx, actorId, command);
  if (command.action === 'operation-approval-page')
    return stageOperationApprovalPage(tx, actorId, command);
  if (command.action === 'operation-approval-media')
    return bindOperationApprovalMedia(tx, actorId, command);
  if (command.action === 'operation-approval-references')
    return bindOperationApprovalReferences(tx, actorId, command);
  if (command.action === 'operation-approval-reference-page')
    return stageOperationReferences(tx, actorId, command);
  if (command.action === 'operation-publish') return publishOperation(tx, actorId, command);
  if (command.action === 'operation-recover') return recoverOperation(tx, actorId, command);
  const key = operationKey(actorId, command.productId, command.operationId);
  const previous = await tx.get(collection, key);
  if (previous) {
    const record = readReservation(previous, actorId, command);
    if (!record) return fail('CONFLICT');
    if (command.action === 'operation-cancel') {
      if (record.state === 'complete') return fail('CONFLICT');
      if (command.inputDigest !== record.operation.inputDigest) return fail('CONFLICT');
      return cancelOperation(tx, record);
    }
    if (
      command.action === 'operation-start' &&
      record.operation.inputDigest !== requestDigest(actorId, command, values)
    ) {
      const sameSubmitted =
        command.submittedInputDigest !== undefined &&
        record.operation.submittedInputDigest === command.submittedInputDigest &&
        record.operation.intent === command.intent &&
        record.operation.expectedUpdatedAt === command.expectedUpdatedAt;
      const legacyReplay =
        record.operation.submittedInputDigest === undefined &&
        (record.operation.inputDigest ===
          requestDigest(actorId, { ...command, submittedInputDigest: undefined }, values) ||
          (command.submittedInputDigest !== undefined &&
            command.submittedInputDigest ===
              submittedProductOperationDigest(
                actorId,
                {
                  productId: record.productId,
                  operationId: record.operationId,
                  intent: record.operation.intent,
                  expectedUpdatedAt: record.operation.expectedUpdatedAt,
                },
                record.operation.values,
              )));
      if (!sameSubmitted && !legacyReplay) return fail('CONFLICT');
    }
    return inspect(tx, record);
  }
  if (command.action === 'operation-get' || command.action === 'operation-cancel')
    return fail('NOT_FOUND');
  const product = await tx.get('products', command.productId);
  if (!product) return fail('NOT_FOUND');
  if (
    product._id !== command.productId ||
    (product.updatedAt ?? null) !== command.expectedUpdatedAt
  )
    return fail('CONFLICT');
  if (
    (command.intent === 'save-draft' &&
      (product.published === true || product.archived === true)) ||
    (command.intent === 'publish' && product.archived === true) ||
    (command.intent === 'refresh-live' && (product.published !== true || product.archived === true))
  )
    return fail('CONFLICT');
  const base = await snapshot(tx, product, command.intent);
  if (!base) return fail('CONFLICT');
  const record = ReservedSchema.parse({
    _id: key,
    actorId,
    productId: command.productId,
    operationId: command.operationId,
    state: 'reserved',
    createdAt: new Date().toISOString(),
    operation: {
      protocolVersion: 2,
      intent: command.intent,
      expectedUpdatedAt: command.expectedUpdatedAt,
      inputDigest: requestDigest(actorId, command, values),
      ...(normalizedStart ? { submittedInputDigest: command.submittedInputDigest } : {}),
      policy: currentPolicy(),
      values,
      base,
    },
  });
  if (!fitsJsonBudget(record, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28))
    return fail('VALIDATION_ERROR');
  await tx.set(collection, record);
  return { ok: true, record, current: true, revisionCurrent: true, expired: false };
}

export function cleanProductOperationValues(
  value: Record<string, unknown>,
  maxBytes = PRODUCT_OPERATION_INPUT_MAX_BYTES,
): Record<string, unknown> | null {
  if (!fitsJsonBudget(value, maxBytes, 24)) return null;
  const parsed = ValuesSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const json = JSON.stringify(parsed.data, (_key, item: unknown) => {
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw new Error('Operation patch must contain JSON values');
      return item;
    });
    return z.record(z.unknown()).parse(JSON.parse(json));
  } catch {
    return null;
  }
}
export function submittedProductOperationDigest(
  actorId: string,
  command: Pick<
    z.infer<typeof ProductOperationStartSchema>,
    'productId' | 'operationId' | 'intent' | 'expectedUpdatedAt'
  >,
  values: Record<string, unknown>,
) {
  return alibabaPricingFingerprint([
    actorId,
    command.productId,
    command.operationId,
    command.intent,
    command.expectedUpdatedAt,
    values,
  ]);
}
function requestDigest(
  actorId: string,
  command: z.infer<typeof ProductOperationStartSchema>,
  values: Record<string, unknown>,
) {
  const parts = [
    'catalog-product-operation-v2',
    actorId,
    command.productId,
    command.operationId,
    command.intent,
    command.expectedUpdatedAt,
    values,
  ];
  if (command.submittedInputDigest !== undefined)
    parts.push({ submittedInputDigest: command.submittedInputDigest });
  return alibabaPricingFingerprint(parts);
}
function readReservation(row: CollectionDoc, actorId: string, command: Command) {
  if (!fitsJsonBudget(row, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32)) return null;
  const parsed = RecordSchema.safeParse(row);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (
    Object.hasOwn(record.operation, 'submittedInputDigest') &&
    record.operation.submittedInputDigest === undefined
  )
    return null;
  if (Object.hasOwn(record.operation, 'cancelledAt') && record.operation.cancelledAt === undefined)
    return null;
  if (
    Object.hasOwn(record.operation, 'recovery') &&
    (record.operation.recovery === undefined || !Object.hasOwn(record.operation, 'cancelledAt'))
  )
    return null;
  if (record.state === 'staging' || record.state === 'complete') {
    const {
      operation: _operation,
      saved: _saved,
      media: _media,
      references: _references,
      referenceStage: _referenceStage,
      ...storedJob
    } = record;
    const { completion: _completion, ...job } = {
      ...storedJob,
      completion: record.state === 'complete' ? record.completion : undefined,
    };
    if (!readApprovalJob(job) || !fitsApprovalJobBudget(job)) return null;
    if (Object.hasOwn(record, 'media') && !readOwnedApprovalMedia(record, record.media))
      return null;
    if (
      Object.hasOwn(record, 'references') &&
      (record.nextPage !== record.pageHashes.length ||
        !readOwnedApprovalReferencePlan(record, record.references))
    )
      return null;
    if (Object.hasOwn(record, 'referenceStage')) {
      const plan = record.references
        ? readOwnedApprovalReferencePlan(record, record.references)
        : null;
      if (
        record.referenceStage === undefined ||
        !record.references ||
        !plan ||
        !readOwnedReferenceStage(record.references, plan, record.referenceStage) ||
        (record.state === 'complete' && record.referenceStage.cursor !== plan.changes.length)
      )
        return null;
    }
  } else if (!fitsJsonBudget(record, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28)) return null;
  if (record.state === 'complete' && Object.hasOwn(record.operation, 'cancelledAt')) return null;
  const values = cleanProductOperationValues(
    record.operation.values,
    record.operation.submittedInputDigest === undefined
      ? PRODUCT_OPERATION_INPUT_MAX_BYTES
      : PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
  );
  if (
    record.actorId !== actorId ||
    record.productId !== command.productId ||
    record.operationId !== command.operationId ||
    record._id !== operationKey(actorId, command.productId, command.operationId) ||
    values === null ||
    record.operation.inputDigest !==
      requestDigest(
        actorId,
        {
          action: 'operation-start',
          productId: record.productId,
          operationId: record.operationId,
          intent: record.operation.intent,
          expectedUpdatedAt: record.operation.expectedUpdatedAt,
          ...(record.operation.submittedInputDigest === undefined
            ? {}
            : { submittedInputDigest: record.operation.submittedInputDigest }),
          values,
        },
        values,
      )
  )
    return null;
  return record;
}
/** A cancellation stops future work; it never rolls back an acknowledged business write. */
async function cancelOperation(
  tx: CatalogApprovalTransaction,
  record: ProductOperationRecord,
  recovery?: Pick<z.infer<typeof RecoveryAuditSchema>, 'actorId' | 'reason'>,
): Promise<ProductOperationResult> {
  const product = await tx.get('products', record.productId);
  let cancelProof: ReturnType<typeof catalogImageReferenceCancelProof> | null = null;
  if (
    record.state === 'staging' &&
    record.references &&
    record.referenceStage &&
    record.referenceStage.cursor > 0
  ) {
    const plan = readOwnedApprovalReferencePlan(record, record.references);
    if (!plan) return fail('CONFLICT');
    const expected = catalogImageReferenceCancelProof(plan.proof);
    const previous = await tx.get(collection, expected._id);
    if (previous && alibabaPricingFingerprint(previous) !== alibabaPricingFingerprint(expected))
      return fail('CONFLICT');
    if (!previous) cancelProof = expected;
  }
  if (recovery) {
    const age = Date.now() - Date.parse(record.createdAt);
    if (age < 0 || (recovery.reason === 'expired' && age <= APPROVAL_JOB_MAX_AGE_MS))
      return fail('CONFLICT');
  }
  const now = new Date().toISOString();
  const cancelled = Object.hasOwn(record.operation, 'cancelledAt')
    ? record
    : RecordSchema.parse({
        ...record,
        operation: {
          ...record.operation,
          cancelledAt: now,
          ...(recovery ? { recovery: { ...recovery, at: now } } : {}),
        },
      });
  if (!fitsJsonBudget(cancelled, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  const age = Date.parse(now) - Date.parse(record.createdAt);
  const result = {
    ok: true as const,
    record: cancelled,
    current: false,
    revisionCurrent:
      product?._id === record.productId && matchesProductRevision(record, product.updatedAt),
    expired: age < 0 || age > APPROVAL_JOB_MAX_AGE_MS,
  };
  if (cancelled !== record) await tx.set(collection, cancelled);
  if (cancelProof) await tx.set(collection, cancelProof);
  return result;
}

async function inspect(
  tx: CatalogApprovalTransaction,
  record: ProductOperationRecord,
  currentProduct?: CollectionDoc | null,
): Promise<ProductOperationResult> {
  const product =
    currentProduct === undefined ? await tx.get('products', record.productId) : currentProduct;
  if (record.state === 'complete') {
    const plan = readOwnedApprovalReferencePlan(record, record.references);
    if (
      !plan ||
      alibabaPricingFingerprint(await tx.get(collection, plan.proof._id)) !==
        alibabaPricingFingerprint(plan.proof)
    )
      return fail('CONFLICT');
    const current =
      product?._id === record.productId
        ? await snapshot(tx, product, record.operation.intent)
        : null;
    const age = Date.now() - Date.parse(record.createdAt);
    return {
      ok: true,
      record,
      current:
        product?.published === true &&
        product.archived !== true &&
        current !== null &&
        alibabaPricingFingerprint(current) ===
          alibabaPricingFingerprint(record.completion.snapshot),
      revisionCurrent:
        product?._id === record.productId &&
        (product.updatedAt ?? null) === record.completion.productUpdatedAt,
      expired: age < 0 || age > APPROVAL_JOB_MAX_AGE_MS,
    };
  }
  const current =
    !Object.hasOwn(record.operation, 'cancelledAt') && product?._id === record.productId
      ? await snapshot(tx, product, record.operation.intent)
      : null;
  const age = Date.now() - Date.parse(record.createdAt);
  return {
    ok: true,
    record,
    current:
      matchesCurrent(record, current) &&
      (record.state !== 'staging' || sameApprovalProduct(product, record)),
    revisionCurrent:
      product?._id === record.productId && matchesProductRevision(record, product.updatedAt),
    expired: age < 0 || age > APPROVAL_JOB_MAX_AGE_MS,
  };
}
async function snapshot(
  tx: CatalogApprovalTransaction,
  product: CollectionDoc,
  writeIntent: Intent,
) {
  const current = productSnapshot(product, null);
  if (!current) return null;
  let source: z.infer<typeof SnapshotSchema>['source'] = null;
  // Broken supplier data must never prevent a withdrawal or a valid draft save.
  if (writeIntent === 'publish' || writeIntent === 'refresh-live') {
    const key = product.alibabaPrimarySourceKey;
    if (key !== undefined && key !== null && key !== '') {
      const parsedKey = id.safeParse(key);
      const revision = alibabaLinkRevision(product);
      if (!parsedKey.success || revision === null) return null;
      const sourceRow = await tx.get('alibabaSourceProducts', parsedKey.data);
      const observation = await tx.get(
        'catalogSourceObservations',
        sourceObservationDocumentId('alibaba', parsedKey.data),
      );
      const link = await tx.get('alibabaProductLinks', parsedKey.data);
      const linkFields = [
        '_id',
        'sourceKey',
        'connectionId',
        'sourceProductId',
        'productId',
        'linkedAt',
      ];
      const linkIdentity =
        parseAlibabaProductLink(link) ??
        (link ? Object.fromEntries(linkFields.map((field) => [field, link[field]])) : null);
      const inputs = [
        sourceBindingInputs(sourceRow),
        sourceObservationInputs(observation),
        linkIdentity,
      ];
      if (!inputs.every((value) => fitsJsonBudget(value, SNAPSHOT_MAX_BYTES, 24))) return null;
      source = {
        key: parsedKey.data,
        linkRevision: revision,
        sourceHash: normalizedSourceInputDigest(sourceRow),
        observationHash: sourceInputDigest(observation),
        linkHash: alibabaPricingFingerprint(linkIdentity),
      };
    }
  }
  const parsed = SnapshotSchema.safeParse({ ...current, source });
  return parsed.success ? parsed.data : null;
}

function productSnapshot(product: CollectionDoc, source: z.infer<typeof SnapshotSchema>['source']) {
  try {
    assertCatalogProductVersions(product);
  } catch (error) {
    if (error instanceof CatalogProductStateError) return null;
    throw error;
  }
  const website = Object.fromEntries(fields.map((field) => [field, product[field]]));
  if (!fitsJsonBudget(website, SNAPSHOT_MAX_BYTES, 24)) return null;
  const approval = {
    publication: approvalFields(product.catalogDetailPublication, ['state', 'revision']),
    receipt: approvalFields(product.catalogDetailApprovalReceipt, [
      'contentFingerprint',
      'operationId',
      'revision',
      'requestDigest',
      'actorId',
      'variantCount',
      'approvedAt',
      'sourceDigest',
      'supplierParts',
    ]),
  };
  if (!fitsJsonBudget(approval, SNAPSHOT_MAX_BYTES, 24)) return null;
  const parsed = SnapshotSchema.safeParse({
    approvalDigest: alibabaPricingFingerprint(approval),
    contentGeneration: product.catalogContentGeneration ?? 0,
    lifecycleVersion: product.catalogLifecycleVersion ?? 0,
    classificationRevision: product.catalogClassificationRevision ?? 0,
    websiteDigest: alibabaPricingFingerprint(website),
    identityDigest: alibabaPricingFingerprint(
      Object.fromEntries(
        [
          'alibabaPrimarySourceKey',
          'alibabaPrimaryOfferKey',
          'alibabaPinnedOfferKey',
          'alibabaLinkRevision',
          'alibabaSourceProductId',
          'alibabaSourceCategoryId',
        ].map((key) => [key, product[key]]),
      ),
    ),
    source,
  });
  return parsed.success ? parsed.data : null;
}

function approvalFields(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function matchesCurrent(
  record: ProductOperationRecord,
  current: z.infer<typeof SnapshotSchema> | null,
) {
  return (
    !Object.hasOwn(record.operation, 'cancelledAt') &&
    current !== null &&
    alibabaPricingFingerprint(record.operation.policy) ===
      alibabaPricingFingerprint(currentPolicy()) &&
    alibabaPricingFingerprint(current) ===
      alibabaPricingFingerprint(
        record.state === 'reserved' ? record.operation.base : record.saved.snapshot,
      )
  );
}
const BindingSchema = z
  .object({ actorId: id, operationId: z.string().uuid(), inputDigest: digest })
  .strict();

/** Capture before a storage read/lock can yield to a caller that still owns its input object. */
export function captureProductOperationSave(
  input: CatalogProductSaveInput,
): CatalogProductSaveInput | null {
  if (input.expectedOperation === undefined) return input;
  if (!fitsJsonBudget(input, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28)) return null;
  const binding = BindingSchema.safeParse(input.expectedOperation);
  const values = cleanProductOperationValues(
    input.data,
    PRODUCT_OPERATION_INTERNAL_START_MAX_BYTES,
  );
  if (!binding.success || values === null) return null;
  try {
    return { ...structuredClone(input), data: values, expectedOperation: binding.data };
  } catch {
    return null;
  }
}
export type ProductOperationSavePlan =
  | { result: 'unbound' }
  | { result: 'stale' }
  | { result: 'replay' }
  | { result: 'ready'; record: ReservedProductOperation }
  | Extract<CatalogProductSaveResult, { result: 'invalid-product' }>;

/** This check and the resulting product/receipt writes must share one storage transaction. */
export async function prepareProductOperationSave(
  tx: CatalogApprovalTransaction,
  product: CollectionDoc | null,
  input: CatalogProductSaveInput,
): Promise<ProductOperationSavePlan> {
  if (input.expectedOperation === undefined) return { result: 'unbound' };
  const parsed = BindingSchema.safeParse(input.expectedOperation);
  if (!parsed.success || input.mode !== 'update' || !product || product._id !== input.productId)
    return { result: 'stale' };
  const binding = parsed.data;
  const actor = await tx.get('users', binding.actorId);
  if (actor?._id !== binding.actorId || actor.role !== 'admin' || actor.status === 'suspended')
    return { result: 'stale' };
  const stored = await tx.get(
    collection,
    operationKey(binding.actorId, input.productId, binding.operationId),
  );
  const record = stored
    ? readReservation(stored, binding.actorId, {
        action: 'operation-get',
        productId: input.productId,
        operationId: binding.operationId,
      })
    : null;
  if (
    !record ||
    Object.hasOwn(record.operation, 'cancelledAt') ||
    (record.operation.intent !== 'save-draft' && record.operation.intent !== 'publish') ||
    input.expectedUpdatedAt !== record.operation.expectedUpdatedAt ||
    binding.inputDigest !== record.operation.inputDigest ||
    alibabaPricingFingerprint(input.data) !== alibabaPricingFingerprint(record.operation.values) ||
    product.published === true ||
    product.archived === true
  )
    return { result: 'stale' };
  const age = Date.now() - Date.parse(record.createdAt);
  if (
    age < 0 ||
    age > APPROVAL_JOB_MAX_AGE_MS ||
    !matchesProductRevision(record, product.updatedAt) ||
    !matchesCurrent(record, await snapshot(tx, product, record.operation.intent))
  )
    return { result: 'stale' };
  if (record.state !== 'reserved') return { result: 'replay' };
  for (const [field, contract] of [
    ['name', CatalogDetailHeaderSchema.shape.name],
    ['description', CatalogDetailHeaderSchema.shape.descriptionText],
  ] as const) {
    if (Object.hasOwn(input.data, field)) {
      // Approval trims descriptions and omits an empty value; keep the saved editor text.
      const value =
        field === 'description' && typeof input.data[field] === 'string'
          ? input.data[field].trim() || undefined
          : input.data[field];
      const validation = contract.safeParse(value);
      if (!validation.success)
        return {
          result: 'invalid-product',
          issues: [
            { field, message: validation.error.issues.map((issue) => issue.message).join('; ') },
          ],
        };
    }
  }
  const previousIds = new Set(draftImageIds(product));
  for (const field of ['imageIds', 'descriptionImageIds', 'configurationPhotos'] as const)
    if (
      Object.hasOwn(input.data, field) &&
      draftImageIds({ ...product, [field]: input.data[field] }).some(
        (imageId) => !previousIds.has(imageId),
      )
    )
      return {
        result: 'invalid-product',
        issues: [{ field, message: 'New photos need preparation before this draft can be saved.' }],
      };
  return { result: 'ready', record };
}

export function productOperationSaveReceipt(
  record: ReservedProductOperation,
  product: CollectionDoc,
): SavedProductOperation {
  // Reuse the source binding checked before any product or alias write.
  const saved = productSnapshot(product, record.operation.base.source);
  if (!saved) throw new Error('Saved product cannot be bound to its operation');
  const receipt = SavedSchema.parse({
    ...record,
    state: 'saved',
    saved: { at: new Date().toISOString(), productUpdatedAt: product.updatedAt, snapshot: saved },
  });
  if (!fitsJsonBudget(receipt, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28))
    throw new Error('Product save receipt exceeds the operation budget');
  return receipt;
}

function draftImageIds(product: Record<string, unknown>): string[] {
  const ids = new Set(catalogReferencedImageIds(product));
  const photos = product.configurationPhotos;
  if (photos && typeof photos === 'object' && !Array.isArray(photos))
    for (const value of Object.values(photos))
      if (Array.isArray(value))
        for (const id of value) if (typeof id === 'string' && id) ids.add(id);
  return [...ids];
}

function matchesProductRevision(record: ProductOperationRecord, updatedAt: unknown): boolean {
  return (
    (updatedAt ?? null) ===
    (record.state === 'reserved'
      ? record.operation.expectedUpdatedAt
      : record.saved.productUpdatedAt)
  );
}

/** The prepared candidate is server-only; HTTP accepts identifiers, never this object. */
async function beginOperationApproval(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationApprovalBeginSchema>,
): Promise<ProductOperationResult> {
  const prepared = command.prepared;
  if (
    !readApprovalJob(prepared) ||
    prepared.state !== 'staging' ||
    prepared.nextPage !== 0 ||
    !fitsJsonBudget(prepared, CATALOG_APPROVAL_JOB_MAX_BYTES, 28)
  )
    return fail('VALIDATION_ERROR');
  const key = operationKey(actorId, command.productId, command.operationId);
  if (
    prepared._id !== key ||
    prepared.actorId !== actorId ||
    prepared.productId !== command.productId ||
    prepared.operationId !== command.operationId
  )
    return fail('CONFLICT');
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, product, inspection } = current;
  if (!sameApprovalProduct(product, prepared)) return fail('CONFLICT');
  if (record.state === 'staging' || record.state === 'complete') {
    const {
      operation: _operation,
      saved: _saved,
      media: _media,
      references: _references,
      referenceStage: _referenceStage,
      ...persisted
    } = record;
    if (approvalPlanDigest(persisted) !== approvalPlanDigest(prepared)) return fail('CONFLICT');
    return inspection;
  }
  const root = ApprovalOperationSchema.parse({
    ...prepared,
    createdAt: record.createdAt,
    operation: record.operation,
    saved: record.saved,
  });
  if (!fitsJsonBudget(root, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  await tx.set(collection, root);
  return { ...inspection, record: root };
}
function approvalPlanDigest(job: PreparedApproval) {
  const {
    revision: _revision,
    createdAt: _createdAt,
    state: _state,
    nextPage: _nextPage,
    publication,
    ...rest
  } = job;
  const { revision: _publicationRevision, ...content } = publication;
  return alibabaPricingFingerprint({ ...rest, publication: content });
}

async function currentApprovalOperation(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command:
    | z.infer<typeof ProductOperationApprovalBeginSchema>
    | z.infer<typeof ProductOperationApprovalPageSchema>
    | z.infer<typeof ProductOperationMediaSchema>
    | z.infer<typeof ProductOperationReferencesSchema>
    | z.infer<typeof ProductOperationReferencePageSchema>
    | z.infer<typeof ProductOperationPublishSchema>,
): Promise<
  | {
      ok: true;
      record: Exclude<ProductOperationRecord, ReservedProductOperation>;
      product: CollectionDoc;
      inspection: Extract<ProductOperationResult, { ok: true }>;
    }
  | ApprovalFailure
> {
  const key = operationKey(actorId, command.productId, command.operationId);
  const stored = await tx.get(collection, key);
  const record = stored ? readReservation(stored, actorId, command) : null;
  if (
    !record ||
    record.state === 'reserved' ||
    record.operation.intent !== 'publish' ||
    record.operation.inputDigest !== command.inputDigest
  )
    return fail('CONFLICT');
  const product = await tx.get('products', record.productId);
  const inspection = await inspect(tx, record, product);
  if (!inspection.ok) return inspection;
  if (record.state === 'complete')
    return command.action === 'operation-publish' && product
      ? { ok: true, record, product, inspection }
      : fail('CONFLICT');
  if (
    !inspection.current ||
    !inspection.revisionCurrent ||
    inspection.expired ||
    !product ||
    product.published === true ||
    product.archived === true
  )
    return fail('CONFLICT');
  return { ok: true, record, product, inspection };
}
async function stageOperationApprovalPage(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationApprovalPageSchema>,
): Promise<ProductOperationResult> {
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, product, inspection } = current;
  if (record.state !== 'staging') return fail('CONFLICT');
  if (!isApprovalPage(record, command.page)) return fail('VALIDATION_ERROR');
  if (command.page < record.nextPage) return inspection;
  const plan = await prepareApprovalPage(tx, product, record, command.page);
  if (!plan.ok) return plan;
  const next = ApprovalOperationSchema.parse({ ...record, nextPage: plan.nextPage });
  if (!fitsJsonBudget(next, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  await storeApprovalPage(tx, plan, next);
  return { ...inspection, record: next };
}

async function bindOperationApprovalMedia(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationMediaSchema>,
): Promise<ProductOperationResult> {
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, product, inspection } = current;
  if (record.state !== 'staging') return fail('CONFLICT');
  if (record.media) return inspection;
  const media = await prepareOwnedApprovalMedia(tx, record, product);
  if (!media) return fail('MEDIA_NOT_READY');
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < 0 || age > APPROVAL_JOB_MAX_AGE_MS) return fail('APPROVAL_EXPIRED');
  const next = ApprovalOperationSchema.parse({ ...record, media });
  if (!fitsJsonBudget(next, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  await tx.set(collection, next);
  return { ...inspection, record: next };
}

async function bindOperationApprovalReferences(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationReferencesSchema>,
): Promise<ProductOperationResult> {
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, product, inspection } = current;
  if (record.state !== 'staging') return fail('CONFLICT');
  if (record.references) return inspection;
  if (record.nextPage !== record.pageHashes.length) return fail('SOURCE_NOT_READY');
  const references = prepareOwnedApprovalReferences(record, product);
  if (!references) return fail('MEDIA_NOT_READY');
  const next = ApprovalOperationSchema.parse({ ...record, references });
  if (!fitsJsonBudget(next, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < 0 || age > APPROVAL_JOB_MAX_AGE_MS) return fail('APPROVAL_EXPIRED');
  await tx.set(collection, next);
  return { ...inspection, record: next };
}

async function stageOperationReferences(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationReferencePageSchema>,
): Promise<ProductOperationResult> {
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, inspection } = current;
  if (record.state !== 'staging' || !record.references) return fail('CONFLICT');
  const plan = readOwnedApprovalReferencePlan(record, record.references);
  if (!plan) return fail('CONFLICT');
  const progress = readOwnedReferenceStage(record.references, plan, record.referenceStage);
  if (!progress || command.cursor > progress.cursor) return fail('CONFLICT');
  if (command.cursor < progress.cursor || progress.cursor === plan.changes.length)
    return inspection;
  if (await tx.get(collection, plan.proof._id)) return fail('CONFLICT');
  // Reserve the worst-case actor/root/product/source reads, terminal slot read and final root write.
  const page = await planOwnedReferenceStagePage(tx, plan, progress.cursor, 98 - 8);
  if (!page.ok) return page;
  const next = ApprovalOperationSchema.parse({
    ...record,
    referenceStage: ownedReferenceStageProgress(record.references, plan, page.nextCursor),
  });
  if (!fitsJsonBudget(next, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < 0 || age > APPROVAL_JOB_MAX_AGE_MS) return fail('APPROVAL_EXPIRED');
  for (const image of page.images) await tx.set('images', image);
  await tx.set(collection, next);
  return { ...inspection, record: next };
}

/** Product, operation success and public reference rights become visible in this one transaction. */
async function publishOperation(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationPublishSchema>,
): Promise<ProductOperationResult> {
  const current = await currentApprovalOperation(tx, actorId, command);
  if (!current.ok) return current;
  const { record, product, inspection } = current;
  if (record.state === 'complete') return inspection;
  if (record.state !== 'staging' || !record.references || !record.media) return fail('CONFLICT');
  if (
    product.alibabaReviewPending === true &&
    ['changed', 'removed'].includes(String(product.alibabaReviewReason))
  )
    return fail('SOURCE_NOT_READY');
  const plan = readOwnedApprovalReferencePlan(record, record.references);
  const progress = plan && readOwnedReferenceStage(record.references, plan, record.referenceStage);
  if (!plan || !progress) return fail('CONFLICT');
  if (record.nextPage !== record.pageHashes.length || progress.cursor !== plan.changes.length)
    return fail('SOURCE_NOT_READY');
  if (await tx.get(collection, plan.proof._id)) return fail('CONFLICT');
  const media = await prepareOwnedApprovalMedia(tx, record, product);
  if (!media || alibabaPricingFingerprint(media) !== alibabaPricingFingerprint(record.media))
    return fail('MEDIA_NOT_READY');
  const now = new Date().toISOString();
  let next: CollectionDoc;
  try {
    next = advanceCatalogProduct(product, { ...product, published: true }, now);
  } catch (error) {
    if (!(error instanceof CatalogProductStateError)) throw error;
    return fail('CONFLICT');
  }
  const issues = validateProductPublication(next);
  if (issues.length)
    return catalogValidationFailure(
      'commit',
      issues.map((issue) =>
        CatalogIssueSchema.parse({
          code: issue.field === 'productFamily' ? 'MISSING_CATEGORY' : 'INVALID_VALUE',
          stage: issue.field === 'productFamily' ? 'classification' : 'commit',
          path: issue.field,
          severity: 'error',
          remedy: issue.field === 'productFamily' ? 'classify' : 'edit',
        }),
      ),
    );
  next = {
    ...next,
    catalogDetailPublication: CatalogDetailPublicationSchema.parse({
      ...record.publication,
      variantStorage: 'immutable-v1',
    }),
    catalogDetailPagination: {
      policyVersion: CATALOG_DETAIL_PAGINATION_POLICY,
      revision: record.revision,
      pageSize: record.publicPageSize ?? 50,
    },
    catalogDetailApprovalReceipt: {
      contentFingerprint: publicationContentFingerprint(next),
      operationId: record.operationId,
      revision: record.revision,
      requestDigest: record.requestDigest,
      actorId,
      variantCount: record.variantIds.length,
      approvedAt: now,
      ...(record.sourceDigest === undefined ? {} : { sourceDigest: record.sourceDigest }),
      ...(record.supplierParts === undefined ? {} : { supplierParts: record.supplierParts }),
    },
  };
  const completed = CompleteOperationSchema.parse({
    ...record,
    state: 'complete',
    referenceStage: progress,
    completion: {
      at: now,
      productUpdatedAt: next.updatedAt,
      published: true,
      snapshot: productSnapshot(next, record.saved.snapshot.source),
    },
  });
  if (!fitsJsonBudget(completed, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32))
    return fail('VALIDATION_ERROR');
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < 0 || age > APPROVAL_JOB_MAX_AGE_MS) return fail('APPROVAL_EXPIRED');
  await tx.set('products', next);
  await tx.set(collection, completed);
  await tx.set(collection, plan.proof);
  return { ok: true, record: completed, current: true, revisionCurrent: true, expired: false };
}

/** Trusted recovery retires an unusable operation; it never continues another actor's publication. */
async function recoverOperation(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ProductOperationRecoverSchema>,
): Promise<ProductOperationResult> {
  const stored = await tx.get(collection, command.operationRootId);
  if (!stored) return fail('NOT_FOUND');
  const ownerId = id.safeParse(stored.actorId);
  const record = ownerId.success
    ? readReservation(stored, ownerId.data, {
        action: 'operation-get',
        productId: command.productId,
        operationId: command.operationId,
      })
    : null;
  if (
    !record ||
    record._id !== command.operationRootId ||
    record.operation.inputDigest !== command.inputDigest
  )
    return fail('CONFLICT');
  if (record.state === 'complete') {
    const result = await inspect(tx, record);
    return result.ok ? { ...result, recovery: 'already-complete' } : result;
  }
  if (Object.hasOwn(record.operation, 'cancelledAt')) {
    const result = await cancelOperation(tx, record);
    return result.ok ? { ...result, recovery: 'already-cancelled' } : result;
  }
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < 0) return fail('CONFLICT');
  let reason: z.infer<typeof RecoveryAuditSchema>['reason'] | undefined;
  let inspection: Extract<ProductOperationResult, { ok: true }> | undefined;
  if (age > APPROVAL_JOB_MAX_AGE_MS) reason = 'expired';
  else {
    const owner = await tx.get('users', record.actorId);
    if (!owner || owner.role !== 'admin' || owner.status === 'suspended')
      reason = 'owner-unavailable';
    else {
      const current = await inspect(tx, record);
      if (!current.ok) return current;
      inspection = current;
      if (!current.current || !current.revisionCurrent) reason = 'input-changed';
    }
  }
  // Reads may cross expiry or a clock correction; decide eligibility immediately before retiring.
  const finalAge = Date.now() - Date.parse(record.createdAt);
  if (finalAge < 0) return fail('CONFLICT');
  if (finalAge > APPROVAL_JOB_MAX_AGE_MS) reason = 'expired';
  else if (reason === 'expired') return fail('CONFLICT');
  if (!reason) return inspection ? { ...inspection, recovery: 'not-needed' } : fail('CONFLICT');
  const result = await cancelOperation(tx, record, {
    actorId,
    reason,
  });
  return result.ok ? { ...result, recovery: 'cancelled' } : result;
}
