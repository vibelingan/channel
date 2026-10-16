import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogImageObservation } from './catalog-image-observation.ts';
const integer = z.number().int().nonnegative().safe();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogPreparationMediaProgressSchema = z
  .object({
    planDigest: hex,
    total: integer,
    cursor: integer,
    verified: integer,
    invalid: integer,
    retry: integer,
    lastReceipt: hex.nullable(),
  })
  .strict()
  .refine(
    (p) =>
      p.cursor <= p.total &&
      p.verified + p.invalid + p.retry === p.cursor &&
      (p.cursor === 0 ? p.lastReceipt === null : p.lastReceipt !== null),
  );
export type CatalogPreparationMediaProgress = z.infer<typeof CatalogPreparationMediaProgressSchema>;
export function initialCatalogMediaProgress(
  planDigest: string,
  total: number,
): CatalogPreparationMediaProgress {
  return CatalogPreparationMediaProgressSchema.parse({
    planDigest,
    total,
    cursor: 0,
    verified: 0,
    invalid: 0,
    retry: 0,
    lastReceipt: null,
  });
}
export function catalogMediaStepReceipt(input: {
  planDigest: string;
  index: number;
  imageId: string;
  imageInputDigest: string | null;
  health: CatalogImageObservation['health'];
}) {
  return alibabaPricingFingerprint([
    input.planDigest,
    input.index,
    input.imageId,
    input.imageInputDigest,
    input.health,
  ]);
}
export function advanceCatalogMediaProgress(
  current: CatalogPreparationMediaProgress,
  receipt: string,
  status: CatalogImageObservation['health']['status'],
) {
  return CatalogPreparationMediaProgressSchema.parse({
    ...current,
    cursor: current.cursor + 1,
    [status]: current[status] + 1,
    lastReceipt: receipt,
  });
}
