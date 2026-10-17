/** Persistent operation inputs and acknowledged draft stages; no stage here publishes. */
import { createHash } from 'node:crypto';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import {
  type CollectionDoc,
  buildWriteSchema,
  catalogReferencedImageIds,
  getCollection,
  writableFields,
} from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogDetailHeaderSchema } from '@vibelingan-channel/shared/catalog-detail';
import type { CatalogValidationReport } from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import { parseAlibabaProductLink } from './alibaba-link-identity.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { alibabaLinkRevision } from './alibaba-product-identity.ts';
import { APPROVAL_JOB_MAX_AGE_MS } from './approval-job-age.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { CatalogProductStateError, assertCatalogProductVersions } from './catalog-product-state.ts';
import {
  normalizedSourceInputDigest,
  sourceBindingInputs,
  sourceInputDigest,
  sourceObservationInputs,
} from './catalog-source-inputs.ts';

export const PRODUCT_OPERATION_INPUT_MAX_BYTES = 256 * 1024;
export const PRODUCT_OPERATION_RECORD_MAX_BYTES = 512 * 1024;
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
  })
  .strict();
export const ProductOperationGetSchema = identifiers
  .extend({ action: z.literal('operation-get') })
  .strict();
const CommandSchema = z.discriminatedUnion('action', [
  ProductOperationStartSchema,
  ProductOperationGetSchema,
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
        policy: PolicySchema,
        values: z.record(z.unknown()),
        base: SnapshotSchema,
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
const RecordSchema = z.discriminatedUnion('state', [ReservedSchema, SavedSchema]);
export type SavedProductOperation = z.infer<typeof SavedSchema>;
export type ProductOperationRecord = ReservedProductOperation | SavedProductOperation;
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
    }
  | {
      ok: false;
      code: 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT';
      validation?: CatalogValidationReport;
    };
const fail = (
  code: Extract<ProductOperationResult, { ok: false }>['code'],
): ProductOperationResult => ({ ok: false, code });
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
  if (!fitsJsonBudget(input, PRODUCT_OPERATION_INPUT_MAX_BYTES, 24))
    return fail('VALIDATION_ERROR');
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_ERROR');
  const command = parsed.data;
  const actor = id.safeParse(actorId);
  if (!actor.success) return fail('FORBIDDEN');
  // Clone the entire JSON patch before the first await, including unknown JSON fields.
  const values = command.action === 'operation-start' ? cleanValues(command.values) : {};
  if (values === null) return fail('VALIDATION_ERROR');
  const user = await tx.get('users', actorId);
  if (user?.role !== 'admin' || user.status === 'suspended') return fail('FORBIDDEN');
  const key = operationKey(actorId, command.productId, command.operationId);
  const previous = await tx.get(collection, key);
  if (previous) {
    const record = readReservation(previous, actorId, command);
    if (!record) return fail('CONFLICT');
    if (
      command.action === 'operation-start' &&
      record.operation.inputDigest !== requestDigest(actorId, command, values)
    )
      return fail('CONFLICT');
    return inspect(tx, record);
  }
  if (command.action === 'operation-get') return fail('NOT_FOUND');
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

function cleanValues(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!fitsJsonBudget(value, PRODUCT_OPERATION_INPUT_MAX_BYTES, 24)) return null;
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
function requestDigest(
  actorId: string,
  command: z.infer<typeof ProductOperationStartSchema>,
  values: Record<string, unknown>,
) {
  return alibabaPricingFingerprint([
    'catalog-product-operation-v2',
    actorId,
    command.productId,
    command.operationId,
    command.intent,
    command.expectedUpdatedAt,
    values,
  ]);
}
function readReservation(row: CollectionDoc, actorId: string, command: Command) {
  if (!fitsJsonBudget(row, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28)) return null;
  const parsed = RecordSchema.safeParse(row);
  if (!parsed.success) return null;
  const record = parsed.data;
  const values = cleanValues(record.operation.values);
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
          values,
        },
        values,
      )
  )
    return null;
  return record;
}
async function inspect(
  tx: CatalogApprovalTransaction,
  record: ProductOperationRecord,
): Promise<ProductOperationResult> {
  const product = await tx.get('products', record.productId);
  const current =
    product?._id === record.productId ? await snapshot(tx, product, record.operation.intent) : null;
  const age = Date.now() - Date.parse(record.createdAt);
  return {
    ok: true,
    record,
    current: matchesCurrent(record, current),
    revisionCurrent: matchesProductRevision(record, product?.updatedAt),
    expired: age < 0 || age > APPROVAL_JOB_MAX_AGE_MS,
  };
}
async function snapshot(
  tx: CatalogApprovalTransaction,
  product: CollectionDoc,
  writeIntent: Intent,
) {
  try {
    assertCatalogProductVersions(product);
  } catch (error) {
    if (error instanceof CatalogProductStateError) return null;
    throw error;
  }
  const website = Object.fromEntries(fields.map((field) => [field, product[field]]));
  if (!fitsJsonBudget(website, SNAPSHOT_MAX_BYTES, 24)) return null;
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
    current !== null &&
    alibabaPricingFingerprint(record.operation.policy) ===
      alibabaPricingFingerprint(currentPolicy()) &&
    alibabaPricingFingerprint(current) ===
      alibabaPricingFingerprint(
        record.state === 'saved' ? record.saved.snapshot : record.operation.base,
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
  const values = cleanValues(input.data);
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
    record.operation.intent !== 'save-draft' ||
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
    !matchesCurrent(record, await snapshot(tx, product, 'save-draft'))
  )
    return { result: 'stale' };
  if (record.state === 'saved') return { result: 'replay' };
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

export async function productOperationSaveReceipt(
  tx: CatalogApprovalTransaction,
  record: ReservedProductOperation,
  product: CollectionDoc,
): Promise<SavedProductOperation> {
  const saved = await snapshot(tx, product, 'save-draft');
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
    (record.state === 'saved' ? record.saved.productUpdatedAt : record.operation.expectedUpdatedAt)
  );
}
