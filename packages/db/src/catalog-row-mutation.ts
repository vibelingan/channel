/** Shared input mutation body. Dedicated preparation/approval outputs use their own CAS. */
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { categorySyncBaseline } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import {
  CatalogProductStateError,
  advanceCatalogProduct,
  isCatalogProductManagedField,
  monotonicProductTime,
} from './catalog-product-state.ts';
import { planSourceInvalidation } from './catalog-source-invalidation.ts';
import { nextCounterValue } from './counter-value.ts';

const collection = z.enum([
  'products',
  'productVariants',
  'alibabaSourceProducts',
  'catalogSourceObservations',
]);
const id = z.string().min(1).max(200);
const base = z.object({ collection, id });
export const CatalogRowMutationSchema = z.discriminatedUnion('action', [
  base
    .extend({
      action: z.enum(['create', 'create-if-missing', 'update', 'upsert']),
      data: z.record(z.unknown()),
      createOnly: z.record(z.unknown()).optional(),
    })
    .strict(),
  base
    .extend({
      action: z.literal('remove'),
      expectedField: z.object({ field: id, value: z.unknown() }).strict().optional(),
    })
    .strict(),
  base.extend({ action: z.literal('increment'), field: id, delta: z.number().finite() }).strict(),
]);
export type CatalogRowMutation = z.infer<typeof CatalogRowMutationSchema>;
export type CatalogRowCollection = z.infer<typeof collection>;
export function isCatalogRowCollection(value: string): value is CatalogRowCollection {
  return (
    value === 'products' ||
    value === 'productVariants' ||
    value === 'alibabaSourceProducts' ||
    value === 'catalogSourceObservations'
  );
}
export interface CatalogRowStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: CatalogRowCollection, doc: CollectionDoc): Promise<void>;
  remove(collection: CatalogRowCollection, id: string): Promise<void>;
}
export type CatalogRowMutationResult =
  | { status: 'written'; doc: CollectionDoc; created: boolean }
  | { status: 'exists'; doc: CollectionDoc }
  | { status: 'missing' | 'removed' };

export const catalogVariantInputFields = [
  'productId',
  'sku',
  'position',
  'optionValues',
  'inventoryState',
  'inventoryQuantity',
  'inventorySnapshots',
  'sourceRegularPrice',
  'sourcePromotionPrice',
  'imageIds',
  'archived',
  'detailSourceOwner',
  'detailSourceRevision',
  'detailSourceMissing',
  'detailSourceCandidate',
  'detailSourceMediaSources',
  'detailSourceUnboundMediaSources',
] as const;

/** All reads/plans precede writes. Caller owns one transaction or one JSON mutation lock. */
export async function runCatalogRowMutation(
  store: CatalogRowStore,
  input: CatalogRowMutation,
  now: string,
): Promise<CatalogRowMutationResult> {
  const command = CatalogRowMutationSchema.parse(input);
  const before = await store.get(command.collection, command.id);
  if (before && before._id !== command.id)
    throw new CatalogProductStateError('Row identity changed');
  if ((command.action === 'create' || command.action === 'create-if-missing') && before)
    return { status: 'exists', doc: before };
  if (['update', 'remove', 'increment'].includes(command.action) && !before)
    return { status: 'missing' };
  let next: CollectionDoc | null;
  if (command.action === 'remove') {
    if (
      command.expectedField &&
      before?.[command.expectedField.field] !== command.expectedField.value
    )
      return { status: 'missing' };
    next = null;
  } else if (command.action === 'increment') {
    if (!before) return { status: 'missing' };
    if (command.collection === 'products' && isCatalogProductManagedField(command.field))
      throw new CatalogProductStateError(
        'Product managed state cannot be incremented as ordinary counters',
      );
    if (
      (command.collection === 'alibabaSourceProducts' ||
        command.collection === 'catalogSourceObservations') &&
      command.field === 'catalogBindingGeneration'
    )
      throw new CatalogProductStateError(
        'Source binding versions cannot be incremented as ordinary counters',
      );
    const value = nextCounterValue(before[command.field], command.delta);
    if (!Number.isFinite(value))
      throw new CatalogProductStateError('Counter result must be finite');
    next = { ...before, [command.field]: value };
  } else {
    const { _id: _patchId, ...patch } = command.data;
    const { _id: _createId, ...createOnly } = command.createOnly ?? {};
    next = { ...(before ?? { createdAt: now, ...createOnly }), ...patch, _id: command.id };
    if (command.action === 'create') next.createdAt = now;
    if (command.collection === 'products' && before)
      next = { ...next, ...categorySyncBaseline(before, patch) };
  }
  const parents: CollectionDoc[] = [];
  if (command.collection === 'products' && next)
    next = advanceCatalogProduct(before, next, now, {
      ...('data' in command ? { lifecyclePatch: command.data } : {}),
    });
  if (command.collection === 'productVariants') {
    if (next) next = { ...next, updatedAt: monotonicProductTime(before, now) };
    if (variantInput(before) !== variantInput(next)) {
      const ids = new Set(
        [before?.productId, next?.productId].filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
      );
      for (const parentId of ids) {
        const parent = await store.get('products', parentId);
        if (!parent) continue;
        if (parent._id !== parentId)
          throw new CatalogProductStateError('Parent product identity changed');
        parents.push(advanceCatalogProduct(parent, parent, now, { forceContent: true }));
      }
    }
  }
  if (
    command.collection === 'alibabaSourceProducts' ||
    command.collection === 'catalogSourceObservations'
  ) {
    if (next) {
      next = { ...next, ...(!before ? { createdAt: now } : {}), updatedAt: now };
      if (before && Object.hasOwn(before, 'catalogBindingGeneration'))
        next.catalogBindingGeneration = before.catalogBindingGeneration;
      else {
        const { catalogBindingGeneration: _untrustedFence, ...sourceValues } = next;
        next = sourceValues;
      }
    }
    if (before && next && isDeepStrictEqual(before, next))
      return { status: 'written', doc: before, created: false };
    const invalidated = await planSourceInvalidation(
      store,
      before,
      next,
      now,
      command.collection === 'alibabaSourceProducts' ? 'mirror' : 'observation',
    );
    if (invalidated) parents.push(invalidated);
  }
  if (next) await store.set(command.collection, next);
  else await store.remove(command.collection, command.id);
  for (const parent of parents) await store.set('products', parent);
  return next ? { status: 'written', doc: next, created: before === null } : { status: 'removed' };
}
function variantInput(row: CollectionDoc | null): string {
  return alibabaPricingFingerprint(
    row ? Object.fromEntries(catalogVariantInputFields.map((field) => [field, row[field]])) : null,
  );
}
