/** Persistent input reservation; a reserved operation has not saved or approved a product. */
import { createHash } from 'node:crypto';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import {
  type CollectionDoc,
  buildWriteSchema,
  getCollection,
  writableFields,
} from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import type { CatalogValidationReport } from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
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
        values: z.record(z.unknown()),
        base: SnapshotSchema,
      })
      .strict(),
  })
  .strict();
type Command = z.infer<typeof CommandSchema>;
type Intent = z.infer<typeof intent>;
export type ReservedProductOperation = z.infer<typeof ReservedSchema>;
export type ProductOperationResult =
  | { ok: true; record: ReservedProductOperation; current: boolean; expired: boolean }
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
      values,
      base,
    },
  });
  if (!fitsJsonBudget(record, PRODUCT_OPERATION_RECORD_MAX_BYTES, 28))
    return fail('VALIDATION_ERROR');
  await tx.set(collection, record);
  return { ok: true, record, current: true, expired: false };
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
  const parsed = ReservedSchema.safeParse(row);
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
  record: ReservedProductOperation,
): Promise<ProductOperationResult> {
  const product = await tx.get('products', record.productId);
  const current =
    product?._id === record.productId ? await snapshot(tx, product, record.operation.intent) : null;
  const age = Date.now() - Date.parse(record.createdAt);
  return {
    ok: true,
    record,
    current:
      current !== null &&
      alibabaPricingFingerprint(current) === alibabaPricingFingerprint(record.operation.base),
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
  const parsed = SnapshotSchema.safeParse({
    contentGeneration: product.catalogContentGeneration ?? 0,
    lifecycleVersion: product.catalogLifecycleVersion ?? 0,
    classificationRevision: product.catalogClassificationRevision ?? 0,
    websiteDigest: alibabaPricingFingerprint(website),
    source,
  });
  return parsed.success ? parsed.data : null;
}
