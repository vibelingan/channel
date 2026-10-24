/** Server-read source inputs used to create or change an explicit binding. */
import {
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { parseAlibabaProductLink } from './alibaba-link-identity.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import {
  sourceBindingHash,
  sourceCaptureMatches,
  sourceInputDigest,
} from './catalog-source-inputs.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogSourceBindingExpectationSchema = z
  .object({
    sourceHash: digest,
    observationHash: digest,
  })
  .strict();
export const CatalogPreparedSourceBindingSchema = CatalogSourceBindingExpectationSchema.extend({
  linkHash: digest,
}).strict();
export type CatalogSourceBindingExpectation = z.infer<typeof CatalogSourceBindingExpectationSchema>;

export { sourceBindingHash, sourceCaptureMatches } from './catalog-source-inputs.ts';

export function sourceBindingSnapshot(source: CollectionDoc, row: CollectionDoc | null) {
  if (
    typeof source._id !== 'string' ||
    !source._id.trim() ||
    typeof source.connectionId !== 'string' ||
    !source.connectionId.trim() ||
    typeof source.sourceProductId !== 'string' ||
    !source.sourceProductId.trim() ||
    (source.sourceKey !== undefined && source.sourceKey !== source._id)
  )
    return { ok: false as const, reason: 'source-not-ready' as const };
  const parsed = validateCatalogSourceObservation(row?.observation);
  if (
    !row ||
    row._id !== sourceObservationDocumentId('alibaba', source._id) ||
    (row.provider !== undefined && row.provider !== 'alibaba') ||
    (row.sourceProductKey !== undefined && row.sourceProductKey !== source._id) ||
    !sourceCaptureMatches(source, row) ||
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

export function primarySourceLinkSnapshot(
  source: CollectionDoc,
  value: unknown,
  productId: string,
) {
  const link = parseAlibabaProductLink(value);
  if (
    !link ||
    link._id !== source._id ||
    link.connectionId !== source.connectionId ||
    link.sourceProductId !== source.sourceProductId ||
    link.productId !== productId
  )
    return { ok: false as const, reason: 'source-not-ready' as const };
  return { ok: true as const, identity: link, linkHash: alibabaPricingFingerprint(link) };
}
