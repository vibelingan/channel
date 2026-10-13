/** Server-read source inputs used to create or change an explicit binding. */
import {
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { sourceInputDigest } from './catalog-source-invalidation.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogSourceBindingExpectationSchema = z
  .object({
    sourceHash: digest,
    observationHash: digest,
  })
  .strict();
export type CatalogSourceBindingExpectation = z.infer<typeof CatalogSourceBindingExpectationSchema>;

const sourceFields = [
  '_id',
  'sourceKey',
  'connectionId',
  'sourceProductId',
  'sourceTitle',
  'sourceDescription',
  'sourceCategoryId',
  'sourceCategoryPath',
  'sourceImageUrls',
  'active',
  'sourceUpdatedAt',
  'contentHash',
] as const;
export function sourceBindingHash(source: CollectionDoc): string {
  return alibabaPricingFingerprint([
    'catalog-source-binding-v1',
    Object.fromEntries(sourceFields.map((field) => [field, source[field]])),
  ]);
}

export function sourceBindingSnapshot(source: CollectionDoc, row: CollectionDoc | null) {
  const parsed = validateCatalogSourceObservation(row?.observation);
  if (
    !row ||
    row._id !== sourceObservationDocumentId('alibaba', source._id) ||
    (row.provider !== undefined && row.provider !== 'alibaba') ||
    (row.sourceProductKey !== undefined && row.sourceProductKey !== source._id) ||
    !parsed.ok ||
    parsed.value.source.provider !== 'alibaba' ||
    parsed.value.source.sourceProductKey !== source._id ||
    parsed.value.source.externalProductId !== source.sourceProductId ||
    parsed.value.source.completeness !== 'full-product'
  )
    return { ok: false as const, reason: 'source-not-ready' as const };
  return {
    ok: true as const,
    observation: parsed.value,
    row,
    expectation: {
      sourceHash: sourceBindingHash(source),
      observationHash: sourceInputDigest(row),
    },
  };
}

/** A per-source write fence, not a shared lease or a new source revision. */
export function advanceSourceBindingFence(row: CollectionDoc): CollectionDoc {
  const generation = row.catalogBindingGeneration ?? 0;
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation === Number.MAX_SAFE_INTEGER
  )
    throw new Error('Source binding fence is invalid or exhausted');
  return { ...row, catalogBindingGeneration: generation + 1 };
}
